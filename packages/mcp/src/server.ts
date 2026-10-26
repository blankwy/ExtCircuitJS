/// <reference types="node" />
// @ext/mcp — 进程级组装：stdio 协议层 + 懒启动的 attach 后端
//
//   stdin/stdout ⇄ StdioMcpServer ⇄ LazyToolset ⇄ (首次调用时) startAttachBackend
//                                                     └ dev server + 浏览器 + WS 桥
//
// 懒启动的理由：宿主（Claude Desktop / Codebuddy / Cursor）在启动子进程后往往先握手
// 再列工具，真正调用可能隔几分钟。握手阶段就拉起浏览器会让「连不上 Chrome」错误
// 出现在 initialize 之前，宿主只会显示 "server failed to start"，无法自愈；懒启动
// 则把这类错误留在工具结果里（isError content），模型看得见、用户改得动。
//
// 退出：stdin 关闭（宿主关进程）或 SIGINT/SIGTERM → 停协议层 → 释放浏览器/桥/dev server。

import type { Readable, Writable } from "node:stream";
import { MCP_TOOLS, StdioMcpServer, type StdioToolset } from "./stdio";
import { startAttachBackend, type AttachBackend, type AttachBackendOptions } from "./backend";

export interface ServeOptions {
    input?: Readable;
    output?: Writable;
    backend?: AttachBackendOptions;
    log?: (line: string) => void;
}

/** 懒启动工具集：握手/列工具不碰浏览器，第一次 tools/call 才起后端 */
class LazyToolset implements StdioToolset {
    private backend: AttachBackend | null = null;
    private starting: Promise<AttachBackend> | null = null;
    private readonly opts: AttachBackendOptions;
    private readonly log: (line: string) => void;
    /** 后端启动失败的原因（排障时打一次，避免每次调用都刷屏） */
    private lastStartError: string | null = null;

    constructor(opts: AttachBackendOptions, log: (line: string) => void) {
        this.opts = opts;
        this.log = log;
    }

    listTools() {
        return MCP_TOOLS;
    }

    async call(name: string, args?: unknown): Promise<any> {
        let backend: AttachBackend;
        try {
            backend = await this.ensure();
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (message !== this.lastStartError) {
                this.lastStartError = message;
                this.log(`[ext-mcp] backend 启动失败: ${message}`);
            }
            return { ok: false, error: { code: "backend_unavailable", message } };
        }
        return backend.toolset.call(name, args);
    }

    private ensure(): Promise<AttachBackend> {
        if (this.backend != null) return Promise.resolve(this.backend);
        if (this.starting == null) {
            this.starting = startAttachBackend({ log: this.log, ...this.opts })
                .then((b) => {
                    this.backend = b;
                    this.log(`[ext-mcp] backend ready: ${JSON.stringify(b.info)}`);
                    return b;
                })
                .finally(() => { this.starting = null; });
        }
        return this.starting;
    }

    async dispose(): Promise<void> {
        const b = this.backend;
        this.backend = null;
        await b?.dispose();
    }
}

/**
 * 跑 MCP stdio 服务器，直到 stdin 关闭或收到终止信号。
 * 返回进程退出码（0 = 正常收尾）。
 */
export async function runStdioServer(opts: ServeOptions = {}): Promise<number> {
    const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
    const input = opts.input ?? process.stdin;
    const output = opts.output ?? process.stdout;

    const toolset = new LazyToolset(opts.backend ?? {}, log);
    const server = new StdioMcpServer({ toolset, input, output, log }).start();

    let closing = false;
    const shutdown = async (reason: string): Promise<number> => {
        if (closing) return 0;
        closing = true;
        log(`[ext-mcp] shutdown (${reason}) stats=${JSON.stringify(server.stats)}`);
        await server.stop();
        await toolset.dispose();
        return 0;
    };

    // 宿主的两种关闭方式：关 stdin（正常）或直接 SIGTERM（强杀前的礼貌）
    const onSigint = () => { void shutdown("signal SIGINT").then((c) => process.exit(c)); };
    const onSigterm = () => { void shutdown("signal SIGTERM").then((c) => process.exit(c)); };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    await new Promise<void>((resolve) => {
        input.once("end", resolve);
        input.once("close", resolve);
    });

    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    return await shutdown("stdin closed");
}
