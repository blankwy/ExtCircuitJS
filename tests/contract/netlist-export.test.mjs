// C02 — 网表导出保真契约测试：373 语料逐例载入真实引擎（浏览器），导出 netlist/0.1 与地面真值对拍。
//   node --test tests/contract/netlist-export.test.mjs
//
// 口径（docs/task-board.md C02；基线 93.84% 出自 docs/spikes/netlist-codec.md 实测）：
//   1. 元件数逐例 100%：nl.components.length === fingerprint.elmCount
//   2. 引脚数聚合比：Σ components[].pins 键数 / Σ fingerprint.elements[].posts.length ≥ 0.938
//      （导出侧跳过空 pins 网络与内部节点 post ≥ getPostCount 的 link，属已知设计，见 packages/netlist/src/index.ts）
//
// 分母已知缺口的说明（2026-10-25 实测，ratio >100% 属预期而非导出 bug）：
//   - 总线导线：引擎 WireElm.getPostCount() = (busWidth??1)*2（4/8 位总线 → 8/16 脚），
//     fingerprint 对导线一律记 2 脚 → 语料合计少记 690 脚；
//   - InstructionDisplayElm：fingerprint 生成时 getInfoJS 抛错被记成 type:null/posts:[]（6 例，共 45 脚）。
//   引擎真值 Σ getPostCount() = 分母 + 735，导出引脚数与引擎真值逐例相等（见摘要中 export/engine 列）。
//
// 地面真值：tests/fixtures/corpus-xml/fingerprints.json（只读）。语料输入：同目录 *.xml（同目录快照，只读）。
// 已知 1 例坏数据 blank（fingerprint ok=false，FAILURES.md 唯一条目）→ 显式跳过并计数。
//
// 浏览器基准与 tests/contract/boot.browser.mjs 同款（该文件只读，不改）：
//   EXT_PW_CORE（playwright-core index.mjs）/ EXT_CHROME / EXC_BASE（默认 http://127.0.0.1:5174）。

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
const PIN_RATIO_BASELINE = 0.938; // 93.8%（spike 实测基线，C02 验收线）
const BATCH = 20; // 每批电路数：373 例分 19 次 page.evaluate，全程压在分钟级

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

test("C02 netlist-export：373 语料元件数 100% / 引脚聚合比 ≥ 93.8%", { timeout: 300_000 }, async () => {
    // ── 1) 地面真值与语料输入 ────────────────────────────────────────────────
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
            expElm: c.elmCount,
            expPins: c.elements.reduce((s, e) => s + (e.posts?.length ?? 0), 0),
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

    // ── 3) 浏览器会话（与 boot.browser.mjs 同款启动）────────────────────────
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

        // ── 4) 分批逐例对拍（每批一次 evaluate，循环在页面内）─────────────────
        const results = [];
        for (let i = 0; i < cases.length; i += BATCH) {
            const batch = cases.slice(i, i + BATCH)
                .map(({ name, text, expElm, expPins }) => ({ name, text, expElm, expPins }));
            const rs = await page.evaluate(async (items) => {
                const ext = window.ExtCircuitJS;
                const out = [];
                for (const c of items) {
                    const r = { name: c.name, expElm: c.expElm, expPins: c.expPins, elm: -1, pins: -1, enginePins: -1, unsupported: 0, err: null };
                    try {
                        // 与 boot.browser.mjs 相同的确定性分析序列：
                        // analyzeCircuit 只同步 elmList，nodeList 在 preStampCircuit 里建
                        ext.api.loadCircuitText(c.text, false);
                        ext.app.needAnalyze();
                        ext.app.sim.analyzeCircuit();
                        ext.app.sim.preStampCircuit(false);
                        const nl = ext.api.dumpNetlist();
                        r.elm = nl.components.length;
                        // 导出引脚数 = Σ components[].pins 的键数（C02 口径）
                        r.pins = nl.components.reduce((s, k) => s + Object.keys(k.pins).length, 0);
                        // 引擎真值（诊断用）：Σ getPostCount()，用于确认导出相对引擎零损失
                        r.enginePins = ext.app.elmList.reduce((s, e) => s + e.getPostCount(), 0);
                        r.unsupported = nl.unsupported.length;
                    } catch (e) {
                        r.err = String((e && e.message) || e).slice(0, 200);
                    }
                    out.push(r);
                }
                return out;
            }, batch);
            results.push(...rs);
        }

        // ── 5) 聚合 ─────────────────────────────────────────────────────────
        const errors = [];
        const mismatches = [];
        let gotPins = 0;
        let expPins = 0;
        let enginePins = 0;
        let unsupportedTotal = 0;
        const engineLoss = [];  // 导出引脚 < 引擎 Σ getPostCount() 的例（真实导出损失）
        const denomShort = []; // 引脚比 >100% 的例（fingerprint 分母缺口，见文件头说明）
        for (const r of results) {
            expPins += r.expPins;
            gotPins += Math.max(r.pins, 0);
            enginePins += Math.max(r.enginePins, 0);
            unsupportedTotal += r.unsupported ?? 0;
            if (r.err) errors.push(r);
            else if (r.elm !== r.expElm) mismatches.push(r);
            if (!r.err && r.pins < r.enginePins) engineLoss.push(`${r.name}: export=${r.pins} engine=${r.enginePins}`);
            if (!r.err && r.expPins > 0 && r.pins > r.expPins) denomShort.push(`${r.name}: export=${r.pins} fp=${r.expPins}`);
        }
        const matched = results.length - errors.length - mismatches.length;
        const pinRatio = expPins > 0 ? gotPins / expPins : 0;
        const worst = results
            .filter((r) => r.expPins > 0)
            .map((r) => ({ name: r.name, ratio: Math.max(r.pins, 0) / r.expPins, got: Math.max(r.pins, 0), exp: r.expPins, err: r.err }))
            .sort((a, b) => a.ratio - b.ratio)
            .slice(0, 10);

        // ── 6) 断言（元件数 100% + 引脚聚合比 ≥ 基线）───────────────────────
        assert.deepEqual(
            errors.map((r) => `${r.name}: ${r.err}`),
            [],
            "引擎载入/导出抛错的语料（应为空）",
        );
        assert.deepEqual(
            mismatches.map((r) => `${r.name}: got=${r.elm} exp=${r.expElm}`),
            [],
            "元件数不匹配的语料（要求 100%）",
        );
        assert.ok(
            pinRatio >= PIN_RATIO_BASELINE,
            `引脚聚合比 ${(pinRatio * 100).toFixed(2)}% 低于基线 ${PIN_RATIO_BASELINE * 100}%`
            + `（got=${gotPins} exp=${expPins}）；若缺口指向引擎 nodeList 划分本身 → 按纪律停止上报，不许绕`,
        );

        // ── 7) 汇总摘要（供 handoff 引用）───────────────────────────────────
        console.log("[C02 netlist-export] ─────────────────────────────────");
        console.log(`[C02 netlist-export] 例数: ${results.length}/${fp.circuits.length}（跳过 ${skipped.length}: ${
            skipped.map((s) => `${s.name} — ${s.reason}`).join("; ") || "无"})`);
        console.log(`[C02 netlist-export] 元件数匹配: ${matched}/${results.length} = ${(matched / results.length * 100).toFixed(2)}%`);
        console.log(`[C02 netlist-export] 引脚聚合比: ${gotPins}/${expPins} = ${(pinRatio * 100).toFixed(2)}%（验收线 ≥ ${PIN_RATIO_BASELINE * 100}%）`);
        console.log(`[C02 netlist-export] 引擎真值对比: export/engine = ${gotPins}/${enginePins}`
            + `（相对引擎 Σ getPostCount() 损失 ${enginePins - gotPins} 脚；引擎侧损失例应为空）`);
        if (engineLoss.length) console.log(`[C02 netlist-export] 引擎侧损失例: ${engineLoss.join("; ")}`);
        console.log(`[C02 netlist-export] 引脚比 >100% 的例（fingerprint 分母缺口，见文件头）: ${denomShort.length} 例 — ${denomShort.slice(0, 10).join("; ")}${denomShort.length > 10 ? " …" : ""}`);
        console.log(`[C02 netlist-export] registry unsupported 条目合计: ${unsupportedTotal}`);
        console.log(`[C02 netlist-export] 最差 10 例（引脚比）: ${
            worst.map((w) => `${w.name} ${w.got}/${w.exp}=${(w.ratio * 100).toFixed(1)}%${w.err ? ` err=${w.err}` : ""}`).join(", ")}`);
        if (pageErrors.length) console.log(`[C02 netlist-export] pageerror×${pageErrors.length}: ${pageErrors.slice(0, 3).join(" | ")}`);
        console.log("[C02 netlist-export] ─────────────────────────────────");
    } finally {
        await browser.close();
    }
});
