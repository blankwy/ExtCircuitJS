// D01 — MCP 会话式 RPC 契约测试（packages/mcp/src/session.ts，InMemory 假实现）
//   node --test tests/contract/mcp-session.test.mjs
//
// spike C 结论（docs/development-plan.md:219）：MCP 必须是会话式 RPC，
// 不能做成无状态工具调用——重建电路会丢时间轴与 scope 状态。本测试锁定：
//   1. 调用顺序：load 之前 step/measure/export → no_circuit；
//      open→load→step→measure→close 的 happy path 每步返回形状。
//   2. 会话存活校验：close 后一切操作 → session_closed；未知 id → unknown_session。
//   3. 会话状态跨调用持久（同会话 step 时间轴累积、双会话互不干扰）——
//      这是「非无状态」的可观察证据。
//   4. 错误语义：结构化 { ok:false, error:{code,message} }，绝不向外抛异常。
//
// 假实现约定（session.ts）：假步长 5e-6（core/ts/CircuitLoader.ts:73 引擎默认
// 同值）、n1 电压 5·exp(-t/2ms) 确定性衰减、GND=0、单元件 c0。

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { InMemorySessionRpc, handleSessionRequest, FAKE_TIME_STEP } = await import(
    "../../packages/mcp/src/session.ts"
);

const TEXT = "netlist-fake-v1: R1 1000"; // 任意非空文本即可，假实现不解析

function approx(actual, expected, eps = 1e-12) {
    assert.ok(
        Math.abs(actual - expected) <= eps,
        `期望 ≈ ${expected}，实际 ${actual}（差 ${Math.abs(actual - expected)}）`,
    );
}

test("open：返回 sessionId，两次 open 得到不同会话，isAlive=true", async () => {
    const rpc = new InMemorySessionRpc();
    const r1 = await rpc.open();
    const r2 = await rpc.open();
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.ok(typeof r1.sessionId === "string" && r1.sessionId.length > 0, "sessionId 应为非空字符串");
    assert.notEqual(r1.sessionId, r2.sessionId, "两次 open 必须产生不同会话");
    assert.equal(rpc.isAlive(r1.sessionId), true);
    assert.equal(rpc.isAlive(r2.sessionId), true);
});

test("顺序：load 之前 step/measure/export → no_circuit（结构化错误，不抛异常）", async () => {
    const rpc = new InMemorySessionRpc();
    const { sessionId } = await rpc.open();
    for (const [name, p] of [
        ["step", () => rpc.step(sessionId, { steps: 1 })],
        ["measure", () => rpc.measure(sessionId)],
        ["export", () => rpc.export(sessionId, { format: "netlist" })],
    ]) {
        let result;
        await assert.doesNotReject(p, `${name} 在 load 之前不得抛异常`);
        result = await p();
        assert.equal(result.ok, false);
        assert.equal(result.error.code, "no_circuit", `${name} 应报 no_circuit，实际 ${result.error.code}`);
    }
});

test("happy path：open→load→measure(t=0)→step→measure 衰减→close，每步返回形状正确", async () => {
    const rpc = new InMemorySessionRpc();
    const { sessionId } = await rpc.open();

    const load = await rpc.load(sessionId, TEXT);
    assert.equal(load.ok, true);
    assert.deepEqual(load.unsupported, []);
    assert.equal(load.t, 0);
    assert.equal(load.timeStepCount, 0);

    // load 后未 step：t=0 初始工作点
    const m0 = await rpc.measure(sessionId);
    assert.equal(m0.ok, true);
    assert.equal(m0.t, 0);
    assert.equal(m0.quantity, "voltage");
    approx(m0.values.n1, 5);
    assert.equal(m0.values.GND, 0);

    // step 200 步 = 1ms：时间轴推进、计数累积
    const s1 = await rpc.step(sessionId, { steps: 200 });
    assert.equal(s1.ok, true);
    approx(s1.t, 200 * FAKE_TIME_STEP);
    assert.equal(s1.timeStepCount, 200);

    const m1 = await rpc.measure(sessionId);
    approx(m1.values.n1, 5 * Math.exp(-1e-3 / 2e-3)); // 确定性衰减可精确对拍
    assert.equal(m1.t, s1.t);

    const s2 = await rpc.step(sessionId, { steps: 200 });
    assert.equal(s2.timeStepCount, 400, "同会话内 timeStepCount 必须累积（无状态调用会清零）");
    approx(s2.t, 400 * FAKE_TIME_STEP);

    const close = await rpc.close(sessionId);
    assert.equal(close.ok, true);
    assert.equal(rpc.isAlive(sessionId), false);
});

test("step 的 seconds 换算：0.002s → 400 步（假步长 5e-6）", async () => {
    const rpc = new InMemorySessionRpc();
    const { sessionId } = await rpc.open();
    await rpc.load(sessionId, TEXT);
    const r = await rpc.step(sessionId, { seconds: 0.002 });
    assert.equal(r.ok, true);
    assert.equal(r.timeStepCount, Math.round(0.002 / FAKE_TIME_STEP));
    assert.equal(r.timeStepCount, 400);
    approx(r.t, 0.002);
});

test("step 参数校验：都给/都不给/负数/0/非整数/非数 → invalid_args，且不污染时间轴", async () => {
    const rpc = new InMemorySessionRpc();
    const { sessionId } = await rpc.open();
    await rpc.load(sessionId, TEXT);
    const before = await rpc.step(sessionId, { steps: 100 });

    const bad = [
        { steps: 10, seconds: 0.01 }, // 都给
        {}, // 都不给
        { steps: 0 },
        { steps: -5 },
        { steps: 1.5 },
        { steps: "10" },
        { seconds: 0 },
        { seconds: -1 },
        { seconds: Infinity },
    ];
    for (const args of bad) {
        const r = await rpc.step(sessionId, args);
        assert.equal(r.ok, false, `args=${JSON.stringify(args)} 应拒绝`);
        assert.equal(r.error.code, "invalid_args", `args=${JSON.stringify(args)} 应报 invalid_args`);
    }
    // 失败调用无副作用：时间轴停在 before 的位置
    const after = await rpc.step(sessionId, { steps: 1 });
    assert.equal(after.timeStepCount, before.timeStepCount + 1);
});

test("measure 参数校验：nets/components 二选一、quantity 与种类匹配", async () => {
    const rpc = new InMemorySessionRpc();
    const { sessionId } = await rpc.open();
    await rpc.load(sessionId, TEXT);

    const bad = [
        { nets: ["n1"], components: ["c0"] }, // 都给
        { nets: ["n1"], quantity: "current" }, // nets 只能读 voltage
        { components: ["c0"] }, // components 缺 quantity 不默认 voltage → invalid_args
        { components: ["c0"], quantity: "voltage" },
        { quantity: "impedance" }, // 非法 quantity
    ];
    for (const args of bad) {
        const r = await rpc.measure(sessionId, args);
        assert.equal(r.ok, false, `args=${JSON.stringify(args)} 应拒绝`);
        assert.equal(r.error.code, "invalid_args");
    }
    // 合法组合：components + current / power
    const cur = await rpc.measure(sessionId, { components: ["c0"], quantity: "current" });
    assert.equal(cur.ok, true);
    approx(cur.values.c0, 5e-3);
    const pow = await rpc.measure(sessionId, { components: ["c0"], quantity: "power" });
    approx(pow.values.c0, 5 * 5e-3);
    // 过滤里未知的名字只是不在 values 里（宽松读取），不报错
    const unknown = await rpc.measure(sessionId, { nets: ["bogus"] });
    assert.equal(unknown.ok, true);
    assert.deepEqual(unknown.values, {});
});

test("存活校验：close 后一切操作 → session_closed；重复 close → session_closed；未知 id → unknown_session", async () => {
    const rpc = new InMemorySessionRpc();
    const a = await rpc.open();
    const b = await rpc.open();

    const first = await rpc.close(a.sessionId);
    assert.equal(first.ok, true);

    // close 后：load/step/measure/export/close 全部 session_closed
    const attempts = [
        () => rpc.load(a.sessionId, TEXT),
        () => rpc.step(a.sessionId, { steps: 1 }),
        () => rpc.measure(a.sessionId),
        () => rpc.export(a.sessionId, { format: "netlist" }),
        () => rpc.close(a.sessionId), // 重复 close 也是 session_closed
    ];
    for (const p of attempts) {
        await assert.doesNotReject(p, "已关闭会话上的操作不得抛异常");
        const r = await p();
        assert.equal(r.ok, false);
        assert.equal(r.error.code, "session_closed", `应报 session_closed，实际 ${JSON.stringify(r.error)}`);
    }
    assert.equal(rpc.isAlive(a.sessionId), false);

    // 未知 id：从未 open 过的 id → unknown_session（与 session_closed 区分）
    for (const p of [
        () => rpc.load("nope", TEXT),
        () => rpc.step("nope", { steps: 1 }),
        () => rpc.measure("nope"),
        () => rpc.close("nope"),
    ]) {
        const r = await p();
        assert.equal(r.ok, false);
        assert.equal(r.error.code, "unknown_session");
    }
    assert.equal(rpc.isAlive("nope"), false);

    // 关掉 a 不影响 b（会话互相独立）
    assert.equal(rpc.isAlive(b.sessionId), true);
    const okStep = await rpc.step(b.sessionId, { steps: 1 });
    assert.equal(okStep.ok, false); // b 没 load，仍是 no_circuit 而非 session_closed
    assert.equal(okStep.error.code, "no_circuit");
});

test("load 内容失败：空文本 → ok:false + unsupported（loader 形状，非 error 通道）；会话仍可用", async () => {
    const rpc = new InMemorySessionRpc();
    const { sessionId } = await rpc.open();

    const bad1 = await rpc.load(sessionId, "");
    assert.equal(bad1.ok, false);
    assert.ok(Array.isArray(bad1.unsupported) && bad1.unsupported.length >= 1);
    // 内容失败走 unsupported，不走 error（error 形状留给会话/参数层）
    assert.equal(bad1.error, undefined);
    const bad2 = await rpc.load(sessionId, "   \n  ");
    assert.equal(bad2.ok, false);

    // 失败的 load 不算载入成功：step 仍 no_circuit（顺序语义不被内容失败破坏）
    const s = await rpc.step(sessionId, { steps: 1 });
    assert.equal(s.error.code, "no_circuit");

    // 会话还活着，重试成功 load 后一切正常
    assert.equal(rpc.isAlive(sessionId), true);
    const ok = await rpc.load(sessionId, TEXT);
    assert.equal(ok.ok, true);
    const m = await rpc.measure(sessionId);
    assert.equal(m.ok, true);
});

test("export：netlist 回显载入文本、bytes 与 UTF-8 长度一致；xml 非空；非法 format → invalid_args", async () => {
    const rpc = new InMemorySessionRpc();
    const { sessionId } = await rpc.open();
    await rpc.load(sessionId, TEXT);

    const net = await rpc.export(sessionId, { format: "netlist" });
    assert.equal(net.ok, true);
    assert.equal(net.format, "netlist");
    assert.equal(net.payload, TEXT);
    assert.equal(net.bytes, new TextEncoder().encode(TEXT).length);

    const xml = await rpc.export(sessionId, { format: "xml" });
    assert.equal(xml.ok, true);
    assert.ok(xml.payload.includes("<circuit/>"));
    assert.equal(xml.bytes, new TextEncoder().encode(xml.payload).length);

    for (const fmt of ["json", "", undefined, 42]) {
        const r = await rpc.export(sessionId, { format: fmt });
        assert.equal(r.ok, false, `format=${JSON.stringify(fmt)} 应拒绝`);
        assert.equal(r.error.code, "invalid_args");
    }
});

test("会话隔离：两个并行会话时间轴互不干扰（非全局无状态）", async () => {
    const rpc = new InMemorySessionRpc();
    const s1 = await rpc.open();
    const s2 = await rpc.open();
    await rpc.load(s1.sessionId, TEXT);
    await rpc.load(s2.sessionId, TEXT);

    await rpc.step(s1.sessionId, { steps: 100 });
    const m2 = await rpc.measure(s2.sessionId);
    assert.equal(m2.t, 0, "s2 的时间轴不得被 s1 的 step 影响");
    approx(m2.values.n1, 5);
    const m1 = await rpc.measure(s1.sessionId);
    approx(m1.values.n1, 5 * Math.exp(-(100 * FAKE_TIME_STEP) / 2e-3));
    assert.notEqual(m1.t, m2.t);

    // s1 close 后 s2 存活
    await rpc.close(s1.sessionId);
    assert.equal(rpc.isAlive(s2.sessionId), true);
    const r2 = await rpc.step(s2.sessionId, { steps: 1 });
    assert.equal(r2.ok, true);
});

test("handleSessionRequest 线协议分发：六方法 round-trip；unknown_method；缺 sessionId → unknown_session", async () => {
    const rpc = new InMemorySessionRpc();

    const opened = await handleSessionRequest(rpc, { method: "open" });
    assert.equal(opened.ok, true);
    const sid = opened.sessionId;

    assert.equal(
        (await handleSessionRequest(rpc, { method: "load", sessionId: sid, params: { text: TEXT } })).ok,
        true,
    );
    const stepped = await handleSessionRequest(rpc, { method: "step", sessionId: sid, params: { steps: 10 } });
    assert.equal(stepped.ok, true);
    assert.equal(stepped.timeStepCount, 10);
    const measured = await handleSessionRequest(rpc, { method: "measure", sessionId: sid });
    assert.equal(measured.ok, true);
    approx(measured.values.n1, 5 * Math.exp(-(10 * FAKE_TIME_STEP) / 2e-3));
    const exported = await handleSessionRequest(rpc, {
        method: "export",
        sessionId: sid,
        params: { format: "netlist" },
    });
    assert.equal(exported.payload, TEXT);
    const closed = await handleSessionRequest(rpc, { method: "close", sessionId: sid });
    assert.equal(closed.ok, true);

    const unknownMethod = await handleSessionRequest(rpc, { method: "nope", sessionId: sid });
    assert.equal(unknownMethod.error.code, "unknown_method");

    // 非 open 方法缺 sessionId → 会话层 unknown_session（报文里 id 落不回任何会话）
    const noId = await handleSessionRequest(rpc, { method: "step", params: { steps: 1 } });
    assert.equal(noId.ok, false);
    assert.equal(noId.error.code, "unknown_session");
});
