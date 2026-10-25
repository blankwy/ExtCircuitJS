// B01 — Fiber（dispose 栈）四条不变式契约测试 + B03 命令插槽（宿主生命周期类）
//   node --test tests/contract/fiber.test.mjs
// B01 四条断言（docs/task-board.md B01）：
//   1. dispose 逆序（LIFO）：后注册的清理先执行
//   2. 重复 dispose 幂等：清理动作只执行一次、状态停在 disposed、不抛
//   3. dispose 后再 add()：迟到的清理动作立即同步执行（不进栈）
//   4. 插件拿到的 AbortSignal 在 dispose 时 aborted=true
// B03 断言（docs/task-board.md B03，见文件尾「命令插槽 + 冲突拒绝」节）：
//   5. ctx.command 注册进调色板、返回的 disposer 可精确撤销、run 经调色板可触发
//   6. 第二插件抢同 id 被拒：activate 抛 "command conflict"（报错不静默），
//      先注册者命令原样保留（不被静默顶替）、被拒插件零残留（LIFO 回滚）
//   7. manifest claims 早拒仍有效；第一插件卸载后槽位释放，后到插件可激活
//   8. 插件卸载后命令数精确回基线、插件 deactivate 钩子被调用；抢占核心命令 id 也被拒
//
// 被测对象说明：
//   B01：宿主 cover/ts/ExtPluginHost.ts:71 的 fiber 就是 new Fiber()（@ext/plugin-api）；
//   ctx.signal 直通 fiber.signal，ctx.effect/on/command/panel 全部汇入 fiber.add
//   ——对 Fiber 类断言即对宿主 fiber 断言。
//   B03：宿主 cover/ts/ExtPluginHost.ts 首次进入 Node 侧测试（B02 时因裸导入不可加载）。
//   ts-resolve 只补相对导入，另需在 resolve 层补三个缺口（只拦解析、不改任何源码）：
//     ① 裸导入 "@ext/plugin-api" → packages/plugin-api/src/index.ts 真实源码
//        （vite 侧的等价物是 cover/vite.cover.config.ts:134 的 resolve.alias）；
//     ② 宿主的 "./CommandPaletteRegistry" → 忠实替身：core 源码含不可擦除语法
//        （ScoredCommand 的参数属性，core/ts/CommandPaletteRegistry.ts:62），Node
//        strip-only 模式无法加载且 core/ 只读；替身逐字镜像宿主用到的表面——
//        特别是 addCommand 对重复 id 静默忽略（core/ts/CommandPaletteRegistry.ts:84-89），
//        这正是宿主必须在其之上先做冲突拒绝的原因；宿主的冲突/所有权/撤销逻辑
//        全部仍走真实 ExtPluginHost.ts。替身经同一 data: URL 导入，与宿主共享同一注册表。
//     ③ activate() 的动态导入 "/plugins/<id>/<entry>?v=..."（cover/ts/ExtPluginHost.ts:75）
//        → 测试内置的虚拟插件源码（data: URL），让真实激活流程
//        （scanClaims → import → createContext → mod.activate → ready/回滚）全程可跑。
//   调色板真实集成（core 原实现 + 真实插件 URL）由构建与 boot.browser 浏览器契约覆盖。

import { register, registerHooks } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

// B03 加载基座：同步钩子先注册（in-thread，先于 ts-resolve 生效），再注册共享的
// ts-resolve（相对导入补全 + cover→core 镜像），最后动态导入被测模块。
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
    // 与 core/ts/CommandPaletteRegistry.ts:84-89 同语义：重复 id 静默忽略（不覆盖、不报错）
    static addCommand(cmd) {
        if (CommandPaletteRegistry.byId.has(cmd.id)) return;
        CommandPaletteRegistry.commands.push(cmd);
        CommandPaletteRegistry.byId.set(cmd.id, cmd);
    }
    static get(id) { return CommandPaletteRegistry.byId.get(id); }
}
`;
// 测试内置的虚拟插件表：key = "/plugins/<id>/<entry>"（不含 ?v= 查询）
const virtualPlugins = new Map();

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@ext/plugin-api") {
            return {
                shortCircuit: true,
                url: new URL("../../packages/plugin-api/src/index.ts", import.meta.url).href,
            };
        }
        if (specifier === "./CommandPaletteRegistry" && String(context.parentURL ?? "").includes("ExtPluginHost")) {
            return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(PALETTE_STANDIN_SRC) };
        }
        if (specifier.startsWith("/plugins/")) {
            const src = virtualPlugins.get(specifier.split("?")[0]);
            if (src !== undefined) {
                return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(src) };
            }
        }
        return nextResolve(specifier, context);
    },
});
register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { Fiber } = await import("../../packages/plugin-api/src/index.ts");
const { PluginHost } = await import("../../cover/ts/ExtPluginHost.ts");
// 与宿主用的是同一个替身实例（同一 data: URL → 同一 ESM 缓存条目）
const { CommandPaletteRegistry: Palette, PaletteCommand } = await import(
    "data:text/javascript," + encodeURIComponent(PALETTE_STANDIN_SRC)
);

test("dispose 逆序：后注册的清理先执行（LIFO），状态落到 disposed", () => {
    const fiber = new Fiber();
    const order = [];
    fiber.add(() => { order.push("d1"); });     // ctx.on 的 off（最先注册）
    fiber.effect(() => { order.push("d2"); });  // ctx.effect 汇入同一栈
    fiber.add(() => { order.push("d3"); });     // 最后注册

    fiber.dispose();

    assert.deepEqual(order, ["d3", "d2", "d1"], `应按 LIFO 执行，实际：${JSON.stringify(order)}`);
    assert.equal(fiber.state, "disposed");
});

test("重复 dispose 幂等：清理动作恰好执行一次，再次 dispose 不抛不重跑", () => {
    const fiber = new Fiber();
    let runs = 0;
    fiber.add(() => { runs++; });

    fiber.dispose();
    assert.doesNotThrow(() => {
        fiber.dispose();
        fiber.dispose();
    }, "dispose 重复调用不得抛异常");
    assert.equal(runs, 1, "清理动作只应在首次 dispose 执行一次");
    assert.equal(fiber.state, "disposed");
});

test("dispose 后再 add()：迟到的清理动作立即同步执行（不进栈、不外泄异常）", () => {
    const fiber = new Fiber();
    fiber.dispose();
    assert.equal(fiber.state, "disposed");

    let lateRan = false;
    const ret = fiber.add(() => { lateRan = true; });
    assert.equal(lateRan, true, "dispose 后 add 的清理动作必须同步立即执行");
    assert.equal(typeof ret, "function", "add 仍返回 disposer 本身");

    // 迟到的 disposer 抛错也不得外泄（与 dispose 内的容错同策略）
    assert.doesNotThrow(() => fiber.effect(() => { throw new Error("late boom"); }));
});

test("插件拿到的 AbortSignal：dispose 时 aborted=true，abort 监听恰好收到一次事件", () => {
    const fiber = new Fiber();
    const signal = fiber.signal; // 即 ctx.signal（ExtPluginHost.ts:158 直通 fiber.signal）
    assert.equal(signal.aborted, false, "dispose 前插件 signal 不应已 abort");

    let abortEvents = 0;
    signal.addEventListener("abort", () => { abortEvents++; });

    fiber.dispose();

    assert.equal(signal.aborted, true, "dispose 后插件 signal.aborted 应为 true");
    assert.equal(signal, fiber.signal, "宿主对外暴露的 signal 与 fiber.signal 是同一对象");
    assert.equal(abortEvents, 1, "插件挂的 abort 监听应恰好收到一次事件");
});

// ─────────────────────────────────────────────────────────────────────────
// B03 — 命令插槽 + 冲突拒绝（宿主生命周期类，docs/task-board.md B03）
// 被测对象：真实 cover/ts/ExtPluginHost.ts（加载缺口见文件头说明）。
// 每个用例使用独立插件 id，调色板基线取相对值，用例结束全部卸载，互不污染。

/** 插件源码工厂：activate 把 ctx 记到 rec.ctx[id] 供断言读取；body 里可用 rec 变量 */
function pluginSrc(id, body) {
    return [
        "export async function activate(ctx) {",
        '  const rec = globalThis.__b03;',
        `  rec.ctx["${id}"] = ctx;`,
        body,
        "}",
        `export async function deactivate() { globalThis.__b03.deactivated.push("${id}"); }`,
    ].join("\n");
}
function servePlugin(id, body) {
    virtualPlugins.set(`/plugins/${id}/plugin.mjs`, pluginSrc(id, body));
}
/** 命令路径不触碰 app/api（ctx.panel/ctx.on 才会），最小假对象即可 */
const fakeApp = {};
const rec = (globalThis.__b03 = { ctx: {}, ran: [], off: {}, deactivated: [] });
const activate = (host, id, extra = {}) =>
    host.activate({ id, entry: "plugin.mjs", version: "1.0.0", ...extra });

test("B03 命令插槽：ctx.command 注册进调色板、返回的 disposer 精确撤销、run 经调色板可触发", async () => {
    servePlugin("p3a", [
        'const off = ctx.command({ id: "p3a.alpha", label: "Alpha", category: "Ext", keywords: "alpha demo",',
        '  run() { rec.ran.push("p3a.alpha"); } });',
        'rec.off["p3a.alpha"] = off;',
        'ctx.command({ id: "p3a.beta", label: "Beta", run() { rec.ran.push("p3a.beta"); } });',
    ].join("\n"));
    const baseline = Palette.commands.length;
    const host = new PluginHost(fakeApp, {});

    await activate(host, "p3a");
    assert.equal(host.list()[0].state, "ready", "插件应激活到 ready");

    // 注册：调色板可见、可取、可运行（custom.execute → 插件 run）
    assert.equal(Palette.commands.length, baseline + 2, "两条命令都应注册进调色板");
    const alpha = Palette.get("p3a.alpha");
    assert.ok(alpha, "注册的命令应能按 id 取到");
    assert.equal(alpha.label, "Alpha");
    alpha.custom.execute();
    assert.deepEqual(rec.ran, ["p3a.alpha"], "调色板命令的 execute 应触发插件 run");

    // 撤销：ctx.command 返回的 disposer 精确移除自身，不波及同插件其他命令
    const off = rec.off["p3a.alpha"];
    assert.equal(typeof off, "function", "ctx.command 应返回 disposer");
    off();
    assert.equal(Palette.get("p3a.alpha"), undefined, "撤销后调色板不再有该命令");
    assert.equal(Palette.commands.length, baseline + 1, "撤销只移除 alpha，beta 应保留");
    assert.doesNotThrow(() => off(), "disposer 重复调用应幂等不抛");

    // 撤销后槽位释放：同 id 可重新注册
    assert.doesNotThrow(() => rec.ctx["p3a"].command({ id: "p3a.alpha", label: "Alpha2", run() {} }));
    assert.equal(Palette.commands.length, baseline + 2, "撤销后同 id 可重新注册（槽位已释放）");

    // 卸载：fiber dispose 汇入的全部 disposer 执行 → 命令数回基线
    await host.dispose();
    assert.equal(Palette.commands.length, baseline, "宿主卸载后命令数回基线");
    assert.equal(Palette.get("p3a.beta"), undefined, "卸载后 beta 也应被移除");
});

test("B03 冲突拒绝：第二插件抢同 id 被拒（抛错非静默），先注册者命令原样保留、被拒插件零残留", async () => {
    servePlugin("p4a", 'ctx.command({ id: "p4.shared", label: "Shared", run() { rec.ran.push("p4a-shared"); } });');
    servePlugin(
        "p4b",
        [
            'ctx.command({ id: "p4b.own", label: "Own", run() { rec.ran.push("p4b-own"); } });',
            'ctx.command({ id: "p4.shared", label: "Hijack", run() { rec.ran.push("p4b-hijack"); } });',
        ].join("\n"),
    );
    const baseline = Palette.commands.length;
    const host = new PluginHost(fakeApp, {});

    await activate(host, "p4a");
    assert.equal(Palette.commands.length, baseline + 1);

    // 第二插件抢同 id：必须在 activate 时抛错（报错不静默，错误指明 id 与在册所有者）
    await assert.rejects(
        () => activate(host, "p4b"),
        /command conflict: "p4\.shared" already registered by plugin "p4a"/,
        "第二插件抢同 id 必须被拒绝且错误信息可读",
    );
    assert.equal(host.list().some((s) => s.id === "p4b"), false, "被拒插件不留在 fiber 表");

    // 先注册者毫发无损：命令仍在、仍是第一插件的实现（未被静默顶替）
    const kept = Palette.get("p4.shared");
    assert.ok(kept, "先注册者的命令应原样保留");
    kept.custom.execute();
    assert.ok(rec.ran.includes("p4a-shared"), "保留的命令仍是第一插件的实现");
    assert.ok(!rec.ran.includes("p4b-hijack"), "冲突注册不得生效");

    // 被拒插件零残留：冲突前已注册的 p4b.own 随激活失败 LIFO 回滚
    assert.equal(Palette.get("p4b.own"), undefined, "被拒插件的已注册命令必须随回滚消失");
    assert.equal(Palette.commands.length, baseline + 1, "命令数停在第一插件的 1 条");

    await host.dispose();
    assert.equal(Palette.commands.length, baseline, "卸载后命令数回基线");
});

test("B03 claims 早拒：manifest 声明与在册所有者冲突 → activate 即拒；卸载后槽位释放、后到插件可激活", async () => {
    servePlugin("p5a", 'ctx.command({ id: "p5.cmd", label: "Five", run() { rec.ran.push("p5a"); } });');
    servePlugin("p5b", 'ctx.command({ id: "p5.cmd", label: "Five-B", run() { rec.ran.push("p5b"); } });');
    const baseline = Palette.commands.length;
    const host = new PluginHost(fakeApp, {});

    await activate(host, "p5a");
    await assert.rejects(
        () => activate(host, "p5b", { claims: { commands: ["p5.cmd"] } }),
        /command conflict: "p5\.cmd" already claimed by plugin "p5a"/,
        "manifest claims 撞上实际注册的所有者 → scanClaims 早拒",
    );

    // p5a 卸载 → 所有权随 disposer 释放 → 同 claims 的插件现在可激活并注册
    await host.dispose();
    await activate(host, "p5b", { claims: { commands: ["p5.cmd"] } });
    assert.equal(host.list().find((s) => s.id === "p5b")?.state, "ready", "卸载后同 claims 插件可激活");
    assert.ok(Palette.get("p5.cmd"), "后到插件可注册该 id");

    await host.dispose();
    assert.equal(Palette.commands.length, baseline, "全部卸载后命令数回基线");
});

test("B03 卸载回基线：多插件交错注册/卸载命令数精确回落；抢占核心命令 id 也被拒、核心命令不受波及", async () => {
    servePlugin("p6a", [
        'ctx.command({ id: "p6a.one", label: "One", run() { rec.ran.push("p6a.one"); } });',
        'ctx.command({ id: "p6a.two", label: "Two", run() { rec.ran.push("p6a.two"); } });',
    ].join("\n"));
    servePlugin("p6b", 'ctx.command({ id: "p6b.solo", label: "Solo", run() { rec.ran.push("p6b.solo"); } });');
    servePlugin(
        "p6c",
        [
            'ctx.command({ id: "p6c.pre", label: "Pre", run() { rec.ran.push("p6c.pre"); } });',
            'ctx.command({ id: "core:fake", label: "Hijack Core", run() { rec.ran.push("p6c.core"); } });',
        ].join("\n"),
    );

    // 预置一条“核心”命令，验证插件注册/撤销不波及它（替身的 byId 与 core 同语义）
    Palette.addCommand(new PaletteCommand({ id: "core:fake", label: "Core", category: "Core", keywords: "" }));
    const baseline = Palette.commands.length;
    const host = new PluginHost(fakeApp, {});

    await activate(host, "p6a");
    await activate(host, "p6b");
    assert.equal(Palette.commands.length, baseline + 3, "两插件共 3 条命令在册");

    // 抢核心命令 id → 拒绝（保护核心命令不被抢占、不被插件的撤销误删）
    await assert.rejects(
        () => activate(host, "p6c"),
        /command conflict: "core:fake" already exists in the command palette/,
        "与核心调色板撞 id 必须被拒",
    );
    assert.equal(Palette.get("p6c.pre"), undefined, "被拒插件的先注册命令已随回滚消失");
    assert.ok(Palette.get("core:fake"), "核心命令保留");

    await host.deactivate("p6a");
    assert.equal(Palette.commands.length, baseline + 1, "卸载 p6a 后只剩 p6b 的 1 条");
    assert.ok(Palette.get("core:fake"), "核心命令不受插件卸载影响");
    await host.deactivate("p6b");
    assert.equal(Palette.commands.length, baseline, "全部卸载后命令数精确回基线");
    assert.ok(
        rec.deactivated.includes("p6a") && rec.deactivated.includes("p6b"),
        "卸载时插件自身的 deactivate 钩子应被调用",
    );
});
