/// <reference types="node" />
// @ext/mcp — MCP stdio 协议层（零依赖）
//
// 角色：把 packages/mcp 的工具面（tools.ts 的 MCP_TOOLS + AttachToolset.call）
// 暴露成标准 MCP 服务器，任何 MCP 宿主（Claude Desktop / Codebuddy / Cursor…）
// 直接 `command: node, args: [tools/ext.mjs, mcp]` 即可接入。
//
// 传输（MCP stdio transport）：**换行分隔的 JSON-RPC 2.0**，一行一条消息。
//   - stdout 只写协议帧（任何日志、彩色输出、`console.log` 都会破坏协议）；
//   - 诊断信息一律走 stderr（构造参数 log 注入，默认 process.stderr）。
//
// 支持的方法（v0.1.1 子集，够跑通宿主）：
//   initialize                 协议版本协商 + capabilities.tools + serverInfo + instructions
//   notifications/initialized  无响应（客户端确认握手完成）
//   ping                       {}
//   tools/list                 MCP_TOOLS 原样（含 inputSchema）
//   tools/call                 {name, arguments} → content[] + structuredContent + isError
//   notifications/cancelled    忽略（本服务器按到达顺序串行处理，无可取消的在途任务）
//
// 错误语义（JSON-RPC）：
//   -32700 解析失败（id 为 null）
//   -32600 非法请求（不是 object）
//   -32601 方法不存在
//   -32602 参数不合法 / 未知工具（MCP 规范建议未知工具用 -32602）
// 工具层的**内容级**失败（{ok:false, error:{code}} 或 {ok:false, unsupported}）不是
// JSON-RPC 错误——按 MCP 约定回 isError:true 的 content，让模型看见并自行纠正。
//
// 并发：同一页面桥上的会话是单电路单时间轴，交错执行会互相踩。这里把消息串行
// 排队（serialize:true 默认），保证「按到达顺序处理」可预期。
//
// 本文件不碰浏览器、不碰进程：注入 input/output/toolset，因此可被纯 Node 契约测试
// 直接驱动（tests/contract/mcp-stdio.test.mjs）。

import type { Readable, Writable } from "node:stream";
import { MCP_TOOLS, type McpToolSpec } from "./tools";

/** 支持的协议版本：从新到旧；客户端请求命中哪个就回哪个（找不到回最新） */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

export const DEFAULT_SERVER_INFO = { name: "ext-circuitjs", version: "0.1.1" };

/** 注入给协议层的工具面（AttachToolset 满足该形状；测试可用假实现） */
export interface StdioToolset {
    listTools(): McpToolSpec[];
    call(name: string, args?: unknown): Promise<any>;
}

export interface StdioServerOptions {
    toolset: StdioToolset;
    input: Readable;
    output: Writable;
    serverInfo?: { name: string; version: string };
    /** 诊断输出（默认 stderr）。绝不能写 stdout。 */
    log?: (line: string) => void;
    /** 串行处理消息，默认 true；纯单元测试可关掉 */
    serialize?: boolean;
}

export interface StdioServerStats {
    /** 收到的合法 JSON-RPC 消息数（含通知） */
    received: number;
    /** 发出的响应数 */
    responded: number;
    /** 解析/校验失败数 */
    errors: number;
    /** 完成的 tools/call 次数 */
    toolCalls: number;
    /** 协商出的协议版本（握手前为 null） */
    protocolVersion: string | null;
    /** 是否收到 notifications/initialized */
    initialized: boolean;
}

const CONTENT_TEXT_LIMIT = 200_000; // 防御：超长文本截断（截图走 image content，不受此限）

type JsonRpcId = string | number | null;

/** initialize 的 instructions：宿主会把它塞进模型上下文，写清「怎么用」比写清「是什么」有用 */
const INSTRUCTIONS = [
    "ExtCircuitJS 是一个电路仿真器，工具面操作**同一个活电路**（会话式，不是无状态）。",
    "典型流程：circuit.load_netlist（载入电路文本）→ circuit.get_netlist（拿稳定 id e1..eN 与参数）",
    "→ circuit.set_param（按 id 改参数）→ sim.step（确定性推进，同一电路同一步数必得同一电压）",
    "→ sim.read_measurements（读 net 电压 / 元件电流）。",
    "sim.run 是墙钟实时步进，读数不可复现；要对拍数值一律用 sim.step。",
    "所有工具返回结构化 JSON；失败形如 {ok:false, error:{code,message}}，不会抛异常。",
].join("\n");

export class StdioMcpServer {
    private readonly toolset: StdioToolset;
    private readonly input: Readable;
    private readonly output: Writable;
    private readonly serverInfo: { name: string; version: string };
    private readonly log: (line: string) => void;
    private readonly serialize: boolean;

    private buffer = "";
    private queue: Promise<void> = Promise.resolve();
    private started = false;
    private stopped = false;
    private readonly counters: StdioServerStats = {
        received: 0, responded: 0, errors: 0, toolCalls: 0,
        protocolVersion: null, initialized: false,
    };

    private readonly onData = (chunk: Buffer | string): void => {
        this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let idx: number;
        // 换行分帧；容忍 CRLF（Windows 客户端）
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, idx).replace(/\r$/, "");
            this.buffer = this.buffer.slice(idx + 1);
            if (line.trim() === "") continue;
            this.dispatch(line);
        }
    };

    constructor(opts: StdioServerOptions) {
        this.toolset = opts.toolset;
        this.input = opts.input;
        this.output = opts.output;
        this.serverInfo = opts.serverInfo ?? DEFAULT_SERVER_INFO;
        this.serialize = opts.serialize !== false;
        this.log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
    }

    /** 开始读取 stdin；返回 this 便于链式拿到 stats */
    start(): this {
        if (this.started) return this;
        this.started = true;
        this.input.setEncoding?.("utf8");
        this.input.on("data", this.onData);
        this.log(`[ext-mcp] stdio server ready (${this.serverInfo.name} v${this.serverInfo.version})`);
        return this;
    }

    get stats(): StdioServerStats {
        return { ...this.counters };
    }

    /** 停止读取并等待在途消息处理完（不关闭 stdout：宿主可能还在写最后一条响应） */
    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.input.off("data", this.onData);
        await this.queue.catch(() => {});
    }

    // ── 分帧 → 串行队列 ─────────────────────────────────────────────────────

    private dispatch(line: string): void {
        if (!this.serialize) {
            void this.handleLine(line);
            return;
        }
        this.queue = this.queue.then(() => this.handleLine(line), () => this.handleLine(line));
    }

    private async handleLine(line: string): Promise<void> {
        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            this.counters.errors++;
            this.log(`[ext-mcp] parse error: ${(e as Error).message}`);
            this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
            return;
        }
        if (msg == null || typeof msg !== "object" || Array.isArray(msg)) {
            this.counters.errors++;
            this.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
            return;
        }
        this.counters.received++;

        const isNotification = msg.id === undefined || msg.id === null;
        const id: JsonRpcId = msg.id ?? null;
        const method = typeof msg.method === "string" ? msg.method : "";

        try {
            // 通知：只处理握手确认，不回包
            if (isNotification) {
                if (method === "notifications/initialized") this.counters.initialized = true;
                else this.log(`[ext-mcp] notification ignored: ${method || "(no method)"}`);
                return;
            }

            switch (method) {
                case "initialize": {
                    const requested = msg.params?.protocolVersion;
                    const version = negotiateVersion(requested);
                    this.counters.protocolVersion = version;
                    this.respond(id, {
                        protocolVersion: version,
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: this.serverInfo,
                        instructions: INSTRUCTIONS,
                    });
                    this.log(`[ext-mcp] initialize: client=${describeClient(msg.params?.clientInfo)} protocol=${version}`);
                    return;
                }
                case "ping":
                    this.respond(id, {});
                    return;
                case "tools/list":
                    this.respond(id, { tools: this.toolset.listTools() });
                    return;
                case "tools/call":
                    await this.handleToolCall(id, msg.params);
                    return;
                case "resources/list":
                case "resources/templates/list":
                    // 未声明 resources 能力；部分宿主会试探性调用，回空列表比报错友好
                    this.respond(id, method === "resources/list" ? { resources: [] } : { resourceTemplates: [] });
                    return;
                default:
                    this.sendError(id, -32601, `Method not found: ${JSON.stringify(method)}`);
            }
        } catch (e) {
            this.counters.errors++;
            const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
            this.log(`[ext-mcp] handler error (${method}): ${text}`);
            this.sendError(id, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private async handleToolCall(id: JsonRpcId, params: any): Promise<void> {
        const name = params?.name;
        if (typeof name !== "string" || name === "") {
            this.sendError(id, -32602, "tools/call 缺少 name");
            return;
        }
        const known = this.toolset.listTools().some((t) => t.name === name);
        if (!known) {
            // MCP 规范：未知工具用 -32602（不是 isError content——客户端应看到协议错误）
            this.sendError(id, -32602, `Unknown tool: ${name}`);
            return;
        }
        const args = params?.arguments ?? {};
        const result = await this.toolset.call(name, args);
        this.counters.toolCalls++;
        this.respond(id, toCallResult(name, result));
    }

    // ── 写帧 ───────────────────────────────────────────────────────────────

    private respond(id: JsonRpcId, result: unknown): void {
        this.send({ jsonrpc: "2.0", id, result });
    }

    private sendError(id: JsonRpcId, code: number, message: string): void {
        this.send({ jsonrpc: "2.0", id, error: { code, message } });
    }

    private send(msg: unknown): void {
        if ("result" in (msg as any) || "error" in (msg as any)) this.counters.responded++;
        this.output.write(JSON.stringify(msg) + "\n");
    }
}

/** 协议版本协商：命中列表就沿用客户端版本，否则回最新 */
export function negotiateVersion(requested: unknown): McpProtocolVersion {
    const hit = MCP_PROTOCOL_VERSIONS.find((v) => v === requested);
    return hit ?? MCP_PROTOCOL_VERSIONS[0];
}

function describeClient(info: any): string {
    if (info == null || typeof info !== "object") return "unknown";
    const name = typeof info.name === "string" ? info.name : "unknown";
    const version = typeof info.version === "string" ? info.version : "?";
    return `${name}@${version}`;
}

/**
 * 工具结果 → MCP CallToolResult：
 *   - 截图 png（data:image/png;base64,…）走 image content（模型能直接看，也避免
 *     把几百 KB base64 塞进 text content）；
 *   - 其余一律 text content = JSON 序列化（宿主/模型可解析），同时给 structuredContent；
 *   - {ok:false,…} → isError:true（内容级失败，不是协议错误）。
 */
export function toCallResult(name: string, result: any): Record<string, unknown> {
    const isError = result != null && typeof result === "object" && result.ok === false;

    if (name === "schematic.screenshot" && result?.ok === true && typeof result.data === "string") {
        const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(result.data);
        if (m != null) {
            const summary = { ok: true, format: result.format, bytes: result.bytes, encoding: "base64", mimeType: m[1] };
            return {
                content: [
                    { type: "image", data: m[2], mimeType: m[1] },
                    { type: "text", text: JSON.stringify(summary) },
                ],
                structuredContent: summary,
                isError: false,
            };
        }
    }

    const text = safeStringify(result);
    const out: Record<string, unknown> = {
        content: [{ type: "text", text: text.length > CONTENT_TEXT_LIMIT ? text.slice(0, CONTENT_TEXT_LIMIT) + "…(truncated)" : text }],
        isError,
    };
    if (result != null && typeof result === "object" && !Array.isArray(result)) out.structuredContent = result;
    return out;
}

function safeStringify(v: unknown): string {
    try {
        return JSON.stringify(v) ?? String(v);
    } catch {
        return String(v);
    }
}

/** 便捷工厂 */
export function createStdioServer(opts: StdioServerOptions): StdioMcpServer {
    return new StdioMcpServer(opts).start();
}

export { MCP_TOOLS };
