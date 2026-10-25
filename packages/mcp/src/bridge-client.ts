/// <reference types="node" />
// （tsconfig.cover.json 的 types 数组只含 vite/client；本文件是 packages 里第一个
//  用 Node 内建模块的 TS，用三斜线引用把 @types/node 拉进程序，不动 tsconfig——
//  D02 写作用域不含 cover/tsconfig.cover.json。）
//
// @ext/mcp — WebSocket 桥 Node 侧（D02，Stage 5）
//
// 角色：MCP 服务器（attach 模式）与「页面内桥」（cover/ts/ExtMcpBridge.ts，
// 经 window.ExtCircuitJS.mcp 暴露）之间的本地环回 WebSocket 通道。
//
//   ┌────────────┐  ws://127.0.0.1:<port>   ┌──────────────────────┐
//   │ Node 本文件 │ ◀──── 页面主动连入 ────── │ 浏览器 ExtMcpBridge   │
//   │ （服务器端） │ ──── req → / ← res ──── │ （WS 客户端，自动重连）│
//   └────────────┘                          └──────────────────────┘
//
//   - Node 侧只**监听** 127.0.0.1（host 传其他值直接抛错；SSRF 纪律：仅本地
//     环回监听，页面向外连的也只有环回——两侧都收紧）。
//   - 会话状态全部在页面侧（sessions Map 与 WS 连接解耦），断线重连后同一
//     sessionId 继续可用、时间轴原样——「会话跨一次重连存活」。
//   - 零依赖：RFC 6455 子集（text 帧 / ping/pong / close；客户端帧必须带掩码，
//     服务端帧不掩码）直接实现，不引入 ws 包。
//
// 线协议（与 cover/ts/ExtMcpBridge.ts 文件头一致；payload 形状 = D01
// session.ts 的结构化返回，内容级失败沿用 {ok:false, unsupported[]}）：
//   请求  {v:1, kind:"req", id:"q7", method:"step", sessionId:"p1", params:{…}}
//   应答  {v:1, kind:"res", id:"q7", payload:{ok:true, t:…, timeStepCount:…}}
//
// 错误分两层：
//   - RPC 层（页面桥返回的 payload.ok === false）：request() 原样返回 payload，
//     由调用方检查（与 D01「结构化返回，绝不向外抛」同一约定）。
//   - 传输层（页面未连 / 请求超时 / 桥已关闭）：request() reject
//     BridgeTransportError。页面断线期间挂起的请求会被拒绝；重连后新请求
//     照常（会话在页面侧仍然活着）。

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";

export const BRIDGE_PROTOCOL_VERSION = 1;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 32 * 1024 * 1024; // 32 MiB：远超任何网表，防滥用即可
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// ── RFC 6455 帧编解码（纯函数，导出供测试直接对拍）────────────────────────

export interface WsFrame {
    fin: boolean;
    opcode: number;
    data: Buffer;
}

/** 服务端→客户端帧：不掩码 */
export function encodeWsFrame(opcode: number, data: Buffer): Buffer {
    const len = data.length;
    let header: Buffer;
    if (len < 126) {
        header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, data]);
}

/**
 * 从 buf 头部解出一个客户端帧（必须带掩码）。
 * 数据不够一帧 → 返回 null（调用方继续攒）；协议违规 → 抛错（调用方以 1002 关闭）。
 */
export function decodeWsFrame(buf: Buffer): { frame: WsFrame; rest: Buffer } | null {
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
        if (buf.length < off + 2) return null;
        len = buf.readUInt16BE(off);
        off += 2;
    } else if (len === 127) {
        if (buf.length < off + 8) return null;
        const hi = buf.readUInt32BE(off);
        const lo = buf.readUInt32BE(off + 4);
        off += 8;
        len = hi * 2 ** 32 + lo;
        if (!Number.isSafeInteger(len)) throw new Error(`frame length not representable: ${len}`);
    }
    if (len > MAX_FRAME_BYTES) throw new Error(`frame too large: ${len} bytes`);
    if (rsv !== 0) throw new Error("rsv bits set (no extension negotiated)");
    if (!fin) throw new Error("fragmented frames unsupported");
    if (!masked) throw new Error("client frames must be masked");
    if (buf.length < off + 4) return null;
    const maskKey = buf.subarray(off, off + 4);
    off += 4;
    if (buf.length < off + len) return null;
    const data = Buffer.allocUnsafe(len);
    const payload = buf.subarray(off, off + len);
    for (let i = 0; i < len; i++) data[i] = payload[i] ^ maskKey[i & 3];
    return { frame: { fin, opcode, data }, rest: buf.subarray(off + len) };
}

// ── 错误类型 ───────────────────────────────────────────────────────────────

/** 传输层错误（页面未连 / 超时 / 桥关闭）。RPC 层错误走结构化 payload，不抛。 */
export class BridgeTransportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BridgeTransportError";
    }
}

// ── 线协议信封 ─────────────────────────────────────────────────────────────

export interface BridgeRequestEnvelope {
    v: number;
    kind: "req";
    id: string;
    method: string;
    sessionId?: string;
    params?: any;
}

export interface BridgeResponseEnvelope {
    v: number;
    kind: "res";
    id: string;
    payload: any;
}

// ── 页面连接（单个已升级的 socket）─────────────────────────────────────────

interface PageConnHandlers {
    onText: (text: string) => void;
    onClose: () => void;
}

class PageConnection {
    socket: Duplex;
    private handlers: PageConnHandlers;
    private buf: Buffer;
    /** 逻辑关闭：不再收发（dropPage 立即置位，路由立刻失效） */
    closed = false;
    private destroyed = false;

    constructor(socket: Duplex, head: Buffer, handlers: PageConnHandlers) {
        this.socket = socket;
        this.handlers = handlers;
        this.buf = Buffer.from(head);
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        socket.on("error", () => this.destroy());
        socket.on("close", () => this.destroy());
        if (head.length > 0) this.pump();
    }

    private onData(chunk: Buffer): void {
        if (this.closed || this.destroyed) return;
        this.buf = Buffer.concat([this.buf, chunk]);
        this.pump();
    }

    private pump(): void {
        for (;;) {
            let parsed: { frame: WsFrame; rest: Buffer } | null;
            try {
                parsed = decodeWsFrame(this.buf);
            } catch (e) {
                this.fail(1002, `protocol error: ${(e as Error).message}`);
                return;
            }
            if (parsed == null) return; // 攒不够一帧
            this.buf = parsed.rest;
            const { opcode, data } = parsed.frame;
            if (opcode === OP_TEXT) {
                this.handlers.onText(data.toString("utf8"));
            } else if (opcode === OP_CLOSE) {
                this.sendRaw(encodeWsFrame(OP_CLOSE, Buffer.alloc(0)));
                this.destroy();
                return;
            } else if (opcode === OP_PING) {
                this.sendRaw(encodeWsFrame(OP_PONG, data));
            } else if (opcode === OP_PONG) {
                // 心跳应答：本侧不主动 ping，忽略
            } else if (opcode === OP_BINARY) {
                this.fail(1003, "binary frames unsupported (protocol is JSON text)");
                return;
            } else if (opcode === OP_CONT) {
                this.fail(1002, "continuation frame without fragmentation support");
                return;
            } else {
                this.fail(1002, `unsupported opcode ${opcode}`);
                return;
            }
        }
    }

    sendText(text: string): boolean {
        if (this.closed || this.destroyed) return false;
        this.socket.write(encodeWsFrame(OP_TEXT, Buffer.from(text, "utf8")));
        return true;
    }

    /**
     * 发 close 帧后拆连接（reconnect 测试用：让页面走 onclose → 自动重连）。
     * closed 立即置位：路由/收发马上失效，不等 close 帧冲刷。
     */
    close(code = 1001, reason = ""): void {
        if (this.closed || this.destroyed) return;
        this.closed = true;
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2);
        try { this.socket.write(encodeWsFrame(OP_CLOSE, body)); } catch { /* dying anyway */ }
        this.destroyAfterFlush();
    }

    private fail(code: number, message: string): void {
        if (this.closed || this.destroyed) return;
        this.closed = true;
        const body = Buffer.alloc(2);
        body.writeUInt16BE(code, 0);
        try { this.socket.write(encodeWsFrame(OP_CLOSE, body)); } catch { /* dying anyway */ }
        this.destroyAfterFlush();
    }

    /** 先让 close 帧冲刷到对端再 destroy（立刻 RST 可能吞掉 close 帧） */
    private destroyAfterFlush(): void {
        setTimeout(() => this.destroy(), 30);
    }

    private sendRaw(frame: Buffer): void {
        if (this.destroyed) return;
        try { this.socket.write(frame); } catch { /* dying anyway */ }
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.closed = true;
        this.handlers.onClose();
        this.socket.destroy();
    }
}

// ── 桥客户端（对 MCP 工具层是「到页面的客户端」，对传输层是环回 WS 服务器）──

export interface McpBridgeOptions {
    /** 监听端口，默认 0（系统分配空闲端口） */
    port?: number;
    /**
     * 监听地址。只允许 127.0.0.1 / localhost / ::1（SSRF 纪律：仅本地环回监听），
     * 默认 127.0.0.1；传任何其他值直接抛错。
     */
    host?: string;
    /** 单个请求的默认超时（ms），默认 15000 */
    requestTimeoutMs?: number;
}

interface Pending {
    resolve: (payload: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const LOOPBACK_LISTEN_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export class McpBridgeClient {
    static async listen(opts: McpBridgeOptions = {}): Promise<McpBridgeClient> {
        // SSRF 纪律在进 Promise 之前同步校验：非法 host 必须是同步 throw，而不是 rejected promise
        const host = opts.host ?? "127.0.0.1";
        if (!LOOPBACK_LISTEN_HOSTS.has(host)) {
            throw new Error(`McpBridgeClient: 仅允许本地环回监听（127.0.0.1），拒绝 ${host}`);
        }
        return new Promise((resolve, reject) => {
            const bridge = new McpBridgeClient(opts);
            bridge.server.once("error", reject);
            bridge.server.listen(bridge.port, bridge.host, () => {
                const addr = bridge.server.address();
                bridge.port = typeof addr === "object" && addr != null ? addr.port : bridge.port;
                resolve(bridge);
            });
        });
    }

    private server: import("node:http").Server;
    private host: string;
    private port: number;
    private requestTimeoutMs: number;
    private conn: PageConnection | null = null;
    private pending = new Map<string, Pending>();
    private pageWaiters: (() => void)[] = [];
    private nextId = 0;
    private closed = false;
    /** 页面发来的非 res 帧（协议规定页面只应答，不主动推；非 0 即协议异常证据） */
    violations = 0;
    /** 页面连接次数（≥2 即发生过重连） */
    pageConnects = 0;

    private constructor(opts: McpBridgeOptions) {
        const host = opts.host ?? "127.0.0.1";
        if (!LOOPBACK_LISTEN_HOSTS.has(host)) {
            throw new Error(`McpBridgeClient: 仅允许本地环回监听（127.0.0.1），拒绝 ${host}`);
        }
        this.host = host;
        this.port = opts.port ?? 0;
        this.requestTimeoutMs = opts.requestTimeoutMs ?? 15000;
        this.server = createServer((req, res) => {
            // 本服务器只做 WebSocket 升级，普通请求一律 426
            res.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("ExtCircuitJS MCP bridge: WebSocket upgrade required\n");
        });
        this.server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    }

    private onUpgrade(req: import("node:http").IncomingMessage, socket: Duplex, head: Buffer): void {
        const key = req.headers["sec-websocket-key"];
        if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
            socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
        socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        (socket as import("node:net").Socket).setNoDelay(true);
        const conn = new PageConnection(socket, head, {
            onText: (text) => this.onPageText(text),
            onClose: () => this.onPageClose(conn),
        });
        // 新连接顶掉旧连接（页面重连的常态：旧 socket 尚未完全关闭）
        if (this.conn != null && this.conn !== conn) this.conn.destroy();
        this.conn = conn;
        this.pageConnects++;
        for (const w of this.pageWaiters.splice(0)) w();
    }

    private onPageText(text: string): void {
        let env: any;
        try {
            env = JSON.parse(text);
        } catch (e) {
            this.violations++;
            return;
        }
        if (env == null || env.v !== BRIDGE_PROTOCOL_VERSION || env.kind !== "res") {
            this.violations++;
            return;
        }
        const p = this.pending.get(String(env.id));
        if (p == null) return; // 超时后迟到的应答：丢弃
        this.pending.delete(String(env.id));
        clearTimeout(p.timer);
        p.resolve(env.payload);
    }

    private onPageClose(conn: PageConnection): void {
        if (this.conn === conn) this.conn = null;
        // 页面断线：挂起中的请求全部以传输错误拒绝（会话在页面侧，重连后仍可用）
        for (const [id, p] of this.pending) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.reject(new BridgeTransportError(`页面连接断开，请求 ${id} 未完成`));
        }
    }

    // ── 对外 API ────────────────────────────────────────────────────────────

    get url(): string {
        return `ws://${this.host}:${this.port}`;
    }

    get listeningPort(): number {
        return this.port;
    }

    get pageConnected(): boolean {
        return this.conn != null && !this.conn.closed;
    }

    /** 等页面桥连入（已连接则立即返回）；超时 reject BridgeTransportError */
    async waitPage(timeoutMs = 10000): Promise<void> {
        if (this.pageConnected) return;
        if (this.closed) throw new BridgeTransportError("bridge already closed");
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = this.pageWaiters.indexOf(resolve);
                if (i >= 0) this.pageWaiters.splice(i, 1);
                reject(new BridgeTransportError(`等待页面连接超时（${timeoutMs}ms）`));
            }, timeoutMs);
            this.pageWaiters.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
        if (!this.pageConnected) throw new BridgeTransportError("页面连接在就绪前断开");
    }

    /**
     * 向页面桥发一个请求，返回 res.payload（D01 结构化形状；payload.ok === false
     * 是 RPC 层结果，不抛异常）。传输层失败（无页面/超时/断开）才 reject。
     */
    async request(
        method: string,
        opts: { sessionId?: string; params?: any; timeoutMs?: number } = {},
    ): Promise<any> {
        if (this.closed) throw new BridgeTransportError("bridge already closed");
        const timeout = opts.timeoutMs ?? this.requestTimeoutMs;
        await this.waitPage(timeout);
        const id = `q${++this.nextId}`;
        const env: BridgeRequestEnvelope = { v: BRIDGE_PROTOCOL_VERSION, kind: "req", id, method };
        if (opts.sessionId != null) env.sessionId = opts.sessionId;
        if (opts.params !== undefined) env.params = opts.params;
        return await new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new BridgeTransportError(`bridge 请求超时（${timeout}ms）：${method}`));
            }, timeout);
            this.pending.set(id, {
                resolve,
                reject,
                timer,
            });
            const ok = this.conn != null && this.conn.sendText(JSON.stringify(env));
            if (!ok) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(new BridgeTransportError(`页面连接不可用：${method}`));
            }
        });
    }

    /** 便捷方法：echo 一来一回（联通用，payload 原样返回） */
    async echo(payload: any, timeoutMs?: number): Promise<any> {
        return this.request("echo", { params: payload, timeoutMs });
    }

    /** 服务器主动断开页面连接（重连存活测试 / 运维踢线）；页面会自动重连 */
    dropPage(reason = "server-side drop"): void {
        if (this.conn != null) this.conn.close(1001, reason);
    }

    /** 关闭整个桥（监听 + 页面连接 + 挂起请求） */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.conn?.destroy();
        this.conn = null;
        for (const [id, p] of this.pending) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.reject(new BridgeTransportError(`bridge closed，请求 ${id} 取消`));
        }
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
}
