// 插件能力权限（permissions）契约测试 —— 纯 Node，无浏览器。
//   node --test tests/contract/permissions.test.mjs
//
// 被测对象与 fiber.test.mjs 同一套加载基座：真实 cover/ts/ExtPluginHost.ts + 真实
// packages/plugin-api（含 permissions.json 目录），只有三处解析缺口用替身补：
//   ① 裸导入 "@ext/plugin-api" → packages 里的真实源码；
//   ② 宿主的 "./CommandPaletteRegistry" → 忠实替身（core 源码含不可擦除语法）；
//   ③ activate 的动态导入 "/plugins/<id>/<entry>" → 本文件内置的虚拟插件源码。
//
// 断言分组：
//   1. 目录自洽（id 唯一 / 字段齐全 / check 可编译 / 与 ExtPermission 联合类型一致）
//   2. 未声明就调用 → 七个面各自抛 ExtPermissionError（code、denial、permission 都要对）
//   3. 未声明且不捕获 → 激活失败且零残留
//   4. 声明了就通 → 七面可用，permissions / permits 如实反映，卸载后零残留
//   5. 权限名拼错 → 加载插件代码**之前**就失败（不在运行期莫名其妙少一半能力）
//   6. 站点策略 deny → 插件仍能装（降级），被拒的面抛 denied-by-policy 且有 warning
//   7. claims 与实现不一致 → 默认 warning，strictClaims 下失败
//   8. ui.menu 独立于 element.register：带菜单要它，menu:false 不需要
//   9. 静态检查（ext plugin lint）与运行期同口径：漏声明在构建期就红

import { register, registerHooks } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const EXT_CLI = path.join(repoRoot, "tools", "ext.mjs");

// 与 fiber.test.mjs 同语义的调色板替身（重复 id 静默忽略）
const PALETTE_STANDIN_SRC = `
export class PaletteCommand {
    constructor(init) {
        this.id = init.id; this.label = init.label; this.category = init.category; this.keywords = init.keywords;
        this.menu = init.menu ?? null; this.item = init.item ?? null; this.custom = init.custom ?? null; this.hint = init.hint ?? null;
    }
    searchText() { return (this.label + " " + this.category + " " + this.keywords).toLowerCase(); }
}
export class CommandPaletteRegistry {
    static commands = [];
    static circuitCommands = [];
    static byId = new Map();
    static clear() {
        CommandPaletteRegistry.commands = [];
        CommandPaletteRegistry.circuitCommands = [];
        CommandPaletteRegistry.byId.clear();
    }
    static addCommand(cmd) {
        if (CommandPaletteRegistry.byId.has(cmd.id)) return;
        CommandPaletteRegistry.commands.push(cmd);
        CommandPaletteRegistry.byId.set(cmd.id, cmd);
    }
    static get(id) { return CommandPaletteRegistry.byId.get(id); }
}
`;

const virtualPlugins = new Map();
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@ext/plugin-api") {
            return { shortCircuit: true, url: new URL("../../packages/plugin-api/src/index.ts", import.meta.url).href };
        }
        if (specifier === "./CommandPaletteRegistry" && String(context.parentURL ?? "").includes("ExtPluginHost")) {
            return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(PALETTE_STANDIN_SRC) };
        }
        if (specifier.startsWith("/plugins/")) {
            const src = virtualPlugins.get(specifier.split("?")[0]);
            if (src !== undefined) return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(src) };
        }
        return nextResolve(specifier, context);
    },
});
register(new URL("./helpers/ts-resolve.mjs", import.meta.url));

const { PluginHost } = await import("../../cover/ts/ExtPluginHost.ts");
const { ExtHooks } = await import("../../cover/ts/ExtHooks.ts");
const { ElementFactory } = await import("../../cover/ts/ElementFactory.ts");
const P = await import("../../packages/plugin-api/src/index.ts");
const { CommandPaletteRegistry: Palette } = await import(
    "data:text/javascript," + encodeURIComponent(PALETTE_STANDIN_SRC)
);
const CATALOG = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "packages", "plugin-api", "permissions.json"), "utf8"),
);

// ── 测试脚手架 ────────────────────────────────────────────────────────────

/** activate 传的 entry 形如 manifest 里的一条；permissions 缺省 = []（什么也不给） */
const activate = (host, id, body, extra = {}) => {
    virtualPlugins.set(`/plugins/${id}/plugin.mjs`, body);
    return host.activate({ id, entry: "plugin.mjs", version: "1.0.0", ...extra });
};

/** 最小假 app：只实现 ctx.panel 与元件注册真正会碰的两处 */
function fakeApp() {
    const app = {
        panels: [],
        elements: [],
        addWidgetToVerticalPanel(el) { app.panels.push(el); },
        removeWidgetFromVerticalPanel(el) {
            const i = app.panels.indexOf(el);
            if (i >= 0) app.panels.splice(i, 1);
        },
        register(className, elm) { app.elements.push([className, elm]); },
    };
    return app;
}

/** 把插件里 catch 到的错误收集到 globalThis，便于一次断言多个面 */
const probe = (slot) => `(globalThis.__permProbe ??= {})["${slot}"]`;
const readProbe = (slot) => (globalThis.__permProbe ?? {})[slot];

test.afterEach(() => {
    delete globalThis.__permProbe;
    delete globalThis.__permImported;
});

// ── 1. 目录自洽 ────────────────────────────────────────────────────────────

test("权限目录：id 唯一、字段齐全、check 都能编译，且与 ExtPermission 联合类型一一对应", () => {
    const list = CATALOG.permissions;
    assert.ok(Array.isArray(list) && list.length > 0, "permissions.json 应有 permissions 数组");

    const ids = list.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, `权限 id 不能重复：${ids.join(",")}`);
    for (const p of list) {
        assert.ok(p.id && p.label && p.surface && p.summary, `权限 ${p.id} 的 id/label/surface/summary 都要有`);
        if (p.check != null) assert.doesNotThrow(() => new RegExp(p.check), `权限 ${p.id} 的 check 不是合法正则`);
    }
    // 运行期导出的 id 列表 == JSON（反方向由 permissions.ts 的类型声明兜住）
    assert.deepEqual([...P.EXT_PERMISSION_IDS].sort(), [...ids].sort(), "EXT_PERMISSION_IDS 与 JSON 不一致");
    // 每个 id 都写进了 ExtPermission 联合类型（这里用字面量列表做独立核对，别只信源码自己）
    assert.deepEqual(
        [...P.EXT_PERMISSION_IDS].sort(),
        ["document.hook", "element.register", "sim.control", "sim.observe", "ui.command", "ui.menu", "ui.panel"],
        "ExtPermission 联合类型漏了/多了权限，permissions.ts 要同步改",
    );
    // 目录里带 check 的能力，覆盖运行期真正会抛的那些面
    const checked = new Set(list.filter((p) => p.check).map((p) => p.id));
    for (const id of ["sim.observe", "sim.control", "ui.command", "ui.panel", "element.register", "document.hook"]) {
        assert.ok(checked.has(id), `权限 ${id} 应在 permissions.json 里给 check 供 lint 用`);
    }
});

// ── 2. 未声明就调用：七个面各自抛 ──────────────────────────────────────────

test("未声明就调用：每个 ctx 面都抛 ExtPermissionError（code / denial / permission 都对）", async () => {
    const app = fakeApp();
    const host = new PluginHost(app, {});
    await activate(host, "perm-a", [
        "export async function activate(ctx) {",
        '  const out = (globalThis.__permProbe ??= {}).deny ??= {};',
        "  const facets = {",
        '    on: () => ctx.on("analyze", () => {}),',
        '    hook: () => ctx.hook("save", (t) => t),',
        '    command: () => ctx.command({ id: "perm-a.cmd", label: "x", run() {} }),',
        "    panel: () => ctx.panel({ tagName: 'DIV', parentNode: null }),",
        "    api: () => ctx.api,",
        '    element: () => ctx.element.register({ className: "PermAElm", ctor: class {}, dumpType: 191 }),',
        '    elementBase: () => ctx.element.base("ResistorElm"),',
        "  };",
        "  for (const [k, fn] of Object.entries(facets)) {",
        "    try { fn(); out[k] = 'ok'; }",
        "    catch (e) { out[k] = { code: e.code, denial: e.denial, permission: e.permission, message: e.message }; }",
        "  }",
        "}",
    ].join("\n"), { permissions: [] });

    const got = readProbe("deny");
    const expect = {
        on: "sim.observe",
        hook: "document.hook",
        command: "ui.command",
        panel: "ui.panel",
        api: "sim.control",
        element: "element.register",
        elementBase: "element.register",
    };
    for (const [facet, perm] of Object.entries(expect)) {
        const r = got[facet];
        assert.notEqual(r, "ok", `${facet} 没声明权限却成功了`);
        assert.equal(r.code, "ext/eperm", `${facet} 的错误应是 ExtPermissionError（拿到的 message: ${r.message}）`);
        assert.equal(r.denial, "undeclared", `${facet} 的 denial 应为 undeclared`);
        assert.equal(r.permission, perm, `${facet} 指向的权限不对`);
        assert.match(r.message, new RegExp(`未声明权限 "${perm}"`), `${facet} 的报错要指名权限`);
        assert.match(r.message, /ctx\.permits/, `${facet} 的报错要给出自救办法`);
    }
    // 全部被拒的情况下，这些面确实什么也没留下
    assert.equal(Palette.get("perm-a.cmd"), undefined, "被拒的命令不得进调色板");
    assert.equal(app.panels.length, 0, "被拒的面板不得挂进侧栏");
    assert.equal(app.elements.length, 0, "被拒的元件不得注册");
    await host.dispose();
});

test("未声明且不捕获：激活失败、插件不留在 ready、注册过的命令随回滚消失", async () => {
    const app = fakeApp();
    const host = new PluginHost(app, {});
    const baseline = Palette.commands.length;
    await assert.rejects(
        () => activate(host, "perm-b", [
            "export async function activate(ctx) {",
            '  ctx.command({ id: "perm-b.ok", label: "先注册的", run() {} });',   // 有权限也没用：本轮整体回滚
            '  ctx.panel({ tagName: "DIV", parentNode: null });',                  // 这里抛
            "}",
        ].join("\n"), { permissions: ["ui.command"] }),
        /"ui\.panel"/,
        "缺 ui.panel 时激活应失败并指名权限",
    );
    assert.equal(host.list().some((s) => s.id === "perm-b"), false, "失败插件不留在 fiber 表");
    assert.equal(Palette.commands.length, baseline, "先注册的命令也要随 LIFO 回滚消失");
    assert.equal(app.panels.length, 0);
    await host.dispose();
});

// ── 3. 声明了就通 ─────────────────────────────────────────────────────────

test("声明了就通：七个面可用，permissions / permits 如实反映，卸载后零残留", async () => {
    const app = fakeApp();
    const apiStub = { listComponents: () => [], getTime: () => 0, on: () => () => {} };
    const hooks = new ExtHooks();
    const host = new PluginHost(app, apiStub, hooks);
    const baseline = Palette.commands.length;

    virtualPlugins.set("/plugins/perm-c/plugin.mjs", [
        "export async function activate(ctx) {",
        "  const out = (globalThis.__permProbe ??= {}).ok ??= {};",
        "  out.permissions = [...ctx.permissions];",
        '  out.permitsHook = ctx.permits("document.hook");',
        '  out.permitsMenu = ctx.permits("ui.menu");',
        '  ctx.on("analyze", () => {});',
        '  out.hookReturn = ctx.hook("save", (t) => t + "|hooked");',
        '  ctx.command({ id: "perm-c.cmd", label: "PermC", run() {} });',
        "  ctx.panel({ tagName: 'DIV', parentNode: null });",
        "  out.apiSame = ctx.api === globalThis.__apiStub;",
        '  const off = ctx.element.register({ className: "PermCElm", ctor: class { constructor() {} }, dumpType: 192, menu: false });',
        "  out.elementRegistered = !!off;",
        "}",
    ].join("\n"));
    globalThis.__apiStub = apiStub;
    await host.activate({
        id: "perm-c",
        entry: "plugin.mjs",
        version: "1.0.0",
        permissions: ["sim.observe", "sim.control", "ui.command", "ui.panel", "element.register", "document.hook"],
    });

    const got = readProbe("ok");
    assert.deepEqual(
        got.permissions.sort(),
        ["document.hook", "element.register", "sim.control", "sim.observe", "ui.command", "ui.panel"],
    );
    assert.equal(got.permitsHook, true, "申请了就应 permits 为 true");
    assert.equal(got.permitsMenu, false, "没申请的 ui.menu 应为 false");
    assert.equal(got.apiSame, true, "ctx.api 应就是宿主那份（同一对象）");
    assert.equal(typeof got.hookReturn, "function", "ctx.hook 应返回 disposer");
    assert.equal(Palette.get("perm-c.cmd")?.label, "PermC", "声明的命令应进调色板");
    assert.equal(app.panels.length, 1, "声明的面板应挂进侧栏");
    assert.equal(hooks.run("save", "abc"), "abc|hooked", "声明的钩子应真的接到总线上");
    assert.equal(ElementFactory.hasClass("PermCElm"), true, "声明的元件应进工厂");

    const status = host.list()[0];
    assert.deepEqual(status.permissions.sort(), got.permissions);
    assert.deepEqual(status.denied, []);
    assert.deepEqual(status.warnings, [], "全声明齐了不该有 warning");

    await host.dispose();
    delete globalThis.__apiStub;
    assert.equal(Palette.commands.length, baseline, "卸载后命令数回基线");
    assert.equal(app.panels.length, 0, "卸载后侧栏节点应摘掉");
    assert.equal(hooks.count(), 0, "卸载后钩子应退订");
    assert.equal(ElementFactory.hasClass("PermCElm"), false, "卸载后元件类应撤销");
});

// ── 4. 名字拼错：加载代码之前就失败 ────────────────────────────────────────

test("权限名拼错：激活前就失败（插件代码根本没被加载），list() 里留下可排障的 failed", async () => {
    const host = new PluginHost(fakeApp(), {});
    await assert.rejects(
        () => activate(host, "perm-d", "globalThis.__permImported = true;\nexport async function activate() {}", {
            permissions: ["ui.pannel"],
        }),
        /未知权限 "ui\.pannel"/,
        "拼错的权限名必须当场报错并列出可用项",
    );
    assert.equal(globalThis.__permImported, undefined, "权限解析失败时不该 import 插件代码");
    const status = host.list().find((s) => s.id === "perm-d");
    assert.ok(status, "失败也要留在 list() 里，否则排障时只看到'它没启动'");
    assert.equal(status.state, "failed");
    assert.match(status.error ?? "", /未知权限/);
    await host.dispose();
});

// ── 5. 站点策略 deny ─────────────────────────────────────────────────────

test("站点策略 deny：插件仍能装（降级），被拒的面抛 denied-by-policy 且 warnings 可见", async () => {
    const app = fakeApp();
    const host = new PluginHost(app, {}, undefined, { denyPermissions: ["ui.panel"] });
    await activate(host, "perm-e", [
        "export async function activate(ctx) {",
        "  const out = (globalThis.__permProbe ??= {}).ok ??= {};",
        "  out.permissions = [...ctx.permissions];",
        "  out.permits = ctx.permits('ui.panel');",
        '  ctx.command({ id: "perm-e.cmd", label: "E", run() {} });',
        "  try { ctx.panel({ tagName: 'DIV', parentNode: null }); out.panel = 'ok'; }",
        "  catch (e) { out.panel = { code: e.code, denial: e.denial, permission: e.permission, message: e.message }; }",
        "}",
    ].join("\n"), { permissions: ["ui.panel", "ui.command"] });

    const got = readProbe("ok");
    assert.deepEqual(got.permissions, ["ui.command"], "被策略拒掉的权限不应出现在授予集里");
    assert.equal(got.permits, false);
    assert.equal(got.panel.denial, "denied-by-policy", "策略拦截与'漏声明'必须能区分");
    assert.match(got.panel.message, /站点策略禁用/);
    assert.equal(Palette.get("perm-e.cmd")?.label, "E", "未被拒的能力照常可用");

    const status = host.list().find((s) => s.id === "perm-e");
    assert.deepEqual(status.denied, ["ui.panel"]);
    assert.equal(status.warnings.length, 1, "被策略拒掉要留下 warning");
    assert.match(status.warnings[0], /ui\.panel/);

    await host.dispose();
});

// ── 6. claims 与实现不一致 ────────────────────────────────────────────────

test("claims 与实现不一致：默认只 warning（不拦插件），strictClaims 下激活失败", async () => {
    const body = [
        "export async function activate(ctx) {",
        '  ctx.command({ id: "perm-f.sneaky", label: "Sneaky", run() {} });',
        "}",
    ].join("\n");

    const lenient = new PluginHost(fakeApp(), {});
    await activate(lenient, "perm-f", body, { permissions: ["ui.command"], claims: { commands: ["perm-f.other"] } });
    const st = lenient.list().find((s) => s.id === "perm-f");
    assert.equal(st.state, "ready", "默认不因 claims 不一致而拦下插件");
    assert.equal(st.warnings.length, 1, "但要留下可查的 warning");
    assert.match(st.warnings[0], /perm-f\.sneaky/);
    await lenient.dispose();

    const strict = new PluginHost(fakeApp(), {}, undefined, { strictClaims: true });
    await assert.rejects(
        () => activate(strict, "perm-g", body, { permissions: ["ui.command"], claims: { commands: ["perm-g.other"] } }),
        /未在 manifest 的 claims 里声明/,
        "strictClaims 下应直接失败",
    );
    await strict.dispose();
});

// ── 7. ui.menu 独立于 element.register ────────────────────────────────────

test("ui.menu 独立：带菜单要它，menu:false 不需要（同一个 register 两种结论）", async () => {
    const app = fakeApp();
    const host = new PluginHost(app, {});
    await activate(host, "perm-h", [
        "export async function activate(ctx) {",
        "  const out = (globalThis.__permProbe ??= {}).ok ??= {};",
        '  try { ctx.element.register({ className: "PermHElm", ctor: class {}, dumpType: 193 }); out.menu = "ok"; }',
        "  catch (e) { out.menu = { code: e.code, permission: e.permission, message: e.message }; }",
        '  try { ctx.element.register({ className: "PermHQuietElm", ctor: class {}, dumpType: 194, menu: false }); out.quiet = "ok"; }',
        "  catch (e) { out.quiet = { code: e.code, permission: e.permission, message: e.message }; }",
        "}",
    ].join("\n"), { permissions: ["element.register"] });

    const got = readProbe("ok");
    assert.equal(got.menu.code, "ext/eperm", "默认 menu:true 需要 ui.menu");
    assert.equal(got.menu.permission, "ui.menu");
    assert.match(got.menu.message, /menu: true/, "报错要提示可以改成 menu:false");
    assert.equal(got.quiet, "ok", "menu:false 不该被 ui.menu 拦住");
    await host.dispose();
    assert.equal(ElementFactory.hasClass("PermHQuietElm"), false, "卸载后仍要撤销");
});

// ── 8. 策略随 manifest 重载变化 ──────────────────────────────────────────

test("manifest policy 重新 load 时从基准策略重算（不会把上一轮的 deny 永久留在内存里）", async () => {
    const origFetch = globalThis.fetch;
    let payload = { plugins: [], policy: { denyPermissions: ["ui.command"] } };
    globalThis.fetch = async () => ({ ok: true, json: async () => payload });
    const host = new PluginHost(fakeApp(), {});
    const body = [
        "export async function activate(ctx) {",
        "  globalThis.__permProbe = { cmd: ctx.permits('ui.command') };",
        '  if (ctx.permits("ui.command")) ctx.command({ id: "perm-i.cmd", label: "I", run() {} });',
        "}",
    ].join("\n");
    try {
        await host.load("/plugins/plugins.manifest.json");
        await activate(host, "perm-i", body, { permissions: ["ui.command"] });
        assert.deepEqual(host.list().find((s) => s.id === "perm-i").denied, ["ui.command"], "首轮应被策略拒掉");

        // 运维把 deny 撤了，重新 load：新一轮必须真的放行
        payload = { plugins: [], policy: { denyPermissions: [] } };
        await host.deactivate("perm-i");
        await host.load("/plugins/plugins.manifest.json");
        await activate(host, "perm-i", body, { permissions: ["ui.command"] });
        const st = host.list().find((s) => s.id === "perm-i");
        assert.deepEqual(st.denied, [], "撤掉 deny 后不该还留着上一轮的记忆");
        assert.equal(readProbe("cmd"), true, "撤掉 deny 后 ctx.permits 应变 true");
    } finally {
        globalThis.fetch = origFetch;
        await host.dispose();
    }
});


// ── 9. 静态检查与运行期同口径 ──────────────────────────────────────────────

test("plugin lint 与运行期同口径：漏声明/claims 自相矛盾/policy 拼错都在构建期报出来", async () => {
    const mk = (name, pluginJson, indexJs) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ext-lint-${name}-`));
        fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(pluginJson, null, 2));
        fs.writeFileSync(path.join(dir, "index.js"), indexJs);
        return dir;
    };
    const run = async (dir) => {
        try {
            const { stdout } = await execFileAsync(process.execPath, [EXT_CLI, "plugin", "lint", dir]);
            return { code: 0, out: stdout };
        } catch (e) {
            return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
        }
    };

    // ① 用了 ctx.panel 但没声明 ui.panel → 构建期就红
    const leaky = mk("leaky", { id: "leaky", permissions: [] }, [
        "export async function activate(ctx) {",
        "  ctx.panel(document.createElement('div'));",
        "}",
    ].join("\n"));
    const r1 = await run(leaky);
    assert.equal(r1.code, 1, "漏声明必须让 lint 失败");
    assert.match(r1.out, /index\.js:\d+: 用到了 ctx\.panel/, "报错要带文件与行号");
    assert.match(r1.out, /没声明权限 "ui\.panel"/);

    // ② 注释里提到 ctx.panel 不算使用（掩码先抹掉注释与字符串）
    const commented = mk("commented", { id: "commented", permissions: [] }, [
        "// 这里只是说明：不要用 ctx.panel，也不要用 ctx.api",
        "export async function activate(ctx) {",
        "  ctx.log('ctx.hook 之类的字面量也不算');",
        "}",
    ].join("\n"));
    const r2 = await run(commented);
    assert.equal(r2.code, 0, `注释与字符串里的 ctx.* 不该触发误报：\n${r2.out}`);

    // ③ claims 有内容却没申请对应权限 → 自相矛盾
    const claimsOnly = mk("claims", { id: "claims", permissions: [], claims: { hooks: ["save"] } }, [
        "export async function activate() {}",
    ].join("\n"));
    const r3 = await run(claimsOnly);
    assert.equal(r3.code, 1);
    assert.match(r3.out, /claims\.hooks 有内容，但没申请权限 "document\.hook"/);

    // ④ 权限名拼错 → 报未知权限并列出可用项
    const typo = mk("typo", { id: "typo", permissions: ["ui.panel", "ui.pannel"] }, [
        "export async function activate(ctx) { ctx.panel(document.createElement('div')); }",
    ].join("\n"));
    const r4 = await run(typo);
    assert.equal(r4.code, 1);
    assert.match(r4.out, /未知权限 "ui\.pannel"/);
    assert.match(r4.out, /sim\.observe/, "报错要列出可用权限名");

    // ⑤ 声明齐全 → 通过
    const clean = mk("clean", { id: "clean", permissions: ["ui.panel"] }, [
        "export async function activate(ctx) { ctx.panel(document.createElement('div')); }",
    ].join("\n"));
    const r5 = await run(clean);
    assert.equal(r5.code, 0, `声明齐全应通过：\n${r5.out}`);

    // ⑥ 仓库自身的 manifest 必须干净（这也是 CI 跑的那条）
    const repo = await execFileAsync(process.execPath, [EXT_CLI, "plugin", "lint"], { cwd: repoRoot });
    assert.match(repo.stdout, /plugin lint ok/);
    for (const d of [leaky, commented, claimsOnly, typo, clean]) fs.rmSync(d, { recursive: true, force: true });
});
