// PRB1 — probe op → 引擎 scope 机制契约测试（浏览器、真引擎）
//   node --test tests/contract/ops-probe.browser.test.mjs
//
// 被测行为（packages/netlist/src/index.ts applyOps 的 probe 分支）：
//   1. {op:"probe", target:"eN", quantity:"voltage"|"current"} → 对该元件建停靠 scope，
//      成功返回 {ok:true, created:{probe:"eN"}}
//   2. 重复 probe 同一目标 → 幂等：不重复建（始终只有一个 scope showing 该元件）
//   3. unknown target / unknown quantity → 结构化失败（C03 语义：ok:false + unsupported，
//      不外抛、无副作用）
//   4. 停靠 scope 不进 elmList —— 网表导出 / getMeasurements 不被探针污染
//   5. 确定性步进后，探针图（ScopePlot.maxValues）采集到有限数据
//
// 语料：core/ts/public/circuits/lrc.txt（netlist-g2 同款）剥掉自带 `o` scope 行 ——
// 干净前置（零存量 scope）。确定性步进配方与 netlist-g2.browser.mjs 同款：
// analyzeCircuit → preStampAndStampCircuit → runCircuit（冻结 Date.now）。
// 浏览器基准与 boot.browser.mjs 同款 env：EXT_PW_CORE / EXT_CHROME / EXC_BASE。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? "http://127.0.0.1:5174";

// core/ts/ScopeConstants.ts：VAL_VOLTAGE=0 / VAL_CURRENT=3；UNITS_V=0 / UNITS_A=1
const VAL_VOLTAGE = 0, VAL_CURRENT = 3, UNITS_V = 0, UNITS_A = 1;

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

test("PRB1 probe op：建 scope / quantity 开关 / 幂等 / unknown target 结构化失败 / 网表不被污染", { timeout: 180_000 }, async () => {
    // ── 1) 环境预检 ─────────────────────────────────────────────────────────
    // 语料：lrc.txt（netlist-g2 同款），但剥掉自带行 —— `o`（停靠 scope，其中一条
    // 正显示 10Ω 电阻，会提前触发幂等路径）、`h`（hint）、`38`（Adjustable 滑条，
    // 按下标引用元件）。剥掉后拓扑不变、零存量 scope，前置条件干净。
    const circuitText = fs.readFileSync(
        path.resolve(import.meta.dirname, "../../core/ts/public/circuits/lrc.txt"),
        "utf8",
    ).split(/\r?\n/).filter((l) => !/^[oh]\s|^38\s/.test(l)).join("\n");
    assert.ok(fs.existsSync(PW_CORE), `playwright-core 不存在: ${PW_CORE}（可用 EXT_PW_CORE 覆盖）`);
    assert.ok(fs.existsSync(CHROME), `Chrome 不存在: ${CHROME}（可用 EXT_CHROME 覆盖）`);
    const status = await probeServer(`${BASE}/circuitjs.html`);
    assert.ok(status >= 200 && status < 400,
        `dev server 不可达（${BASE} → ${status}）；先起服务：node tools/ext.mjs dev --port 5174`);

    // ── 2) 浏览器会话 ───────────────────────────────────────────────────────
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
        page.on("dialog", (d) => d.dismiss().catch(() => {}));

        await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
        await page.waitForTimeout(1200); // 插件宿主 fetch + dynamic import（坑位 22：启动电路异步装载，之后我们自行载入）

        const result = await page.evaluate((text) => {
            const ext = window.ExtCircuitJS;
            const out = { errors: [] };

            // ── 确定性步进基座（netlist-g2.browser.mjs 同款）──────────────────
            if (!window.__probeRealNow) window.__probeRealNow = Date.now;
            window.__probeFakeNow = 1700000000000;
            Date.now = () => window.__probeFakeNow;

            const stepFor = (elapsedTarget, maxFrames = 4000) => {
                const app = ext.app;
                const sim = app.sim;
                const t0 = sim.t;
                let frames = 0;
                const frame = (didAnalyze) => {
                    window.__probeFakeNow += 16;
                    if (app.analyzeFlag) {
                        app.analyzeFlag = false;
                        sim.analyzeCircuit();
                    }
                    sim.runCircuit(didAnalyze);
                    frames++;
                };
                frame(true);
                while (sim.t - t0 < elapsedTarget && frames < maxFrames && !app.stopMessage) frame(false);
                return { frames, elapsed: +(sim.t - t0).toFixed(9), stopped: app.stopMessage };
            };

            // 分析序列按 UIManager.updateCircuit() 的真实顺序（只调 preStampCircuit 会 NaN 崩）
            const analyzeNow = () => {
                ext.app.needAnalyze();
                ext.app.sim.analyzeCircuit();
                ext.app.analyzeFlag = false;
                ext.app.sim.preStampAndStampCircuit();
            };

            // ── scope 状态快照（停靠 scope + 各图）────────────────────────────
            const snapScopes = () => {
                const sm = ext.app.scopeManager;
                const scopes = [];
                for (let i = 0; i < sm.scopeCount; i++) {
                    const s = sm.scopes[i];
                    scopes.push({
                        showV: !!s.showV,
                        showI: !!s.showI,
                        plots: (s.plots ?? []).map((p) => ({
                            value: p.value,
                            units: p.units,
                            elmIdx: p.elm ? ext.app.elmList.indexOf(p.elm) : -1,
                        })),
                        visibleValues: (s.visiblePlots ?? []).map((p) => p.value),
                    });
                }
                return { scopeCount: sm.scopeCount, scopes };
            };
            // 哪些停靠 scope 正显示某 elm（showingElm 按 plots 判定，core/ts/Scope.ts:1516）
            const hitsFor = (elm) => {
                const sm = ext.app.scopeManager;
                const hits = [];
                for (let i = 0; i < sm.scopeCount; i++)
                    if (sm.scopes[i]?.showingElm?.(elm)) hits.push(i);
                return hits;
            };
            const floatingHitsFor = (elm) =>
                ext.app.elmList.filter((e) => e?.isScopeElm?.() && e?.elmScope?.showingElm?.(elm)).length;

            try {
                // ── 载入 + 分配稳定 id ────────────────────────────────────────
                ext.api.loadCircuitText(text, false);
                analyzeNow();
                const nl = ext.api.dumpNetlist();
                out.compCountBefore = nl.components.length;
                out.unsupportedBefore = nl.unsupported.length;
                const target = nl.components.find((c) => c.type === "ResistorElm" && c.props.resistance === 10)
                    ?? nl.components.find((c) => c.type === "ResistorElm");
                const target2 = nl.components.find((c) => c.type === "ResistorElm" && c !== target);
                if (!target || !target2) throw new Error("lrc.txt 应含两个 ResistorElm");
                // components 按 elmList 顺序构造（exportNetlist 用 elms.map），下标即 elmList 下标
                const targetElm = ext.app.elmList[nl.components.indexOf(target)];
                const target2Elm = ext.app.elmList[nl.components.indexOf(target2)];
                out.targetId = target.id;
                out.target2Id = target2.id;

                const before = snapScopes();
                out.beforeScopeCount = before.scopeCount;
                out.beforeTargetHits = hitsFor(targetElm);

                // ── 1) probe voltage：建 scope ────────────────────────────────
                const r1 = ext.api.applyOps([{ op: "probe", target: target.id, quantity: "voltage" }]);
                out.r1 = { ok: r1.ok, applied: r1.applied, created: r1.created, unsupported: r1.unsupported.length };
                const snap1 = snapScopes();
                out.afterR1 = { scopeCount: snap1.scopeCount, hits: hitsFor(targetElm), floating: floatingHitsFor(targetElm) };
                out.scope1 = snap1.scopes[hitsFor(targetElm)[0]] ?? null;

                // ── 2) probe current：同一目标切 quantity（仍是同一个 scope）────
                const r2 = ext.api.applyOps([{ op: "probe", target: target.id, quantity: "current" }]);
                out.r2 = { ok: r2.ok, created: r2.created };
                const snap2 = snapScopes();
                out.afterR2 = { scopeCount: snap2.scopeCount, hits: hitsFor(targetElm) };
                out.scope2 = snap2.scopes[hitsFor(targetElm)[0]] ?? null;

                // ── 3) 重复 probe（同 target 同 quantity）→ 幂等 ────────────────
                const r3 = ext.api.applyOps([{ op: "probe", target: target.id, quantity: "current" }]);
                out.r3 = { ok: r3.ok, created: r3.created };
                out.afterR3 = { scopeCount: snapScopes().scopeCount, hits: hitsFor(targetElm) };

                // ── 4) 切回 voltage 再步进：探针图应有数据 ──────────────────────
                const r4 = ext.api.applyOps([{ op: "probe", target: target.id, quantity: "voltage" }]);
                out.r4 = { ok: r4.ok, created: r4.created };
                const hits4 = hitsFor(targetElm);
                out.afterR4 = { hits: hits4 };
                analyzeNow();
                out.step = stepFor(0.002);
                const vPlot = hits4.length === 1
                    ? (ext.app.scopeManager.scopes[hits4[0]].visiblePlots ?? []).find((p) => p.value === 0)
                    : null;
                const mv = vPlot?.maxValues ?? [];
                out.data = {
                    len: mv.length,
                    finite: mv.filter(Number.isFinite).length,
                    nonZero: mv.some((v) => Math.abs(v) > 1e-12),
                    sample: typeof mv[0] === "number" ? mv[0] : null,
                };

                // ── 5) unknown target → 结构化失败，无副作用 ────────────────────
                const r5 = ext.api.applyOps([{ op: "probe", target: "e99", quantity: "voltage" }]);
                out.r5 = { ok: r5.ok, reason: r5.unsupported?.[0]?.reason ?? null };
                out.afterR5 = { hits: hitsFor(targetElm) };

                // ── 6) unknown quantity → 结构化失败 ───────────────────────────
                const r6 = ext.api.applyOps([{ op: "probe", target: target.id, quantity: "power" }]);
                out.r6 = { ok: r6.ok, reason: r6.unsupported?.[0]?.reason ?? null };
                out.afterR6 = { hits: hitsFor(targetElm) };

                // ── 7) 第二个元件 → 再建一个 scope ─────────────────────────────
                const r7 = ext.api.applyOps([{ op: "probe", target: target2.id, quantity: "current" }]);
                out.r7 = { ok: r7.ok, created: r7.created };
                out.afterR7 = {
                    hits2: hitsFor(target2Elm),
                    scope2: (() => {
                        const sm = ext.app.scopeManager;
                        for (let i = 0; i < sm.scopeCount; i++) {
                            if (sm.scopes[i]?.showingElm?.(target2Elm)) {
                                const s = sm.scopes[i];
                                return { showV: !!s.showV, showI: !!s.showI, visibleValues: (s.visiblePlots ?? []).map((p) => p.value) };
                            }
                        }
                        return null;
                    })(),
                };

                // ── 8) 网表 / getMeasurements 不被探针污染（停靠 scope 不进 elmList）
                const nl2 = ext.api.dumpNetlist();
                out.nl2 = {
                    compCount: nl2.components.length,
                    unsupported: nl2.unsupported.length,
                    scopeElmComps: nl2.components.filter((c) => c.type === "ScopeElm").length,
                };
                const meas = ext.api.getMeasurements();
                // getMeasurements 的 cN 下标 = elmList 下标 = nl2.components 下标
                const targetIdx = nl2.components.findIndex((x) => x.id === target.id);
                const measTarget = targetIdx >= 0 ? meas.components[targetIdx] : null;
                out.meas = {
                    compCount: meas.components.length,
                    targetFound: !!measTarget,
                    targetVd: measTarget?.vd ?? null,
                    targetCurrent: measTarget?.current ?? null,
                };

                out.ok = true;
            } catch (e) {
                out.errors.push(String((e && e.stack) || e));
            } finally {
                if (window.__probeRealNow) {
                    Date.now = window.__probeRealNow;
                    window.__probeRealNow = null;
                }
            }
            return out;
        }, circuitText);

        // ── 3) Node 侧断言 ─────────────────────────────────────────────────────
        assert.deepEqual(result.errors, [], `页内场景不应抛错：${JSON.stringify(result.errors)}`);
        assert.ok(result.beforeScopeCount === 0, "剥掉 o 行后电路应零存量 scope");
        assert.deepEqual(result.beforeTargetHits, [], "probe 前 target 不应已被任何 scope 显示");

        // 1) probe voltage：ok + created{probe: 元件id} + 恰好一个 scope 显示该元件
        assert.equal(result.r1.ok, true, `probe voltage 应成功：${JSON.stringify(result.r1)}`);
        assert.equal(result.r1.applied, 1);
        assert.equal(result.r1.created.probe, result.targetId, "created.probe 应为元件稳定 id");
        assert.equal(result.r1.unsupported, 0);
        assert.equal(result.afterR1.hits.length, 1, "恰好一个停靠 scope 显示 target");
        assert.equal(result.afterR1.floating, 0, "不产生浮动 ScopeElm");
        assert.ok(result.afterR1.scopeCount <= result.beforeScopeCount + 1,
            "scope 数至多 +1（viewInScope 复用空槽时不变）");
        const s1 = result.scope1;
        assert.ok(s1, "新 scope 应存在");
        assert.equal(s1.showV, true, "quantity=voltage → showV=true");
        assert.equal(s1.showI, false, "quantity=voltage → showI=false");
        assert.deepEqual(s1.visibleValues, [VAL_VOLTAGE], "可见图只有电压图");
        assert.ok(s1.plots.some((p) => p.value === VAL_VOLTAGE && p.units === UNITS_V && p.elmIdx >= 0),
            `应有 target 的电压图：${JSON.stringify(s1.plots)}`);

        // 2) probe current：同一 scope 原地切 quantity，不新建
        assert.equal(result.r2.ok, true);
        assert.equal(result.r2.created.probe, undefined, "切 quantity 不新建 → created 不含 probe");
        assert.deepEqual(result.afterR2.hits, result.afterR1.hits, "仍是同一个 scope");
        assert.equal(result.afterR2.scopeCount, result.afterR1.scopeCount);
        const s2 = result.scope2;
        assert.equal(s2.showI, true, "quantity=current → showI=true");
        assert.equal(s2.showV, false, "quantity=current → showV=false");
        assert.deepEqual(s2.visibleValues, [VAL_CURRENT], "可见图只有电流图");
        assert.ok(s2.plots.some((p) => p.value === VAL_CURRENT && p.units === UNITS_A && p.elmIdx >= 0),
            `应补建 target 的电流图：${JSON.stringify(s2.plots)}`);

        // 3) 幂等：重复 probe 不重复建
        assert.equal(result.r3.ok, true);
        assert.equal(result.r3.created.probe, undefined, "重复 probe → created 不含 probe");
        assert.deepEqual(result.afterR3.hits, result.afterR1.hits, "始终只有一个 scope 显示 target");
        assert.equal(result.afterR3.scopeCount, result.afterR1.scopeCount, "scope 总数不变");

        // 4) 切回 voltage + 步进 → 探针图采到有限数据
        assert.equal(result.r4.ok, true);
        assert.deepEqual(result.afterR4.hits, result.afterR1.hits, "切回 voltage 仍是同一个 scope");
        assert.ok(!result.step.stopped, `步进不应停机：${JSON.stringify(result.step)}`);
        assert.ok(result.step.frames > 0, "步进应发生");
        assert.ok(result.data.len > 0, "探针图数据缓冲应有数据点");
        assert.equal(result.data.finite, result.data.len, "全部数据点应为有限数");
        assert.equal(result.data.nonZero, true, `步进后探针图应采到非零数据：${JSON.stringify(result.data)}`);

        // 5) unknown target：C03 语义（ok:false + unsupported 含 unknown target），无副作用
        assert.equal(result.r5.ok, false);
        assert.ok(
            String(result.r5.reason).includes("unknown target"),
            `reason 应含 "unknown target"，实际：${result.r5.reason}`,
        );
        assert.deepEqual(result.afterR5.hits, result.afterR1.hits, "失败不产生副作用");

        // 6) unknown quantity：结构化失败
        assert.equal(result.r6.ok, false);
        assert.ok(
            String(result.r6.reason).includes("unknown quantity"),
            `reason 应含 "unknown quantity"，实际：${result.r6.reason}`,
        );
        assert.deepEqual(result.afterR6.hits, result.afterR1.hits, "失败不产生副作用");

        // 7) 第二个元件：再建一个 scope，quantity 独立
        assert.equal(result.r7.ok, true);
        assert.equal(result.r7.created.probe, result.target2Id);
        assert.equal(result.afterR7.hits2.length, 1, "第二个元件恰好一个 scope");
        assert.equal(result.afterR7.scope2?.showI, true);
        assert.deepEqual(result.afterR7.scope2?.visibleValues, [VAL_CURRENT]);

        // 8) 网表 / getMeasurements 不被污染
        assert.equal(result.nl2.compCount, result.compCountBefore, "探针不得进网表元件表");
        assert.equal(result.nl2.scopeElmComps, 0, "不得出现 ScopeElm 影子元件");
        assert.equal(result.nl2.unsupported, result.unsupportedBefore, "unsupported 条目数不变");
        assert.equal(result.meas.compCount, result.compCountBefore, "getMeasurements 元件数不变");
        assert.equal(result.meas.targetFound, true, "getMeasurements 应含被 probe 的元件");
        assert.ok(Number.isFinite(result.meas.targetVd) && Number.isFinite(result.meas.targetCurrent),
            `被 probe 元件的 vd/current 应可读且有限：${JSON.stringify(result.meas)}`);

        // 页面错误（含探针路径上的任何引擎异常）
        assert.deepEqual(pageErrors, [], `页面不应有未捕获异常：${pageErrors.slice(0, 3).join(" | ")}`);

        console.log("[PRB1 ops-probe] ─────────────────────────────────");
        console.log(`[PRB1 ops-probe] target=${result.targetId} target2=${result.target2Id}`);
        console.log(`[PRB1 ops-probe] scopeCount: before=${result.beforeScopeCount} afterR1=${result.afterR1.scopeCount}`);
        console.log(`[PRB1 ops-probe] step: frames=${result.step.frames} elapsed=${result.step.elapsed} stopped=${result.step.stopped}`);
        console.log(`[PRB1 ops-probe] 电压图数据: len=${result.data.len} finite=${result.data.finite} sample=${result.data.sample}`);
        console.log(`[PRB1 ops-probe] 网表: comp=${result.nl2.compCount}/${result.compCountBefore} unsupported=${result.nl2.unsupported}`);
        console.log("[PRB1 ops-probe] ─────────────────────────────────");
    } finally {
        await browser.close();
    }
});
