// 产物契约测试（真实 Chromium）：把 dist/ 当**站点**打开，验证生产构建是可用的。
//   node tests/contract/dist-site.browser.mjs [--prefix /ExtCircuitJS] [--prefix ""] [--port 5199]
//
// 为什么需要它：dev 走 Vite 自己的解析，10 套浏览器契约全绿也不代表 dist 能用——
// v0.1.0 的 dist 就是启动即崩（coverOverlay 交还反斜杠 id → 同一份源码两个模块实例，
// 两个 CirSim 类，registerElements 里 CirSim.theApp 是 undefined）。见 HANDOVER §4 坑位 9。
//
// 默认跑两种挂载形态（都断言）：
//   ""（站点根，自定义域根路径的形态）
//   /ExtCircuitJS（项目页子路径，最严形态：绝对路径类问题只有这里会露）
//
// 每个形态的断言：
//   1. 站点根（index.html）能起应用：window.ExtCircuitJS 就绪、canvas 存在
//   2. 站内请求 0 个 4xx/5xx/网络失败（含 <base>/plugins/ 的动态 import）
//   3. 插件全部 ready（证明插件根 URL 是按文档推的，不是硬编码 "/plugins/"）
//   4. 确定性步进 2ms 后 V(n1) > 1V（与 netlist-g2 同序列，dist 里数值必须和 dev 一致）
//
// 一个形态一台 server + 独立端口：Service Worker 的预缓存请求会在 context 关闭后仍有一两个
// in-flight，共用 server 时会被下一种形态误判成"跑到前缀外"（根路径的 SW 解析出 /circuitjs/...
// 本来就是对的）。端口隔离后各形态的越界统计互不污染。
//
// 依赖本机 Chrome + playwright-core（EXT_PW_CORE / EXT_CHROME，与其它浏览器契约同套）。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const repoRoot = path.resolve(import.meta.dirname, "../..");
const dist = path.join(repoRoot, "dist");
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);

const prefixes = [];
for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--prefix") prefixes.push(String(process.argv[i + 1] ?? "").replace(/\/$/, ""));
}
// 默认两种形态都跑：站点根 + 子路径（后者会暴露绝对路径类问题）
const cases = prefixes.length ? prefixes : ["", "/ExtCircuitJS"];
const basePort = Number(arg("--port", "5199"));

function fail(msg) {
    console.error("FAIL:", msg);
    process.exit(1);
}
if (!fs.existsSync(PW_CORE)) fail(`playwright-core not found: ${PW_CORE}`);
if (!fs.existsSync(CHROME)) fail(`chrome not found: ${CHROME}`);
if (!fs.existsSync(path.join(dist, "index.html"))) fail(`dist not built: ${dist}（先跑 node tools/ext.mjs build）`);

const MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
    ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};

/** 极简静态服务：把 <dist> 挂在 <prefix>/ 下，前缀外一律 404（模拟 Pages 的 /<repo>/） */
function makeServer(prefix, outside) {
    return http.createServer((req, res) => {
        const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const inPrefix = prefix === "" || url === prefix || url.startsWith(prefix + "/");
        if (!inPrefix) {
            outside.push(url);
            res.writeHead(404).end("outside prefix");
            return;
        }
        let rel = url.slice(prefix.length).replace(/^\//, "");
        if (rel === "" || rel.endsWith("/")) rel += "index.html";
        const file = path.join(dist, rel);
        if (!file.startsWith(dist) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404).end("not found");
            return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
    });
}

const circuitText = fs.readFileSync(path.join(repoRoot, "core/ts/public/circuits/lrc.txt"), "utf8");
const { chromium } = await import("file:///" + PW_CORE.replace(/\\/g, "/"));
const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
});

/** 跑一个挂载形态，返回该 case 的断言结果 */
async function runCase(prefix, port) {
    const outside = [];
    const server = makeServer(prefix, outside);
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://127.0.0.1:${port}`;

    // 每种形态用独立 context：避免 SW 缓存跨 case 串味（根与子路径的 scope 不同）
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const failed = [];
    const logs = [];
    page.on("response", (r) => {
        if (r.status() >= 400 && r.url().startsWith(base)) failed.push({ status: r.status(), url: r.url().replace(base, "") });
    });
    page.on("requestfailed", (r) => {
        // 上游 HTML 带的外部脚本（dropbox）不在断言范围
        if (r.url().startsWith(base)) failed.push({ status: "netfail", url: r.url().replace(base, ""), err: r.failure()?.errorText });
    });
    page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

    const summary = { prefix: prefix || "(根路径)", target: `${base}${prefix}/`, ok: false };
    try {
        await page.goto(`${base}${prefix}/`, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
        // 插件是串行动态 import：等全部 ready，才能证明 <base>/plugins/ 真的解析对了
        await page.waitForFunction(() => {
            const l = window.ExtCircuitJS?.plugins?.list?.() ?? [];
            return l.length > 0 && l.every((p) => p.state === "ready");
        }, null, { timeout: 30000 });

        const r = await page.evaluate(async (text) => {
            const ext = window.ExtCircuitJS;
            const out = { version: ext.version, plugins: [], errors: [] };
            try {
                out.plugins = (ext.plugins.list() ?? []).map((p) => `${p.id}:${p.state}`);
                out.canvas = !!document.querySelector("canvas");
                ext.api.loadCircuitText(text, false);
                // 确定性步进（netlist-g2 同序列）：冻结墙钟 + 手动驱动 runCircuit。
                // 分析只建矩阵壳，行分配在 preStampAndStampCircuit()；每帧墙钟必须前进，否则被节流。
                let fakeNow = 1700000000000;
                Date.now = () => fakeNow;
                const app = ext.app, sim = app.sim;
                app.needAnalyze();
                sim.analyzeCircuit();
                app.analyzeFlag = false;
                sim.preStampAndStampCircuit();
                const nl = ext.api.dumpNetlist();
                out.netlist = { components: nl.components.length, nets: nl.nets.length };
                const t0 = sim.t;
                let frames = 0;
                const frame = (didAnalyze) => {
                    fakeNow += 16;
                    if (app.analyzeFlag) { app.analyzeFlag = false; sim.analyzeCircuit(); }
                    sim.runCircuit(didAnalyze);
                    frames++;
                };
                frame(true);
                while (sim.t - t0 < 0.002 && frames < 4000 && !app.stopMessage) frame(false);
                const m = ext.api.getMeasurements();
                const volts = m.nets.filter((n) => !n.ground).map((n) => +(n.v ?? 0).toFixed(4));
                out.voltages = volts;
                out.maxVoltage = volts.length ? Math.max(...volts.map(Math.abs)) : 0;
            } catch (e) {
                out.errors.push(String(e?.stack ?? e));
            }
            return out;
        }, circuitText);

        const pageErrors = logs.filter((l) => l.startsWith("[pageerror]"));
        Object.assign(summary, {
            ok: !!r.canvas
                && (r.netlist?.components ?? 0) > 0
                && (r.maxVoltage ?? 0) > 1
                && r.plugins.length > 0 && r.plugins.every((p) => p.endsWith(":ready"))
                && failed.length === 0 && outside.length === 0 && pageErrors.length === 0,
            version: r.version,
            plugins: r.plugins,
            netlist: r.netlist,
            voltages: r.voltages,
            pageErrors,
            failedRequests: failed,
            requestsOutsidePrefix: outside,
            runtimeErrors: r.errors,
        });
    } catch (e) {
        summary.fatal = String(e?.stack ?? e);
        summary.consoleTail = logs.slice(-15);
    } finally {
        // 主动注销 SW：避免它的预缓存请求在 context 关闭后继续打到这台 server 上
        await page.evaluate(() => navigator.serviceWorker?.getRegistrations?.().then((rs) => Promise.all(rs.map((r) => r.unregister())))).catch(() => {});
        await ctx.close();
        await new Promise((r) => server.close(r));
    }
    return summary;
}

const results = [];
for (const [i, p] of cases.entries()) results.push(await runCase(p, basePort + i));
console.log(JSON.stringify(results.length === 1 ? results[0] : { cases: results }, null, 2));
await browser.close();
if (results.some((r) => !r.ok)) process.exitCode = 1;
