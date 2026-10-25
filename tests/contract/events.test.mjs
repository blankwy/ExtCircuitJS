// B02 — 事件多路复用契约测试（3 订阅全收 + 抛错隔离）
//   node --test tests/contract/events.test.mjs
// 断言（docs/task-board.md B02 / zcode-goal_step.md Stage 3 步骤 2）：
//   1. 3 个订阅者同时挂 analyze：一次 emit 三者全收到，订阅表计数 = 3
//      （对抗 core 单槽钩子：JSInterface.callAnalyzeHook 只读 window.CircuitJS1.onanalyze
//       一个槽位，core/ts/JSInterface.ts:90-94，后写覆盖先写）
//   2. 其中一个回调抛错：异常不外泄，其余订阅者（含抛错者之后注册的）仍全收到；
//      总线不静默摘除抛错者、后续 emit 照常派发
//   3. analyze 类事件四路（analyze/update/timestep/svgren）互不串扰
//   4. wireAppEvents（cover/ts/ExtEvents.ts:55）桥接 jsInterface：单槽方法一次调用 →
//      3 个订阅全收 + core 原钩子仍被调用（叠加而非顶替）；unwire 后恢复直通、不再 emit
//   5. 退订与生命周期：off() 精确移除自身；按宿主 ctx.on 接线（ExtPluginHost.ts:161-165）
//      后 fiber.dispose() → 订阅计数回 0（B07「监听器计数归零」的单元级前提）
//
// 被测对象说明：
//   事件面 = cover/ts/ExtEvents.ts（无内部依赖，Node 直接加载）；
//   宿主接线语义 = cover/ts/ExtPluginHost.ts:161-165 的 ctx.on（api.on + fiber.add），
//   其中 api.on 是 events.on 的直通（cover/ts/ExtApi.ts:88-90），故用真实 Fiber
//   （packages/plugin-api/src/index.ts）+ 真实 ExtEvents 复现同一组合；
//   PluginHost 本体含裸导入 @ext/plugin-api / @ext/netlist（ts-resolve 不解析裸模块）
//   且其命令插槽依赖 B03 的 cover 层落点，不在 Node 侧加载。

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { ExtEvents, wireAppEvents } = await import("../../cover/ts/ExtEvents.ts");
const { Fiber } = await import("../../packages/plugin-api/src/index.ts");

test("3 个订阅者同时挂 analyze：一次 emit 三者全收，订阅计数=3（对抗单槽）", () => {
    const bus = new ExtEvents();
    const got = [[], [], []];
    const off1 = bus.on("analyze", (p) => got[0].push(p));
    bus.on("analyze", (p) => got[1].push(p));
    bus.on("analyze", (p) => got[2].push(p));
    assert.equal(typeof off1, "function", "on() 应返回退订函数");

    assert.equal(bus.count("analyze"), 3, "订阅表应同时容纳 3 个订阅者（单槽钩子只会剩最后写入的 1 个）");

    const payload = { reason: "analyze-circuit" };
    bus.emit("analyze", payload);

    for (let i = 0; i < 3; i++) {
        assert.equal(got[i].length, 1, `订阅者 ${i + 1} 应恰好收到 1 次`);
        assert.equal(got[i][0], payload, `订阅者 ${i + 1} 收到的 payload 应原样透传`);
    }
});

test("其中一个回调抛错：异常被隔离，其余订阅者（含后注册者）仍全收，总线不损", () => {
    const bus = new ExtEvents();
    const calls = [];
    const boom = new Error("plugin A callback exploded");
    const errMock = mock.method(console, "error", () => {});

    try {
        bus.on("analyze", () => { calls.push("a"); });
        bus.on("analyze", () => { calls.push("b"); throw boom; });
        bus.on("analyze", () => { calls.push("c"); });

        // emit 不得把插件异常外泄给引擎调用方（CirSim/SimulationManager 的调用点）
        assert.doesNotThrow(() => bus.emit("analyze", { n: 1 }));
        assert.deepEqual(calls, ["a", "b", "c"], "抛错不得中断同事件后续订阅者");
        assert.equal(bus.count("analyze"), 3, "抛错的订阅者不应被总线静默摘除");
        assert.ok(errMock.mock.calls.length >= 1, "隔离时应记录错误日志（console.error）");
        assert.ok(
            errMock.mock.calls.some((c) => String(c.arguments[0]).includes('event "analyze" handler failed')),
            "错误日志应指向 analyze 事件（ExtEvents.emit 的隔离日志）",
        );

        // 总线未被破坏：第二次 emit 照常三路全达
        calls.length = 0;
        bus.emit("analyze", { n: 2 });
        assert.deepEqual(calls, ["a", "b", "c"], "抛错后总线应继续正常派发");
    } finally {
        errMock.mock.restore();
    }
});

test("analyze 类事件四路互不串扰：各命名空间独立派发", () => {
    const bus = new ExtEvents();
    const seen = { analyze: 0, update: 0, timestep: 0, svgren: 0 };
    for (const name of ["analyze", "update", "timestep", "svgren"]) {
        bus.on(name, () => { seen[name]++; });
    }

    bus.emit("analyze");
    bus.emit("update");
    bus.emit("timestep");
    bus.emit("svgren", "<svg/>");

    assert.deepEqual(seen, { analyze: 1, update: 1, timestep: 1, svgren: 1 });
});

test("wireAppEvents：core 单槽钩子一次调用 → 3 插件订阅全收，原钩子不被顶替", () => {
    const bus = new ExtEvents();
    const coreCalls = [];
    const app = {
        jsInterface: {
            callAnalyzeHook(arg) { coreCalls.push(["analyze", arg]); return "orig-analyze"; },
            callUpdateHook(arg) { coreCalls.push(["update", arg]); },
            callTimeStepHook(arg) { coreCalls.push(["timestep", arg]); },
            callSVGRenderedHook(arg) { coreCalls.push(["svgren", arg]); },
        },
    };
    const unwire = wireAppEvents(app, bus);

    const got = [];
    for (let i = 0; i < 3; i++) bus.on("analyze", (p) => got.push([i, p]));
    bus.on("svgren", (p) => got.push(["svg", p]));

    const payload = { sim: "post-analyze" };
    const ret = app.jsInterface.callAnalyzeHook(payload);

    assert.equal(ret, "orig-analyze", "包装层应透传原钩子返回值");
    assert.deepEqual(coreCalls, [["analyze", payload]], "core 原钩子应仍被恰好调用一次");
    const pluginReceipts = got.filter((g) => typeof g[0] === "number");
    assert.equal(pluginReceipts.length, 3, "一次单槽调用应扇出到 3 个插件订阅者");
    for (const g of pluginReceipts) assert.equal(g[1], payload, "每个插件收到的 payload 应原样透传");

    // svg 通道：参数透传 + 不串扰 analyze 订阅者
    app.jsInterface.callSVGRenderedHook("<svg/>");
    assert.deepEqual(got[3], ["svg", "<svg/>"], "callSVGRenderedHook 应映射到 svgren 事件并透传参数");
    assert.equal(got.length, 4, "svg 通道调用不得串扰 analyze 订阅者");

    // unwire：恢复直通，core 钩子照常但总线不再收到事件
    unwire();
    got.length = 0; coreCalls.length = 0;
    app.jsInterface.callAnalyzeHook({ after: 1 });
    assert.deepEqual(coreCalls, [["analyze", { after: 1 }]], "unwire 后 core 钩子照常被调用");
    assert.equal(got.length, 0, "unwire 后总线不再收到事件");
    assert.equal(bus.count("analyze"), 3, "unwire 只拆事件桥，不清理插件订阅（由 fiber disposer 管理）");
});

test("wireAppEvents：app 无 jsInterface 时安全返回 noop", () => {
    const bus = new ExtEvents();
    const unwire = wireAppEvents({}, bus);
    assert.equal(typeof unwire, "function", "无 jsInterface 也应返回可调用的 unwire");
    assert.doesNotThrow(() => unwire(), "空 unwire 不得抛异常");
});

test("退订与宿主生命周期：off 精确移除；ctx.on 接线 + fiber.dispose → 订阅计数回 0", () => {
    // ① off() 只移除自己的订阅
    const bus = new ExtEvents();
    let h1 = 0, h2 = 0;
    const off1 = bus.on("analyze", () => { h1++; });
    bus.on("analyze", () => { h2++; });
    off1();
    assert.equal(bus.count("analyze"), 1, "off 后订阅计数应减到 1");
    bus.emit("analyze");
    assert.equal(h1, 0, "已退订者不再收到");
    assert.equal(h2, 1, "未退订者照常收到");

    // ② 宿主接线语义（ExtPluginHost.ts:161-165）：ctx.on = api.on + fiber.add(off)
    //    3 个插件同时挂 analyze，fiber.dispose 后订阅计数回基线 0
    const hostBus = new ExtEvents();
    const fiber = new Fiber();
    const ctxOn = (name, h) => {
        const off = hostBus.on(name, h); // api.on 直通 events.on（ExtApi.ts:88-90）
        fiber.add(off);
        return off;
    };
    let received = 0;
    for (let i = 0; i < 3; i++) ctxOn("analyze", () => { received++; });
    assert.equal(hostBus.count("analyze"), 3);

    fiber.dispose(); // deactivate 时宿主调用的正是 fiber.dispose（ExtPluginHost.ts:99）
    assert.equal(fiber.state, "disposed");
    assert.equal(hostBus.count("analyze"), 0, "三个插件卸载后订阅计数应回 0（不残留监听）");
    hostBus.emit("analyze");
    assert.equal(received, 0, "dispose 后不应有任何插件再收到事件");
});
