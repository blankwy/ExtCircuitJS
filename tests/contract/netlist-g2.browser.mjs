// G2 门禁（Stage 2）— set → run 2ms → measure V(n1) 闭环契约测试
//   node tests/contract/netlist-g2.browser.mjs [--base http://127.0.0.1:5174]
//
// 验证（docs/zcode-goal_step.md Stage 2 步骤 7）：
//   1. 载入 lrc.txt → export 网表 → 定位 R1（ResistorElm，稳定 id）
//   2. applyOps set R1=2.2k
//   3. 确定性步进 2ms（冻结 Date.now + 手动驱动 SimulationManager.runCircuit，
//      与 spike/plugin-runtime corpus.mjs 同款配方）
//   4. 测 net "n1" 电压：基线（R=10Ω）与改参（R=2.2k）各跑一遍，
//      断言数值随参数变化且合理（有限、量级受源约束）
//
// 与 boot.browser.mjs 同款环境约定：EXT_PW_CORE / EXT_CHROME / EXC_BASE。

import fs from "node:fs";
import path from "node:path";

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? (process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://127.0.0.1:5174");

function fail(msg) {
    console.error("FAIL:", msg);
    process.exit(1);
}

if (!fs.existsSync(PW_CORE)) fail(`playwright-core not found: ${PW_CORE}`);
if (!fs.existsSync(CHROME)) fail(`chrome not found: ${CHROME}`);

const circuitText = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../core/ts/public/circuits/lrc.txt"),
    "utf8",
);

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

try {
    await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
    await page.waitForTimeout(1200);

    const result = await page.evaluate(async (text) => {
        const ext = window.ExtCircuitJS;
        const out = { errors: [] };

        // ── 确定性步进基座：冻结墙钟 + 手动驱动 runCircuit ───────────────────
        if (!window.__g2RealNow) window.__g2RealNow = Date.now;
        window.__g2FakeNow = 1700000000000;
        Date.now = () => window.__g2FakeNow;

        const stepFor = (elapsedTarget, maxFrames = 4000) => {
            const app = ext.app;
            const sim = app.sim;
            const t0 = sim.t;
            let frames = 0;
            const frame = (didAnalyze) => {
                window.__g2FakeNow += 16;
                if (app.analyzeFlag) {
                    app.analyzeFlag = false;
                    sim.analyzeCircuit();
                }
                sim.runCircuit(didAnalyze);
                frames++;
            };
            frame(true); // didAnalyze=true：越过墙钟节流的首帧
            while (sim.t - t0 < elapsedTarget && frames < maxFrames && !app.stopMessage) frame(false);
            return { frames, elapsed: +(sim.t - t0).toFixed(9), steps: sim.timeStepCount, stopped: app.stopMessage };
        };

        // ── 一次完整场景：载入 → (可选 set) → 步进 2ms → 读 V(n1) ───────────
        // 分析序列按 UIManager.updateCircuit() 的真实顺序：analyzeCircuit 之后
        // 必须走 preStampAndStampCircuit()（分析只建矩阵壳，stamp 才分配行；
        // 只调 preStampCircuit 会让 runCircuit 在 NaN 检查处崩）。
        const analyzeNow = () => {
            ext.app.needAnalyze();
            ext.app.sim.analyzeCircuit();
            ext.app.analyzeFlag = false;
            ext.app.sim.preStampAndStampCircuit();
        };
        const scenario = (setOhm) => {
            ext.api.loadCircuitText(text, false); // 重新载入 = 全新实例、干净初始条件
            analyzeNow();

            const nl = ext.api.dumpNetlist(); // 分配稳定 id + nets
            const target = nl.components.find((c) => c.type === "ResistorElm" && c.props.resistance === 10)
                ?? nl.components.find((c) => c.type === "ResistorElm");
            let ops = null;
            if (setOhm != null) {
                ops = ext.api.applyOps([{ op: "set", target: target.id, prop: "resistance", value: setOhm }]);
                analyzeNow(); // applyOps 只置 analyzeFlag，重 stamp 后步进
            }

            const step = stepFor(0.002);

            // 测 V(n1)：netlist 的 n1（退化时取第一个非地 net）。
            // 电压读取：net pins 形如 "<组件id>:<post>"；components 数组按 elmList 顺序
            // 构造（exportNetlist 用 elms.map），所以组件下标即 elmList 下标。
            const nl2 = ext.api.dumpNetlist();
            const net = nl2.nets.find((n) => n.id === "n1") ?? nl2.nets.find((n) => !n.ground);
            const pin = net?.pins?.[0];
            const m = pin ? /^([^:]+):(\d+)$/.exec(pin) : null;
            const ci = m ? nl2.components.findIndex((c) => c.id === m[1]) : -1;
            const elm = ci >= 0 ? ext.app.elmList[ci] : null;
            const v = elm?.nodes?.[Number(m?.[2])]?.v;
            return {
                targetId: target?.id,
                targetOhm: target?.props?.resistance,
                setApplied: ops?.applied ?? null,
                step,
                net: net?.id ?? null,
                via: elm?.getClassName?.() ?? null,
                t: +ext.app.sim.t.toFixed(9),
                v: typeof v === "number" ? +v.toPrecision(9) : null,
            };
        };

        try {
            out.baseline = scenario(null); // R1 = 10Ω（电路原值）
            out.changed = scenario(2200); // set R1 = 2.2kΩ
        } catch (e) {
            out.errors.push(String((e && e.stack) || e));
        } finally {
            if (window.__g2RealNow) {
                Date.now = window.__g2RealNow;
                window.__g2RealNow = null;
            }
        }

        const b = out.baseline?.v;
        const c = out.changed?.v;
        out.voltageDelta = typeof b === "number" && typeof c === "number" ? +(c - b).toPrecision(9) : null;
        out.ok =
            out.errors.length === 0 &&
            out.baseline?.setApplied === null &&
            out.changed?.setApplied === 1 &&
            typeof b === "number" && Number.isFinite(b) && Math.abs(b) < 1e4 &&
            typeof c === "number" && Number.isFinite(c) && Math.abs(c) < 1e4 &&
            out.voltageDelta !== null && Math.abs(out.voltageDelta) > 0.01 && // 数值随参数变化
            !out.baseline.step.stopped && !out.changed.step.stopped;
        return out;
    }, circuitText);

    const bad = logs.filter((l) => l.startsWith("[pageerror]") || l.includes("[error]"));
    const summary = {
        ok: result.ok,
        baseline: result.baseline,
        changed: result.changed,
        voltageDelta: result.voltageDelta,
        errors: result.errors,
        consoleErrors: bad.slice(0, 10),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
        console.log("--- console tail ---");
        console.log(logs.slice(-25).join("\n"));
        process.exitCode = 1;
    }
} finally {
    await browser.close();
}
