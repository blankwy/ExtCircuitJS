// D04 — ai-loop 闭环 demo（Stage 5）：一条命令跑通 AI 改参回路，输出前后对比
//
//   node examples/ai-loop.mjs
//
// 输出（含 "V(" 行）：
//   读网表（元件 + 参数）→ 基线跑 2ms → 读电压
//   → set 电阻 2.2k → 重载后跑干净的 2ms → 读电压 → 前后对比（两组电压数值 + 参数）
//
// 全链路走 Stage 5 的 MCP 主链（与外部 MCP 客户端同款工具面）：
//   Node AttachToolset（packages/mcp/src/tools.ts，D03）
//     ── ws://127.0.0.1:<port> 本地环回 WebSocket（packages/mcp/src/bridge-client.ts，D02）──
//   页面内桥 ExtMcpBridge（cover/ts/ExtMcpBridge.ts，动态 import 后挂
//   window.ExtCircuitJS.mcp）→ 真实引擎（不改 core 仿真循环）。
//
// 步进确定性 = G2 配方：sim.step 工具背后的页面桥 step RPC 内部冻结 Date.now 并手动
// 驱动 analyzeCircuit → preStampAndStampCircuit → runCircuit 帧循环（与
// tests/contract/netlist-g2.browser.mjs 的 stepFor 同款，见 ExtMcpBridge.ts
// runFor/analyzeNow）。v0.1.1 起工具面自带 sim.step，demo 不再绕过工具面直连桥
// （sim.run 是墙钟实时步进，确定性不成立，不能用来对拍数值）。
//
// 两个场景各自重新载入 lrc.txt（全新实例、干净初始条件、时间轴归零，G2 门禁
// 同款）：基线 R=10Ω 与改参 R=2.2kΩ 的电压落在同一 t≈2ms 点上，ΔV 只反映参数。
//
// 环境约定与 tests/contract/*.browser.mjs 同款：
//   EXT_PW_CORE（playwright-core index.mjs）/ EXT_CHROME（Chrome 路径）/
//   EXC_BASE（默认 http://127.0.0.1:5174；dev server 须在跑：
//   node tools/ext.mjs dev --port 5174）。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { register } from "node:module";

// Node 侧加载 packages/mcp 的 TS（无扩展名相对导入补 .ts；helpers 自定位仓库根）
register(new URL("../tests/contract/helpers/ts-resolve.mjs", import.meta.url));
const { McpBridgeClient } = await import("../packages/mcp/src/bridge-client.ts");
const { AttachToolset } = await import("../packages/mcp/src/tools.ts");

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? "http://127.0.0.1:5174";

/** 页面内桥模块：/@fs 让 Vite dev server 按普通模块转译 TS（server.fs.allow 含仓库根） */
const BRIDGE_MODULE_URL =
    "/@fs/" + path.resolve(import.meta.dirname, "../cover/ts/ExtMcpBridge.ts").replace(/\\/g, "/");

const LRC_TEXT = fs.readFileSync(
    path.resolve(import.meta.dirname, "../core/ts/public/circuits/lrc.txt"),
    "utf8",
);

function fail(msg) {
    console.error("FAIL:", msg);
    process.exit(1);
}

/** 电压列宽对齐的紧凑数值 */
function fmtV(v) {
    return (+v.toPrecision(6)) + " V";
}

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

// ── 环境检查（与契约测试同款，缺什么提示什么）───────────────────────────────
if (!fs.existsSync(PW_CORE)) fail(`playwright-core not found: ${PW_CORE}（可用 EXT_PW_CORE 覆盖）`);
if (!fs.existsSync(CHROME)) fail(`chrome not found: ${CHROME}（可用 EXT_CHROME 覆盖）`);
const serverStatus = await probeServer(`${BASE}/circuitjs.html`);
if (!(serverStatus >= 200 && serverStatus < 400)) {
    fail(`dev server 不可达（${BASE} → ${serverStatus}）；先起服务：node tools/ext.mjs dev --port 5174`);
}

const bridge = await McpBridgeClient.listen({ port: 0 });
let browser = null;
const pageErrors = [];

try {
    const { chromium } = await import("file:///" + PW_CORE.replace(/\\/g, "/"));
    browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
    });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
    await page.waitForTimeout(1200); // 插件宿主 fetch + dynamic import（契约测试同款）

    // 页面内装载桥模块并连入环回服务器（D02 契约同款）
    const attached = await page.evaluate(async ({ modUrl, wsUrl }) => {
        const mod = await import(modUrl);
        const b = mod.getMcpBridge() ?? mod.attachMcpBridge(window.ExtCircuitJS);
        b.connect(wsUrl);
        return { attached: window.ExtCircuitJS.mcp === b };
    }, { modUrl: BRIDGE_MODULE_URL, wsUrl: bridge.url });
    if (attached.attached !== true) fail("页面桥未挂到 window.ExtCircuitJS.mcp");
    await bridge.waitPage(15000);

    // MCP 工具面（D03）：懒/显式开会话，全部工具调用落在同一活电路上
    const tools = new AttachToolset(bridge, { timeoutMs: 60_000 });
    const opened = await tools.openSession();
    if (opened.ok !== true) fail(`open session 失败: ${JSON.stringify(opened)}`);

    /** RPC 层失败（payload.ok===false）原样报错退出 */
    const mustOk = (label, r) => {
        if (r == null || r.ok !== true) fail(`${label} 失败: ${JSON.stringify(r)}`);
        return r;
    };

    /**
     * 一个完整场景（G2 配方）：载入 lrc.txt → 读网表 → (可选 set 电阻) →
     * 跑 2ms → 读全网电压。每个场景重新载入 = 全新实例、干净初始条件。
     */
    const scenario = async (setOhm) => {
        mustOk("circuit.load_netlist", await tools.call("circuit.load_netlist", { text: LRC_TEXT }));

        // 读网表：稳定 id（e1..eN）+ 参数；定位改参目标（10Ω 电阻）
        const nl = mustOk("circuit.get_netlist", await tools.call("circuit.get_netlist")).netlist;
        const target = nl.components.find((c) => c.type === "ResistorElm" && c.props.resistance === 10)
            ?? nl.components.find((c) => c.type === "ResistorElm");
        if (target == null) fail("网表中没有 ResistorElm 可作改参目标");

        let applied = null;
        if (setOhm != null) {
            const sr = mustOk("circuit.set_param", await tools.call("circuit.set_param",
                { target: target.id, prop: "resistance", value: setOhm }));
            applied = sr.applied;
        }

        // 跑 2ms：sim.step = 桥 step 的同款配方（冻结 Date.now + analyzeCircuit →
        // preStampAndStampCircuit → runCircuit 帧循环），页面侧确定性拉取。
        // v0.1.1 起它已在工具面上（此前 demo 得绕过工具面直连桥）。
        const step = await tools.call("sim.step", { seconds: 0.002 });
        if (step == null || step.ok !== true) fail(`sim.step 失败: ${JSON.stringify(step)}`);

        // 读电压：sim.read_measurements（无过滤 = 全网 voltage）
        const meas = mustOk("sim.read_measurements", await tools.call("sim.read_measurements"));

        // 复读网表拿落盘后的参数（set_param 后经同一会话可见）
        const nlAfter = mustOk("circuit.get_netlist", await tools.call("circuit.get_netlist")).netlist;
        const targetAfter = nlAfter.components.find((c) => c.id === target.id) ?? target;

        return {
            netlist: nlAfter,
            target: targetAfter,
            applied,
            step,
            values: meas.values,
            t: meas.t,
        };
    };

    console.log("=== ExtCircuitJS ai-loop demo (D04): 读网表 → set 电阻 → 跑 2ms → 读电压 ===");
    console.log(`页面 ${BASE}/circuitjs.html · 桥 ${bridge.url} · 会话 ${tools.id}`);

    const before = await scenario(null);
    const after = await scenario(2200);

    /** 打印一组「参数 + 电压」 */
    const printGroup = (title, sc) => {
        console.log(`\n── ${title} ──`);
        console.log(`参数: ${sc.target.id} (${sc.target.type}) resistance = ${sc.target.props.resistance} Ω`);
        console.log(`读网表: ${sc.netlist.components.length} components / ${sc.netlist.nets.length} nets`);
        console.log(`跑 2ms → t = ${+(+sc.step.t).toFixed(6)} s, ${sc.step.timeStepCount} engine steps`);
        console.log(`读电压 (sim.read_measurements @ t=${+(+sc.t).toFixed(6)} s):`);
        const width = Math.max(...Object.keys(sc.values).map((k) => k.length));
        for (const [net, v] of Object.entries(sc.values)) {
            console.log(`  V(${net.padEnd(width)}) = ${fmtV(v)}`);
        }
    };

    printGroup("改参前（基线）", before);
    printGroup(
        `改参后（set ${after.target.id}.resistance = ${after.target.props.resistance} Ω，applied ${after.applied}）`,
        after,
    );

    // ── 前后对比：同一 t≈2ms 点上，ΔV 只反映参数变化 ─────────────────────────
    console.log("\n── 前后对比 ──");
    console.log(`参数: R ${before.target.props.resistance} Ω → ${after.target.props.resistance} Ω (×${after.target.props.resistance / before.target.props.resistance})`);
    let maxDelta = 0;
    let maxDeltaNet = null;
    const width = Math.max(...Object.keys(before.values).map((k) => k.length));
    for (const net of Object.keys(before.values)) {
        const b = before.values[net];
        const a = after.values[net];
        if (typeof b !== "number" || typeof a !== "number") continue;
        const d = a - b;
        console.log(`  V(${net.padEnd(width)}) : ${fmtV(b)} → ${fmtV(a)} (Δ ${d >= 0 ? "+" : ""}${(+d.toPrecision(6))} V)`);
        // 地网络电压恒 0，排除掉再找最大变化
        const ground = after.netlist.nets.find((n) => n.id === net)?.ground === true;
        if (!ground && Number.isFinite(d) && Math.abs(d) > Math.abs(maxDelta)) {
            maxDelta = d;
            maxDeltaNet = net;
        }
    }

    // ── 自检（G2 门禁同款口径）：数值有限且随参数变化 ─────────────────────────
    const allFinite = Object.values(before.values).concat(Object.values(after.values))
        .every((v) => typeof v === "number" && Number.isFinite(v));
    const changed = maxDeltaNet != null && Math.abs(maxDelta) > 0.01;
    if (pageErrors.length > 0) fail(`页面运行期间有 pageerror: ${pageErrors.slice(0, 3).join(" | ")}`);
    if (!allFinite) fail("电压读数存在非有限值");
    if (!changed) fail(`电压未随参数变化（max |ΔV| = ${maxDelta}，需要 > 0.01）`);
    if (after.applied !== 1) fail(`set 应恰好应用 1 条 op，实际 applied=${after.applied}`);

    console.log(`\ndemo OK: 电压随参数变化且有限（max |ΔV(${maxDeltaNet})| = ${(+(Math.abs(maxDelta).toPrecision(6)))} V > 0.01）；会话 ${tools.id} 全程同一活电路`);
} finally {
    await bridge?.close();
    await browser?.close();
}
