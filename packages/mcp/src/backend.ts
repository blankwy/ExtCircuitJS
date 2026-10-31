/// <reference types="node" />
// @ext/mcp — attach 后端（「页面从哪来」的另一半）
//
// 生命周期（全部懒启动，只在第一次工具调用时发生）：
//   1. dev server：ensureDevServer()（探活 → 复用 / 拉起，见 dev-server.ts）
//   2. WebSocket 桥：McpBridgeClient.listen({port:0})（只监听 127.0.0.1，见 bridge-client.ts）
//   3. 浏览器：headless Chrome/Edge 打开 ${baseUrl}/circuitjs.html → 等 window.ExtCircuitJS
//      → 用 /@fs/ 动态 import cover/ts/ExtMcpBridge.ts 并 connect(ws) → 页面桥挂到
//      window.ExtCircuitJS.mcp
//   4. 工具集：AttachToolset（同一活电路、会话式）
//
// 为什么必须真浏览器：载入/仿真/网表/截图全在页面里（core 引擎 + canvas），
// 无头求解器是 v0.2 的另一条后备路线（HeadlessApp shim）。
//
// 依赖（都不进 package.json，避免把浏览器驱动强加给只跑 Node 契约的人）：
//   playwright-core —— EXT_PW_CORE 或仓库根 node_modules（`npm i -D playwright-core`）
//   Chrome/Edge     —— EXT_CHROME 或各平台默认安装路径
// 缺依赖时的报错要能直接照做（见 resolvePwCore/resolveChrome 的抛错文案）。

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpBridgeClient } from "./bridge-client";
import { AttachToolset } from "./tools";
import { ensureDevServer, probeUrl, DEFAULT_BASE_URL, type DevServerHandle } from "./dev-server";

// 仓库根：packages/mcp/src → 上三级
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 页面内桥模块：/@fs 让 Vite dev server 按普通模块转译 TS（server.fs.allow 含仓库根） */
export const BRIDGE_MODULE_URL =
    "/@fs/" + path.join(repoRoot, "cover", "ts", "ExtMcpBridge.ts").replace(/\\/g, "/");

export interface AttachBackendOptions {
    baseUrl?: string;
    devPort?: number;
    /** auto（默认）：探活失败就拉起；reuse：只复用，连不上就报错；off：完全不管 dev server */
    devServer?: "auto" | "reuse" | "off";
    /** playwright-core 的 index.* 绝对路径 */
    pwCore?: string;
    /** Chrome/Edge 可执行文件绝对路径 */
    chrome?: string;
    /** 单个桥请求超时（ms），默认 60s */
    timeoutMs?: number;
    /** 同进程浏览器池：复用 browser、每会话独立 context（隔离靠 context 不靠进程）。
     *  桌面 stdio 一个进程只 attach 一次，用不上；多会话宿主 / 批量脚本开着才有收益。默认关。 */
    pool?: boolean;
    log?: (line: string) => void;
}

export interface AttachBackend {
    toolset: AttachToolset;
    baseUrl: string;
    bridgeUrl: string;
    /** 诊断信息（pid、浏览器版本、页面错误条数），写在 MCP 日志/stdout 之外 */
    info: Record<string, unknown>;
    /** 页面运行期错误（页面 console.error / pageerror），排障用 */
    pageErrors: string[];
    dispose(): Promise<void>;
}

const CHROME_CANDIDATES: Record<string, string[]> = {
    win32: [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    darwin: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    linux: [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
    ],
};

/** 找 playwright-core 的 index 文件；找不到就抛一条能照做的错 */
export function resolvePwCore(explicit?: string): string {
    const fromEnv = explicit ?? process.env.EXT_PW_CORE;
    if (fromEnv) {
        if (fs.existsSync(fromEnv)) return fromEnv;
        throw new Error(`EXT_PW_CORE 指向的文件不存在: ${fromEnv}`);
    }
    const candidates: string[] = [];
    try {
        const req = createRequire(path.join(repoRoot, "package.json"));
        candidates.push(req.resolve("playwright-core"));
    } catch { /* 没装 */ }
    for (const dir of [repoRoot, path.join(repoRoot, "core", "ts")]) {
        candidates.push(path.join(dir, "node_modules", "playwright-core", "index.js"));
        candidates.push(path.join(dir, "node_modules", "playwright-core", "index.mjs"));
    }
    for (const c of candidates) {
        if (c && fs.existsSync(c)) return c;
    }
    throw new Error(
        "找不到 playwright-core。" +
        "仓库不把它当依赖（只跑 Node 契约的人不需要它）：任选其一 ——" +
        "(1) 仓库根 `npm i -D playwright-core`；" +
        "(2) 设 EXT_PW_CORE=<已安装的 playwright-core/index.* 绝对路径>。",
    );
}

/** 找浏览器可执行文件；找不到就抛一条能照做的错 */
export function resolveChrome(explicit?: string): string {
    const fromEnv = explicit ?? process.env.EXT_CHROME;
    if (fromEnv) {
        if (fs.existsSync(fromEnv)) return fromEnv;
        throw new Error(`EXT_CHROME 指向的文件不存在: ${fromEnv}`);
    }
    for (const c of CHROME_CANDIDATES[process.platform] ?? []) {
        if (fs.existsSync(c)) return c;
    }
    throw new Error(
        `没找到 Chrome/Edge（${process.platform}）。装一个 Chromium 系浏览器，或设 EXT_CHROME=<可执行文件绝对路径>。`,
    );
}

// ── 浏览器池（issue #3）──────────────────────────────────────────────────────
// 同进程复用 headless Chrome，每会话独立 context。headless Chrome 每实例 200–400 MB
// 常驻内存，所以池必须有上限与空闲 TTL，不能放任增长。

interface PooledBrowser {
    browser: any;
    chromePath: string;
    /** 未释放的 context 租约数 */
    leases: number;
    /** leases 归零的时刻（ms）；有租约时无意义 */
    idleSince: number;
}

/** 池上限（通常只有一个 chromePath，多实例只出现在混装 Chrome/Edge 的机器上） */
const POOL_MAX = 2;
/** 0 租约实例的空闲回收时限 */
const POOL_IDLE_TTL_MS = 5 * 60_000;

const browserPool: PooledBrowser[] = [];
let poolReaper: ReturnType<typeof setInterval> | null = null;

function closePooled(entry: PooledBrowser): void {
    const i = browserPool.indexOf(entry);
    if (i < 0) return; // 已被回收/断连清理过
    browserPool.splice(i, 1);
    try {
        const closing = entry.browser?.close?.();
        if (closing?.catch) closing.catch(() => {});
    } catch { /* best effort */ }
    if (browserPool.length === 0 && poolReaper != null) {
        clearInterval(poolReaper);
        poolReaper = null;
    }
}

function ensurePoolReaper(): void {
    if (poolReaper != null) return;
    poolReaper = setInterval(() => {
        const now = Date.now();
        for (const entry of [...browserPool]) {
            if (entry.leases === 0 && now - entry.idleSince >= POOL_IDLE_TTL_MS) closePooled(entry);
        }
    }, 30_000);
    poolReaper.unref?.();
}

/** 取（或起）一个与 chromePath 匹配的池内浏览器；调用方持 1 个租约，随 context 释放归还 */
async function acquirePooledBrowser(chromium: any, chromePath: string, launchArgs: string[]): Promise<PooledBrowser> {
    const hit = browserPool.find((e) => e.chromePath === chromePath);
    if (hit) {
        hit.leases++;
        return hit;
    }
    const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: launchArgs });
    const entry: PooledBrowser = { browser, chromePath, leases: 1, idleSince: 0 };
    browser.on?.("disconnected", () => closePooled(entry)); // 崩溃/被杀时把条目摘掉
    browserPool.push(entry);
    ensurePoolReaper();
    // 超上限只挤闲置实例（有租约的挤不动，宁可暂时超编，等 reaper 收敛）
    while (browserPool.length > POOL_MAX) {
        const victim = browserPool.find((e) => e.leases === 0 && e !== entry);
        if (victim == null) break;
        closePooled(victim);
    }
    return entry;
}

function releasePooledBrowser(entry: PooledBrowser): void {
    entry.leases = Math.max(0, entry.leases - 1);
    if (entry.leases === 0) entry.idleSince = Date.now();
}

/** 关掉池里所有浏览器（宿主收尾用）。有租约的实例也会被关——这是强制关停语义。 */
export async function disposeBrowserPool(): Promise<void> {
    for (const entry of [...browserPool]) closePooled(entry);
}

/**
 * 启动 attach 后端。失败时确保已分配的资源都被回收（不留孤儿 dev server / 浏览器）。
 */
export async function startAttachBackend(opts: AttachBackendOptions = {}): Promise<AttachBackend> {
    const log = opts.log ?? (() => {});
    const baseUrl = (opts.baseUrl ?? process.env.EXC_BASE ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const pageErrors: string[] = [];

    let dev: DevServerHandle | null = null;
    let bridge: McpBridgeClient | null = null;
    let browser: any = null;
    let context: any = null;
    /** 非空 = 浏览器来自池（dispose 只归还租约，不关浏览器） */
    let pooled: PooledBrowser | null = null;

    const disposeAll = async () => {
        try { await context?.close?.(); } catch { /* best effort */ }
        if (pooled != null) {
            releasePooledBrowser(pooled);
        } else {
            try { await browser?.close?.(); } catch { /* best effort */ }
        }
        try { await bridge?.close(); } catch { /* best effort */ }
        try { await dev?.dispose(); } catch { /* best effort */ }
        context = null;
        pooled = null;
        browser = null;
        bridge = null;
        dev = null;
    };

    try {
        // ── 1) dev server ───────────────────────────────────────────────────
        if (opts.devServer === "off") {
            const code = await probeUrl(`${baseUrl}/circuitjs.html`);
            if (!(code >= 200 && code < 400)) {
                throw new Error(`dev server 不可达（${baseUrl}/circuitjs.html → ${code}），且 devServer=off`);
            }
        } else {
            dev = await ensureDevServer({
                baseUrl,
                port: opts.devPort,
                log,
                // reuse：探活失败直接抛，不擅自拉起
                allowSpawn: opts.devServer !== "reuse",
            });
        }

        // ── 2) 环回 WebSocket 桥 ────────────────────────────────────────────
        bridge = await McpBridgeClient.listen({ port: 0 });
        log(`[ext-mcp] bridge listening ${bridge.url}`);

        // ── 3) 浏览器 + 页面桥 ─────────────────────────────────────────────
        const pwIndex = resolvePwCore(opts.pwCore);
        const chromePath = resolveChrome(opts.chrome);
        const pw: any = await import(pathToFileURL(pwIndex).href);
        const chromium = pw.chromium ?? pw.default?.chromium;
        if (chromium == null) throw new Error(`playwright-core 没有导出 chromium（${pwIndex}）`);

        const launchArgs = ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"];
        if (opts.pool === true) {
            pooled = await acquirePooledBrowser(chromium, chromePath, launchArgs);
            browser = pooled.browser;
        } else {
            browser = await chromium.launch({ executablePath: chromePath, headless: true, args: launchArgs });
        }
        context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        page.on("dialog", (d: any) => d.dismiss().catch?.(() => {}));
        page.on("pageerror", (e: any) => pageErrors.push(String(e?.message ?? e)));
        page.on("console", (m: any) => {
            if (m.type?.() === "error") pageErrors.push(`console.error: ${m.text?.()}`);
        });

        await page.goto(`${baseUrl}/circuitjs.html`, { waitUntil: "load", timeout: 60_000 });
        await page.waitForFunction(() => !!(window as any).ExtCircuitJS, null, { timeout: 60_000 });
        // 插件宿主 fetch + dynamic import：等页面侧的显式就绪标志（ExtBoot 在 plugins.load()
        // 之后置 ExtCircuitJS.ready），不再固定 sleep —— 快机器省 1.2 s，慢机器也不会随机失败。
        // 超时降级继续：插件 fetch 挂住只影响插件元件，不值得让整个 attach 硬失败。
        try {
            await page.waitForFunction(() => (window as any).ExtCircuitJS?.ready === true, null, { timeout: 60_000 });
        } catch {
            log("[ext-mcp] 插件宿主就绪等待超时，继续（部分插件元件可能缺位）");
        }

        // 桥的装载策略（双线）：
        //   1) 优先用页面自带的 loadMcpBridge()（ExtBoot 暴露）——**静态产物也能用**
        //      （dist/、GitHub Pages 没有 Vite 的 /@fs/ 转译路径，桥已随 bundle 切成 chunk）
        //   2) 退回到 /@fs/ 直接 import TS 源码 —— dev server（Vite）专有，作为兜底
        const attached = await page.evaluate(async (args: { modUrl: string; wsUrl: string }) => {
            const w = window as any;
            let b: any = null;
            let via = "";
            // 1) 页面内建加载器（静态产物优先）
            if (typeof w.ExtCircuitJS?.loadMcpBridge === "function") {
                try {
                    b = await w.ExtCircuitJS.loadMcpBridge();
                    if (b) via = "builtin";
                } catch { /* 落到 /@fs/ */ }
            }
            // 2) dev server 兜底：直接 import TS 源码
            if (b == null) {
                const mod: any = await import(args.modUrl);
                b = mod.getMcpBridge?.() ?? mod.attachMcpBridge(w.ExtCircuitJS);
                via = "fs";
            }
            if (b == null) return { attached: false, via };
            b.connect(args.wsUrl);
            return { attached: w.ExtCircuitJS?.mcp === b, via };
        }, { modUrl: BRIDGE_MODULE_URL, wsUrl: bridge.url });
        if (attached.attached !== true) throw new Error("页面桥未挂到 window.ExtCircuitJS.mcp");
        await bridge.waitPage(20_000);
        log(`[ext-mcp] page bridge connected (via ${attached.via})`);

        const toolset = new AttachToolset(bridge, { timeoutMs: opts.timeoutMs ?? 60_000 });
        let version: string | null = null;
        try {
            version = typeof browser?.version === "function" ? String(await browser.version()) : null;
        } catch { /* 版本只是诊断信息，取不到不影响功能 */ }

        return {
            toolset,
            baseUrl,
            bridgeUrl: bridge.url,
            pageErrors,
            info: {
                baseUrl,
                bridgeUrl: bridge.url,
                devServerReused: dev?.reused === true,
                devServerPid: dev?.pid ?? null,
                chrome: chromePath,
                browserVersion: version ?? null,
                browserPooled: pooled != null,
            },
            dispose: disposeAll,
        };
    } catch (e) {
        await disposeAll();
        throw e;
    }
}
