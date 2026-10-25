// C04 — add between nets 导线分裂增量放置契约测试（C04b 实现卡）
//   node --test tests/contract/place.test.mjs
//
// 断言（docs/zcode-goal_step.md Stage 4 步骤 3 + docs/handoffs/stage4-design.md §6）：
//   T1 主验收（lrc.txt，between ["GND","n1"] 加 1k 电阻）：
//     1. 新增**功能元件**（非导线）恰 +1（任务卡"components+1"的读法：导出 components
//        数组把 WireElm 也计入，而"必要时补正交导线/分裂导线"本身就会加导线——
//        7→8 与"跳线 ≥1"在原始计数下不可兼得，故按非导线计数断言 +1，
//        并对总数做精确账目核对 = before + 1(新元件) + splits(新半段) + wires(跳线)，
//        这比裸 +1 更严：证明除申报的放置物外没有任何元件被增删）；
//     2. nets 5 → 5（不变；静默开路/误并网的探测器）
//     3. sim 确定性步进 ≥10 步、t 前进、无 stopMessage（netlist-g2.browser.mjs 同款配方）
//     4. 无 console error / pageerror
//     5.（附加不变式）新元件两脚恰落 {n0(=GND 别名的引擎地网), n1}；
//        created/atoms 的稳定 id 与重导出一致；splits/wires 如实上报几何
//   T2 net id 双轨：between ["n0","n1"] 与 ["GND","n1"] 结果等价
//   T3 重复放置：同 between 连续 add 两次都 ok，nets 仍 5、功能元件 6→8
//   T4 写读闭环：add 返回的稳定 id 可被 set 消费（resistance 1000 → 2200）
//   T5 序列化往返：add 后 dumpCircuit 文本重载，components/nets 计数一致
//   T-cage 强制分裂：手工语料把两网 post 接入点全部封死（±32 格点压 post），
//        唯一可行路线必经导线内点分裂 → splits 恰 1、落点在导线内部（覆盖 split 机制）
//   T6 错误语义（Node 假 app，ops.test.mjs 同款基座）：unknown net / nets identical /
//        unknown element type / 非 2 端 / unknown prop / 缺 sim —— 全部结构化失败不抛异常、
//        无副作用（elmList 不变）
//
// 浏览器基准与 netlist-export.test.mjs / plugins-smoke.browser.test.mjs 同款：
// EXT_PW_CORE / EXT_CHROME / EXC_BASE（默认 http://127.0.0.1:5174）、dialog 自动 dismiss。
// 设计 §6 T7（校验失败回滚的注入式构造）按设计预留的跳过条款记录不做：
// 真引擎上构造"必然失败且可观测"的放置需要改 core 注入故障，超出本卡写作用域。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// ── Node 侧（T6）：ts-resolve 基座加载 TS 源（ops.test.mjs 同款） ──────────
import { register } from "node:module";
register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { applyOps } = await import("../../packages/netlist/src/index.ts");

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? "http://127.0.0.1:5174";

/** 与 boot.browser.mjs 同源的 lrc.txt 语料 */
const circuitText = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../core/ts/public/circuits/lrc.txt"),
    "utf8",
);

/**
 * 强制分裂语料（手工构造，几何论证见测试内注释）：
 *  - net A = 竖导线 (64,64)-(64,192) + 电阻 (64,192)-(64,320) 的 post0 网；
 *  - net B = 电阻 (288,128)-(288,240) 的 post0 (288,128) 单点网；
 *  - 8 个封堵电阻把 net A 两个 post tap（(64,64)、(64,192)）四向 ±32 的
 *    post2 候选全部压上既有 post（R1/R2 全灭），且 tapB 与两 post 不轴对齐（R0 灭）；
 *  - 导线内部格点 (64,80..176) 中 (64,96)/(64,160) 被封堵 post 占据，其余可分裂；
 *    其中 (64,128) 与 (288,128) 同行 → R0 直连（分数 0）必胜 → splits 恰 1 且落点 (64,128)。
 */
const cageText = [
    "$ 1 0.000005 10.20027730826997 50 5 43 5e-11",
    "w 64 64 64 192 0",
    "r 64 192 64 320 0 1000",   // RA：post0 并入 net A
    "r 32 64 32 192 0 1000",    // B1：封 (32,64)/(32,192)
    "r 96 192 96 320 0 1000",   // B2：封 (96,192)
    "r 96 64 224 64 0 1000",    // B3：封 (96,64)
    "r 64 224 160 224 0 1000",  // B4：封 (64,224)
    "r 64 32 160 32 0 1000",    // B5：封 (64,32)
    "r 64 96 160 96 0 1000",    // B6：封 (64,96)
    "r 64 160 160 160 0 1000",  // B7：封 (64,160)
    "r 288 128 288 240 0 1000", // VB：post0 (288,128) = net B 唯一接入点
].join("\n");

// ── T6：错误语义（Node 假 app，不需要真引擎） ───────────────────────────────

function fakeElm(cls, posts) {
    return {
        getClassName: () => cls,
        getPostCount: () => posts.length,
        getPost: (n) => posts[n] ?? null,
        delete() { /* CircuitElm.delete 只清 mouseElmRef/滑条，假件无副作用 */ },
        drag(x2, y2) { this.x2 = x2; this.y2 = y2; },
    };
}

function makeFakeApp({ sim } = {}) {
    const elm = fakeElm("ResistorElm", [{ x: 0, y: 0 }, { x: 32, y: 0 }]);
    const app = {
        elmList: [elm],
        needAnalyzeCalls: 0,
        needAnalyze() { this.needAnalyzeCalls++; },
        gridSize: 16,
        snapGrid: (v) => (v + 7) & ~15,
        constructElement(name) {
            if (name === "NopeElm") return null;
            if (name === "NTransistorElm") return fakeElm("NTransistorElm", [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 64, y: 0 }]);
            return fakeElm(name, [{ x: 0, y: 0 }, { x: 32, y: 0 }]);
        },
        sim,
    };
    return app;
}

/** 带 1 个网（n0）的最小假 sim：analyzeCircuit/preStamp 空转，nodeList 手工给 */
function makeFakeSim(elm) {
    return {
        nodeList: [{ links: [{ elm, num: 0 }] }],
        analyzeCircuit() { /* 假引擎：nodeList 已手工构造 */ },
        preStampCircuit() { return true; },
        preStampAndStampCircuit() { },
    };
}

const ADD = (type, between, props) => ({ op: "add", type, between, ...(props ? { props } : {}) });

test("T6 add 错误语义：全部结构化失败（ok:false、不抛异常、无副作用）", () => {
    // 1) unknown net
    {
        const app = makeFakeApp();
        app.sim = makeFakeSim(app.elmList[0]);
        const len = app.elmList.length;
        let r;
        assert.doesNotThrow(() => { r = applyOps(app, [ADD("ResistorElm", ["n99", "n0"])]); });
        assert.equal(r.ok, false);
        assert.equal(r.applied, 0);
        assert.ok(String(r.unsupported[0]?.reason).includes("unknown net"),
            `reason 应含 "unknown net"，实际：${JSON.stringify(r.unsupported)}`);
        assert.equal(app.elmList.length, len, "失败不得改动 elmList");
    }
    // 2) between 两 id 相同
    {
        const app = makeFakeApp();
        app.sim = makeFakeSim(app.elmList[0]);
        let r;
        assert.doesNotThrow(() => { r = applyOps(app, [ADD("ResistorElm", ["n0", "n0"])]); });
        assert.equal(r.ok, false);
        assert.ok(String(r.unsupported[0]?.reason).includes("nets identical"),
            `reason 应含 "nets identical"，实际：${JSON.stringify(r.unsupported)}`);
        assert.equal(app.elmList.length, 1);
    }
    // 3) unknown element type
    {
        const app = makeFakeApp({ sim: makeFakeSim(null) });
        let r;
        assert.doesNotThrow(() => { r = applyOps(app, [ADD("NopeElm", ["n0", "n1"])]); });
        assert.equal(r.ok, false);
        assert.ok(String(r.unsupported[0]?.reason).includes("unknown element type"),
            `reason 应含 "unknown element type"，实际：${JSON.stringify(r.unsupported)}`);
        assert.equal(app.elmList.length, 1);
    }
    // 4) 非 2 端元件（NTransistorElm 3 post）
    {
        const app = makeFakeApp({ sim: makeFakeSim(null) });
        let r;
        assert.doesNotThrow(() => { r = applyOps(app, [ADD("NTransistorElm", ["n0", "n1"])]); });
        assert.equal(r.ok, false);
        assert.ok(String(r.unsupported[0]?.reason).includes("only 2-post elements supported"),
            `reason 应含 "only 2-post elements supported"，实际：${JSON.stringify(r.unsupported)}`);
        assert.equal(app.elmList.length, 1);
    }
    // 5) 假 app 缺 sim → 结构化失败不抛异常
    {
        const app = makeFakeApp(); // 无 sim
        let r;
        assert.doesNotThrow(() => { r = applyOps(app, [ADD("ResistorElm", ["GND", "n1"])]); });
        assert.equal(r.ok, false);
        assert.ok(String(r.unsupported[0]?.reason).length > 0, "reason 应为非空字符串");
        assert.equal(app.elmList.length, 1, "缺 sim 时不得创建元件");
    }
    // 6) unknown prop（双网假引擎 + 坏 props：改动前预校验，无副作用）
    {
        const app = makeFakeApp();
        const e1 = fakeElm("ResistorElm", [{ x: 0, y: 0 }, { x: 32, y: 0 }]);
        const e2 = fakeElm("CapacitorElm", [{ x: 64, y: 0 }, { x: 96, y: 0 }]);
        app.elmList = [e1, e2];
        app.sim = {
            nodeList: [
                { links: [{ elm: e1, num: 0 }] },
                { links: [{ elm: e1, num: 1 }] },
                { links: [{ elm: e2, num: 0 }] },
                { links: [{ elm: e2, num: 1 }] },
            ],
            analyzeCircuit() { },
            preStampCircuit() { return true; },
            preStampAndStampCircuit() { },
        };
        let r;
        assert.doesNotThrow(() => { r = applyOps(app, [ADD("ResistorElm", ["n0", "n1"], { nope: 1 })]); });
        assert.equal(r.ok, false);
        assert.ok(String(r.unsupported[0]?.reason).includes("unknown prop"),
            `reason 应含 "unknown prop"，实际：${JSON.stringify(r.unsupported)}`);
        assert.equal(app.elmList.length, 2, "props 校验失败不得创建元件");
    }
});

// ── 浏览器侧（T1–T5 + T-cage） ─────────────────────────────────────────────

/** GET 探活 dev server（只判 2xx/3xx） */
function probeServer(url) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on("error", () => resolve(0));
        req.setTimeout(5000, () => { req.destroy(); resolve(0); });
    });
}

test("C04 place：lrc.txt between [GND,n1] 增量放置（T1/T2/T3/T4/T5/T-cage）", { timeout: 240_000 }, async () => {
    // ── 环境预检 ─────────────────────────────────────────────────────────────
    assert.ok(fs.existsSync(PW_CORE), `playwright-core 不存在: ${PW_CORE}（可用 EXT_PW_CORE 覆盖）`);
    assert.ok(fs.existsSync(CHROME), `Chrome 不存在: ${CHROME}（可用 EXT_CHROME 覆盖）`);
    const status = await probeServer(`${BASE}/circuitjs.html`);
    assert.ok(status >= 200 && status < 400,
        `dev server 不可达（${BASE} → ${status}）；先起服务：node tools/ext.mjs dev --port 5174`);

    const { chromium } = await import("file:///" + PW_CORE.replace(/\\/g, "/"));
    const browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
    });
    const consoleMsgs = [];
    const pageErrors = [];
    try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        page.on("pageerror", (e) => pageErrors.push(e.message));
        page.on("console", (m) => consoleMsgs.push({ type: m.type(), text: m.text() }));
        page.on("dialog", (d) => d.dismiss().catch(() => {}));

        await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
        await page.waitForTimeout(800);

        // 每批共用的页内基座：冻结墙钟 + 确定性分析/步进（netlist-g2.browser.mjs 同款配方）。
        // eval 的 const 不外泄，故整体挂到 window.__placeHelpers 再解构。
        const PRELUDE = `
            window.__placeHelpers = {
                freezeClock() {
                    if (!window.__placeRealNow) window.__placeRealNow = Date.now;
                    window.__placeFakeNow = 1700000000000;
                    Date.now = () => window.__placeFakeNow;
                },
                restoreClock() {
                    if (window.__placeRealNow) { Date.now = window.__placeRealNow; window.__placeRealNow = null; }
                },
                analyzeNow(ext) {
                    ext.app.needAnalyze();
                    ext.app.sim.analyzeCircuit();
                    ext.app.analyzeFlag = false;
                    ext.app.sim.preStampAndStampCircuit();
                },
                stepFor(ext, elapsedTarget, maxFrames = 4000) {
                    const app = ext.app, sim = app.sim;
                    const t0 = sim.t, s0 = sim.timeStepCount;
                    let frames = 0;
                    const frame = (didAnalyze) => {
                        window.__placeFakeNow += 16;
                        if (app.analyzeFlag) { app.analyzeFlag = false; sim.analyzeCircuit(); }
                        sim.runCircuit(didAnalyze);
                        frames++;
                    };
                    frame(true);
                    while (sim.t - t0 < elapsedTarget && frames < maxFrames && !app.stopMessage) frame(false);
                    return { frames, steps: sim.timeStepCount - s0, dt: +(sim.t - t0).toFixed(9), stopped: app.stopMessage ?? null };
                },
            };
        `;

        // ── T1 主验收 ─────────────────────────────────────────────────────────
        const t1 = await page.evaluate(async ({ text, prelude }) => {
            const ext = window.ExtCircuitJS;
            const out = { errors: [] };
            eval(prelude); // 注入本批基座（freezeClock/analyzeNow/stepFor）并解构
            const { freezeClock, restoreClock, analyzeNow, stepFor } = window.__placeHelpers;
            freezeClock();
            try {
                ext.api.loadCircuitText(text, false);
                analyzeNow(ext);
                const before = ext.api.dumpNetlist();
                out.before = { ...before.meta.counts };
                out.beforeNonWire = before.components.filter((c) => c.type !== "WireElm").length;

                const ops = ext.api.applyOps([{
                    op: "add", type: "ResistorElm", between: ["GND", "n1"], props: { resistance: 1000 },
                }]);
                out.ops = {
                    ok: ops.ok, applied: ops.applied, created: ops.created,
                    unsupported: ops.unsupported, atoms: ops.atoms,
                };

                const after = ext.api.dumpNetlist({ layout: true });
                out.after = { components: after.meta.counts.components, nets: after.meta.counts.nets };
                out.afterNonWire = after.components.filter((c) => c.type !== "WireElm").length;
                out.afterWires = after.components.filter((c) => c.type === "WireElm").length;
                out.idsUnique = new Set(after.components.map((c) => c.id)).size === after.components.length;
                const newId = ops.created?.["ResistorElm#1"] ?? null;
                out.newComp = after.components.find((c) => c.id === newId) ?? null;
                // splits/wires 如实上报：每个 split 落点确有导线端点；每条跳线 id/几何与导出一致
                const atoms = ops.atoms?.[0] ?? {};
                out.report = {
                    splits: atoms.splits ?? null,
                    wires: atoms.wires ?? null,
                    splitVerified: (atoms.splits ?? []).every((s) =>
                        after.components.some((c) => c.type === "WireElm" &&
                            ((c.layout[0] === s.at[0] && c.layout[1] === s.at[1]) ||
                             (c.layout[2] === s.at[0] && c.layout[3] === s.at[1])))),
                    wiresVerified: (atoms.wires ?? []).every((w) =>
                        after.components.some((c) => c.type === "WireElm" && c.id === w.id &&
                            c.layout[0] === w.p1[0] && c.layout[1] === w.p1[1] &&
                            c.layout[2] === w.p2[0] && c.layout[3] === w.p2[1])),
                };
                // 元件端点间距 ≥ 32px（2 格）且格点对齐（16px 网格）
                if (out.newComp) {
                    const [x1, y1, x2, y2] = out.newComp.layout;
                    out.layoutOk = Math.abs(x2 - x1) + Math.abs(y2 - y1) >= 32 &&
                        [x1, y1, x2, y2].every((v) => v % 16 === 0);
                }

                // sim 确定性步进（2ms 内部时间，远超 10 个 timeStep）
                analyzeNow(ext);
                out.step = stepFor(ext, 0.002);
            } catch (e) {
                out.errors.push(String((e && e.stack) || e));
            } finally {
                restoreClock();
            }
            out.ok = out.errors.length === 0;
            return out;
        }, { text: circuitText, prelude: PRELUDE });

        // T1 断言（验收四条 + 附加不变式）
        assert.deepEqual(t1.errors, [], `T1 页内异常: ${JSON.stringify(t1.errors)}`);
        assert.equal(t1.ops.ok, true, `T1 add 应成功: ${JSON.stringify(t1.ops.unsupported)}`);
        assert.equal(t1.ops.applied, 1);
        assert.deepEqual(t1.ops.unsupported, [], "T1 不应有 unsupported");
        assert.ok(t1.ops.created?.["ResistorElm#1"], `T1 created 应含 ResistorElm#1: ${JSON.stringify(t1.ops.created)}`);
        assert.deepEqual(t1.before, { components: 7, nets: 5 }, `T1 放置前计数: ${JSON.stringify(t1.before)}`);
        assert.equal(t1.beforeNonWire, 6, "T1 放置前非导线元件应为 6");
        assert.equal(t1.after.nets, 5,
            `T1 放置后 nets 应不变（5）: ${JSON.stringify(t1.after)}（nets 变化 = 静默开路/误并网）`);
        assert.equal(t1.afterNonWire, 7,
            `T1 新增功能元件应恰 +1（6→7）: ${JSON.stringify({ nonWire: t1.afterNonWire, ...t1.after })}`);
        // 精确账目：总数 = 7(旧) + 1(新元件) + splits 数(分裂出的新半段) + wires 数(跳线)
        assert.equal(
            t1.after.components,
            7 + 1 + (t1.report.splits?.length ?? 0) + (t1.report.wires?.length ?? 0),
            `T1 元件总数应与申报的放置物精确一致（splits=${t1.report.splits?.length}, wires=${t1.report.wires?.length}）: ${JSON.stringify(t1.after)}`,
        );
        assert.ok(t1.idsUnique, "T1 放置后稳定 id 应唯一");
        assert.equal(t1.newComp?.type, "ResistorElm");
        assert.equal(t1.newComp?.props?.resistance, 1000, "T1 props.resistance 应为 1000");
        assert.deepEqual(
            [t1.newComp?.pins?.["0"], t1.newComp?.pins?.["1"]].sort(),
            ["n0", "n1"],
            `T1 新元件两脚应恰落 {n0(GND 别名地网), n1}: ${JSON.stringify(t1.newComp?.pins)}`,
        );
        assert.equal(t1.ops.atoms[0]?.add?.id, t1.ops.created["ResistorElm#1"], "T1 atoms.add.id 与 created 一致");
        assert.equal(t1.report.splitVerified, true, `T1 splits 应如实上报: ${JSON.stringify(t1.report.splits)}`);
        assert.equal(t1.report.wiresVerified, true, `T1 wires 应如实上报: ${JSON.stringify(t1.report.wires)}`);
        assert.equal(t1.layoutOk, true, `T1 元件端点应 ≥32px 且格点对齐: ${JSON.stringify(t1.newComp?.layout)}`);
        assert.ok(t1.step.steps >= 10, `T1 sim 步数应 ≥10: ${JSON.stringify(t1.step)}`);
        assert.ok(t1.step.dt > 0, `T1 sim 时间应前进: ${JSON.stringify(t1.step)}`);
        assert.equal(t1.step.stopped, null, `T1 sim 不应 stopMessage: ${JSON.stringify(t1.step)}`);

        // ── T2 net id 双轨：["n0","n1"] 与 ["GND","n1"] 等价 ─────────────────
        const t2 = await page.evaluate(async ({ text, prelude }) => {
            const ext = window.ExtCircuitJS;
            const out = { errors: [] };
            eval(prelude);
            const { freezeClock, restoreClock, analyzeNow, stepFor } = window.__placeHelpers;
            freezeClock();
            const run = (nameA) => {
                ext.api.loadCircuitText(text, false);
                analyzeNow(ext);
                const ops = ext.api.applyOps([{
                    op: "add", type: "ResistorElm", between: [nameA, "n1"], props: { resistance: 1000 },
                }]);
                const nl = ext.api.dumpNetlist();
                const id = ops.created?.["ResistorElm#1"];
                const comp = nl.components.find((c) => c.id === id);
                return {
                    ok: ops.ok, applied: ops.applied,
                    components: nl.meta.counts.components, nets: nl.meta.counts.nets,
                    pins: comp ? [comp.pins["0"], comp.pins["1"]].sort() : null,
                };
            };
            try {
                out.byAlias = run("GND");
                out.byExportedId = run("n0");
            } catch (e) {
                out.errors.push(String((e && e.stack) || e));
            } finally {
                restoreClock();
            }
            return out;
        }, { text: circuitText, prelude: PRELUDE });

        assert.deepEqual(t2.errors, [], `T2 页内异常: ${JSON.stringify(t2.errors)}`);
        assert.equal(t2.byAlias.ok, true, `T2 GND 别名应成功: ${JSON.stringify(t2.byAlias)}`);
        assert.equal(t2.byExportedId.ok, true, `T2 显式 n0 应成功: ${JSON.stringify(t2.byExportedId)}`);
        assert.deepEqual(t2.byAlias, t2.byExportedId, "T2 双轨结果应完全等价");

        // ── T3 重复放置：同 between 连续两次 ──────────────────────────────────
        const t3 = await page.evaluate(async ({ text, prelude }) => {
            const ext = window.ExtCircuitJS;
            const out = { errors: [] };
            eval(prelude);
            const { freezeClock, restoreClock, analyzeNow, stepFor } = window.__placeHelpers;
            freezeClock();
            try {
                ext.api.loadCircuitText(text, false);
                analyzeNow(ext);
                const nl0 = ext.api.dumpNetlist();
                out.before = { ...nl0.meta.counts };
                out.beforeNonWire = nl0.components.filter((c) => c.type !== "WireElm").length;
                out.ops1 = ext.api.applyOps([{ op: "add", type: "ResistorElm", between: ["GND", "n1"], props: { resistance: 1000 } }]);
                out.ops2 = ext.api.applyOps([{ op: "add", type: "ResistorElm", between: ["GND", "n1"], props: { resistance: 2200 } }]);
                const nl1 = ext.api.dumpNetlist();
                out.after = { ...nl1.meta.counts };
                out.afterNonWire = nl1.components.filter((c) => c.type !== "WireElm").length;
                out.added1 = { splits: out.ops1.atoms?.[0]?.splits?.length ?? 0, wires: out.ops1.atoms?.[0]?.wires?.length ?? 0 };
                out.added2 = { splits: out.ops2.atoms?.[0]?.splits?.length ?? 0, wires: out.ops2.atoms?.[0]?.wires?.length ?? 0 };
                out.created2 = out.ops2.created?.["ResistorElm#1"] ?? null;
            } catch (e) {
                out.errors.push(String((e && e.stack) || e));
            } finally {
                restoreClock();
            }
            return out;
        }, { text: circuitText, prelude: PRELUDE });

        assert.deepEqual(t3.errors, [], `T3 页内异常: ${JSON.stringify(t3.errors)}`);
        assert.deepEqual(t3.before, { components: 7, nets: 5 });
        assert.equal(t3.beforeNonWire, 6);
        assert.equal(t3.ops1.ok && t3.ops2.ok, true,
            `T3 两次 add 都应成功: ${JSON.stringify([t3.ops1?.unsupported, t3.ops2?.unsupported])}`);
        assert.equal(t3.after.nets, 5, `T3 nets 仍应 5: ${JSON.stringify(t3.after)}`);
        assert.equal(t3.afterNonWire, 8, `T3 功能元件应 6→8: ${JSON.stringify(t3.after)}`);
        assert.equal(
            t3.after.components,
            7 + 2 + t3.added1.splits + t3.added1.wires + t3.added2.splits + t3.added2.wires,
            `T3 元件总数应与两次申报的放置物精确一致: ${JSON.stringify({ after: t3.after, added1: t3.added1, added2: t3.added2 })}`,
        );

        // ── T4 写读闭环：add 的稳定 id 可被 set 消费 ──────────────────────────
        const t4 = await page.evaluate(async ({ text, prelude }) => {
            const ext = window.ExtCircuitJS;
            const out = { errors: [] };
            eval(prelude);
            const { freezeClock, restoreClock, analyzeNow, stepFor } = window.__placeHelpers;
            freezeClock();
            try {
                ext.api.loadCircuitText(text, false);
                analyzeNow(ext);
                const add = ext.api.applyOps([{
                    op: "add", type: "ResistorElm", between: ["GND", "n1"], props: { resistance: 1000 },
                }]);
                const id = add.created?.["ResistorElm#1"];
                out.set = ext.api.applyOps([{ op: "set", target: id, prop: "resistance", value: 2200 }]);
                const nl = ext.api.dumpNetlist();
                out.comp = nl.components.find((c) => c.id === id) ?? null;
            } catch (e) {
                out.errors.push(String((e && e.stack) || e));
            } finally {
                restoreClock();
            }
            return out;
        }, { text: circuitText, prelude: PRELUDE });

        assert.deepEqual(t4.errors, [], `T4 页内异常: ${JSON.stringify(t4.errors)}`);
        assert.equal(t4.set.ok, true, `T4 set 应成功: ${JSON.stringify(t4.set)}`);
        assert.equal(t4.set.applied, 1);
        assert.equal(t4.comp?.props?.resistance, 2200, "T4 set 后导出应见 2200");

        // ── T5 序列化往返：dump → 重载 → 再导出 计数一致 ──────────────────────
        const t5 = await page.evaluate(async ({ text, prelude }) => {
            const ext = window.ExtCircuitJS;
            const out = { errors: [] };
            eval(prelude);
            const { freezeClock, restoreClock, analyzeNow, stepFor } = window.__placeHelpers;
            freezeClock();
            try {
                ext.api.loadCircuitText(text, false);
                analyzeNow(ext);
                ext.api.applyOps([{ op: "add", type: "ResistorElm", between: ["GND", "n1"], props: { resistance: 1000 } }]);
                const nl1 = ext.api.dumpNetlist();
                out.before = {
                    counts: { ...nl1.meta.counts },
                    types: nl1.components.map((c) => c.type).sort(),
                };
                const text2 = ext.api.dumpCircuitXml();
                ext.api.loadCircuitText(text2, false);
                analyzeNow(ext);
                const nl2 = ext.api.dumpNetlist();
                out.after = {
                    counts: { ...nl2.meta.counts },
                    types: nl2.components.map((c) => c.type).sort(),
                };
            } catch (e) {
                out.errors.push(String((e && e.stack) || e));
            } finally {
                restoreClock();
            }
            return out;
        }, { text: circuitText, prelude: PRELUDE });

        assert.deepEqual(t5.errors, [], `T5 页内异常: ${JSON.stringify(t5.errors)}`);
        assert.deepEqual(t5.before.counts, t5.after.counts,
            `T5 round-trip 计数应一致: ${JSON.stringify([t5.before.counts, t5.after.counts])}`);
        assert.deepEqual(t5.before.types, t5.after.types, "T5 round-trip 元件类型多重集应一致");

        // ── T-cage 强制分裂：唯一可行路线必经导线内点 ─────────────────────────
        const tc = await page.evaluate(async ({ text, prelude }) => {
            const ext = window.ExtCircuitJS;
            const out = { errors: [] };
            eval(prelude);
            const { freezeClock, restoreClock, analyzeNow, stepFor } = window.__placeHelpers;
            freezeClock();
            try {
                ext.api.loadCircuitText(text, false);
                analyzeNow(ext);
                const nl = ext.api.dumpNetlist({ layout: true });
                const wire = nl.components.find((c) => c.type === "WireElm" && c.layout[0] === 64 && c.layout[1] === 64);
                const vb = nl.components.find((c) => c.type === "ResistorElm" && c.layout[0] === 288 && c.layout[1] === 128);
                out.netA = wire?.pins?.["0"] ?? null;
                out.netB = vb?.pins?.["0"] ?? null;
                out.before = { ...nl.meta.counts };
                out.before.nonWire = nl.components.filter((c) => c.type !== "WireElm").length;

                const ops = ext.api.applyOps([{
                    op: "add", type: "ResistorElm", between: [out.netA, out.netB], props: { resistance: 1000 },
                }]);
                out.ops = { ok: ops.ok, created: ops.created, unsupported: ops.unsupported, atoms: ops.atoms };
                const nl2 = ext.api.dumpNetlist({ layout: true });
                out.after = { ...nl2.meta.counts };
                out.afterNonWire = nl2.components.filter((c) => c.type !== "WireElm").length;
                const newId = ops.created?.["ResistorElm#1"];
                out.newComp = nl2.components.find((c) => c.id === newId) ?? null;
                // 分裂后导线在落点处确有端点
                const at = ops.atoms?.[0]?.splits?.[0]?.at;
                out.splitEndpointVerified = !!at && nl2.components.some((c) =>
                    c.type === "WireElm" && ((c.layout[0] === at[0] && c.layout[1] === at[1]) ||
                                              (c.layout[2] === at[0] && c.layout[3] === at[1])));
                out.wireCountBefore = nl.components.filter((c) => c.type === "WireElm").length;
                out.wireCountAfter = nl2.components.filter((c) => c.type === "WireElm").length;
            } catch (e) {
                out.errors.push(String((e && e.stack) || e));
            } finally {
                restoreClock();
            }
            return out;
        }, { text: cageText, prelude: PRELUDE });

        assert.deepEqual(tc.errors, [], `T-cage 页内异常: ${JSON.stringify(tc.errors)}`);
        assert.ok(tc.netA && tc.netB, `T-cage 应解析出两张网: ${JSON.stringify([tc.netA, tc.netB])}`);
        assert.equal(tc.ops.ok, true, `T-cage add 应成功: ${JSON.stringify(tc.ops.unsupported)}`);
        assert.equal(tc.after.nets, tc.before.nets, "T-cage nets 不变");
        assert.equal(tc.afterNonWire, tc.before.nonWire + 1, "T-cage 功能元件 +1");
        const cageSplits = tc.ops.atoms?.[0]?.splits ?? [];
        const cageWires = tc.ops.atoms?.[0]?.wires ?? [];
        assert.equal(tc.after.components, tc.before.components + 1 + cageSplits.length + cageWires.length,
            `T-cage 元件总数应与申报放置物精确一致: ${JSON.stringify({ before: tc.before, after: tc.after, cageSplits, cageWires })}`);
        assert.equal(cageSplits.length, 1,
            `T-cage post 接入点全被封死时 splits 应恰 1（必经导线分裂）: ${JSON.stringify(cageSplits)}`);
        assert.deepEqual(cageSplits[0]?.at, [64, 128],
            `T-cage 分裂落点应为 (64,128)（与 net B 唯一接入点同行直连）: ${JSON.stringify(cageSplits)}`);
        assert.equal(tc.splitEndpointVerified, true, "T-cage 分裂落点处应确有导线端点");
        assert.equal(tc.wireCountAfter, tc.wireCountBefore + 1, "T-cage 分裂后导线数 +1（一段变两段）");
        assert.deepEqual(
            [tc.newComp?.pins?.["0"], tc.newComp?.pins?.["1"]].sort(),
            [tc.netA, tc.netB].sort(),
            `T-cage 新元件两脚应恰落两目标网: ${JSON.stringify(tc.newComp?.pins)}`,
        );

        // ── console 干净（零容忍，仅豁免环境级资源加载噪声） ──────────────────
        const ENV_NOISE = /^failed to load resource|net::|dropbox/i;
        const bad = consoleMsgs.filter((m) => m.type === "error" && !ENV_NOISE.test(m.text));
        assert.deepEqual(bad, [], `不应有 console error: ${JSON.stringify(bad)}`);
        assert.deepEqual(pageErrors, [], `不应有 pageerror: ${JSON.stringify(pageErrors)}`);

        // 计数证据落 stdout（验收要求附输出）
        console.log("C04b place counts:", JSON.stringify({
            t1: {
                before: t1.before, after: t1.after,
                pins: t1.newComp?.pins, layout: t1.newComp?.layout,
                splits: t1.report.splits, wires: t1.report.wires,
                step: t1.step,
            },
            t2: { byAlias: t2.byAlias, byExportedId: t2.byExportedId },
            t3: { before: t3.before, after: t3.after },
            t4: { applied: t4.set.applied, resistance: t4.comp?.props?.resistance },
            t5: { before: t5.before.counts, after: t5.after.counts },
            tcage: {
                before: tc.before, after: tc.after, netA: tc.netA, netB: tc.netB,
                splits: tc.ops.atoms?.[0]?.splits, pins: tc.newComp?.pins,
            },
            consoleErrors: consoleMsgs.filter((m) => m.type === "error").map((m) => m.text).slice(0, 5),
        }, null, 2));
    } finally {
        await browser.close();
    }
});
