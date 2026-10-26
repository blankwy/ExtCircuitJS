/// <reference types="node" />
// @ext/mcp — dev server 守护（attach 后端的「页面从哪来」这一半）
//
// 问题：MCP 服务器要连的页面由 Vite dev server 提供（core/ts 为 root + cover overlay），
// 而历史上所有浏览器契约测试都假定「5174 上已经有人在跑」——这是 Stage 1 起就记在
// observations 里的债（CI/新环境没有遗留进程）。这里把它做成一等公民：
//
//   ensureDevServer() → 探活成功 = 复用（不关别人起的服务）
//                     → 探活失败 = 自己拉起（进程组隔离，退出时连同 vite 子进程一起回收）
//
// 复用的判据是 HTTP 探活（/circuitjs.html 2xx/3xx），不是端口占用——端口被别人占着
// 但返回 404 时必须报错而不是假装成功。
//
// 进程回收：Windows 用 taskkill /T /F（node → vite 是两层）；POSIX 用 detached 建立的
// 进程组 kill(-pid)，先 SIGTERM 再 SIGKILL。漏掉这一步会留下占着端口的孤儿 vite，
// 下次 `ext mcp`/浏览器测试就会连到**上一次构建的**旧代码。

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根：packages/mcp/src → 上三级
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const EXT_CLI = path.join(repoRoot, "tools", "ext.mjs");

export interface DevServerOptions {
    baseUrl?: string;
    /** 未指定时从 baseUrl 的端口推导 */
    port?: number;
    /** 拉起后等就绪的上限（ms），默认 60s */
    timeoutMs?: number;
    /** false = 只在已就绪时复用，探活失败直接抛错（不擅自拉起另一个 vite），默认 true */
    allowSpawn?: boolean;
    log?: (line: string) => void;
}

export interface DevServerHandle {
    baseUrl: string;
    /** true = 复用了已在跑的服务（dispose 不会关它） */
    reused: boolean;
    /** 我们自己拉起的进程 pid（复用或关闭后为 null） */
    pid: number | null;
    dispose(): Promise<void>;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:5174";

/** GET 探活：返回状态码，失败/超时返回 0 */
export function probeUrl(url: string, timeoutMs = 5000): Promise<number> {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on("error", () => resolve(0));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(0); });
    });
}

function portOf(baseUrl: string, fallback: number): number {
    try {
        const u = new URL(baseUrl);
        const p = Number(u.port || (u.protocol === "https:" ? 443 : 80));
        return Number.isInteger(p) && p > 0 ? p : fallback;
    } catch {
        return fallback;
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 杀掉整棵进程树（Windows: taskkill /T；POSIX: 进程组） */
function killTree(child: ChildProcess): void {
    const pid = child.pid;
    if (pid == null) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        return;
    }
    try {
        // detached:true → 子进程是进程组长，负 pid 即整组
        process.kill(-pid, "SIGTERM");
    } catch {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    setTimeout(() => {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }, 1500).unref?.();
}

/**
 * 确保 baseUrl 上有可用的 dev server。
 *   - 已在跑（探活 2xx/3xx）→ reused:true，dispose 不动它
 *   - 否则自己拉 `node tools/ext.mjs dev --port <port>`，等就绪；超时/早退 → 关掉并抛错
 */
export async function ensureDevServer(opts: DevServerOptions = {}): Promise<DevServerHandle> {
    const baseUrl = (opts.baseUrl ?? process.env.EXC_BASE ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const log = opts.log ?? (() => {});
    const probe = `${baseUrl}/circuitjs.html`;

    const existing = await probeUrl(probe);
    if (existing >= 200 && existing < 400) {
        log(`[ext-mcp] dev server 复用 ${baseUrl}（/circuitjs.html → ${existing}）`);
        return { baseUrl, reused: true, pid: null, dispose: async () => {} };
    }

    if (!fs.existsSync(EXT_CLI)) throw new Error(`找不到 ${EXT_CLI}（仓库结构异常？）`);
    if (opts.allowSpawn === false) {
        throw new Error(
            `dev server 不可达（${probe} → ${existing}），且本次调用不允许拉起（allowSpawn=false）。` +
            "先手工起：node tools/ext.mjs dev --port <port>",
        );
    }
    const port = opts.port ?? portOf(baseUrl, 5174);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    log(`[ext-mcp] dev server 未就绪（${probe} → ${existing}），拉起 node tools/ext.mjs dev --port ${port}`);

    // 探活失败但端口可能真的被占（别的服务）——拉起会失败，错误信息里带上原始状态码
    const child = spawn(process.execPath, [EXT_CLI, "dev", "--port", String(port)], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
    });
    let stderrTail = "";
    const keepTail = (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout?.on("data", keepTail);
    child.stderr?.on("data", keepTail);

    // 用对象承载退出状态：闭包里赋值不会被 TS 的控制流收窄钉死成 null
    const exitInfo: { done: boolean; code: number | null; signal: string | null } =
        { done: false, code: null, signal: null };
    child.on("exit", (code, signal) => {
        exitInfo.done = true;
        exitInfo.code = code;
        exitInfo.signal = signal;
    });

    const handle: DevServerHandle = {
        baseUrl,
        reused: false,
        pid: child.pid ?? null,
        dispose: async () => {
            if (exitInfo.done) return;
            killTree(child);
            for (let i = 0; i < 20 && !exitInfo.done; i++) await sleep(100);
        },
    };

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (exitInfo.done) {
            await handle.dispose();
            throw new Error(
                `dev server 启动即退出（code=${exitInfo.code} signal=${exitInfo.signal}）；` +
                `探活状态 ${existing}。stderr 尾部：\n${stderrTail || "(空)"}`,
            );
        }
        const code = await probeUrl(probe, 2000);
        if (code >= 200 && code < 400) {
            log(`[ext-mcp] dev server 就绪 ${baseUrl}（pid=${child.pid}）`);
            return handle;
        }
        await sleep(400);
    }

    await handle.dispose();
    throw new Error(
        `dev server ${timeoutMs}ms 内未就绪（${probe}）。端口 ${port} 可能被别的服务占用（探活 ${existing}）。` +
        `stderr 尾部：\n${stderrTail || "(空)"}`,
    );
}
