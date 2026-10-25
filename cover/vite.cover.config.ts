// ExtCircuitJS · App 层构建配置（派生自上游 vite.config.ts，不修改 core）
//
//   node tools/ext.mjs dev     -> vite（root = core/ts，overlay 生效）
//   node tools/ext.mjs build   -> tsc(core) + tsc(cover) + vite build -> <repo>/dist
//
// 关键点：
//  - 直接 import 上游配置并 spread：上游换掉 rolldownOptions/keepNames 会自动跟随；
//  - 上游的 copy-public-assets 插件把路径算死在自己的目录，这里替换成 outDir 感知的版本；
//  - /plugins/* 在 dev 走中间件、在 build 走 closeBundle 拷贝（插件是运行期资产）。

import { defineConfig } from "vitest/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import base from "../core/ts/vite.config";
import { coverOverlay } from "../tools/coverOverlay.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const coreRoot = path.join(repoRoot, "core", "ts");
const coverRoot = path.join(here, "ts");
const pluginsDir = path.join(repoRoot, "plugins");
const outDir = path.join(repoRoot, "dist");
const assetsDir = "circuitjs";

const baseCfg: any = base;

const MIME: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};

/** dev: /plugins/* -> <repo>/plugins/*  (插件不打包，运行期按 URL 加载) */
function servePlugins() {
    return {
        name: "ext-serve-plugins",
        configureServer(server: any) {
            // 旧 war 路径（circuitjs.html 里写死的 /circuit/manifest.json、favicon）
            const legacy: Record<string, string> = {
                "/circuit/manifest.json": path.join(coreRoot, "..", "war", "manifest.json"),
                "/favicon.ico": path.join(coreRoot, "..", "war", "icon128.png"),
            };
            const send = (res: ServerResponse, filePath: string) => {
                res.setHeader("Content-Type", MIME[path.extname(filePath)] ?? "application/octet-stream");
                res.setHeader("Cache-Control", "no-store");
                fs.createReadStream(filePath).pipe(res);
            };
            server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
                if (!req.url || req.method !== "GET") return next();
                const urlPath = decodeURIComponent(req.url.split("?")[0]!);
                if (legacy[urlPath] && fs.existsSync(legacy[urlPath])) return send(res, legacy[urlPath]);
                if (!urlPath.startsWith("/plugins/")) return next();
                const filePath = path.join(pluginsDir, urlPath.slice("/plugins/".length));
                if (!filePath.startsWith(pluginsDir)) return next();
                fs.stat(filePath, (err: NodeJS.ErrnoException | null, stat: fs.Stats) => {
                    if (err || !stat.isFile()) return next();
                    send(res, filePath);
                });
            });
        },
    };
}

/** build: 上游 public 资源 + 静态页 + 插件目录 -> dist */
function copyAssetsToDist() {
    return {
        name: "ext-copy-assets",
        apply: "build" as const,
        closeBundle() {
            const publicDir = path.join(coreRoot, "public");
            const nested = path.join(outDir, assetsDir);
            fs.mkdirSync(nested, { recursive: true });
            for (const name of ["circuits", "locale", "images"]) {
                const src = path.join(publicDir, name);
                if (fs.existsSync(src)) fs.cpSync(src, path.join(nested, name), { recursive: true });
            }
            const fontSrc = path.join(publicDir, "circuitjs", "font");
            if (fs.existsSync(fontSrc)) fs.cpSync(fontSrc, path.join(nested, "font"), { recursive: true });
            const setup = path.join(publicDir, "setuplist.txt");
            if (fs.existsSync(setup)) fs.copyFileSync(setup, path.join(nested, "setuplist.txt"));

            // 静态页（上游 copyPublicAssets 的等价物）
            for (const page of ["iframe.html", "jsinterface.html", "circuitjs/about.html"]) {
                const src = path.join(coreRoot, page);
                if (!fs.existsSync(src)) continue;
                const dst = path.join(outDir, page);
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.copyFileSync(src, dst);
            }

            // 插件（运行期资产）
            if (fs.existsSync(pluginsDir))
                fs.cpSync(pluginsDir, path.join(outDir, "plugins"), { recursive: true });

            // 旧 war 路径（保持与 dev 一致，消掉 404）
            const warDir = path.join(coreRoot, "..", "war");
            const legacy: [string, string][] = [
                ["manifest.json", path.join("circuit", "manifest.json")],
                ["icon128.png", "favicon.ico"],
            ];
            for (const [src, rel] of legacy) {
                const from = path.join(warDir, src);
                if (!fs.existsSync(from)) continue;
                const to = path.join(outDir, rel);
                fs.mkdirSync(path.dirname(to), { recursive: true });
                fs.copyFileSync(from, to);
            }
        },
    };
}

export default defineConfig({
    ...baseCfg,
    root: coreRoot,
    base: "./",
    plugins: [
        ...(baseCfg.plugins ?? []).filter((p: any) => p?.name !== "copy-public-assets"),
        coverOverlay({ coreRoot, coverRoot, coverPublicDir: path.join(here, "public"), assetsDir, outDir }),
        servePlugins(),
        copyAssetsToDist(),
    ],
    resolve: {
        ...(baseCfg.resolve ?? {}),
        alias: {
            ...(baseCfg.resolve?.alias ?? {}),
            "@ext/netlist": path.join(repoRoot, "packages", "netlist", "src", "index.ts"),
            "@ext/plugin-api": path.join(repoRoot, "packages", "plugin-api", "src", "index.ts"),
        },
    },
    server: {
        ...(baseCfg.server ?? {}),
        port: Number(process.env.EXT_PORT ?? 5174),
        strictPort: true,
        open: false,
        fs: { allow: [repoRoot] },
    },
    build: {
        ...(baseCfg.build ?? {}),
        outDir,
        emptyOutDir: true,
        assetsDir,
        copyPublicDir: false,
        rolldownOptions: {
            ...(baseCfg.build?.rolldownOptions ?? {}),
            // 相对 entry 会按 cwd（仓库根）解析，这里固定成 core 的绝对路径
            input: { circuitjs: path.join(coreRoot, "circuitjs.html") },
        },
    },
});
