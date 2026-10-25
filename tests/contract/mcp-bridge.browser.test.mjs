// D02 — MCP WebSocket 桥契约测试（页面内桥 + Node 客户端）
//   node --test tests/contract/mcp-bridge.browser.test.mjs
//
// 验证（docs/task-board.md D02 / zcode-goal_step.md Stage 5 步骤 2）：
//   1. 协议层（不经浏览器）：零依赖 RFC6455 环回服务器握手/掩码帧收发正确
//      （Node 内置 WebSocket 当"假页面"）。
//   2. 浏览器内 echo 一来一回：页面动态 import cover/ts/ExtMcpBridge.ts
//      （/@fs 由 dev server 转译）→ 自动挂到 window.ExtCircuitJS.mcp →
//      连入环回服务器 → Node echo 请求原样往返。
//   3. 会话 RPC 全链路（真实引擎）：open → load(lrc.txt) → step(2ms) →
//      measure → export(netlist/xml) → close，形状与 D01 语义一致。
//   4. 错误语义跨线：no_circuit / invalid_args / unknown_method /
//      session_closed / unknown_session；页面侧环回守护（非 127.0.0.1 拒连）。
//   5. 会话跨一次重连存活：服务器 dropPage → 页面自动重连 → 同 sessionId
//      继续步进，时间轴/步数累积不丢（会话与连接解耦的核心契约）。
//
// 环境约定与 boot.browser.mjs / netlist-export.test.mjs 同款：
//   EXT_PW_CORE（playwright-core index.mjs）/ EXT_CHROME / EXC_BASE（默认
//   http://127.0.0.1:5174，dev server 须在跑：node tools/ext.mjs dev --port 5174）。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { McpBridgeClient } = await import("../../packages/mcp/src/bridge-client.ts");

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? "http://127.0.0.1:5174";

/** 页面内桥模块：/@fs 让 Vite dev server 按普通模块转译 TS（server.fs.allow 含仓库根） */
const BRIDGE_MODULE_URL =
    "/@fs/" + path.resolve(import.meta.dirname, "../../cover/ts/ExtMcpBridge.ts").replace(/\\/g, "/");

const LRC_TEXT = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../core/ts/public/circuits/lrc.txt"),
    "utf8",
);

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

// ── 1) 协议层：不经浏览器 ───────────────────────────────────────────────────

test("协议层：环回监听 + RFC6455 握手 + 掩码帧收发（Node 内置 WebSocket 当假页面）", { timeout: 30_000 }, async () => {
    assert.equal(typeof WebSocket, "function", "Node ≥22 应内置全局 WebSocket");
    const bridge = await McpBridgeClient.listen({ port: 0 });
    try {
        // SSRF 纪律：仅本地环回监听（listen 是 async 函数，非法 host 以 rejected promise 拒绝）
        assert.match(bridge.url, /^ws:\/\/127\.0\.0\.1:\d+$/, "必须监听在 127.0.0.1");
        await assert.rejects(McpBridgeClient.listen({ host: "0.0.0.0" }), /仅允许本地环回/);
        await assert.rejects(McpBridgeClient.listen({ host: "example.com" }), /仅允许本地环回/);

        const ws = new WebSocket(bridge.url);
        ws.onmessage = (ev) => {
            // 假页面：对收到的 req 原样回 res（echo 语义）
            const env = JSON.parse(String(ev.data));
            if (env.kind === "req") {
                ws.send(JSON.stringify({ v: 1, kind: "res", id: env.id, payload: { ok: true, echo: env.params ?? null } }));
            }
        };
        const opened = new Promise((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("假页面 WebSocket onerror（握手失败）"));
        });
        await opened;
        await bridge.waitPage(5000);
        assert.equal(bridge.pageConnected, true);

        const echoed = await bridge.echo({ hello: "node-protocol", arr: [1, 2, 3] }, 5000);
        assert.deepEqual(echoed.echo, { hello: "node-protocol", arr: [1, 2, 3] }, "一来一回 payload 必须逐字相等");

        // 服务器主动断开生效（重连是页面侧职责，此测试只验证断开）
        bridge.dropPage("protocol-layer-test-done");
        await new Promise((resolve) => {
            ws.onclose = () => resolve();
            setTimeout(resolve, 3000);
        });
        assert.equal(bridge.pageConnected, false);
    } finally {
        await bridge.close();
    }
});

// ── 2) 浏览器侧（共享一个 Chromium 会话 + 一个环回桥）──────────────────────

describe("浏览器侧（真实引擎）", { timeout: 300_000 }, () => {
let browser = null;
let page = null;
let bridge = null;
const pageLogs = [];
const pageErrors = [];

before(async () => {
    assert.ok(fs.existsSync(PW_CORE), `playwright-core 不存在: ${PW_CORE}（可用 EXT_PW_CORE 覆盖）`);
    assert.ok(fs.existsSync(CHROME), `Chrome 不存在: ${CHROME}（可用 EXT_CHROME 覆盖）`);
    const status = await probeServer(`${BASE}/circuitjs.html`);
    assert.ok(status >= 200 && status < 400,
        `dev server 不可达（${BASE} → ${status}）；先起服务：node tools/ext.mjs dev --port 5174`);

    bridge = await McpBridgeClient.listen({ port: 0 });

    const { chromium } = await import("file:///" + PW_CORE.replace(/\\/g, "/"));
    browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
    });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await ctx.newPage();
    page.on("console", (m) => pageLogs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (d) => d.dismiss().catch(() => {}));

    await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
    await page.waitForTimeout(1200); // 插件宿主 fetch + dynamic import

    // 页面内装载桥模块（/@fs 转译 TS）并连入环回服务器
    const attached = await page.evaluate(async ({ modUrl, wsUrl }) => {
        const mod = await import(modUrl);
        const b = mod.getMcpBridge() ?? mod.attachMcpBridge(window.ExtCircuitJS);
        b.connect(wsUrl);
        return { attached: window.ExtCircuitJS.mcp === b, state: b.status().state };
    }, { modUrl: BRIDGE_MODULE_URL, wsUrl: bridge.url });
    assert.equal(attached.attached, true, "桥必须经 window.ExtCircuitJS.mcp 暴露");
    await bridge.waitPage(15000);
});

after(async () => {
    // 浏览器端日志证据（Stage 5 达成条件要求「附浏览器端日志证据」）
    console.log("[D02 mcp-bridge] ─────────────────────────────────");
    const evidence = pageLogs.filter((l) => l.includes("ExtMcpBridge"));
    for (const l of evidence) console.log(`[D02 mcp-bridge] 页面日志: ${l}`);
    if (page && !pageErrors.length) {
        try {
            const st = await page.evaluate(() => window.ExtCircuitJS?.mcp?.status?.() ?? null);
            if (st) console.log(`[D02 mcp-bridge] 页面桥终态: ${JSON.stringify(st)}`);
        } catch { /* 页面已关 */ }
    }
    if (pageErrors.length) console.log(`[D02 mcp-bridge] pageerror×${pageErrors.length}: ${pageErrors.slice(0, 5).join(" | ")}`);
    console.log("[D02 mcp-bridge] ─────────────────────────────────");
    await bridge?.close();
    await browser?.close();
});

test("浏览器内 echo 一来一回（window.ExtCircuitJS.mcp ↔ 环回服务器）", { timeout: 60_000 }, async () => {
    const payload = { hello: "浏览器", nested: { n: 42, list: [1, 2, 3] } };
    const r = await bridge.echo(payload, 10_000);
    assert.equal(r.ok, true);
    assert.deepEqual(r.echo, payload, "echo payload 必须逐字往返");

    const ping = await bridge.request("ping", { timeoutMs: 10_000 });
    assert.equal(ping.ok, true);
    assert.equal(ping.pong, true);
});

/** 地网络 id：优先导出网表里 ground:true 的网络；lrc 无 GroundElm 时回落第一个网络（引擎 nodeList[0] 恒为地） */
async function groundNetId(sid) {
    const net = await bridge.request("export", { sessionId: sid, params: { format: "netlist" }, timeoutMs: 30_000 });
    assert.equal(net.ok, true, `export 失败: ${JSON.stringify(net)}`);
    const nl = JSON.parse(net.payload);
    const g = nl.nets.find((n) => n.ground) ?? nl.nets[0];
    assert.ok(g != null, "网表至少要有一个网络");
    return g.id;
}

test("会话 RPC 全链路（真实引擎）：open → load(lrc) → step(2ms) → measure → export → close", { timeout: 120_000 }, async () => {
    const opened = await bridge.request("open", { timeoutMs: 10_000 });
    assert.equal(opened.ok, true);
    const sid = opened.sessionId;
    assert.match(sid, /^p\d+$/);

    // load 之前：no_circuit
    const early = await bridge.request("step", { sessionId: sid, params: { steps: 1 }, timeoutMs: 10_000 });
    assert.equal(early.ok, false);
    assert.equal(early.error.code, "no_circuit");

    const load = await bridge.request("load", { sessionId: sid, params: { text: LRC_TEXT }, timeoutMs: 30_000 });
    assert.equal(load.ok, true, `load 失败: ${JSON.stringify(load)}`);
    assert.deepEqual(load.unsupported, []);
    assert.equal(load.t, 0);
    assert.equal(load.timeStepCount, 0);

    // 地网络 id 从导出网表推导（有 GroundElm → "GND"；无 → 引擎 nodeList[0]，恒为地）
    const gid = await groundNetId(sid);

    const step = await bridge.request("step", { sessionId: sid, params: { seconds: 0.002 }, timeoutMs: 60_000 });
    assert.equal(step.ok, true, `step 失败: ${JSON.stringify(step)}`);
    assert.ok(step.t >= 0.002 - 1e-9, `t 必须 ≥ 0.002，实际 ${step.t}`);
    assert.ok(step.t <= 0.002 + 5e-4, `t 超出容忍上界（帧粒度），实际 ${step.t}`);
    assert.ok(step.timeStepCount >= 400, `0.002s / maxTimeStep 5e-6 = 400 步，实际 ${step.timeStepCount}`);
    assert.ok(step.frames > 0);

    // measure（默认全 nets）：所有值有限，地网络恒 0
    const meas = await bridge.request("measure", { sessionId: sid, timeoutMs: 30_000 });
    assert.equal(meas.ok, true);
    assert.equal(meas.quantity, "voltage");
    assert.equal(meas.t, step.t);
    assert.ok(Object.keys(meas.values).length >= 2, `至少地网络 + 一个信号网络，实际 ${JSON.stringify(meas.values)}`);
    assert.ok(gid in meas.values, `值里应有地网络 ${gid}，实际 ${JSON.stringify(Object.keys(meas.values))}`);
    assert.equal(meas.values[gid], 0, `地网络 ${gid} 的电压必须恒 0`);
    for (const [k, v] of Object.entries(meas.values)) {
        assert.ok(typeof v === "number" && Number.isFinite(v), `net ${k} 的电压必须有限，实际 ${v}`);
    }

    // export：netlist JSON 可解析且元件数 > 0；xml 非空
    const net = await bridge.request("export", { sessionId: sid, params: { format: "netlist" }, timeoutMs: 30_000 });
    assert.equal(net.ok, true);
    assert.equal(net.format, "netlist");
    const nl = JSON.parse(net.payload);
    assert.ok(Array.isArray(nl.components) && nl.components.length > 0, "导出网表必须有元件");
    assert.equal(net.bytes, Buffer.byteLength(net.payload, "utf8"));
    const xml = await bridge.request("export", { sessionId: sid, params: { format: "xml" }, timeoutMs: 30_000 });
    assert.equal(xml.ok, true);
    // CircuitXMLSerializer 的根元素是 <cir …>（core/ts/CircuitXMLSerializer.ts:98）
    assert.ok(xml.payload.length > 0 && xml.payload.includes("<cir"), `xml 导出非空且根元素为 <cir>，实际前 40 字符: ${xml.payload.slice(0, 40)}`);
    assert.equal(xml.bytes, Buffer.byteLength(xml.payload, "utf8"));

    const closed = await bridge.request("close", { sessionId: sid, timeoutMs: 10_000 });
    assert.equal(closed.ok, true);
    assert.equal(closed.sessionId, sid);
    const afterClose = await bridge.request("measure", { sessionId: sid, timeoutMs: 10_000 });
    assert.equal(afterClose.ok, false);
    assert.equal(afterClose.error.code, "session_closed");
});

test("错误语义跨线：invalid_args / unknown_method / unknown_session / load 内容失败", { timeout: 60_000 }, async () => {
    const opened = await bridge.request("open", { timeoutMs: 10_000 });
    const sid = opened.sessionId;
    await bridge.request("load", { sessionId: sid, params: { text: LRC_TEXT }, timeoutMs: 30_000 });

    // steps 与 seconds 都给 → invalid_args
    const both = await bridge.request("step", { sessionId: sid, params: { steps: 1, seconds: 0.001 }, timeoutMs: 10_000 });
    assert.equal(both.ok, false);
    assert.equal(both.error.code, "invalid_args");
    // 都不给 → invalid_args
    const neither = await bridge.request("step", { sessionId: sid, params: {}, timeoutMs: 10_000 });
    assert.equal(neither.error.code, "invalid_args");

    // 未知 method → unknown_method
    const unknown = await bridge.request("nope", { sessionId: sid, timeoutMs: 10_000 });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "unknown_method");

    // 未知 sessionId → unknown_session
    const ghost = await bridge.request("step", { sessionId: "p99999", params: { steps: 1 }, timeoutMs: 10_000 });
    assert.equal(ghost.error.code, "unknown_session");

    // load 内容失败（空文本）→ {ok:false, unsupported[]}（loader 形状，非 error 通道）
    const badLoad = await bridge.request("load", { sessionId: sid, params: { text: "" }, timeoutMs: 30_000 });
    assert.equal(badLoad.ok, false);
    assert.ok(Array.isArray(badLoad.unsupported) && badLoad.unsupported.length >= 1);
    assert.equal(badLoad.error, undefined, "内容失败不走 error 通道");
    await bridge.request("close", { sessionId: sid, timeoutMs: 10_000 });
});

test("SSRF 环回守护：页面侧 connect 拒绝非环回地址", { timeout: 60_000 }, async () => {
    const guard = await page.evaluate(() => {
        const out = {};
        for (const url of ["ws://10.0.0.5:1234/", "ws://example.com:8080/", "http://127.0.0.1:5174/"]) {
            try {
                window.ExtCircuitJS.mcp.connect(url);
                out[url] = "accepted";
            } catch (e) {
                out[url] = String((e && e.message) || e);
            }
        }
        return out;
    });
    for (const [url, result] of Object.entries(guard)) {
        assert.notEqual(result, "accepted", `connect(${url}) 必须被拒绝`);
        assert.match(String(result), /仅允许本地环回|仅支持 ws/, `connect(${url}) 的拒绝原因: ${result}`);
    }
    // 真实连接未被守护误伤
    const ping = await bridge.request("ping", { timeoutMs: 10_000 });
    assert.equal(ping.pong, true);
});

test("会话跨一次重连存活：dropPage → 页面自动重连 → 同 sessionId 时间轴继续累积", { timeout: 120_000 }, async () => {
    const opened = await bridge.request("open", { timeoutMs: 10_000 });
    const sid = opened.sessionId;
    await bridge.request("load", { sessionId: sid, params: { text: LRC_TEXT }, timeoutMs: 30_000 });
    const gid = await groundNetId(sid);
    const step1 = await bridge.request("step", { sessionId: sid, params: { seconds: 0.001 }, timeoutMs: 60_000 });
    assert.equal(step1.ok, true);
    const connectsBefore = bridge.pageConnects;

    // 服务器主动断开（模拟桥重启/网络闪断）——页面侧应自动重连
    bridge.dropPage("d02-reconnect-test");
    await bridge.waitPage(15_000);
    assert.equal(bridge.pageConnected, true, "页面必须在断线后自动重连");
    assert.equal(bridge.pageConnects, connectsBefore + 1, "pageConnects 必须恰好 +1（一次重连）");

    // 会话在页面侧存活：isAlive / 继续步进 / 时间轴与步数累积
    const alive = await bridge.request("isAlive", { sessionId: sid, timeoutMs: 10_000 });
    assert.equal(alive.ok, true);
    assert.equal(alive.alive, true, `会话 ${sid} 必须跨重连存活`);

    const step2 = await bridge.request("step", { sessionId: sid, params: { seconds: 0.001 }, timeoutMs: 60_000 });
    assert.equal(step2.ok, true, `重连后 step 失败: ${JSON.stringify(step2)}`);
    assert.ok(step2.t >= step1.t + 0.001 - 1e-9, `时间轴必须累积：t1=${step1.t} t2=${step2.t}`);
    assert.ok(step2.timeStepCount > step1.timeStepCount, `步数必须累积：c1=${step1.timeStepCount} c2=${step2.timeStepCount}`);

    const meas = await bridge.request("measure", { sessionId: sid, params: { nets: [gid] }, timeoutMs: 30_000 });
    assert.equal(meas.ok, true);
    assert.equal(meas.values[gid], 0, `重连后地网络 ${gid} 的电压仍必须恒 0`);

    // 页面桥自述：发生过 ≥1 次重连且当前在线
    const st = await page.evaluate(() => window.ExtCircuitJS.mcp.status());
    assert.equal(st.state, "online");
    assert.ok(st.reconnects >= 1, `页面侧 reconnects 必须 ≥1，实际 ${st.reconnects}`);
    assert.equal(st.aliveSessions >= 1, true);
});

test("收尾：全程无 pageerror（页面桥不得抛未捕获异常）", { timeout: 30_000 }, async () => {
    assert.deepEqual(pageErrors, [], "页面运行期间不得有 pageerror");
    const st = await page.evaluate(() => window.ExtCircuitJS.mcp.status());
    assert.equal(st.state, "online");
    assert.equal(st.lastError, null, `页面桥 lastError 应为 null，实际 ${st.lastError}`);
});
}); // describe 浏览器侧
