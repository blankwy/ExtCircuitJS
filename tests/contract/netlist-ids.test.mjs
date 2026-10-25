// C06 — 网表稳定 id 契约测试（WeakMap + 全新电路重置，见 packages/netlist/src/ids.ts）
//   node --test tests/contract/netlist-ids.test.mjs
// 四条断言：
//   1. set 编辑不改变任何元件 id
//   2. delete 后幸存者 id 不变，被删 id 不复用
//   3. 全新电路（实例全部更换，模拟 reload）id 序列从头分配
//   4. applyOps 双轨 target：稳定 id（eN）与旧 cN 下标都可用

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { exportNetlist, applyOps, resetIds } = await import("../../packages/netlist/src/index.ts");

const resistor = (v = 100) => ({
    getClassName: () => "ResistorElm",
    getXmlDumpType: () => "r",
    resistance: v,
    flags: 0,
});
const makeApp = (elms) => ({
    elmList: elms,
    sim: { nodeList: [] },
    needAnalyze() { this.analyzed = (this.analyzed ?? 0) + 1; },
});

test("set 编辑不改变 id（export → set → export，id 全部一致）", () => {
    resetIds();
    const app = makeApp([resistor(), resistor(220), resistor(1000)]);
    const ids1 = exportNetlist(app).components.map((c) => c.id);
    const r = applyOps(app, [{ op: "set", target: ids1[1], prop: "resistance", value: 330 }]);
    assert.equal(r.ok, true);
    assert.equal(r.applied, 1);
    assert.equal(app.elmList[1].resistance, 330);
    const ids2 = exportNetlist(app).components.map((c) => c.id);
    assert.deepEqual(ids2, ids1);
});

test("delete 后幸存者 id 不变、被删 id 不复用", () => {
    resetIds();
    const app = makeApp([resistor(), resistor(220), resistor(1000)]);
    const ids1 = exportNetlist(app).components.map((c) => c.id);
    const deleted = ids1[1];

    const r = applyOps(app, [{ op: "delete", target: deleted }]);
    assert.equal(r.ok, true);
    assert.equal(r.applied, 1);
    assert.equal(r.atoms[0].deleted, deleted);

    const ids2 = exportNetlist(app).components.map((c) => c.id);
    assert.deepEqual(ids2, [ids1[0], ids1[2]], "幸存者 id 不变");

    // 新元件加入：分配全新 id，不回收被删的 id
    app.elmList.push(resistor(47));
    const ids3 = exportNetlist(app).components.map((c) => c.id);
    assert.equal(ids3.length, 3);
    assert.deepEqual(ids3.slice(0, 2), [ids1[0], ids1[2]]);
    assert.notEqual(ids3[2], deleted, "被删 id 不复用");
});

test("全新电路重置：实例全部更换后 id 从 e1 重新分配（round-trip 兼容）", () => {
    resetIds();
    const appA = makeApp([resistor()]);
    assert.deepEqual(exportNetlist(appA).components.map((c) => c.id), ["e1"]);

    const appB = makeApp([resistor(), resistor()]); // 全部新实例，模拟 reload
    assert.deepEqual(
        exportNetlist(appB).components.map((c) => c.id),
        ["e1", "e2"],
        "无已知实例 → 重置，而不是接着 e2/e3",
    );
});

test("applyOps 双轨 target：稳定 id 与旧 cN 下标都能命中", () => {
    resetIds();
    const app = makeApp([resistor(100), resistor(220)]);
    const ids = exportNetlist(app).components.map((c) => c.id);
    assert.deepEqual(ids, ["e1", "e2"]);

    const r1 = applyOps(app, [{ op: "set", target: "e2", prop: "resistance", value: 4700 }]);
    assert.equal(r1.applied, 1);
    assert.equal(app.elmList[1].resistance, 4700);

    const r2 = applyOps(app, [{ op: "set", target: "c0", prop: "resistance", value: 680 }]);
    assert.equal(r2.applied, 1);
    assert.equal(app.elmList[0].resistance, 680, "cN 旧格式仍指向 elmList 下标");

    // 已被删除的稳定 id 不再命中（unknown target，不抛）
    applyOps(app, [{ op: "delete", target: "e1" }]);
    const r3 = applyOps(app, [{ op: "set", target: "e1", prop: "resistance", value: 1 }]);
    assert.equal(r3.ok, false);
    assert.match(r3.unsupported[0].reason, /unknown target/);
});
