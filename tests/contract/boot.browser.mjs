// 启动契约测试（真实 Chromium）：验证 ExtBoot 暴露的 window.ExtCircuitJS 与只读/写闭环。
//   node tests/contract/boot.browser.mjs [--base http://127.0.0.1:5174] [--keep]
// 依赖本机 Chrome + playwright-core（与 spike C 同一套，零下载）。

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
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

try {
    await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
    // 给插件宿主一点时间完成 fetch + dynamic import
    await page.waitForTimeout(1200);

    const result = await page.evaluate(async (text) => {
        const ext = window.ExtCircuitJS;
        const out = {
            version: ext.version,
            hasApi: !!ext.api,
            hasPlugins: !!ext.plugins,
            plugins: ext.plugins?.list?.() ?? [],
            commandCount: null,
            netlist: null,
            measurements: null,
            ops: null,
            errors: [],
        };
        try {
            ext.api.loadCircuitText(text, false);
            // 确定性分析：analyzeCircuit 只同步 elmList，nodeList 在 preStampCircuit 里建
            ext.app.needAnalyze();
            ext.app.sim.analyzeCircuit();
            ext.app.sim.preStampCircuit(false);
            const nl = ext.api.dumpNetlist();
            out.netlist = {
                components: nl.components.length,
                nets: nl.nets.length,
                schema: nl.schema,
                sample: nl.components.slice(0, 4),
                unsupported: nl.unsupported.slice(0, 4),
            };
            const m = ext.api.getMeasurements();
            out.measurements = { t: m.t, nets: m.nets.length, components: m.components.length };
            const target = ext.api.listComponents().find((c) => c.type === "ResistorElm");
            out.ops = target
                ? ext.api.applyOps([{ op: "set", target: target.id, prop: "resistance", value: 2200 }])
                : { ok: false, applied: 0, unsupported: [{ reason: "no ResistorElm in circuit" }] };
            out.commandCount = ext.api.listComponents().length;

            // 生命周期：热重载 + 卸载（插件契约的最小验证）
            out.lifecycle = { before: ext.plugins.list() };
            await ext.plugins.reload("hello");
            out.lifecycle.afterReload = ext.plugins.list();
            await ext.plugins.deactivate("hello");
            out.lifecycle.afterDeactivate = ext.plugins.list();
            await ext.plugins.activate({
                id: "hello", entry: "index.js", version: "0.1.0", rev: Date.now(),
            });
            out.lifecycle.afterReactivate = ext.plugins.list();
        } catch (e) {
            out.errors.push(String(e && e.stack || e));
        }
        return out;
    }, circuitText);

    const bad = logs.filter((l) => l.startsWith("[pageerror]") || l.includes("[error]"));
    const summary = {
        ok: result.hasApi && result.netlist && result.netlist.components > 0 && (result.ops?.applied ?? 0) === 1,
        version: result.version,
        plugins: result.plugins,
        netlist: result.netlist && {
            components: result.netlist.components,
            nets: result.netlist.nets,
            schema: result.netlist.schema,
            unsupported: result.netlist.unsupported.length,
        },
        ops: result.ops,
        lifecycle: result.lifecycle && {
            before: result.lifecycle.before?.length ?? 0,
            afterReload: result.lifecycle.afterReload?.map((p) => p.state) ?? [],
            afterDeactivate: result.lifecycle.afterDeactivate?.length ?? 0,
            afterReactivate: result.lifecycle.afterReactivate?.map((p) => p.state) ?? [],
        },
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
    if (!process.argv.includes("--keep")) await browser.close();
}
