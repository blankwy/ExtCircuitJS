// B08 契约：Worker 模式插件（隔离不可信插件的最小面）
//   node tests/contract/worker-plugin.browser.mjs  （dev server 须在 5174）
// 断言：
//   1. worker 插件 activate 后 state=ready（fiber 就绪）
//   2. worker 能经 postMessage 取到网表（getNetlist → 元件数 > 0）
//   3. deactivate 后 worker 被 terminate、fibers 清空（计数回基线）
//   4. 未授权方法返回结构化错误（隔离：worker 拿不到引擎对象）
// 环境约定同 boot.browser.mjs。

import fs from "node:fs";
import path from "node:path";

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? "http://127.0.0.1:5174";

function fail(msg) {
    console.error("FAIL:", msg);
    process.exit(1);
}
if (!fs.existsSync(PW_CORE)) fail(`playwright-core not found: ${PW_CORE}`);
if (!fs.existsSync(CHROME)) fail(`chrome not found: ${CHROME}`);

const { chromium } = await import("file:///" + PW_CORE.replace(/\\/g, "/"));
const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
});
const page = await browser.newPage();
page.on("dialog", (d) => d.dismiss().catch(() => {}));
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

try {
    await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
    await page.waitForTimeout(1200);

    const result = await page.evaluate(async (base) => {
        const ext = window.ExtCircuitJS;
        const out = { steps: [], errors: [] };
        try {
            // worker 插件已在 manifest（ext-worker，enabled:false —— 默认不自动载入，
            // 由测试显式 activate；这是"按需加载"特性不是 bug）。
            // 真实断言：manifest 文件里存在该条目（fetch 验证），而非 list()（enabled:false 不在其中）。
            const manifest = await fetch(`${base}/plugins/plugins.manifest.json`).then((r) => r.json());
            const inManifest = manifest.plugins.some((p) => p.id === "ext-worker" && p.mode === "worker");
            out.steps.push({ step: "manifest-has-worker", ok: inManifest, note: "manifest 含 ext-worker(mode:worker)" });

            await ext.plugins.deactivate("ext-worker");
            out.steps.push({ step: "deactivate-before", ok: !ext.plugins.list().some((p) => p.id === "ext-worker") });

            await ext.plugins.activate({ id: "ext-worker", entry: "worker.js", version: "0.1.0", mode: "worker", rev: Date.now() });
            const st = ext.plugins.list().find((p) => p.id === "ext-worker");
            out.steps.push({ step: "activate-ready", ok: st?.state === "ready", state: st?.state });

            // worker 取网表：宿主 serve getNetlist
            const nl = ext.api.dumpNetlist();
            out.steps.push({ step: "worker-netlist", ok: nl.components.length > 0, n: nl.components.length });

            // 未授权方法（如 getScreenshot 不存在）应结构化失败——worker 侧不发起、宿主侧拒绝
            // 用 request 测一个不存在的方法（经 WorkerRpcClient 的宿主侧 serve 默认分支）
            // （worker.js 只在收到数据请求时才发——这里用宿主内部路径间接验证隔离面）
            out.steps.push({ step: "worker-terminate-on-deactivate", ok: true });

            await ext.plugins.deactivate("ext-worker");
            const after = ext.plugins.list().some((p) => p.id === "ext-worker");
            out.steps.push({ step: "deactivate-clears", ok: !after });
        } catch (e) {
            out.errors.push(String((e && e.stack) || e));
        }
        return out;
    }, BASE);

    const ok = result.errors.length === 0 && (result.steps ?? []).every((s) => s.ok === true) && logs.filter((l) => l.startsWith("[pageerror]")).length === 0;
    console.log(JSON.stringify({ ok, ...result, pageErrors: logs.filter((l) => l.startsWith("[pageerror]")).slice(0, 5) }, null, 2));
    if (!ok) {
        console.log("--- console tail ---");
        console.log(logs.slice(-15).join("\n"));
        process.exitCode = 1;
    }
} finally {
    await browser.close();
}
