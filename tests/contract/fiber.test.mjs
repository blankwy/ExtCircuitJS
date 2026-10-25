// B01 — Fiber（dispose 栈）四条不变式契约测试 + B03 命令插槽 + B04 面板插槽（宿主生命周期类）
//   node --test tests/contract/fiber.test.mjs
// B01 四条断言（docs/task-board.md B01）：
//   1. dispose 逆序（LIFO）：后注册的清理先执行
//   2. 重复 dispose 幂等：清理动作只执行一次、状态停在 disposed、不抛
//   3. dispose 后再 add()：迟到的清理动作立即同步执行（不进栈）
//   4. 插件拿到的 AbortSignal 在 dispose 时 aborted=true
// B03 断言（docs/task-board.md B03，见「命令插槽 + 冲突拒绝」节）：
//   5. ctx.command 注册进调色板、返回的 disposer 可精确撤销、run 经调色板可触发
//   6. 第二插件抢同 id 被拒：activate 抛 "command conflict"（报错不静默），
//      先注册者命令原样保留（不被静默顶替）、被拒插件零残留（LIFO 回滚）
//   7. manifest claims 早拒仍有效；第一插件卸载后槽位释放，后到插件可激活
//   8. 插件卸载后命令数精确回基线、插件 deactivate 钩子被调用；抢占核心命令 id 也被拒
// B04 断言（docs/task-board.md B04，见文件尾「面板插槽 + DOM 卸载清理」节）：
//   9. ctx.panel 把元素挂进宿主 verticalPanel 容器（iFrame 之前），返回的 disposer
//      精确撤销且幂等；宿主卸载不得让已撤销元素复挂
//  10. 多插件交错挂面板：逐个卸载后子节点数精确回基线、无残留节点（真实 detach，
//      且一个插件的卸载不波及其他插件的面板）
//  11. activate 中途抛错：已挂面板随 LIFO 回滚 detach，零 DOM 残留
//  12. 插件自行摘除面板后宿主卸载不抛、无错误日志（core 的 parentNode 守卫语义）
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
//     ③ activate() 的动态导入 "/plugins/<id>/<entry>?rev=..."（cover/ts/ExtPluginHost.ts:75）
//        → 测试内置的虚拟插件源码（data: URL），让真实激活流程
//        （scanClaims → import → createContext → mod.activate → ready/回滚）全程可跑。
//   调色板真实集成（core 原实现 + 真实插件 URL）由构建与 boot.browser 浏览器契约覆盖。

import { register, registerHooks } from "node:module";
import test, { mock } from "node:test";
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
// 测试内置的虚拟插件表：key = "/plugins/<id>/<entry>"（不含 ?rev= 查询）
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

    // 迟到的 disposer 抛错也不得外泄（与 dispose 内的容错同策略，
    // packages/plugin-api/src/index.ts:57-64 的 catch 分支）：
    // 异常必须被 Fiber 捕获，只走 console.error 通道恰好一次，进程零未捕获异常
    const errMock = mock.method(console, "error", () => {});
    try {
        assert.doesNotThrow(() => fiber.effect(() => { throw new Error("late boom"); }));
        assert.equal(errMock.mock.calls.length, 1, "迟到 disposer 的异常应被 Fiber 捕获并记录恰好一次");
        assert.match(
            String(errMock.mock.calls[0].arguments[1]),
            /late boom/,
            "记录的是原始异常对象",
        );
    } finally {
        errMock.mock.restore();
    }
});

test("插件拿到的 AbortSignal：dispose 时 aborted=true，abort 监听恰好收到一次事件", () => {
    const fiber = new Fiber();
    const signal = fiber.signal; // 即 ctx.signal（ExtPluginHost.ts:172 直通 fiber.signal）
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
const rec = (globalThis.__b03 = {
    ctx: {}, ran: [], off: {}, deactivated: [],
    el: {},
    // B04 面板元素工厂：桩容器只读写 tagName/parentNode/marker，普通对象即可当 HTMLElement
    mkEl: (marker) => ({ tagName: "DIV", marker, parentNode: null }),
});
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

// ─────────────────────────────────────────────────────────────────────────
// B04 — 面板插槽 + DOM 卸载清理（宿主生命周期类，docs/task-board.md B04）
// 被测对象：真实 cover/ts/ExtPluginHost.ts 的 ctx.panel（ExtPluginHost.ts:209-214）：
//   挂载走 app.addWidgetToVerticalPanel，disposer 走 app.removeWidgetFromVerticalPanel
//   并汇入 fiber.add —— 卸载（deactivate / 激活失败回滚）时随 fiber.dispose 自动摘除。
// DOM 桩（手写最小桩，零第三方依赖）：逐字镜像被用到的 core 表面，不改任何 core 源码：
//   - verticalPanel 容器：core/ts/UIManager.ts:585-589 创建的 div#painel；
//     初始化完成后 iFrame 恒在面板内（core/ts/UIManager.ts:820），是可插入锚点。
//   - ui.addWidgetToVerticalPanel / removeWidgetFromVerticalPanel：逐字镜像
//     core/ts/UIManager.ts:1879-1897 —— iFrame 存在时插到其前；卸载仅当
//     w.parentNode === verticalPanel 才摘除（disposer 幂等、插件自摘后宿主不抛的
//     语义依据）。setiFrameHeight 是纯高度计算，不在 DOM 计数契约内，桩省略。
//   - app 层：镜像 core/ts/CirSim.ts:614-616 的直通委托，宿主只调 app 层。

/** 构造最小 DOM 桩：返回 { app, panel, iFrame, childCount, indexOf, childAt } */
function makeStubPanelDom(baselineWidgets = 3) {
    const mkNode = (tag) => ({ tagName: String(tag).toUpperCase(), parentNode: null });

    // verticalPanel 容器节点（core/ts/UIManager.ts:585-589）
    const panel = mkNode("div");
    panel.id = "painel";
    const children = [];
    Object.assign(panel, {
        appendChild(w) { children.push(w); w.parentNode = panel; return w; },
        insertBefore(w, ref) {
            const i = children.indexOf(ref);
            if (i === -1) throw new Error("stub DOM: insertBefore ref is not a child");
            children.splice(i, 0, w);
            w.parentNode = panel;
            return w;
        },
        removeChild(w) {
            const i = children.indexOf(w);
            if (i === -1) throw new Error("stub DOM: removeChild target is not a child");
            children.splice(i, 1);
            w.parentNode = null;
            return w;
        },
    });

    // 基线子节点：若干核心控件 + iFrame 收尾（UIManager 初始化完成后的面板形态）
    for (let i = 0; i < baselineWidgets; i++) panel.appendChild(mkNode("div"));
    const iFrame = mkNode("iframe");
    panel.appendChild(iFrame);

    // core/ts/UIManager.ts:1879-1897（逐字镜像；setiFrameHeight 省略）
    const ui = {
        verticalPanel: panel,
        iFrame,
        addWidgetToVerticalPanel(w) {
            if (this.verticalPanel == null) return;
            if (this.iFrame != null) this.verticalPanel.insertBefore(w, this.iFrame);
            else this.verticalPanel.appendChild(w);
        },
        removeWidgetFromVerticalPanel(w) {
            if (this.verticalPanel == null) return;
            if (w.parentNode === this.verticalPanel) this.verticalPanel.removeChild(w);
        },
    };
    // core/ts/CirSim.ts:614-616（app 层直通委托）
    const app = {
        ui,
        addWidgetToVerticalPanel(w) { this.ui.addWidgetToVerticalPanel(w); },
        removeWidgetFromVerticalPanel(w) { this.ui.removeWidgetFromVerticalPanel(w); },
    };

    return {
        app,
        panel,
        iFrame,
        get childCount() { return children.length; },
        indexOf: (w) => children.indexOf(w),
        childAt: (i) => children[i],
    };
}

test("B04 面板插槽：ctx.panel 把元素挂进宿主 verticalPanel（iFrame 之前），disposer 精确撤销且幂等", async () => {
    servePlugin("p7a", [
        'rec.el["p7a.panel"] = rec.mkEl("p7a-panel");',
        'rec.off["p7a.panel"] = ctx.panel(rec.el["p7a.panel"]);',
    ].join("\n"));
    const dom = makeStubPanelDom();
    const host = new PluginHost(dom.app, {});
    const baseline = dom.childCount;

    await activate(host, "p7a");
    assert.equal(host.list()[0].state, "ready", "插件应激活到 ready");

    // 挂载：元素真的进了 verticalPanel 容器，且插在 iFrame 之前（core 的 iFrame 分支）
    const el = rec.el["p7a.panel"];
    assert.equal(el.parentNode, dom.panel, "ctx.panel 应把元素挂到宿主 verticalPanel 容器");
    assert.equal(dom.childCount, baseline + 1, "挂载后子节点数 = 基线 + 1");
    assert.equal(dom.indexOf(el), dom.childCount - 2, "插件面板应插在 iFrame 之前");
    assert.equal(dom.childAt(dom.childCount - 1), dom.iFrame, "iFrame 仍是面板最后一个子节点");

    // ctx.panel 返回的 disposer：精确撤销自身
    const off = rec.off["p7a.panel"];
    assert.equal(typeof off, "function", "ctx.panel 应返回 disposer");
    off();
    assert.equal(el.parentNode, null, "撤销后元素应从容器真实 detach");
    assert.equal(dom.childCount, baseline, "撤销后子节点数回基线");
    assert.doesNotThrow(() => off(), "disposer 重复调用应幂等不抛（core 的 parentNode 守卫）");
    assert.equal(dom.childCount, baseline, "重复撤销后子节点数仍为基线");

    // off() 已手动撤销，宿主卸载再跑同一 disposer 也不得复挂/抛错
    await host.dispose();
    assert.equal(dom.childCount, baseline, "宿主卸载后子节点数仍为基线");
    assert.equal(el.parentNode, null, "宿主卸载不得让已撤销元素复挂");
});

test("B04 DOM 卸载清理：多插件交错挂面板，逐个卸载后子节点数精确回基线、无残留节点", async () => {
    servePlugin("p8a", [
        'rec.el["p8a.1"] = rec.mkEl("p8a-1");',
        'rec.el["p8a.2"] = rec.mkEl("p8a-2");',
        'ctx.panel(rec.el["p8a.1"]); ctx.panel(rec.el["p8a.2"]);',
    ].join("\n"));
    servePlugin("p8b", [
        'rec.el["p8b.1"] = rec.mkEl("p8b-1");',
        'ctx.panel(rec.el["p8b.1"]);',
    ].join("\n"));
    const dom = makeStubPanelDom();
    const host = new PluginHost(dom.app, {});
    const baseline = dom.childCount;

    await activate(host, "p8a");
    await activate(host, "p8b");
    assert.equal(dom.childCount, baseline + 3, "两插件共 3 块面板挂载");
    assert.equal(dom.indexOf(rec.el["p8b.1"]), dom.childCount - 2, "后挂面板同样在 iFrame 之前");

    // 卸载是精确的：p8b 只摘除自己的 1 块，p8a 的 2 块原样保留
    await host.deactivate("p8b");
    assert.equal(dom.childCount, baseline + 2, "卸载 p8b 后只余 p8a 的 2 块面板");
    assert.equal(rec.el["p8b.1"].parentNode, null, "p8b 的面板节点已真实 detach");
    assert.equal(rec.el["p8a.1"].parentNode, dom.panel, "p8a 面板 1 不受其他插件卸载波及");
    assert.equal(rec.el["p8a.2"].parentNode, dom.panel, "p8a 面板 2 不受其他插件卸载波及");

    await host.deactivate("p8a");
    assert.equal(dom.childCount, baseline, "全部卸载后子节点数精确回基线");
    for (let i = 0; i < dom.childCount; i++) {
        assert.equal(dom.childAt(i).marker, undefined, `容器槽位 ${i} 无插件节点残留`);
    }
});

test("B04 激活失败回滚：activate 中途抛错，已挂面板随 LIFO 回滚 detach，零 DOM 残留", async () => {
    servePlugin("p9a", [
        'rec.el["p9a.1"] = rec.mkEl("p9a-1");',
        'ctx.panel(rec.el["p9a.1"]);',
        'throw new Error("boom after panel");',
    ].join("\n"));
    const dom = makeStubPanelDom();
    const host = new PluginHost(dom.app, {});
    const baseline = dom.childCount;

    await assert.rejects(
        () => activate(host, "p9a"),
        /boom after panel/,
        "activate 中途抛错应向外传播（宿主 rethrow）",
    );
    assert.equal(host.list().some((s) => s.id === "p9a"), false, "失败插件不留在 fiber 表");
    assert.equal(rec.el["p9a.1"].parentNode, null, "失败插件已挂的面板必须随回滚 detach");
    assert.equal(dom.childCount, baseline, "回滚后子节点数回基线（零 DOM 残留）");

    await host.dispose();
    assert.equal(dom.childCount, baseline, "宿主卸载后仍为基线");
});

test("B04 清理弹性：插件自行摘除面板后，宿主卸载不抛、无错误日志、容器计数不变", async () => {
    servePlugin("p10a", [
        'const el = rec.mkEl("p10a-1");',
        'ctx.panel(el);',
        'el.parentNode.removeChild(el); // 插件自行摘除（桩容器带 DOM 方法）',
    ].join("\n"));
    const dom = makeStubPanelDom();
    const host = new PluginHost(dom.app, {});
    const baseline = dom.childCount;

    await activate(host, "p10a");
    assert.equal(dom.childCount, baseline, "插件挂了又自摘，计数停在基线");

    const errMock = mock.method(console, "error", () => {});
    try {
        await assert.doesNotReject(() => host.deactivate("p10a"), "宿主卸载不得因面板已被摘而抛错");
        assert.equal(
            errMock.mock.calls.length, 0,
            "卸载路径应零错误日志（disposer 在 core 的 parentNode 守卫下不得失败）",
        );
    } finally {
        errMock.mock.restore();
    }
    assert.equal(dom.childCount, baseline, "卸载后子节点数仍为基线");
});
