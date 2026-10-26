// D03 — MCP 工具集契约测试（packages/mcp/src/tools.ts，attach 模式）
//   node --test tests/contract/mcp-tools.browser.test.mjs
//
// 验证（zcode-goal_step.md Stage 5 步骤 3 / task-board D03）：10 个工具全部
// 可调用并返回结构化 JSON，每个工具至少一次成功调用记录（after() 里打印汇总）：
//   circuit.get_netlist / load_netlist / list_components / set_param
//   sim.run / sim.stop / sim.reset / sim.read_measurements / sim.read_scope
//   schematic.screenshot
//
// 锁定的关键语义：
//   1. 工具层校验（不经浏览器）：unknown_tool / invalid_args / 传输层
//      bridge_unavailable 都走结构化返回，绝不抛异常（与 D01 同约定）。
//   2. 会话式：全部工具调用落在 AttachToolset 持有的同一活会话上——set_param
//      的改参效果经后续 get_netlist / read_measurements 可见（无状态调用做不到）。
//   3. sim.read_scope 返回的 minValues/maxValues 是**全量**环形缓冲
//      （length === pointCount），不降采样（Stage 5 禁止项）。
//   4. sim.reset 后 t=0 且时间轴由会话接管（paused）；sim.run/stop 如实报告
//      宿主实时步进的 running 状态。
//
// 环境约定与 mcp-bridge.browser.test.mjs 同款：
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
const { AttachToolset, MCP_TOOLS } = await import("../../packages/mcp/src/tools.ts");

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

// ── 1) 工具层（不经浏览器）：声明 + 校验 + 结构化失败 ───────────────────────

test("工具层：11 工具声明齐全；unknown_tool / invalid_args / bridge_unavailable 结构化返回不抛异常", { timeout: 30_000 }, async () => {
    // 任务卡清单逐一对齐（zcode-goal_step.md Stage 5 步骤 3）；
    // v0.1.1 增补 sim.step —— 任务卡原清单只有墙钟 sim.run，外部 MCP 客户端
    // 拿不到可复现的推进，读数无法对拍（见 HANDOVER §6 待办 2）。
    assert.deepEqual(
        MCP_TOOLS.map((t) => t.name),
        [
            "circuit.get_netlist",
            "circuit.load_netlist",
            "circuit.list_components",
            "circuit.set_param",
            "sim.run",
            "sim.stop",
            "sim.step",
            "sim.reset",
            "sim.read_measurements",
            "sim.read_scope",
            "schematic.screenshot",
        ],
        "工具清单必须与任务卡一致（含 v0.1.1 增补的 sim.step）",
    );
    for (const t of MCP_TOOLS) {
        assert.equal(t.inputSchema.type, "object", `${t.name} 的 inputSchema 必须是 object schema`);
        assert.ok(typeof t.description === "string" && t.description.length > 0, `${t.name} 缺描述`);
    }

    // 无页面的桥：unknown_tool / invalid_args 在触桥之前就返回
    const bridge = await McpBridgeClient.listen({ port: 0 });
    try {
        const ts = new AttachToolset(bridge, { timeoutMs: 1200 });

        const unknown = await ts.call("no.such.tool");
        assert.equal(unknown.ok, false);
        assert.equal(unknown.error.code, "unknown_tool");

        const missing = await ts.call("circuit.load_netlist", {});
        assert.equal(missing.ok, false);
        assert.equal(missing.error.code, "invalid_args", `缺 text 应 invalid_args，实际 ${JSON.stringify(missing)}`);

        const badType = await ts.call("circuit.set_param", { target: "e1", prop: 42, value: 1 });
        assert.equal(badType.ok, false);
        assert.equal(badType.error.code, "invalid_args");

        const badEnum = await ts.call("schematic.screenshot", { format: "gif" });
        assert.equal(badEnum.ok, false);
        assert.equal(badEnum.error.code, "invalid_args");

        // 传输层：页面未连 → 超时后结构化 bridge_unavailable（不抛异常）
        const t0 = Date.now();
        const unavail = await ts.call("sim.run");
        assert.equal(unavail.ok, false);
        assert.equal(unavail.error.code, "bridge_unavailable", `应报 bridge_unavailable，实际 ${JSON.stringify(unavail)}`);
        assert.ok(Date.now() - t0 < 10_000, "超时失败必须快速返回而不是挂死");

        // 懒会话未被失败调用污染
        assert.equal(ts.id, null, "失败调用不得留下半开会话");
    } finally {
        await bridge.close();
    }
});

// ── 2) 浏览器侧：真实引擎 + 工具集全链路 ─────────────────────────────────────

describe("浏览器侧（真实引擎 + 工具集）", { timeout: 300_000 }, () => {
let browser = null;
let page = null;
let bridge = null;
let tools = null;
const pageLogs = [];
const pageErrors = [];
/** list_components 定位的改参目标（ResistorElm 稳定 id），跨测试共享 */
let targetId = null;
/** 每工具成功调用记录（after() 打印，Stage 5 达成条件「8 个工具各一次成功调用记录」） */
const toolRecords = [];

/** 记录一次成功调用（工具名 + 结果摘要） */
function record(name, result) {
    assert.equal(result.ok, true, `${name} 必须成功，实际 ${JSON.stringify(result).slice(0, 400)}`);
    const snippet = JSON.stringify(result);
    toolRecords.push({ tool: name, ok: true, snippet: snippet.length > 160 ? snippet.slice(0, 160) + "…" : snippet });
    return result;
}

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

    const attached = await page.evaluate(async ({ modUrl, wsUrl }) => {
        const mod = await import(modUrl);
        const b = mod.getMcpBridge() ?? mod.attachMcpBridge(window.ExtCircuitJS);
        b.connect(wsUrl);
        return { attached: window.ExtCircuitJS.mcp === b };
    }, { modUrl: BRIDGE_MODULE_URL, wsUrl: bridge.url });
    assert.equal(attached.attached, true, "桥必须经 window.ExtCircuitJS.mcp 暴露");
    await bridge.waitPage(15000);

    // 工具集挂在同一个桥上：懒开会话，全部工具调用落在同一活电路
    tools = new AttachToolset(bridge, { timeoutMs: 60_000 });
});

after(async () => {
    // 每工具成功调用记录（Stage 5 达成条件的证据）
    console.log("[D03 mcp-tools] ─────────────────────────────────");
    const seen = new Set(toolRecords.map((r) => r.tool));
    for (const r of toolRecords) console.log(`[D03 mcp-tools] 成功调用: ${r.tool} → ${r.snippet}`);
    const missing = MCP_TOOLS.map((t) => t.name).filter((n) => !seen.has(n));
    console.log(`[D03 mcp-tools] 工具覆盖: ${seen.size}/${MCP_TOOLS.length}${missing.length ? `，缺: ${missing.join(", ")}` : ""}`);
    const evidence = pageLogs.filter((l) => l.includes("ExtMcpBridge"));
    for (const l of evidence.slice(0, 6)) console.log(`[D03 mcp-tools] 页面日志: ${l}`);
    if (page && !pageErrors.length) {
        try {
            const st = await page.evaluate(() => window.ExtCircuitJS?.mcp?.status?.() ?? null);
            if (st) console.log(`[D03 mcp-tools] 页面桥终态: ${JSON.stringify(st)}`);
        } catch { /* 页面已关 */ }
    }
    if (pageErrors.length) console.log(`[D03 mcp-tools] pageerror×${pageErrors.length}: ${pageErrors.slice(0, 5).join(" | ")}`);
    console.log("[D03 mcp-tools] ─────────────────────────────────");
    await bridge?.close();
    await browser?.close();
});

test("circuit.load_netlist：载入 lrc 电路（懒开会话，时间轴归零）", { timeout: 60_000 }, async () => {
    const r = record("circuit.load_netlist", await tools.call("circuit.load_netlist", { text: LRC_TEXT }));
    assert.deepEqual(r.unsupported, [], "载入不得有 unsupported");
    assert.equal(r.t, 0);
    assert.equal(r.timeStepCount, 0);
    // 懒开的会话 id（页面桥 pN 形状），后续全部工具复用这一会话
    assert.match(tools.id, /^p\d+$/, "工具集必须持有页面桥会话");
});

test("circuit.get_netlist：读 JSON 网表（稳定 id、含 RLC 拓扑；layout 默认不输出）", { timeout: 60_000 }, async () => {
    const r = record("circuit.get_netlist", await tools.call("circuit.get_netlist"));
    const nl = r.netlist;
    assert.equal(nl.schema, "netlist/0.1");
    assert.ok(Array.isArray(nl.components) && nl.components.length >= 7, `lrc 至少 7 个元件，实际 ${nl.components.length}`);
    assert.ok(Array.isArray(nl.nets) && nl.nets.length >= 3, `lrc 至少 3 个网络，实际 ${nl.nets.length}`);
    for (const c of nl.components) assert.match(c.id, /^e\d+$/, "稳定 id 形状");
    const res = nl.components.find((c) => c.type === "ResistorElm");
    assert.ok(res != null && typeof res.props.resistance === "number", "网表必须含电阻且带 resistance");
    assert.ok(nl.components.every((c) => c.layout === undefined), "layout 默认关闭：不得输出坐标");
});

test("circuit.list_components：元件清单（稳定 id + 类型 + 参数）", { timeout: 60_000 }, async () => {
    const r = record("circuit.list_components", await tools.call("circuit.list_components"));
    assert.ok(r.counts.components >= 7);
    assert.equal(r.components.length, r.counts.components);
    const ids = r.components.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, "稳定 id 不得重复");
    const res = r.components.find((c) => c.type === "ResistorElm" && c.props.resistance === 10)
        ?? r.components.find((c) => c.type === "ResistorElm");
    assert.ok(res != null, "清单里必须有 10Ω 电阻（改参目标）");
    targetId = res.id;
});

test("circuit.set_param：按稳定 id 改 R=2.2k，改参经 get_netlist 可见（同会话活电路证据）", { timeout: 60_000 }, async () => {
    assert.ok(typeof targetId === "string", "前序 list_components 必须已定位电阻");
    const r = record("circuit.set_param",
        await tools.call("circuit.set_param", { target: targetId, prop: "resistance", value: 2200 }));
    assert.equal(r.applied, 1, "恰好应用一条 set");
    assert.ok(Array.isArray(r.atoms) && r.atoms.length === 1);
    assert.deepEqual(r.unsupported, []);

    // 同一会话的活电路上，改参对后续读取可见（无状态调用会重建电路、丢掉这一事实）
    const nl = await tools.call("circuit.get_netlist");
    const changed = nl.netlist.components.find((c) => c.id === targetId);
    assert.equal(changed.props.resistance, 2200, `改参必须落盘，实际 ${JSON.stringify(changed?.props)}`);
});

test("sim.run：恢复宿主实时步进（running=true）", { timeout: 60_000 }, async () => {
    const r = record("sim.run", await tools.call("sim.run"));
    assert.equal(r.running, true, `setSimRunning(true) 后必须 running，实际 ${JSON.stringify(r)}`);
});

test("sim.stop：暂停宿主实时步进（running=false，时间轴回到会话接管）", { timeout: 60_000 }, async () => {
    const r = record("sim.stop", await tools.call("sim.stop"));
    assert.equal(r.running, false);
});

test("sim.reset：t=0、步数清零、保持会话接管（paused）", { timeout: 60_000 }, async () => {
    const r = record("sim.reset", await tools.call("sim.reset"));
    assert.equal(r.t, 0, "复位后时间轴必须归零");
    assert.equal(r.timeStepCount, 0, "复位后步数必须清零");
    assert.equal(r.running, false, "复位后必须回到会话接管（paused），running 状态只由 sim.run/stop 控制");
});

test("sim.read_measurements：确定性步进 2ms 后读全网电压 + 元件电流（地网络恒 0）", { timeout: 120_000 }, async () => {
    // 确定性推进改走被测工具 sim.step（v0.1.1 起工具面自带，外部客户端不再需要
    // 直连桥的 step RPC）；scope 缓冲分配依赖页面 repaint 一次 updateCircuit，稍等再步进
    await page.waitForTimeout(150);
    const step = record("sim.step", await tools.call("sim.step", { seconds: 0.002 }));
    assert.equal(step.ok, true, `step 失败: ${JSON.stringify(step)}`);

    const r = record("sim.read_measurements", await tools.call("sim.read_measurements"));
    assert.equal(r.quantity, "voltage");
    assert.equal(r.t, step.t, "读数时间轴必须与步进一致（同一活电路）");
    assert.ok(Object.keys(r.values).length >= 2, `至少地网络 + 一个信号网络，实际 ${JSON.stringify(r.values)}`);
    const nl = await tools.call("circuit.get_netlist");
    const gid = (nl.netlist.nets.find((n) => n.ground) ?? nl.netlist.nets[0]).id;
    assert.equal(r.values[gid], 0, `地网络 ${gid} 电压必须恒 0`);
    for (const [k, v] of Object.entries(r.values)) {
        assert.ok(typeof v === "number" && Number.isFinite(v), `net ${k} 电压必须有限，实际 ${v}`);
    }

    // 过滤读取：元件电流（复用同一工具的 components 通道）
    const cur = await tools.call("sim.read_measurements", { components: [targetId], quantity: "current" });
    assert.equal(cur.ok, true, `过滤读电流失败: ${JSON.stringify(cur)}`);
    assert.ok(typeof cur.values[targetId] === "number" && Number.isFinite(cur.values[targetId]),
        `电阻电流必须有限，实际 ${JSON.stringify(cur.values)}`);
});

test("sim.read_scope：全量环形缓冲（length===pointCount，不降采样）且有真实波形数据", { timeout: 120_000 }, async () => {
    const r = record("sim.read_scope", await tools.call("sim.read_scope"));
    assert.ok(r.scopeCount >= 1, `lrc 自带 3 条 scope，实际 ${r.scopeCount}`);
    assert.equal(r.returned, r.scopeCount, "无 index 过滤时必须返回全部 scope");
    let sawData = false;
    for (const sc of r.scopes) {
        assert.ok(Array.isArray(sc.plots) && sc.plots.length >= 1, `scope ${sc.index} 必须有 plot`);
        for (const p of sc.plots) {
            // 不降采样的核心断言：返回的缓冲长度 === 容量（全量，环形原样）
            assert.equal(p.minValues.length, p.pointCount,
                `minValues 必须 full-length（${p.minValues.length} vs ${p.pointCount}）——禁止降采样`);
            assert.equal(p.maxValues.length, p.pointCount,
                `maxValues 必须 full-length（${p.maxValues.length} vs ${p.pointCount}）——禁止降采样`);
            assert.ok(["voltage", "current", "power"].includes(p.valueName), `valueName 必须可读，实际 ${p.valueName}`);
            if (p.elm != null) assert.match(p.elm, /^e\d+$/, "plot 的元件必须是稳定 id");
            if (p.maxValues.some((v) => v !== 0) || p.lastValue !== 0) sawData = true;
        }
    }
    assert.ok(sawData, "步进 2ms 后 scope 必须有非零波形数据");
});

test("schematic.screenshot：png dataURL 与 svg 文本两种格式", { timeout: 60_000 }, async () => {
    const png = record("schematic.screenshot", await tools.call("schematic.screenshot", { format: "png" }));
    assert.equal(png.format, "png");
    assert.match(png.data, /^data:image\/png;base64,/, "png 必须是 dataURL");
    assert.ok(png.bytes > 1000, `png dataURL 必须非平凡，实际 ${png.bytes} bytes`);
    assert.equal(png.bytes, Buffer.byteLength(png.data, "utf8"));

    const svg = await tools.call("schematic.screenshot", { format: "svg" });
    assert.equal(svg.ok, true, `svg 截图失败: ${JSON.stringify(svg).slice(0, 200)}`);
    assert.ok(svg.data.includes("<svg"), "svg 导出必须含 <svg 根元素");
});

test("circuit.get_netlist format=compact：自描述紧凑投影，无需 registry 即可本地解码回同一张网表", { timeout: 60_000 }, async () => {
    const { decodeCompact } = await import("../../packages/netlist/src/compact.ts");
    const named = await tools.call("circuit.get_netlist");
    const r = await tools.call("circuit.get_netlist", { format: "compact" });
    assert.equal(r.ok, true, `紧凑导出失败: ${JSON.stringify(r).slice(0, 300)}`);
    assert.equal(r.format, "compact", "返回里要说清是哪种形态（别让调用方猜 payload 是 netlist 还是 compact）");

    const compact = r.compact;
    assert.equal(compact.v, 1);
    assert.ok(compact.t != null && Object.keys(compact.t).length > 0, "必须是自描述形态：带 t 类型图例");
    assert.equal(compact.netlist, undefined, "紧凑形态放在 compact 字段，不冒用 netlist");

    // 自描述的核心不变量：**每个已用槽位都有名字**（否则那一位就是个无法解读的数字）
    for (const row of compact.c) {
        const [t, , , vals] = row;
        const entry = compact.t[t];
        assert.ok(entry != null, `组件用了类型 ${t} 但图例里没有它`);
        assert.ok((vals?.length ?? 0) <= entry[1].length,
            `类型 ${entry[0]} 的数据有 ${vals?.length} 个槽，图例只给了 ${entry[1].length} 个名字`);
    }

    // 体积：紧凑必须显著小于命名 JSON（否则这个格式没有存在意义）
    assert.ok(r.bytes < named.bytes,
        `紧凑 ${r.bytes} 应小于命名 JSON ${named.bytes}`);
    assert.ok(!JSON.stringify(compact).includes('"layout"'), "紧凑格式不含坐标");

    // 本地解码：元件类型序列 + 逐元件 props 必须与命名网表一致（图例映射正确的证据）
    const back = decodeCompact(compact);
    assert.equal(back.losses.unresolved, 0, "不该有解析不出的类型");
    assert.equal(back.losses.legendDrift, 0, "同一进程内编解码，两端 registry 不该漂移");
    const want = named.netlist.components.filter((c) => c.type !== "WireElm");
    assert.deepEqual(back.netlist.components.map((c) => c.type), want.map((c) => c.type),
        "解码后的元件类型序列必须与命名网表一致（导线行被刻意剔除）");
    for (let i = 0; i < want.length; i++) {
        assert.deepEqual(back.netlist.components[i].props, want[i].props,
            `#${i} ${want[i].type} 的属性必须逐字段相等`);
    }
    // 连通性：命名网表里每个 post 的 net 下标，解码后落到同名 net
    const namedNet = new Map(named.netlist.nets.map((n, i) => [n.id, i]));
    const backNet = new Map(back.netlist.nets.map((n, i) => [n.id, i]));
    for (let i = 0; i < want.length; i++) {
        for (const [post, netId] of Object.entries(want[i].pins)) {
            assert.equal(backNet.get(back.netlist.components[i].pins[post]), namedNet.get(netId),
                `#${i} post${post} 应落在同一个 net`);
        }
    }
});

test("circuit.load_netlist：网表 JSON（含紧凑）明确拒绝，且不改动当前电路", { timeout: 60_000 }, async () => {
    const before = await tools.call("circuit.list_components");
    const compact = (await tools.call("circuit.get_netlist", { format: "compact" })).compact;

    const r = await tools.call("circuit.load_netlist", { text: JSON.stringify(compact) });
    assert.equal(r.ok, false, "紧凑格式不能载入（没有坐标/导线，引擎也没有网表导入器）");
    assert.equal(r.error, undefined, "内容级失败走 unsupported 通道，不占用 error");
    assert.equal(r.unsupported?.[0]?.code, "netlist_json_not_loadable", `实际 ${JSON.stringify(r).slice(0, 300)}`);
    assert.match(r.unsupported[0].reason, /circuit\.set_param|XML/, "拒绝理由要给出可行方向，而不是只说不行");

    // 命名网表 JSON 同样不行：别把"能导出"误读成"能导入"
    const named = await tools.call("circuit.get_netlist");
    const r2 = await tools.call("circuit.load_netlist", { text: JSON.stringify(named.netlist) });
    assert.equal(r2.ok, false);
    assert.equal(r2.unsupported?.[0]?.code, "netlist_json_not_loadable");

    // 关键：被拒绝的载入不得把电路清空（这是"静默失败"最坏的形态）
    const after = await tools.call("circuit.list_components");
    assert.equal(after.counts.components, before.counts.components, "拒绝必须发生在动电路之前");
});

test("收尾：同一会话全程存活；工具全覆盖；无 pageerror", { timeout: 30_000 }, async () => {
    const seen = new Set(toolRecords.map((r) => r.tool));
    const missing = MCP_TOOLS.map((t) => t.name).filter((n) => !seen.has(n));
    assert.deepEqual(missing, [], `每工具至少一次成功调用，缺: ${missing.join(", ")}`);
    assert.match(tools.id, /^p\d+$/, "全程同一会话");
    const alive = await bridge.request("isAlive", { sessionId: tools.id, timeoutMs: 10_000 });
    assert.equal(alive.alive, true, "收尾时会话必须仍存活（会话式而非一次性调用）");
    assert.deepEqual(pageErrors, [], "页面运行期间不得有 pageerror");
});
}); // describe 浏览器侧
