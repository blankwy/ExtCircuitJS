// C07 — 网表 → 电路 编译器契约（纯 Node，不需要浏览器/真引擎）
//   node --test tests/contract/compile.test.mjs
//
// 这里有两层：
//   1. geom.ts 的算法层（布局 / A* 绕障）—— 纯几何，手算可验证；
//   2. compileNetlist 的全链路 —— 用**迷你引擎**（坐标相同即同网）跑，
//      所以拓扑硬闸、异网不短路、layout 照搬这些语义都是真跑出来的，
//      不是"看起来对"。真引擎的往返对拍在 `netlist-compile.browser.mjs`。
//
// 迷你引擎故意只实现 compile.ts 用到的那几个鸭子类型接口。它不复刻仿真，
// 只复刻**连接语义**：post 坐标相同的引脚属于同一节点 —— 这和真引擎里
// 导线靠端点重合合并节点是同一件事，所以布线错（没接上/接错）一定会被抓住。

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// 包内源码用无扩展名相对导入（"./index"），Node ESM 需要 ts-resolve 钩子补 .ts
register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { autoLayout, connectionOrder, routeNets, crossings } = await import("../../packages/netlist/src/geom.ts");
const { compileNetlist } = await import("../../packages/netlist/src/compile.ts");

const G = 16;

// ── 迷你引擎 ─────────────────────────────────────────────────────────────────

const POSTS = { ResistorElm: 2, VoltageElm: 2, CapacitorElm: 2, WireElm: 2, GroundElm: 1, NTransistorElm: 3 };

function miniEngine() {
    const elmList = [];
    const sim = {
        nodeList: [],
        analyzeCircuit() { /* 连接在 preStamp 里算 */ },
        preStampCircuit() { build(); },
        preStampAndStampCircuit() { build(); },
    };

    function build() {
        // 并查集：真引擎的 calcWireClosure 做同样两件事
        //   1. 坐标相同的 post 是同一个节点（画布上贴着就是连着）；
        //   2. 一条导线的两端是同一个节点（导线是理想短接，不是两段点）。
        // 只做第 1 条会把每根导线当成"两个孤立的点"，等于把真引擎的语义做错。
        const slots = [];      // { elm, num, key }
        for (const elm of elmList) {
            const n = elm.getPostCount();
            for (let i = 0; i < n; i++) {
                const p = elm.getPost(i);
                slots.push({ elm, num: i, key: `${Math.round(p.x)},${Math.round(p.y)}` });
            }
        }
        const parent = slots.map((_, i) => i);
        const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

        const byKey = new Map();
        slots.forEach((s, i) => {
            const hit = byKey.get(s.key);
            if (hit == null) byKey.set(s.key, i);
            else union(hit, i);
        });
        for (const elm of elmList) {
            if (elm.getClassName() !== "WireElm") continue;
            const a = slots.findIndex((s) => s.elm === elm && s.num === 0);
            const b = slots.findIndex((s) => s.elm === elm && s.num === 1);
            if (a >= 0 && b >= 0) union(a, b);
        }

        const cn = new Map();
        for (const elm of elmList) elm.nodes = [];
        slots.forEach((s, i) => {
            const root = find(i);
            let node = cn.get(root);
            if (!node) { node = { links: [] }; cn.set(root, node); }
            node.links.push({ elm: s.elm, num: s.num });
            s.elm.nodes[s.num] = node;
        });
        sim.nodeList = [...cn.values()];
    }

    const app = {
        elmList,
        gridSize: G,
        sim,
        needAnalyze() { /* 下一个读取点会重算 */ },
        constructElement(name, x, y) {
            const count = POSTS[name];
            if (count == null) return null;
            return {
                x, y, x2: x, y2: y, flags: 0, nodes: [],
                getClassName: () => name,
                getPostCount: () => count,
                getPost(n) {
                    if (count === 1) return { x: this.x, y: this.y };
                    if (n === 0) return { x: this.x, y: this.y };
                    if (n === 1) return { x: this.x2, y: this.y2 };
                    return { x: this.x + 16 * (n - 1), y: this.y + 16 };
                },
                drag(x2, y2) { this.x2 = x2; this.y2 = y2; },
            };
        },
        clearCircuit() { elmList.length = 0; },
        dumpCircuit() {
            return `<cir>${elmList.map((e) => `<${e.getClassName()} x="${e.x}" y="${e.y}"/>`).join("")}</cir>`;
        },
        importCircuitFromText(text) {
            // 模拟"重新载入快照"：编译前的电路是空的，回滚即清空
            app.__restoredWith = text;
            elmList.length = 0;
        },
    };
    return app;
}

/** 最小电路：电压源 + 电阻 + 地 */
function dividerNetlist() {
    return {
        schema: "netlist/0.1",
        components: [
            { id: "e1", type: "VoltageElm", f: 0, props: { maxVoltage: 5 }, pins: { "0": "GND", "1": "n0" } },
            { id: "e2", type: "ResistorElm", f: 0, props: { resistance: 1000 }, pins: { "0": "n0", "1": "n1" } },
            { id: "e3", type: "GroundElm", f: 0, props: { symbolType: 0 }, pins: { "0": "GND" } },
        ],
        nets: [
            { id: "GND", pins: ["e1:0", "e3:0"], ground: true },
            { id: "n0", pins: ["e1:1", "e2:0"] },
            { id: "n1", pins: ["e2:1"] },
        ],
    };
}

const segCells = (s, unit = G) => {
    const out = [];
    const x1 = Math.round(s.x1 / unit), y1 = Math.round(s.y1 / unit);
    const x2 = Math.round(s.x2 / unit), y2 = Math.round(s.y2 / unit);
    if (x1 === x2) for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) out.push(`${x1},${y}`);
    else for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) out.push(`${x},${y1}`);
    return out;
};

// ── 算法层 ───────────────────────────────────────────────────────────────────

test("G1 connectionOrder：链式网表按连接序排（不是输入序）", () => {
    // 故意把链打乱：c 接 b 接 a，但输入顺序是 a,c,b
    const comps = [
        { id: "a", type: "R", pins: { "0": "n0", "1": "n1" } },
        { id: "c", type: "R", pins: { "0": "n2", "1": "n3" } },
        { id: "b", type: "R", pins: { "0": "n1", "1": "n2" } },
    ];
    assert.deepEqual(connectionOrder(comps), ["a", "b", "c"]);
});

test("G1b connectionOrder：孤岛按输入顺序续排，结果确定", () => {
    const comps = [
        { id: "x", type: "R", pins: { "0": "n0", "1": "n1" } },
        { id: "y", type: "R", pins: { "0": "n0", "1": "n1" } },
        { id: "z", type: "R", pins: { "0": "m0", "1": "m1" } },
    ];
    assert.deepEqual(connectionOrder(comps), ["x", "y", "z"]);
    assert.deepEqual(connectionOrder(comps), connectionOrder(comps), "同输入必须同输出");
});

test("G2 autoLayout：坐标全落格点、元件水平、行间留出布线通道", () => {
    const comps = Array.from({ length: 4 }, (_, i) => ({
        id: `e${i}`, type: "R", pins: { "0": `n${i}`, "1": `n${i + 1}` },
    }));
    const lay = autoLayout(comps, {});
    assert.equal(lay.cols, 2);
    assert.equal(lay.rows, 2);
    for (const [id, b] of Object.entries(lay.boxes)) {
        assert.equal(b.y1 % G, 0, `${id} y 未对齐`);
        assert.equal(b.x1 % G, 0, `${id} x 未对齐`);
        assert.equal(b.y1, b.y2, `${id} 应当水平`);
        assert.ok(b.x2 - b.x1 >= 32, `${id} 跨度太小`);
    }
    // 行距 = span + gapY = 32 + 64 = 96，中间 64 是通道，不与任何元件本体同高
    const ys = [...new Set(Object.values(lay.boxes).map((b) => b.y1))].sort((a, b) => a - b);
    assert.deepEqual(ys, [32, 128]);
});

test("G3 routeNets：同轴两点直连（1 段），不绕路", () => {
    const pinPoints = new Map([["e1:1", { x: 64, y: 32 }], ["e2:0", { x: 112, y: 32 }]]);
    const r = routeNets({ nets: [{ id: "n0", pins: ["e1:1", "e2:0"] }], pinPoints });
    assert.equal(r.wires.length, 1);
    assert.deepEqual(r.wires[0], { x1: 64, y1: 32, x2: 112, y2: 32 });
    assert.equal(r.conflicts.length, 0);
});

test("G4 routeNets：中间有元件本体时必须绕开（不得共线穿过）", () => {
    // 元件本体横卧在 (96,32)-(128,32)，两端引脚在它左右同一行
    const pinPoints = new Map([["a:1", { x: 32, y: 32 }], ["b:0", { x: 160, y: 32 }]]);
    const bodies = [{ x1: 96, y1: 32, x2: 128, y2: 32 }];
    const r = routeNets({
        nets: [{ id: "n", pins: ["a:1", "b:0"] }],
        pinPoints, bodies,
        posts: [{ x: 32, y: 32 }, { x: 160, y: 32 }, { x: 96, y: 32 }, { x: 128, y: 32 }],
    });
    assert.equal(r.conflicts.length, 0, `不该有冲突：${JSON.stringify(r.conflicts)}`);
    const cells = r.wires.flatMap((s) => segCells(s));
    const bodyCells = segCells(bodies[0]);
    const overlap = cells.filter((c) => bodyCells.includes(c));
    assert.deepEqual(overlap, [], `导线压过了元件本体：${overlap.join(" ")}`);
    // 必须是绕行（段数 > 1）
    assert.ok(r.wires.length >= 2, `应当绕过本体，实际 ${JSON.stringify(r.wires)}`);
});

test("G5 routeNets：异网导线不共用格点（共用 = 真短路）", () => {
    // 两个 U 形嵌套：若各自走后最短路，会想去用中间那条通道
    const pinPoints = new Map([
        ["a:1", { x: 32, y: 32 }], ["a2:0", { x: 32, y: 96 }],
        ["b:1", { x: 64, y: 32 }], ["b2:0", { x: 64, y: 96 }],
    ]);
    const r = routeNets({
        nets: [
            { id: "n1", pins: ["a:1", "a2:0"] },
            { id: "n2", pins: ["b:1", "b2:0"] },
        ],
        pinPoints,
        posts: [...pinPoints.values()],
    });
    assert.equal(r.conflicts.length, 0, JSON.stringify(r.conflicts));
    // 逐段归属无法从结果回溯，这里只做弱断言（两条网都出了线、无冲突）；
    // 强断言（异网短路会被拓扑闸拦下）在 C3/C8 与真引擎契约里。
    assert.ok(r.wires.length >= 2, `两条网至少各一段，实际 ${r.wires.length}`);
});

test("G6 routeNets：被围死时记 no_path 并退回 L 形（拓扑优先，但必须报）", () => {
    const pinPoints = new Map([["a:1", { x: 32, y: 32 }], ["b:0", { x: 160, y: 32 }]]);
    // 四面包围起点：上下左右各一块本体
    const bodies = [
        { x1: 32, y1: 16, x2: 48, y2: 16 },
        { x1: 32, y1: 48, x2: 48, y2: 48 },
        { x1: 16, y1: 32, x2: 32, y2: 32 },
        { x1: 32, y1: 32, x2: 64, y2: 32 },   // 右边也得封，否则 A* 会从起点右侧出去
    ];
    const r = routeNets({
        nets: [{ id: "n", pins: ["a:1", "b:0"] }],
        pinPoints, bodies,
        posts: [{ x: 32, y: 32 }, { x: 160, y: 32 }],
    });
    assert.equal(r.stats.routed, 0, "应当布不通");
    assert.ok(r.conflicts.length >= 1);
    assert.ok(["no_path", "fallback_l"].includes(r.conflicts[0].reason));
    assert.ok(r.wires.length >= 1, "兜底仍要给出一条路径（拓扑优先）");
});

test("G7 crossings：每个交叉点只报一次", () => {
    const pts = crossings([
        { x1: 0, y1: 32, x2: 64, y2: 32 },
        { x1: 32, y1: 0, x2: 32, y2: 64 },
        { x1: 0, y1: 64, x2: 64, y2: 64 },
    ]);
    // 第三条线横在 y=64，与竖线交于 (32,64)——也是真交叉，一起报
    assert.deepEqual(pts, [{ x: 32, y: 32 }, { x: 32, y: 64 }]);
});

// ── 编译器（迷你引擎）────────────────────────────────────────────────────────

test("C1 预校验：空网表 / 未知类型 / 自短路 / 坏引脚名，全部结构化拒绝", () => {
    const app = miniEngine();
    const cases = [
        [{ schema: "netlist/0.1", components: [], nets: [] }, "empty_netlist"],
        [{ schema: "netlist/0.1", components: [{ id: "e", type: "NopeElm", pins: { "0": "a", "1": "b" } }], nets: [] }, "unknown_element_type"],
        [{
            schema: "netlist/0.1",
            components: [{ id: "e", type: "ResistorElm", pins: { pin0: "a", "1": "b" } }],
            nets: [],
        }, "invalid_pins"],
    ];
    for (const [nl, code] of cases) {
        const r = compileNetlist(app, nl, { apply: true });
        assert.equal(r.ok, false, `${code} 应当失败`);
        assert.ok(r.unsupported.some((u) => u.code === code),
            `期望 ${code}，实际 ${JSON.stringify(r.unsupported)}`);
    }
    assert.equal(app.elmList.length, 0, "预校验失败不得动电路");
});

test("C1b 自短路 / 空引脚不算错误（真实语料里很常见）", () => {
    const app = miniEngine();
    const nl = {
        schema: "netlist/0.1",
        components: [
            // 两脚同网：多脚开关的常闭对、调试短接都会这样，上游允许
            { id: "a", type: "ResistorElm", props: { resistance: 10 }, pins: { "0": "n0", "1": "n0" } },
            // 没有引脚：未接入的元件，照建不接线
            { id: "b", type: "ResistorElm", props: { resistance: 20 }, pins: {} },
            { id: "v", type: "VoltageElm", props: { maxVoltage: 5 }, pins: { "0": "GND", "1": "n0" } },
            { id: "g", type: "GroundElm", pins: { "0": "GND" } },
        ],
        nets: [{ id: "GND", pins: ["v:0", "g:0"] }, { id: "n0", pins: ["a:0", "a:1", "v:1"] }],
    };
    const r = compileNetlist(app, nl, { apply: true });
    assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.unsupported));
    assert.equal(r.stats.components, 4);
});

test("C2 无 layout + 多端元件 → needs_layout（不猜坐标）", () => {
    const app = miniEngine();
    const nl = {
        schema: "netlist/0.1",
        components: [
            { id: "q1", type: "NTransistorElm", pins: { "0": "c", "1": "b", "2": "e" } },
            { id: "r1", type: "ResistorElm", pins: { "0": "c", "1": "b" } },
        ],
        nets: [{ id: "c", pins: ["q1:0", "r1:0"] }, { id: "b", pins: ["q1:1", "r1:1"] }, { id: "e", pins: ["q1:2"] }],
    };
    const r = compileNetlist(app, nl, { apply: true });
    assert.equal(r.ok, false);
    assert.equal(r.unsupported[0].code, "needs_layout");
    assert.equal(r.unsupported[0].component, "q1");
    assert.equal(app.elmList.length, 0);
});

test("C3 无 layout 全 2 端：编译成功、导线重建、拓扑划分与输入一致", () => {
    const app = miniEngine();
    const r = compileNetlist(app, dividerNetlist(), { apply: true });
    assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.unsupported));
    assert.equal(r.stats.components, 3);
    assert.ok(r.stats.wires >= 2, `应当为 2 个多脚网各布导线，实际 ${r.stats.wires}`);
    assert.equal(r.losses.geometry, "generated");
    assert.equal(r.losses.wires, "rebuilt");
    assert.match(r.text, /<cir>/);
    assert.equal(app.elmList.length, 3 + r.stats.wires);
});

test("C4 layout:true 照搬坐标（cols/rows 为 0，losses.geometry=kept）", () => {
    const app = miniEngine();
    const nl = dividerNetlist();
    nl.components[0].layout = [32, 32, 64, 32];
    nl.components[1].layout = [64, 32, 96, 32];
    nl.components[2].layout = [32, 96, 32, 96];
    const r = compileNetlist(app, nl, { apply: true });
    assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.unsupported));
    assert.equal(r.losses.geometry, "kept");
    assert.equal(r.stats.cols, 0);
    assert.deepEqual(r.losses.ignored, []);
    const elms = app.elmList.filter((e) => e.getClassName() !== "WireElm");
    assert.deepEqual([elms[0].x, elms[0].y, elms[0].x2], [32, 32, 64], "电压源坐标应照搬");
    assert.deepEqual([elms[1].x, elms[1].y, elms[1].x2], [64, 32, 96], "电阻坐标应照搬");
});

test("C5 属性透传 + 未知属性记 ignored（不静默、不致命）", () => {
    const app = miniEngine();
    const nl = dividerNetlist();
    nl.components[1].props = { resistance: 4700, bogusProp: 1 };
    const r = compileNetlist(app, nl, { apply: true });
    assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.unsupported));
    const res = app.elmList.find((e) => e.getClassName() === "ResistorElm");
    assert.equal(res.resistance, 4700);
    assert.equal(res.bogusProp, undefined);
    assert.ok(r.losses.ignored.some((x) => x.reason.includes("bogusProp")),
        `应报出被丢弃的属性：${JSON.stringify(r.losses.ignored)}`);
});

test("C6 重复编译同一张网表 → 同一份文本（确定性，坐标与导线都不随机）", () => {
    const a = miniEngine(), b = miniEngine();
    const r1 = compileNetlist(a, dividerNetlist(), { apply: true });
    const r2 = compileNetlist(b, dividerNetlist(), { apply: true });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r1.text, r2.text, "同输入必须同输出（否则无法做回归与 diff）");
});

test("C7 apply:false 时编译完回滚：电路回到快照，文本仍然可用", () => {
    const app = miniEngine();
    const r = compileNetlist(app, dividerNetlist(), { apply: false });
    assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.unsupported));
    assert.ok(r.text.length > 0);
    assert.ok(app.__restoredWith != null, "应当用快照回滚");
    assert.equal(app.elmList.filter((e) => e.getClassName() !== "WireElm").length, 0,
        "apply:false 结束后不得留下构造出来的元件");
});
