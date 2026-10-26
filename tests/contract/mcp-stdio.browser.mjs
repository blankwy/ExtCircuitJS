// MCP stdio 端到端（真实宿主视角）：独立进程起 `ext mcp`，只通过 stdin/stdout 说
// 标准 MCP 协议，跑通「读网表 → 改参数 → 确定性步进 → 读电压 → 截图」。
//
//   node tests/contract/mcp-stdio.browser.mjs
//
// 与 mcp-tools / ai-loop 的区别（这条专门补 G4 的外部客户端缺口）：
//   - 前面两者是**同进程**直接 import packages/mcp（拿得到 bridge 对象，可以绕过协议）；
//   - 这里连 bridge 对象都摸不到：只有一个子进程、两根管道。协议不对（握手/分帧/
//     content 形状）就必然失败，这正是真实 MCP 宿主看到的东西。
//
// 自管理验证（本测试的第二个目的）：
//   - 用**专用端口**（默认 5191）而不是共用 5174，强制走「探活失败 → 自己拉起 dev server」；
//   - 断言 stderr 里出现「dev server 就绪」与「backend ready」；
//   - 关掉 stdin 后断言进程退出码 0、且该端口不再响应（进程树被回收，不留孤儿 vite）。
//
// 环境约定：EXT_PW_CORE（playwright-core index.*）/ EXT_CHROME / EXC_BASE（默认
// http://127.0.0.1:5191）/ EXT_MCP_PORT（同上，给 EXC_BASE 用）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NODE = process.execPath;
const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.EXT_MCP_PORT ?? "5191");
const BASE = process.env.EXC_BASE ?? `http://127.0.0.1:${PORT}`;
const LRC_TEXT = fs.readFileSync(path.join(ROOT, "core/ts/public/circuits/lrc.txt"), "utf8");

/** 基线：lrc.txt 载入后经 step RPC 确定性推进 2ms，n1 电压（examples/ai-loop.mjs 同款配方，4.80356V） */
const BASELINE_N1 = 4.80356;
const BASELINE_TOL = 0.005;

function probe(url) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on("error", () => resolve(0));
        req.setTimeout(2000, () => { req.destroy(); resolve(0); });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg, extra) {
    console.log(JSON.stringify({ ok: false, error: msg, ...(extra ?? {}) }, null, 2));
    process.exit(1);
}

// ── 子进程 + NDJSON 协议客户端（一个「标准 MCP 客户端」的最小实现）──────────
function spawnServer() {
    const child = spawn(NODE, [path.join(ROOT, "tools", "ext.mjs"), "mcp"], {
        cwd: ROOT,
        env: { ...process.env, EXC_BASE: BASE, EXT_PW_CORE: PW_CORE, EXT_CHROME: CHROME },
        stdio: ["pipe", "pipe", "pipe"],
    });

    const pending = new Map();
    const stderrChunks = [];
    let stdoutBuf = "";
    let nextId = 1;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => stderrChunks.push(d));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk;
        let i;
        while ((i = stdoutBuf.indexOf("\n")) >= 0) {
            const line = stdoutBuf.slice(0, i).trim();
            stdoutBuf = stdoutBuf.slice(i + 1);
            if (!line) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch (e) {
                fail(`stdout 出现非 JSON 帧（协议被污染）: ${line.slice(0, 200)}`, { stderr: stderrChunks.join("") });
            }
            const waiter = pending.get(msg.id);
            if (waiter) {
                pending.delete(msg.id);
                waiter.resolve(msg);
            }
        }
    });

    const exited = new Promise((resolve) => {
        child.on("exit", (code, signal) => {
            // 子进程先死时，别让请求悬着（否则事件循环空转会得到 "unsettled top-level await"）
            for (const [, w] of pending) w.reject(new Error(`MCP 服务器进程退出（code=${code} signal=${signal}）`));
            pending.clear();
            resolve({ code, signal });
        });
    });

    const send = (method, params) => {
        const id = nextId++;
        const frame = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`MCP 请求超时（${method}）：${frame.slice(0, 200)}`));
            }, 180_000);
            child.stdin.write(frame + "\n", () => clearTimeout(timer));
        });
    };

    const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) + "\n");

    return { child, send, notify, exited, stderr: () => stderrChunks.join("") };
}

/** 断言协议错误（非 isError）：读 result 里的 content 并 JSON 解析 */
function expectOk(res, label) {
    if (res.error) fail(`${label} 返回协议错误: ${JSON.stringify(res.error)}`);
    const out = res.result;
    if (out.isError === true) fail(`${label} 返回 isError: ${JSON.stringify(out.structuredContent ?? out.content)}`);
    const text = out.content?.find?.((c) => c.type === "text")?.text;
    let parsed = null;
    try { parsed = text == null ? null : JSON.parse(text); } catch { /* 非 JSON 文本（截图摘要不会走到这里） */ }
    if (parsed == null || parsed.ok !== true) fail(`${label} 的业务结果不是 ok:true: ${text}`);
    return parsed;
}

async function main() {
    const t0 = Date.now();
    const portBefore = await probe(`${BASE}/circuitjs.html`);
    if (portBefore !== 0) {
        fail(`端口 ${PORT} 上已有服务在跑（探活 ${portBefore}）；本测试要验证「自动拉起」，请换 EXT_MCP_PORT 或先停掉它`);
    }

    const s = spawnServer();
    const out = { ok: false, base: BASE, tools: null, netlist: null, baseline: null, after: null, screenshot: null };

    try {
        // ── 1) 握手 ─────────────────────────────────────────────────────────
        const init = await s.send("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "ext-contract-stdio", version: "0.0.0" },
        });
        if (init.error) fail(`initialize 失败: ${JSON.stringify(init.error)}`, { stderr: s.stderr() });
        if (init.result?.protocolVersion !== "2025-06-18") {
            fail(`协议版本协商失败: ${JSON.stringify(init.result?.protocolVersion)}`);
        }
        if (init.result?.capabilities?.tools == null) fail("initialize 未声明 tools 能力");
        s.notify("notifications/initialized");

        // 懒启动：握手完不该有浏览器（此时端口仍未就绪）
        out.lazyBeforeCall = (await probe(`${BASE}/circuitjs.html`)) === 0;

        // ── 2) 列工具 ───────────────────────────────────────────────────────
        const list = await s.send("tools/list");
        if (list.error) fail(`tools/list 失败: ${JSON.stringify(list.error)}`);
        out.tools = list.result.tools.map((t) => t.name);
        const missing = ["sim.step", "circuit.load_netlist", "circuit.set_param", "sim.read_measurements"]
            .filter((n) => !out.tools.includes(n));
        if (missing.length) fail(`工具清单缺项: ${missing.join(", ")}`, { tools: out.tools });

        // ── 3) 第一次工具调用：后端在这时才起来（dev server + 浏览器 + 桥）──
        expectOk(await s.send("tools/call", { name: "circuit.load_netlist", arguments: { text: LRC_TEXT } }), "circuit.load_netlist");

        const nl = expectOk(await s.send("tools/call", { name: "circuit.get_netlist", arguments: {} }), "circuit.get_netlist").netlist;
        out.netlist = { components: nl.components.length, nets: nl.nets.length };
        if (!(nl.components.length >= 7)) fail(`lrc 至少 7 个元件，实际 ${nl.components.length}`);

        const resistor = nl.components.find((c) => c.type === "ResistorElm" && c.props?.resistance === 10)
            ?? nl.components.find((c) => c.type === "ResistorElm");
        if (resistor == null) fail("网表里没有 ResistorElm");
        const signalNet = nl.nets.find((n) => n.name === "n1") ?? nl.nets.find((n) => n.id === "n1") ?? nl.nets.find((n) => !n.ground);
        if (signalNet == null) fail("网表里没有非地网络");

        // ── 4) 确定性步进 + 读数（不碰任何 Node 侧对象，纯协议）──────────────
        const step = expectOk(await s.send("tools/call", { name: "sim.step", arguments: { seconds: 0.002 } }), "sim.step");
        const meas = expectOk(await s.send("tools/call", { name: "sim.read_measurements", arguments: {} }), "sim.read_measurements");
        out.baseline = { t: meas.t, steps: step.timeStepCount, net: signalNet.id, v: meas.values[signalNet.id] };
        if (Math.abs(meas.t - (step.t ?? 0.002)) > 1e-9) fail(`读数时间轴与步进不一致: ${meas.t} vs ${step.t}`);
        if (Math.abs(meas.values[signalNet.id] - BASELINE_N1) > BASELINE_TOL) {
            fail(`V(${signalNet.id}) 偏离基线: ${meas.values[signalNet.id]}（基线 ${BASELINE_N1}±${BASELINE_TOL}）`);
        }

        // ── 5) 改参数 → 重步进 → 电压必须变 ─────────────────────────────────
        expectOk(await s.send("tools/call", {
            name: "circuit.set_param",
            arguments: { target: resistor.id, prop: "resistance", value: 2200 },
        }), "circuit.set_param");
        const nl2 = expectOk(await s.send("tools/call", { name: "circuit.get_netlist", arguments: {} }), "circuit.get_netlist(复读)").netlist;
        const r2 = nl2.components.find((c) => c.id === resistor.id);
        if (r2?.props?.resistance !== 2200) fail(`set_param 未生效: ${JSON.stringify(r2?.props)}`);

        expectOk(await s.send("tools/call", { name: "sim.reset", arguments: {} }), "sim.reset");
        const step2 = expectOk(await s.send("tools/call", { name: "sim.step", arguments: { seconds: 0.002 } }), "sim.step(改参后)");
        const meas2 = expectOk(await s.send("tools/call", { name: "sim.read_measurements", arguments: {} }), "sim.read_measurements(改参后)");
        out.after = { t: meas2.t, steps: step2.timeStepCount, net: signalNet.id, v: meas2.values[signalNet.id] };
        if (!(Math.abs(meas2.values[signalNet.id] - meas.values[signalNet.id]) > 0.01)) {
            fail(`改参后电压没变: ${meas.values[signalNet.id]} → ${meas2.values[signalNet.id]}`);
        }

        // ── 6) 截图：png 走 image content ───────────────────────────────────
        const shot = await s.send("tools/call", { name: "schematic.screenshot", arguments: { format: "png" } });
        if (shot.error) fail(`schematic.screenshot 协议错误: ${JSON.stringify(shot.error)}`);
        const img = shot.result.content.find((c) => c.type === "image");
        if (img == null) fail(`截图未返回 image content: ${JSON.stringify(shot.result.content).slice(0, 200)}`);
        out.screenshot = { mimeType: img.mimeType, base64Bytes: img.data.length };

        // ── 7) 自管理证据（stderr 只看，不参与判定逻辑的因果）──────────────
        const err = s.stderr();
        out.devServerSpawned = /dev server 未就绪/.test(err) && /dev server 就绪/.test(err);
        out.backendReady = /backend ready/.test(err);
        if (!out.devServerSpawned) fail("stderr 里没有『自动拉起 dev server』的痕迹（自管理未生效）", { stderr: err.slice(-2000) });
        if (!out.backendReady) fail("stderr 里没有 backend ready", { stderr: err.slice(-2000) });
    } finally {
        // ── 8) 关 stdin → 进程退出 → 端口释放（进程树回收）──────────────────
        s.child.stdin.end();
        const exit = await Promise.race([s.exited, sleep(30_000).then(() => ({ code: "timeout", signal: null }))]);
        out.exit = exit;
        let released = false;
        for (let i = 0; i < 30; i++) {
            if ((await probe(`${BASE}/circuitjs.html`)) === 0) { released = true; break; }
            await sleep(300);
        }
        out.portReleased = released;
        out.stderrTail = s.stderr().split("\n").slice(-6);
    }

    if (out.exit?.code !== 0) fail(`进程退出码 ${out.exit?.code}（signal ${out.exit?.signal}）`, { stderr: out.stderrTail });
    if (!out.portReleased) fail(`dev server 未随进程退出（${BASE} 仍在响应）——进程树没回收`, { stderr: out.stderrTail });

    out.ok = true;
    out.elapsedMs = Date.now() - t0;
    console.log(JSON.stringify(out, null, 2));
}

await main().catch((e) => fail(`异常: ${e?.stack ?? e}`));
