// MCP stdio 协议层契约测试（纯 Node，无浏览器、无 dev server → 进 CI）
//
//   node --test tests/contract/mcp-stdio.test.mjs
//
// 锁定的是「宿主看见的协议形状」，不是内部实现：
//   1. initialize：版本协商（命中客户端版本 / 未知回最新）+ capabilities.tools + instructions
//   2. notifications/*：无响应；ping → {}
//   3. tools/list：MCP_TOOLS 原样下发（inputSchema 必须是 object schema）
//   4. tools/call：成功 → text content（JSON）+ structuredContent + isError:false
//   5. tools/call：内容级失败（{ok:false}）→ isError:true（不是 JSON-RPC 错误）
//   6. tools/call：未知工具 → -32602（规范建议）；未知方法 → -32601
//   7. 坏帧：非 JSON → -32700（id null）；JSON 但不是 object → -32600
//   8. 串行：同一块 stdin 里的两条调用按到达顺序执行（同一活电路不能被并发踩）
//   9. 截图：png dataURL → image content（模型可直接看图），文字摘要另给一条
//  10. stop() 等在途消息处理完再返回（宿主关 stdin 时不能丢最后一条响应）

import assert from "node:assert/strict";
import { register } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";

// packages 的 TS 用无扩展名相对导入（"./tools"），走与运行时同一份加载钩子
register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { StdioMcpServer, MCP_PROTOCOL_VERSIONS, toCallResult } = await import("../../packages/mcp/src/stdio.ts");
const { MCP_TOOLS } = await import("../../packages/mcp/src/tools.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假的工具面：只有 echo / slow / fail / shot 四个，记录调用顺序 */
function fakeToolset() {
    const calls = [];
    return {
        calls,
        listTools: () => MCP_TOOLS,
        async call(name, args) {
            calls.push({ name, args });
            if (name === "sim.step") {
                // 用真实工具名做「慢调用」：验证串行（第二条必须等第一条返回）
                await sleep(30);
                return { ok: true, t: args?.seconds ?? 0, timeStepCount: 3, order: calls.length };
            }
            if (name === "circuit.load_netlist") return { ok: false, unsupported: [{ type: "XyzElm", reason: "unknown" }] };
            if (name === "schematic.screenshot") {
                return { ok: true, format: "png", data: "data:image/png;base64,QUJD", bytes: 4 };
            }
            return { ok: true, echo: args ?? null };
        },
    };
}

function harness(toolset = fakeToolset()) {
    const input = new PassThrough();
    const output = new PassThrough();
    const frames = [];
    let buf = "";
    output.on("data", (d) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            frames.push(JSON.parse(line)); // 协议帧必须是合法 JSON，否则测试自己就该炸
        }
    });
    const server = new StdioMcpServer({ toolset, input, output, log: () => {} }).start();
    const send = (msg) => input.write(JSON.stringify(msg) + "\n");
    const sendRaw = (text) => input.write(text + "\n");
    const waitFrames = async (n, timeoutMs = 3000) => {
        const deadline = Date.now() + timeoutMs;
        while (frames.length < n && Date.now() < deadline) await sleep(5);
        assert.ok(frames.length >= n, `期望至少 ${n} 条响应，实际 ${frames.length}：${JSON.stringify(frames)}`);
        return frames;
    };
    return { server, frames, send, sendRaw, waitFrames, toolset };
}

const INIT = {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "unit", version: "0" } },
};

test("initialize：协议版本协商 + capabilities.tools + instructions", async () => {
    const h = harness();
    h.send(INIT);
    const [res] = await h.waitFrames(1);
    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, "2024-11-05", "命中客户端版本时必须沿用它");
    assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
    assert.equal(res.result.serverInfo.name, "ext-circuitjs");
    assert.match(res.result.instructions, /sim\.step/, "instructions 必须写明确定性步进入口");

    // 未知版本 → 回最新支持版本（MCP 规范：服务器选自己能用的版本）
    h.send({ ...INIT, id: 2, params: { ...INIT.params, protocolVersion: "1999-01-01" } });
    const frames = await h.waitFrames(2);
    assert.equal(frames[1].result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
    await h.server.stop();
});

test("通知无响应；ping → {}；握手状态可观测", async () => {
    const h = harness();
    h.send(INIT);
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.send({ jsonrpc: "2.0", id: 7, method: "ping" });
    const frames = await h.waitFrames(2);
    assert.equal(frames.length, 2, "通知不得产生响应帧");
    assert.deepEqual(frames[1].result, {});
    assert.equal(h.server.stats.initialized, true);
    assert.equal(h.server.stats.protocolVersion, "2024-11-05");
    await h.server.stop();
});

test("tools/list：下发 MCP_TOOLS 全量且 inputSchema 合法", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const [res] = await h.waitFrames(1);
    assert.deepEqual(res.result.tools.map((t) => t.name), MCP_TOOLS.map((t) => t.name));
    for (const t of res.result.tools) {
        assert.equal(t.inputSchema.type, "object", `${t.name} 的 inputSchema 必须是 object schema`);
        assert.ok(typeof t.description === "string" && t.description.length > 0, `${t.name} 缺描述`);
    }
    // 宿主拿到的清单里必须有确定性步进（否则 AI 只能靠墙钟 sim.run，读数不可复现）
    assert.ok(res.result.tools.some((t) => t.name === "sim.step"));
    await h.server.stop();
});

test("tools/call：成功 → text(JSON) + structuredContent；isError:false", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "circuit.list_components", arguments: {} } });
    const [res] = await h.waitFrames(1);
    assert.equal(res.result.isError, false);
    assert.deepEqual(JSON.parse(res.result.content[0].text), { ok: true, echo: {} });
    assert.deepEqual(res.result.structuredContent, { ok: true, echo: {} });
    await h.server.stop();
});

test("tools/call：内容级失败（unsupported）走 isError，不是 JSON-RPC 错误", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "circuit.load_netlist", arguments: { text: "x" } } });
    const [res] = await h.waitFrames(1);
    assert.equal(res.error, undefined, "内容级失败不得占用协议错误通道");
    assert.equal(res.result.isError, true);
    assert.equal(res.result.structuredContent.ok, false);
    assert.equal(res.result.structuredContent.unsupported[0].type, "XyzElm");
    await h.server.stop();
});

test("tools/call：未知工具 → -32602；未知方法 → -32601", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "circuit.nope", arguments: {} } });
    h.send({ jsonrpc: "2.0", id: 2, method: "no/such/method" });
    const frames = await h.waitFrames(2);
    assert.equal(frames[0].error.code, -32602);
    assert.match(frames[0].error.message, /Unknown tool/);
    assert.equal(frames[1].error.code, -32601);
    await h.server.stop();
});

test("坏帧：非 JSON → -32700（id null）；JSON 非 object → -32600", async () => {
    const h = harness();
    h.sendRaw("{ this is not json");
    h.sendRaw("[1,2,3]");
    const frames = await h.waitFrames(2);
    assert.equal(frames[0].error.code, -32700);
    assert.equal(frames[0].id, null);
    assert.equal(frames[1].error.code, -32600);
    assert.ok(h.server.stats.errors >= 2);
    await h.server.stop();
});

test("串行：同一块 stdin 的两条调用按到达顺序执行（不并发踩同一会话）", async () => {
    const h = harness();
    // 两条一起写进同一个 chunk：若并发执行，第二条的 order 会等于 1
    h.sendRaw([
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sim.step", arguments: { seconds: 0.001 } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "sim.step", arguments: { seconds: 0.002 } } }),
    ].join("\n"));
    const frames = await h.waitFrames(2);
    const a = frames.find((f) => f.id === 1).result.structuredContent;
    const b = frames.find((f) => f.id === 2).result.structuredContent;
    assert.equal(a.order, 1);
    assert.equal(b.order, 2, "第二条必须等第一条返回后执行");
    assert.equal(a.t, 0.001);
    assert.equal(b.t, 0.002);
    await h.server.stop();
});

test("截图：png dataURL → image content + 文字摘要（不把 base64 塞进 text）", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "schematic.screenshot", arguments: { format: "png" } } });
    const [res] = await h.waitFrames(1);
    const [img, text] = res.result.content;
    assert.equal(img.type, "image");
    assert.equal(img.mimeType, "image/png");
    assert.equal(img.data, "QUJD");
    assert.equal(text.type, "text");
    const summary = JSON.parse(text.text);
    assert.equal(summary.bytes, 4);
    assert.equal(summary.encoding, "base64");
    assert.ok(!text.text.includes("QUJD"), "文字内容里不该重复 base64 数据");
    await h.server.stop();
});

test("toCallResult：纯函数边界（svg 走 text；非对象结果也给 text）", () => {
    const svg = toCallResult("schematic.screenshot", { ok: true, format: "svg", data: "<svg/>" });
    assert.equal(svg.content.length, 1);
    assert.equal(JSON.parse(svg.content[0].text).format, "svg");
    const scalar = toCallResult("sim.read_measurements", 42);
    assert.equal(scalar.content[0].text, "42");
    assert.equal(scalar.structuredContent, undefined);
    assert.equal(scalar.isError, false);
});

test("stop() 等在途消息处理完再返回（关 stdin 不能丢最后一条响应）", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sim.step", arguments: { seconds: 0.003 } } });
    await h.server.stop(); // sim.step 有 30ms 延迟；stop 必须等它
    const frames = await h.waitFrames(1);
    assert.equal(frames[0].id, 1);
    assert.equal(frames[0].result.structuredContent.timeStepCount, 3);
});
