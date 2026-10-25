// C03 — applyOps 错误语义契约测试（packages/netlist 写通道）
//   node --test tests/contract/ops.test.mjs
// 三种错误情况都必须返回 { ok:false, unsupported:[...] }，绝不向外抛异常：
//   1. unknown target（c99 越界）
//   2. unknown prop（registry xmlAttrs 里不存在的属性）
//   3. add 未实现（增量布局留待 v0.2）
// 另加一条正向对照证明假对象驱动是正确的。
//
// 用最小假对象驱动，不需要真引擎；通过共享 helper 加载 TS 源
// （helper 的 load 钩子把 registry.json 包成默认导出，绕过
//  Node ESM 的 import attribute 检查）。

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { applyOps } = await import("../../packages/netlist/src/index.ts");

/** 最小 ResistorElm 假元件：registry 里 xmlAttrs 是 attr "r" → field "resistance" */
function makeResistor() {
    return { getClassName: () => "ResistorElm", resistance: 100, flags: 0 };
}

/** 最小假 app：elmList + needAnalyze 计数 spy */
function makeApp(elms = [makeResistor()]) {
    const app = { elmList: elms, needAnalyzeCalls: 0 };
    app.needAnalyze = () => { app.needAnalyzeCalls++; };
    return app;
}

test("unknown target：set 指向不存在的 c99 → ok:false、applied:0、unsupported 含 unknown target、不抛异常", () => {
    const app = makeApp();
    let result;
    assert.doesNotThrow(() => {
        result = applyOps(app, [{ op: "set", target: "c99", prop: "resistance", value: 2200 }]);
    }, "applyOps 对 unknown target 不得向外抛异常");

    assert.equal(result.ok, false);
    assert.equal(result.applied, 0);
    assert.ok(Array.isArray(result.unsupported) && result.unsupported.length >= 1);
    assert.ok(
        String(result.unsupported[0].reason).includes("unknown target"),
        `reason 应含 "unknown target"，实际：${result.unsupported[0].reason}`,
    );
    // 错误不产生副作用：元件未被改
    assert.equal(app.elmList[0].resistance, 100);
    assert.equal(app.needAnalyzeCalls, 0);
});

test("unknown prop：set 指向 registry 没有的属性 → ok:false、unsupported 含 unknown prop", () => {
    const app = makeApp();
    const result = applyOps(app, [{ op: "set", target: "c0", prop: "nope", value: 1 }]);

    assert.equal(result.ok, false);
    assert.equal(result.applied, 0);
    assert.ok(
        result.unsupported.some((u) => String(u.reason).includes("unknown prop")),
        `unsupported 里应有 "unknown prop"，实际：${JSON.stringify(result.unsupported)}`,
    );
});

test("add 未实现：→ ok:false、unsupported 含 not implemented、没有元件被创建", () => {
    const app = makeApp();
    const result = applyOps(app, [{ op: "add", type: "ResistorElm", between: ["GND", "n1"] }]);

    assert.equal(result.ok, false);
    assert.equal(result.applied, 0);
    assert.ok(
        result.unsupported.some((u) => String(u.reason).includes("not implemented")),
        `unsupported 里应有 "not implemented"，实际：${JSON.stringify(result.unsupported)}`,
    );
    assert.equal(app.elmList.length, 1, "add 未实现时不得创建元件");
});

test("正向对照：合法 set 生效 —— value 字符串数字转 number、needAnalyze 恰好调 1 次", () => {
    const app = makeApp();
    const result = applyOps(app, [{ op: "set", target: "c0", prop: "resistance", value: "2200" }]);

    assert.equal(result.ok, true);
    assert.equal(result.applied, 1);
    assert.equal(app.elmList[0].resistance, 2200, "字符串数字应被转成 number");
    assert.equal(app.needAnalyzeCalls, 1, "成功写入后 needAnalyze 应被调 1 次");
});
