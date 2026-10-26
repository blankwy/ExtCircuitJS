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
import { createHash } from "node:crypto";
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

/**
 * 静态托管收尾（GitHub Pages 等**子路径**部署：站点挂在 /<repo>/ 下）。
 *
 * 上游产物默认按「站点根」写死绝对路径（circuitjs.html 的 manifest 链接、manifest.json
 * 的 start_url/icons），在 /<repo>/ 下全部会打到站点根并 404；也没有 Pages 需要的入口页。
 * 这里就地把产物改成全相对（相对当前文档 URL），并补齐入口：
 *   - 所有 .html 的 `href="/x"`、`src="/x"` -> 按该文件所在深度补 `./`、`./../`
 *   - dist/circuit/manifest.json：start_url / icons 改成相对 manifest 自身目录的路径，并补 PWA 图标
 *   - dist/index.html：站点根直接进仿真器（内容 = circuitjs.html 的副本，不额外维护第二份页面）
 *   - dist/.nojekyll：切回「分支部署」时跳过 Jekyll 处理（Actions 部署用不到，留作兜底）
 * 幂等：emptyOutDir 每次清空产物，重复构建不会叠加改动。
 */
function finalizeForHosting() {
    const htmls: string[] = [];
    const walk = (dir: string, depth: number) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth < 2) walk(p, depth + 1); // 只处理站点根 + 一层（circuitjs/about.html）
            } else if (entry.name.endsWith(".html")) {
                htmls.push(p);
            }
        }
    };
    walk(outDir, 0);

    for (const file of htmls) {
        const depth = path.relative(outDir, path.dirname(file)).split(path.sep).filter(Boolean).length;
        const prefix = "./" + "../".repeat(depth);
        const before = fs.readFileSync(file, "utf8");
        // 只改站内绝对路径：`//host/x` 是协议相对 URL，排除
        const after = before.replace(/(\b(?:href|src))="\/(?!\/)/g, `$1="${prefix}`);
        if (after !== before) fs.writeFileSync(file, after);
    }

    const manifestPath = path.join(outDir, "circuit", "manifest.json");
    if (fs.existsSync(manifestPath)) {
        const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const warDir = path.join(coreRoot, "..", "war");
        m.start_url = "../index.html";
        if (Array.isArray(m.icons)) {
            for (const icon of m.icons) {
                if (typeof icon.src === "string" && icon.src.startsWith("/circuit/"))
                    icon.src = "./" + icon.src.slice("/circuit/".length);
            }
        }
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
        for (const icon of ["icon512.png", "icon1024.png"]) {
            const from = path.join(warDir, icon);
            if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outDir, "circuit", icon));
        }
    }

    const appHtml = path.join(outDir, "circuitjs.html");
    if (fs.existsSync(appHtml)) fs.copyFileSync(appHtml, path.join(outDir, "index.html"));
    fs.writeFileSync(path.join(outDir, ".nojekyll"), "");

    // 不生成 CNAME：站点域名属于部署侧（Pages 仓库设置 / 反向代理），产物不该知道
    // 自己挂在哪个域名下。构建脚本里出现业务域名 = 演示站与程序绑定。
    // 注：CNAME 若放进产物会被下面 writeServiceWorker 的全量扫描带进预缓存列表。

    // 站点根 favicon：浏览器会直接请求 <站点根>/favicon.ico，子路径部署下那是 Pages 域名根，
    // 不是我们的产物目录，所以显式给个相对引用（dev 由 servePlugins 的 legacy 路由兜住）。
    for (const name of ["circuitjs.html", "index.html"]) {
        const p = path.join(outDir, name);
        if (!fs.existsSync(p)) continue;
        const html = fs.readFileSync(p, "utf8");
        if (html.includes('rel="icon"')) continue;
        fs.writeFileSync(p, html.replace("</head>", '  <link rel="icon" href="./favicon.ico">\n</head>'));
    }

    writeServiceWorker();
}

/**
 * 生成 PWA service-worker.js：上游是在 dist.sh（部署脚本）里从
 * `core/ts/service-worker.template.js` 替换两个占位符得来的，我们这条构建链一直没有这一步——
 * 结果生产页面每次加载都报 "Service Worker registration failed (404)"。
 * 缓存名带文件清单摘要：产物一变，新 worker 装入新缓存，activate 里删掉旧缓存。
 */
function writeServiceWorker() {
    const templatePath = path.join(coreRoot, "service-worker.template.js");
    if (!fs.existsSync(templatePath)) return;
    const template = fs.readFileSync(templatePath, "utf8");

    const files: string[] = [];
    const walk = (dir: string, prefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
            else if (entry.isFile() && !SW_EXCLUDE.has(rel)) files.push(rel);
        }
    };
    walk(outDir, "");
    files.sort();

    const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version ?? "0.0.0";
    const digest = createHash("sha1").update(files.join("\n")).digest("hex").slice(0, 8);
    const list = files.filter((f) => !["circuitjs.html", "iframe.html", "jsinterface.html"].includes(f))
        .map((f) => `  '${f}',`)
        .join("\n");

    const out = template
        .replace("VERSION_PLACEHOLDER", `${version}-${digest}`)
        .replace("FILE_LIST_GOES_HERE", list);
    fs.writeFileSync(path.join(outDir, "service-worker.js"), out);
}

/** service worker 清单里不该出现的：worker 自己、Jekyll 标记、构建报告（都是部署脚手架）。 */
const SW_EXCLUDE = new Set(["service-worker.js", ".nojekyll", "cover-overlay.json"]);

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

            finalizeForHosting();
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
