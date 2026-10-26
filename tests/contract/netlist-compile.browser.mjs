// C07 — 网表 → 电路 的真引擎往返契约
//   node tests/contract/netlist-compile.browser.mjs [--base http://127.0.0.1:5174]
//
// 为什么必须有这一层：`compile.test.mjs` 用迷你引擎跑通了编译事务，但迷你引擎的
// constructElement / getPost / 节点合并都是假的 —— 它证明不了"真引擎里导线端点真的
// 会和引脚合并成同一节点"。这里的判据只有一条，而且是最硬的那条：
//
//     exportNetlist(layout:true) → compileNetlist(apply:true) → exportNetlist(layout:true)
//     两次导出的**引脚分组划分**必须完全相同（元件顺序、类型、网数也一致）
//
// 这就是"往返同构"：网表是拓扑，坐标/导线是编译器补的，补完之后拓扑不能变。
// 断言不看 net 名字（重编号是允许的），只看「哪些脚属于同一个网」这个划分。
//
// 另外三条：
//   · apply:false 必须不改变当前电路（dumpCircuit 前后逐字相同）；
//   · 无 layout 的 2 端电路走自动布局，拓扑同样必须一致；
//   · 无 layout 的多端电路必须结构化拒绝（needs_layout），不许瞎摆。

import fs from "node:fs";
import path from "node:path";

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? (process.argv.includes("--base")
    ? process.argv[process.argv.indexOf("--base") + 1] : "http://127.0.0.1:5174");

function fail(msg) {
    console.error("FAIL:", msg);
    process.exit(1);
}

if (!fs.existsSync(PW_CORE)) fail(`playwright-core not found: ${PW_CORE}`);
if (!fs.existsSync(CHROME)) fail(`chrome not found: ${CHROME}`);

const repoRoot = path.resolve(import.meta.dirname, "../..");
const corpusDir = path.join(repoRoot, "core/ts/public/circuits");

/** 固定语料（不随机取：结果要能逐次对比） */
const NAMES = [
    { name: "lrc.txt" },
    { name: "rectify.txt" },
    { name: "diodevar.txt" },
    { name: "nmosinverter.txt" },
    { name: "opamp.txt" },
    // 负例：含子电路实例，网表不带子电路定义 → 必须结构化拒绝，不许造出 1 脚的假元件
    { name: "td4-add2.txt", reject: "subcircuit_not_supported" },
];
const corpus = NAMES.map((item) => ({
    ...item,
    text: fs.readFileSync(path.join(corpusDir, item.name), "utf8"),
}));

const { chromium } = await import("file:///" + PW_CORE.replace(/\\/g, "/"));
const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on("dialog", (d) => d.dismiss().catch(() => {}));
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

const rows = [];
try {
    await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
    await page.waitForTimeout(1200);

    const res = await page.evaluate(async (items) => {
        const ext = window.ExtCircuitJS;
        const api = ext.api;
        const out = { rows: [], errors: [] };

        // 载入只同步 elmList，nodeList 要等 preStamp —— 网表投影依赖 nodeList
        const analyzeNow = () => {
            ext.app.needAnalyze();
            ext.app.sim.analyzeCircuit();
            ext.app.analyzeFlag = false;
            if (typeof ext.app.sim.preStampAndStampCircuit === "function") ext.app.sim.preStampAndStampCircuit();
            else ext.app.sim.preStampCircuit(false);
        };

        /** 引脚划分：忽略 net 名字，只看"哪些脚属于同一个网" */
        const partition = (nl) => {
            const self = nl.components.slice();
            const groups = new Map();
            self.forEach((c, i) => {
                for (const [pin, net] of Object.entries(c.pins ?? {})) {
                    const list = groups.get(net) ?? [];
                    list.push(`${i}:${pin}`);
                    groups.set(net, list);
                }
            });
            return [...groups.values()].map((g) => g.sort().join("|")).sort().join(";");
        };
        const shapes = (nl) => nl.components.map((c) => c.type).join(",");

        /** 忽略导线后的引脚划分：自动布局路径要和原图比，但导线是重建的、数量不同 */
        const isWire = (c) => /WireElm$/.test(c.type);
        const partitionNoWires = (nl) => {
            const comps = nl.components.filter((c) => !isWire(c));
            const groups = new Map();
            comps.forEach((c, i) => {
                for (const [pin, net] of Object.entries(c.pins ?? {})) {
                    const list = groups.get(net) ?? [];
                    list.push(`${i}:${pin}`);
                    groups.set(net, list);
                }
            });
            return [...groups.values()].map((g) => g.sort().join("|")).sort().join(";");
        };

        /** 去掉导线元件，得到一个"只能自动布局"的网表（网表里 net 的成员信息仍然完整） */
        const stripWires = (nl) => {
            const keep = nl.components.filter((c) => !isWire(c));
            const idMap = new Map(keep.map((c, i) => [c.id, `k${i}`]));
            return {
                schema: nl.schema,
                components: keep.map((c) => ({ ...c, id: idMap.get(c.id) })),
                nets: nl.nets.map((n) => ({
                    ...n,
                    pins: (n.pins ?? [])
                        .filter((p) => idMap.has(String(p).split(":")[0]))
                        .map((p) => {
                            const [id, num] = String(p).split(":");
                            return `${idMap.get(id)}:${num}`;
                        }),
                })),
            };
        };

        for (const item of items) {
            const row = { name: item.name };
            try {
                api.loadCircuitText(item.text, false);
                analyzeNow();
                const before = api.dumpNetlist({ layout: true });
                row.components = before.components.length;
                row.nets = before.nets.length;

                // ── 1) 带 layout：往返同构 ────────────────────────────────
                const t0 = performance.now();
                const r = api.compileNetlist(before, { apply: true });
                row.ms = Math.round(performance.now() - t0);
                row.ok = !!r.ok;
                if (!r.ok) {
                    row.reason = r.reason;
                    row.unsupported = r.unsupported;
                    out.rows.push(row);
                    continue;
                }
                row.wires = r.stats.wires;
                row.conflicts = r.losses.conflicts.length;
                row.geometry = r.losses.geometry;

                const after = api.dumpNetlist({ layout: true });
                row.partitionSame = partition(before) === partition(after);
                row.shapeSame = shapes(before) === shapes(after);
                row.compSame = before.components.length === after.components.length;
                row.netsSame = before.nets.length === after.nets.length;
                if (!row.partitionSame) {
                    row.want = partition(before).slice(0, 200);
                    row.got = partition(after).slice(0, 200);
                }

                // ── 2) apply:false 不得改动当前电路 ──────────────────────
                const snap = api.dumpCircuitXml();
                const r2 = api.compileNetlist(before, { apply: false });
                row.dryRunOk = !!r2.ok;
                row.dryRunClean = api.dumpCircuitXml() === snap;
                if (!row.dryRunClean) out.errors.push(`${item.name}: apply:false 改动了当前电路`);

                // ── 3) 去掉导线 → 只能自动布局 + A* 布线，拓扑仍须一致 ──────
                const noWires = stripWires(before);
                const r3 = api.compileNetlist(noWires, { apply: true });
                row.autoOk = !!r3.ok;
                if (r3.ok) {
                    const afterAuto = api.dumpNetlist({ layout: true });
                    row.autoGeometry = r3.losses.geometry;
                    row.autoWires = r3.stats.wires;
                    row.autoConflicts = r3.losses.conflicts.length;
                    row.autoPartitionSame = partitionNoWires(noWires) === partitionNoWires(afterAuto);
                    if (!row.autoPartitionSame) {
                        row.autoWant = partitionNoWires(noWires).slice(0, 240);
                        row.autoGot = partitionNoWires(afterAuto).slice(0, 240);
                    }
                } else {
                    row.autoCode = r3.unsupported?.[0]?.code ?? r3.reason;
                }
            } catch (e) {
                row.ok = false;
                row.reason = String(e?.message ?? e);
                out.errors.push(`${item.name}: ${row.reason}`);
            }
            out.rows.push(row);
        }

        // ── 合成用例：无 layout、无导线的环，专压自动布局 + A* ──────────────
        // 语料里去掉导线后大多只剩 1 个功能脚（连接全靠导线），压不到布线器；
        // 这个环每个网都有 2~3 个功能脚，必须真的算出 6 条路径。
        const synth = {
            schema: "netlist/0.1",
            components: [
                { id: "v", type: "VoltageElm", f: 0, props: { maxVoltage: 5 }, pins: { "0": "GND", "1": "n0" } },
                { id: "g", type: "GroundElm", f: 0, props: { symbolType: 0 }, pins: { "0": "GND" } },
                { id: "r1", type: "ResistorElm", f: 0, props: { resistance: 1000 }, pins: { "0": "n0", "1": "n1" } },
                { id: "r2", type: "ResistorElm", f: 0, props: { resistance: 1000 }, pins: { "0": "n1", "1": "n2" } },
                { id: "r3", type: "ResistorElm", f: 0, props: { resistance: 1000 }, pins: { "0": "n2", "1": "n3" } },
                { id: "r4", type: "ResistorElm", f: 0, props: { resistance: 1000 }, pins: { "0": "n3", "1": "n0" } },
            ],
            nets: [
                { id: "GND", pins: ["v:0", "g:0"], ground: true },
                { id: "n0", pins: ["v:1", "r1:0", "r4:1"] },
                { id: "n1", pins: ["r1:1", "r2:0"] },
                { id: "n2", pins: ["r2:1", "r3:0"] },
                { id: "n3", pins: ["r3:1", "r4:0"] },
            ],
        };
        {
            const row = { name: "synthetic-ring" };
            try {
                const r = api.compileNetlist(synth, { apply: true });
                row.ok = !!r.ok;
                row.components = synth.components.length;
                row.nets = synth.nets.length;
                if (r.ok) {
                    row.wires = r.stats.wires;
                    row.conflicts = r.losses.conflicts.length;
                    row.geometry = r.losses.geometry;
                    const after = api.dumpNetlist({ layout: true });
                    // 自动布局会重建导线，比较时必须连同"过滤导线"一起做
                    row.partitionSame = partitionNoWires(synth) === partitionNoWires(after);
                    row.shapeSame = synth.components.map((c) => c.type).join(",")
                        === after.components.filter((c) => !isWire(c)).map((c) => c.type).join(",");
                    // 尺寸检查：布局必须真的铺开，而不是把所有元件叠在一起
                    const xs = after.components.map((c) => c.layout?.[0] ?? 0);
                    const ys = after.components.map((c) => c.layout?.[1] ?? 0);
                    row.spread = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
                } else {
                    row.reason = r.reason;
                    row.unsupported = r.unsupported;
                }
            } catch (e) {
                row.ok = false;
                row.reason = String(e?.message ?? e);
            }
            out.rows.push(row);
        }

        return out;
    }, corpus);

    const problems = [];
    for (const row of res.rows) {
        const bad = [];
        const expect = corpus.find((c) => c.name === row.name)?.reject;
        if (expect) {
            const codes = (row.unsupported ?? []).map((u) => u.code);
            if (row.ok) bad.push(`本应被拒绝（${expect}），却编译成功`);
            else if (!codes.includes(expect)) bad.push(`拒绝码应为 ${expect}，实际 ${JSON.stringify(codes)}`);
            rows.push(row);
            if (bad.length) problems.push(`${row.name}: ${bad.join("；")}`);
            continue;
        }
        if (!row.ok) bad.push(`编译失败: ${row.reason} ${JSON.stringify(row.unsupported ?? "")}`);
        if (row.name === "synthetic-ring") {
            if (row.ok) {
                if (row.wires < 6) bad.push(`环有 6 条边，实际只布了 ${row.wires} 段`);
                if (row.conflicts > 0) bad.push(`布线留了 ${row.conflicts} 处冲突`);
                if (!row.partitionSame) bad.push("环的拓扑划分变了");
                if (!row.shapeSame) bad.push("环的元件序列变了");
                if (row.spread && (row.spread[0] < 64 || row.spread[1] < 64))
                    bad.push(`布局没铺开（跨度 ${row.spread}）`);
            }
            rows.push(row);
            if (bad.length) problems.push(`${row.name}: ${bad.join("；")}`);
            continue;
        }
        if (row.ok) {
            if (!row.partitionSame) bad.push("拓扑划分变了");
            if (!row.shapeSame) bad.push("元件序列变了");
            if (!row.compSame) bad.push(`元件数 ${row.components} != ${row.components}`);
            if (!row.netsSame) bad.push("网数变了");
            if (!row.dryRunOk) bad.push("apply:false 失败");
            if (!row.dryRunClean) bad.push("apply:false 改动了电路");
            if (!row.autoOk) bad.push(`无导线网表编译失败: ${row.autoCode}`);
            else if (!row.autoPartitionSame) bad.push(`自动布局后拓扑变了（want ${row.autoWant} got ${row.autoGot}）`);
        }
        if (bad.length) problems.push(`${row.name}: ${bad.join("；")}`);
        rows.push(row);
    }
    if (res.errors.length) problems.push(...res.errors);
    const errLogs = logs.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]"));
    if (errLogs.length) problems.push(`控制台错误: ${errLogs.slice(0, 3).join(" / ")}`);

    console.log("语料            元件  网  导线  耗时  冲突  照搬  自动布局");
    for (const r of rows) {
        console.log(
            `${String(r.name).padEnd(16)}${String(r.components ?? "-").padStart(4)}` +
            `${String(r.nets ?? "-").padStart(4)}${String(r.wires ?? "-").padStart(6)}` +
            `${String(r.ms ?? "-").padStart(6)}${String(r.conflicts ?? "-").padStart(6)}` +
            `${String(r.geometry ?? "-").padStart(8)}` +
            `${String(r.autoOk === true ? `${r.autoWires}w/${r.autoConflicts ?? "?"}c` : (r.autoCode ?? "-")).padStart(14)}`,
        );
    }

    if (problems.length) fail(problems.join("\n  "));
    console.log(`\nPASS  ${rows.length} 个语料往返同构`);
} finally {
    await browser.close();
}
