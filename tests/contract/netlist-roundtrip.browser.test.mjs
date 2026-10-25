// C07 — 网表 round-trip 幂等契约测试：373 语料逐例验证 export → dump XML → reload → export 前后零差异。
//   node --test tests/contract/netlist-roundtrip.browser.test.mjs
//
// 口径（docs/task-board.md C07；断言 = 全量深比较，不许挑字段弱化）：
//   1. 载入语料 XML（ext.api.loadCircuitText）→ 分析序列 → export 得 E1
//   2. ext.app.dumpCircuit() 把当前电路序列化回官方 XML
//   3. 载入这份 dump 出来的 XML（同分析序列）→ export 得 E2
//   4. 断言 E1 与 E2 深度相等（逐例 diff = 0）
//
// 对比口径：canonical stringify（递归 key 排序后的全量序列化）——对象字段顺序由代码决定，
// 排序只是消掉无关的插入顺序抖动；比较范围仍是 E1/E2 的全部字段，不做任何字段挑选。
//
// 分析序列与 C02 完全同款（boot.browser.mjs 的确定性序列）：
//   loadCircuitText(text,false) → needAnalyze() → analyzeCircuit() → preStampCircuit(false) → dumpNetlist()
//
// 已知 1 例坏数据 blank（fingerprint ok=false，与 C02 一致口径）→ 显式跳过并计数。
//
// 浏览器基准与 tests/contract/netlist-export.test.mjs 同款（env：EXT_PW_CORE / EXT_CHROME / EXC_BASE）。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? "http://127.0.0.1:5174";

const FIX_DIR = path.resolve(import.meta.dirname, "../fixtures/corpus-xml");
const BATCH = 20; // 每批电路数：每批一次 page.evaluate（页内循环含两轮载入+两轮导出），373 例分 19 批

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

test("C07 netlist-roundtrip：373 语料 export→dump→reload→export 逐例 diff=0", { timeout: 300_000 }, async () => {
    // ── 1) 语料输入（跳过口径与 C02 完全一致）────────────────────────────────
    const fp = JSON.parse(fs.readFileSync(path.join(FIX_DIR, "fingerprints.json"), "utf8"));
    assert.equal(fp.schema, "extcircuitjs/corpus@1", "fingerprints schema 漂移");

    const skipped = [];
    const cases = [];
    for (const c of fp.circuits) {
        const base = c.source.split("/").pop().replace(/\.txt$/, ".xml");
        if (c.ok !== true || c.elmCount == null || !Array.isArray(c.elements)) {
            skipped.push({ name: base, reason: `fingerprint ok=${c.ok}（FAILURES.md 坏例，显式跳过）` });
            continue;
        }
        cases.push({
            name: base.replace(/\.xml$/, ""),
            text: fs.readFileSync(path.join(FIX_DIR, base), "utf8"),
        });
    }
    assert.ok(cases.length > 0, "语料为空");
    assert.equal(cases.length + skipped.length, fp.circuits.length, "ok/跳过 例数与总数不一致");

    // ── 2) 环境预检 ─────────────────────────────────────────────────────────
    assert.ok(fs.existsSync(PW_CORE), `playwright-core 不存在: ${PW_CORE}（可用 EXT_PW_CORE 覆盖）`);
    assert.ok(fs.existsSync(CHROME), `Chrome 不存在: ${CHROME}（可用 EXT_CHROME 覆盖）`);
    const status = await probeServer(`${BASE}/circuitjs.html`);
    assert.ok(status >= 200 && status < 400,
        `dev server 不可达（${BASE} → ${status}）；先起服务：node tools/ext.mjs dev --port 5174`);

    // ── 3) 浏览器会话（与 netlist-export.test.mjs / boot.browser.mjs 同款启动）──
    const { chromium } = await import("file:///" + PW_CORE.replace(/\\/g, "/"));
    const browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
    });
    const pageErrors = [];
    try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        page.on("pageerror", (e) => pageErrors.push(e.message));
        // 个别语料 import 异常路径可能走 alert()；无人接管的 dialog 会卡死后续 evaluate
        page.on("dialog", (d) => d.dismiss().catch(() => {}));

        await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
        await page.waitForTimeout(1200); // 插件宿主 fetch + dynamic import

        // ── 4) 分批逐例 round-trip（每批一次 evaluate，循环在页面内）────────────
        // 页内辅助：canonical stringify（递归 key 排序）与首个差异定位（只回传片段，不回传全量 dump）
        const results = [];
        for (let i = 0; i < cases.length; i += BATCH) {
            const batch = cases.slice(i, i + BATCH)
                .map(({ name, text }) => ({ name, text }));
            const rs = await page.evaluate(async (items) => {
                const ext = window.ExtCircuitJS;

                function canonical(v) {
                    if (v === undefined) return "undefined";
                    if (v === null || typeof v !== "object") return JSON.stringify(v);
                    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
                    const keys = Object.keys(v).sort();
                    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
                }
                function firstDiff(a, b) {
                    const n = Math.min(a.length, b.length);
                    let i = 0;
                    while (i < n && a[i] === b[i]) i++;
                    const lo = Math.max(0, i - 70);
                    return {
                        at: i,
                        e1: a.slice(lo, i + 70),
                        e2: b.slice(lo, i + 70),
                        lenE1: a.length,
                        lenE2: b.length,
                    };
                }

                const analyze = () => {
                    // 与 boot.browser.mjs 相同的确定性分析序列：
                    // analyzeCircuit 只同步 elmList，nodeList 在 preStampCircuit 里建
                    ext.app.needAnalyze();
                    ext.app.sim.analyzeCircuit();
                    ext.app.sim.preStampCircuit(false);
                };

                const out = [];
                for (const c of items) {
                    const r = { name: c.name, diff: true, firstDiff: null, err: null };
                    try {
                        ext.api.loadCircuitText(c.text, false);
                        analyze();
                        const e1 = canonical(ext.api.dumpNetlist());

                        const dump = ext.app.dumpCircuit();
                        ext.api.loadCircuitText(dump, false);
                        analyze();
                        const e2 = canonical(ext.api.dumpNetlist());

                        r.diff = e1 !== e2;
                        if (r.diff) r.firstDiff = firstDiff(e1, e2);
                    } catch (e) {
                        r.err = String((e && e.message) || e).slice(0, 300);
                    }
                    out.push(r);
                }
                return out;
            }, batch);
            results.push(...rs);
        }

        // ── 5) 聚合与断言（全量深比较，逐例 diff 必须为 0）──────────────────────
        const errors = results.filter((r) => r.err);
        const mismatches = results.filter((r) => !r.err && r.diff);
        const passed = results.length - errors.length - mismatches.length;

        assert.deepEqual(
            errors.map((r) => `${r.name}: ${r.err}`),
            [],
            "round-trip 引擎载入/导出抛错的语料（应为空）",
        );
        assert.deepEqual(
            mismatches.map((r) => `${r.name}: 首个差异 @${r.firstDiff?.at} …${r.firstDiff?.e1}… ≠ …${r.firstDiff?.e2}…`),
            [],
            "E1/E2 深度不相等的语料（要求逐例 diff=0）。"
            + "若首个差异指向引擎 dump/reload 本身有损（scope/选项丢失等上游行为）→ 按纪律停止上报，不许挑字段弱化断言",
        );

        // ── 6) 汇总摘要（供 handoff 引用）────────────────────────────────────
        console.log("[C07 netlist-roundtrip] ─────────────────────────────────");
        console.log(`[C07 netlist-roundtrip] 例数: ${results.length}/${fp.circuits.length}（跳过 ${skipped.length}: ${
            skipped.map((s) => `${s.name} — ${s.reason}`).join("; ") || "无"})`);
        console.log(`[C07 netlist-roundtrip] round-trip diff=0: ${passed}/${results.length} = ${(passed / results.length * 100).toFixed(2)}%`);
        if (pageErrors.length) console.log(`[C07 netlist-roundtrip] pageerror×${pageErrors.length}: ${pageErrors.slice(0, 3).join(" | ")}`);
        console.log("[C07 netlist-roundtrip] ─────────────────────────────────");
    } finally {
        await browser.close();
    }
});
