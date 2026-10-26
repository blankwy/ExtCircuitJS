// C05 — 紧凑编码的**解码器**契约（纯 Node，不需要浏览器/引擎）
//   node --test tests/contract/netlist-compact.test.mjs
//
// 为什么需要一个解码器：紧凑格式是给 AI 读的有损投影，如果不能解回网表形状，
// "三档互相可转"（docs/development-plan.md §schema）就只是一句口号，而且没有任何
// 低成本方式发现编码端悄悄改了语义。
//
// 有损格式不可能"解回原样"，所以正确性用**幂等律**钉住：
//
//     encode(decode(encode(nl)))  ≡  encode(nl)
//
// 即解码不引入新的损失（见 packages/netlist/src/compact.ts 文件头）。语料级对拍
// （373 例真实电路）在 `node tools/ext.mjs netlist bench` 里跑，本文件管的是
// 边界语义：导线剔除、属性位置、引脚空洞、net 下标反推、非法输入。
//
// v0.1.7 起紧凑格式**自描述**：默认输出带 `t` 类型图例（类型名 + 该类型实际用到的
// 属性名前缀），所以无需外部 registry 就能读懂位置化的 props。图例同时是编码端的
// registry 快照 —— 解码优先按它还原，两端口径不一致时记 `losses.legendDrift`。
// 图例相关契约在文件末尾（第 10–14 组）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { encodeCompact, decodeCompact, compactTypes } from "../../packages/netlist/src/compact.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const REGISTRY = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages/netlist/src/registry.json"), "utf8"));
const TYPE_TABLE = compactTypes();

/** 类名 → 紧凑格式里的 typeIdx（与解码端同一张表的反查） */
const idx = (cls) => TYPE_TABLE.indexOf(cls);

function netlist(components, nets, unsupported = []) {
    return { schema: "netlist/0.1", components, nets, unsupported };
}

/** 一电平+一阻+一地的最小电路；props 全给，避免受"尾部省略"影响 */
function basic() {
    return netlist(
        [
            {
                id: "e1", type: "VoltageElm", f: 0,
                props: {
                    waveform: 1, frequency: 1000, maxVoltage: 5, bias: 0,
                    phaseShift: 0, dutyCycle: 0.5, riseTime: 0, internalResistance: 0.001,
                },
                pins: { "0": "GND", "1": "n0" },
            },
            { id: "e2", type: "ResistorElm", f: 0, props: { resistance: 1000 }, pins: { "0": "n0", "1": "n1" } },
            { id: "e3", type: "GroundElm", f: 0, props: { symbolType: 0 }, pins: { "0": "GND" } },
        ],
        [
            { id: "GND", pins: ["e1:0", "e3:0"], ground: true },
            { id: "n0", pins: ["e1:1", "e2:0"] },
            { id: "n1", pins: ["e2:1"] },
        ],
    );
}

/** 幂等律 + 返回解码结果 */
function roundtrip(nl) {
    const c1 = encodeCompact(nl);
    const decoded = decodeCompact(c1);
    const c2 = encodeCompact(decoded.netlist);
    assert.deepEqual(c2, c1, "encode(decode(encode(nl))) 必须与 encode(nl) 深度相等");
    return decoded;
}

test("基本往返：类型/引脚/属性/接地都解回来，且再编码逐字节相同", () => {
    const nl = basic();
    const { netlist: back, losses } = roundtrip(nl);

    assert.equal(back.schema, "netlist/0.1");
    assert.deepEqual(back.components.map((c) => c.type), ["VoltageElm", "ResistorElm", "GroundElm"]);
    assert.deepEqual(back.components.map((c) => c.id), ["e1", "e2", "e3"], "紧凑数组顺序 → e1..eN");
    assert.deepEqual(back.components[0].props, nl.components[0].props, "属性位置化必须可逆");
    assert.deepEqual(back.components[1].pins, { "0": "n0", "1": "n1" });

    assert.deepEqual(back.nets.map((n) => n.id), ["GND", "n0", "n1"], "net id 按 GND / n0.. 还原");
    assert.equal(back.nets[0].ground, true);
    assert.deepEqual(back.nets[1].pins, ["e1:1", "e2:0"], "net 的引脚表要按元件顺序重建");

    assert.deepEqual(losses, { geometry: true, wires: "unknown", unresolved: 0, orphanProps: 0, legendDrift: 0, unreferencedNets: 0 });
});

test("导线整行剔除：解码后元件少一个、id 有缺口（losses.wires 明确写 unknown）", () => {
    const nl = netlist(
        [
            { id: "e1", type: "ResistorElm", f: 0, props: { resistance: 100 }, pins: { "0": "n0", "1": "n1" } },
            { id: "e2", type: "WireElm", f: 0, props: {}, pins: { "0": "n1", "1": "n2" } },
            { id: "e3", type: "ResistorElm", f: 0, props: { resistance: 200 }, pins: { "0": "n2", "1": "GND" } },
        ],
        [
            { id: "GND", pins: ["e3:1"], ground: true },
            { id: "n0", pins: ["e1:0"] },
            { id: "n1", pins: ["e1:1", "e2:0"] },
            { id: "n2", pins: ["e2:1", "e3:0"] },
        ],
    );
    const { netlist: back, losses } = roundtrip(nl);

    assert.equal(back.components.length, 2, "导线不占行");
    assert.deepEqual(back.components.map((c) => c.id), ["e1", "e2"], "原 e3 解码后叫 e2 —— id 缺口无法还原");
    assert.equal(losses.wires, "unknown", "导线数量不可知，别假装能算出来");
    assert.equal(losses.unresolved, 0, "元件的类型都在，不算未解析");
});

test("属性位置：前导 null 补位、尾部省略、dump-only 属性不占位", () => {
    // CapacitorElm 的 xmlAttrs 是 c / iv / sr / vd(仅 dump, field=null)
    const nl = netlist(
        [
            // 只给 capacitance → 编码成 [1]（尾部省略）
            { id: "e1", type: "CapacitorElm", f: 0, props: { capacitance: 1e-6 }, pins: { "0": "n0" } },
            // 只给 seriesResistance → 编码成 [null, null, 0.5]（前导 null 占位）
            { id: "e2", type: "CapacitorElm", f: 0, props: { seriesResistance: 0.5 }, pins: { "0": "n0" } },
        ],
        [{ id: "n0", pins: ["e1:0", "e2:0"] }],
    );
    const compact = encodeCompact(nl);
    assert.deepEqual(compact.c[0][3], [1e-6], "尾部缺失省略");
    assert.deepEqual(compact.c[1][3], [null, null, 0.5], "前导缺失补 null；vd 不该出现在位置 3");

    const { netlist: back } = roundtrip(nl);
    assert.deepEqual(back.components[0].props, { capacitance: 1e-6 });
    assert.deepEqual(back.components[1].props, { seriesResistance: 0.5 }, "null 占位不能被当成属性值");
});

test("引脚空洞：中间 -1 保留、尾部 -1 被裁剪（这是 encode 的规范形，不是 bug）", () => {
    const nl = netlist(
        [
            { id: "e1", type: "ThreeWireElm", f: 0, props: { n: 0 }, pins: { "0": "n0", "2": "n1" } },
            { id: "e2", type: "ResistorElm", f: 0, props: { resistance: 1 }, pins: { "0": "n1" } },
        ],
        [
            { id: "n0", pins: ["e1:0"] },
            { id: "n1", pins: ["e1:2", "e2:0"] },
        ],
    );
    const compact = encodeCompact(nl);
    assert.deepEqual(compact.c[0][2], [0, -1, 1], "post 1 没连 → -1");
    assert.deepEqual(compact.c[1][2], [1], "post 1 不存在 → 尾部不写");

    const { netlist: back } = roundtrip(nl);
    assert.deepEqual(back.components[0].pins, { "0": "n0", "2": "n1" }, "中间空洞要跳过而不是错位");

    // 人工构造的尾部 -1（引擎导出的网表不会出现，因为 maxPost 取自实际存在的 key）
    // 再编码会把它裁掉 —— 解码的职责是"不引入新损失"，不是"保留非法形状"
    const pathological = decodeCompact({ v: 1, c: [[idx("ResistorElm"), 0, [0, -1], [1]]] });
    assert.deepEqual(pathological.netlist.components[0].pins, { "0": "n0" });
});

test("类型索引解析不出：占位 Unknown 并计数（再编码会如实回到 -1）", () => {
    const nl = netlist(
        [
            { id: "e1", type: "MadeUpElm", f: 3, props: { anything: 1 }, pins: { "0": "n0" } },
            { id: "e2", type: "ResistorElm", f: 0, props: { resistance: 2 }, pins: { "0": "n0" } },
        ],
        [{ id: "n0", pins: ["e1:0", "e2:0"] }],
        [{ component: "e1", type: "MadeUpElm", reason: "not in registry" }],
    );
    const compact = encodeCompact(nl);
    assert.equal(compact.c[0][0], -1, "registry 里没有的类型编成 -1");
    assert.deepEqual(compact.c[0][3], [], "没有属性表 → 不占位");

    const { netlist: back, losses } = roundtrip(nl);
    assert.equal(back.components[0].type, "Unknown");
    assert.equal(losses.unresolved, 1);
    assert.deepEqual(back.unsupported, nl.unsupported, "unsupported 原样透传（它是唯一说得出原因的字段）");

    // 越界索引同样是"解析不出"，不该抛错也不该错位
    const oob = decodeCompact({ v: 1, c: [[TYPE_TABLE.length + 5, 0, [], []]] });
    assert.equal(oob.netlist.components[0].type, "Unknown");
    assert.equal(oob.losses.unresolved, 1);
});

test("net 下标反推：ground 在末位 / 命名 net / 无人引用的 net", () => {
    // ground 在索引 3、命名在索引 1；n0 只有导线连着（导线被剔除后它成了空 net）
    const nl = netlist(
        [
            { id: "e1", type: "ResistorElm", f: 0, props: { resistance: 1 }, pins: { "0": "n1", "1": "n2" } },
            { id: "e2", type: "ResistorElm", f: 0, props: { resistance: 1 }, pins: { "0": "n2", "1": "GND" } },
            { id: "e3", type: "WireElm", f: 0, props: {}, pins: { "0": "n0", "1": "n2" } },
        ],
        [
            { id: "n0", pins: ["e3:0"] },
            { id: "n1", pins: ["e1:0"], name: "mid" },
            { id: "n2", pins: ["e1:1", "e2:0", "e3:1"] },
            { id: "GND", pins: ["e2:1"], ground: true },
        ],
    );
    const compact = encodeCompact(nl);
    assert.equal(compact.g, 3);

    const { netlist: back, losses } = roundtrip(nl);
    assert.deepEqual(back.nets.map((n) => n.id), ["n0", "n1", "n2", "GND"], "ground 在末位也要按 GND / n0.. 排");
    assert.equal(back.nets[3].ground, true);
    assert.equal(back.nets[1].name, "mid");
    assert.deepEqual(back.nets[2].pins, ["e1:1", "e2:0"], "只剩非导线元件的引脚");
    assert.equal(losses.unreferencedNets, 1, "n0 的唯一引脚在导线上 → 空 net，如实计数");

    // 上界之外的下标（命名表指向更远的 net）也要撑出占位，否则再编码会错位
    const gap = decodeCompact({ v: 1, c: [], n: { 4: "far" } });
    assert.equal(gap.netlist.nets.length, 5);
    assert.equal(gap.netlist.nets[4].name, "far");
    assert.equal(gap.losses.unreferencedNets, 5);
});

test("非法输入直接抛错：紧凑格式是机器产出的，坏了就该炸而不是返回半个电路", () => {
    const bad = [
        [null, /必须是对象/],
        [[], /必须是对象/],
        [{ v: 2, c: [] }, /不支持的版本/],
        [{ c: [] }, /不支持的版本/],
        [{ v: 1 }, /缺少组件数组/],
        [{ v: 1, c: {} }, /缺少组件数组/],
        [{ v: 1, c: [1] }, /c\[0\] 不是数组/],
        [{ v: 1, c: [[idx("ResistorElm"), 0, 7, []]] }, /pins.*不是数组/],
    ];
    for (const [input, re] of bad) {
        assert.throws(() => decodeCompact(input), re, `应拒绝：${JSON.stringify(input)}`);
    }
    // 合法的空电路不该被误杀
    const empty = decodeCompact({ v: 1, c: [] });
    assert.deepEqual(empty.netlist.components, []);
    assert.deepEqual(empty.netlist.nets, []);
    assert.equal(empty.losses.unreferencedNets, 0);
});

test("幂等性连跑两轮：decode 的产物再走一遍 encode→decode 不变", () => {
    const nl = basic();
    const once = decodeCompact(encodeCompact(nl));
    const twice = decodeCompact(encodeCompact(once.netlist));
    assert.deepEqual(twice.netlist, once.netlist, "解码结果是不动点");
    assert.deepEqual(twice.losses, once.losses);
});

test("属性位置越出属性表（registry 漂移）要计数，不能静默丢值", () => {
    // ResistorElm 只有 1 个属性位，硬塞 2 个值
    const drifted = decodeCompact({ v: 1, c: [[idx("ResistorElm"), 0, [], [1000, 999]]] });
    assert.deepEqual(drifted.netlist.components[0].props, { resistance: 1000 });
    assert.equal(drifted.losses.orphanProps, 1, "多出来的值必须报出来（编码端/解码端 registry 不一致的典型症状）");
});

// ── 10–14：类型图例（自描述）───────────────────────────────────────────────
// 起点问题：位置化的 props 单看 `[1,1000,5,0,0,0.5,0,0.001]` 无法解读——消费方必须先
// 知道第 3 个槽位是 frequency。喂整份 registry（255 个类型）比数据本身还大，所以格式自己带
// 一份"本电路用到的类型 + 属性名前缀"。

test("图例：默认输出带 t，只含用到的类型，字段名是 registry 顺序的已用前缀", () => {
    const nl = basic();
    const out = encodeCompact(nl);

    assert.ok(out.t != null, "默认必须带图例（自描述）");
    const used = new Set(nl.components.map((c) => idx(c.type)));
    assert.deepEqual(Object.keys(out.t).map(Number).sort((a, b) => a - b), [...used].sort((a, b) => a - b),
        "图例只能含本电路用到的类型，且按数字索引升序");

    // GroundElm 只带 symbolType 一个值 → 图例只报 1 个字段名（不抄整份属性表）
    const ground = out.t[idx("GroundElm")];
    assert.equal(ground[0], "GroundElm");
    assert.deepEqual(ground[1], ["symbolType"]);

    // VoltageElm 8 个值全给 → 图例报满 8 个名字，顺序与 registry 的 xmlAttrs 一致
    const volt = out.t[idx("VoltageElm")][1];
    const registryFields = REGISTRY.elements.VoltageElm.xmlAttrs
        .filter((a) => a.field && !["x", "y", "x2", "y2"].includes(a.field))
        .map((a) => a.field);
    assert.deepEqual(volt, registryFields, "图例的字段顺序必须与 props 槽位一一对应");
});

test("图例：只报已用前缀 —— 同类型元件里最长的那个决定深度", () => {
    // 两个电阻：一个只给 resistance（1 个值），一个多塞一个值占满 2 个槽
    const nl = netlist(
        [
            { id: "e1", type: "ResistorElm", f: 0, props: { resistance: 1 }, pins: { "0": "n0" } },
            { id: "e2", type: "ResistorElm", f: 0, props: { resistance: 2 }, pins: { "0": "n1" } },
        ],
        [{ id: "n0", pins: [] }, { id: "n1", pins: [] }],
    );
    const out = encodeCompact(nl);
    assert.deepEqual(out.t[idx("ResistorElm")][1], ["resistance"], "只用 1 个槽就只报 1 个名字");

    // 伪造"用满 2 个槽"的输入：属性表里没有第 2 个可写属性 → 值进 orphanProps，
    // 但图例深度按实际写出的槽位算（编码端不知道第 2 个槽叫什么是解码端的事）
    const fake = { v: 1, c: [[idx("ResistorElm"), 0, [], [1000, 7]]] };
    const back = decodeCompact(fake);
    assert.equal(back.losses.orphanProps, 1);
    assert.deepEqual(back.netlist.components[0].props, { resistance: 1000 });
});

test("图例：解码优先按图例还原字段名（属性顺序变了也解对），并记 legendDrift", () => {
    const nl = basic();
    const drifted = JSON.parse(JSON.stringify(encodeCompact(nl)));
    // 模拟"编码端 registry 与该类型现在的顺序不同"：交换前两个属性名
    const vKey = idx("VoltageElm");
    const fields = drifted.t[vKey][1];
    drifted.t[vKey][1] = [fields[1], fields[0], ...fields.slice(2)];

    const back = decodeCompact(drifted);
    const volt = back.netlist.components[0];
    assert.equal(volt.props.frequency, 1, "第 0 槽按图例应解成 frequency（图例才是编码端的意思）");
    assert.equal(volt.props.waveform, 1000, "第 1 槽按图例应解成 waveform");
    assert.equal(back.losses.legendDrift, 1, "两端 registry 不一致必须计数");
    // 干净的编码不报漂移
    assert.equal(decodeCompact(encodeCompact(nl)).losses.legendDrift, 0);
});

test("图例：本机 registry 不认识的类型也能解（历史数据不会因 registry 更新而废掉）", () => {
    const back = decodeCompact({ v: 1, t: { 999: ["FutureElm", ["alpha", "beta"]] }, c: [[999, 0, [0, 1], [3, "x"]]] });
    const c = back.netlist.components[0];
    assert.equal(c.type, "FutureElm", "图例里的类型名直接采用");
    assert.deepEqual(c.props, { alpha: 3, beta: "x" }, "字段名同样来自图例");
    assert.equal(back.losses.unresolved, 0, "图例能解析就不算未解析");
    assert.equal(back.losses.legendDrift, 0, "registry 里根本没有这个索引 → 无从比较，不算漂移");
});

test("图例：legend:false 是纯投影（更小、不带 t），两种形态解出同一份网表", () => {
    const nl = basic();
    const withLegend = encodeCompact(nl);
    const proj = encodeCompact(nl, { legend: false });
    assert.equal("t" in proj, false, "纯投影不得带图例");
    assert.ok(JSON.stringify(withLegend).length > JSON.stringify(proj).length, "图例必然更贵——这是它的成本");

    const a = decodeCompact(withLegend).netlist;
    const b = decodeCompact(proj).netlist;
    assert.deepEqual(a.components, b.components, "两种形态必须解出同一份元件");
    assert.deepEqual(a.nets, b.nets);
});

test("图例：形状不合法要抛（坏图例会让每个字段名都错位，静默忽略等于把数据解错）", () => {
    const bad = [
        { v: 1, t: [], c: [] },
        { v: 1, t: { x: ["A", []] }, c: [] },
        { v: 1, t: { "1": ["A"] }, c: [] },
        { v: 1, t: { "1": ["A", [1]] }, c: [] },
        { v: 1, t: { "-2": ["A", []] }, c: [] },
    ];
    for (const x of bad) {
        assert.throws(() => decodeCompact(x), /decodeCompact: t/, `应拒绝 ${JSON.stringify(x)}`);
    }
});
