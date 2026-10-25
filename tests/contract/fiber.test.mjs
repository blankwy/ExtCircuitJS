// B01 — Fiber（dispose 栈）四条不变式契约测试
//   node --test tests/contract/fiber.test.mjs
// 四条断言（docs/task-board.md B01）：
//   1. dispose 逆序（LIFO）：后注册的清理先执行
//   2. 重复 dispose 幂等：清理动作只执行一次、状态停在 disposed、不抛
//   3. dispose 后再 add()：迟到的清理动作立即同步执行（不进栈）
//   4. 插件拿到的 AbortSignal 在 dispose 时 aborted=true
//
// 被测对象说明：
//   宿主 cover/ts/ExtPluginHost.ts:63 的 fiber 就是 new Fiber()（@ext/plugin-api）；
//   ctx.signal 直通 fiber.signal（ExtPluginHost.ts:158），ctx.effect/on/command/panel
//   全部汇入 fiber.add（ExtPluginHost.ts:160-186）——对 Fiber 类断言即对宿主 fiber 断言。
//   PluginHost 模块级裸导入 "@ext/plugin-api"，Node 侧 ts-resolve 只解析相对导入，
//   故这里直接加载同一份 Fiber 源文件 packages/plugin-api/src/index.ts。

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { Fiber } = await import("../../packages/plugin-api/src/index.ts");

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
