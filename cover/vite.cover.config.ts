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
import { loadSiteConfig, applyToEntryHtml, applyToAboutHtml } from "../tools/siteConfig.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const coreRoot = path.join(repoRoot, "core", "ts");
const coverRoot = path.join(here, "ts");
// 站点配置（cover/site.config.json）在 cover 根，和 TS 源码目录不是同一层
const coverDir = here;
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
 * 站点配置注入（dev + build 同一条路径）。
 *
 * 用户只改 `cover/site.config.json`（title / htmlTitle / description / homeurl / about），
 * 这里负责把它落到入口 HTML 与关于页上；dev 与 build 行为必须一致，否则用户改完配置
 * 在 dev 看是对的、部署出去又不是。
 *
 * 顺带补回 cover 层自己的公共样式引用：`cover/public/ext-cover.css` 是 A05 的影子覆盖样例，
 * 原先靠手写进 core 的 circuitjs.html，上游一同步就没了——引用改由本插件每次补。
 */
function extSiteConfig() {
    return {
        name: "ext-site-config",
        transformIndexHtml(html: string, ctx: any) {
            // 只处理主入口：iframe.html / jsinterface.html 是上游的辅助页，不该被站点标题污染
            const cfg = loadSiteConfig(coverDir);
            const coverCssHref = ctx?.server ? "/ext-cover.css" : `/${assetsDir}/ext-cover.css`;
            return applyToEntryHtml(html, cfg, { coverCssHref });
        },
        configureServer(server: any) {
            // dev 下 AboutBox 的 iframe 直接请求 core/ts/circuitjs/about.html（Vite 静态服务），
            // 拦一层做注入，保证和构建产物一致。
            server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
                if (req.method !== "GET" || !req.url) return next();
                if (decodeURIComponent(req.url.split("?")[0]!) !== "/circuitjs/about.html") return next();
                const src = path.join(coreRoot, "circuitjs", "about.html");
                if (!fs.existsSync(src)) return next();
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.end(applyToAboutHtml(fs.readFileSync(src, "utf8"), loadSiteConfig(coverDir)));
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

    // 关于页：自定义内容插在正文最前面，上游的 GPL/第三方许可声明原样留在下面。
    // （dev 由 extSiteConfig 的中间件做同样的事，两边共用 tools/siteConfig.mjs 的同一个函数）
    const aboutPath = path.join(outDir, "circuitjs", "about.html");
    if (fs.existsSync(aboutPath)) {
        fs.writeFileSync(aboutPath, applyToAboutHtml(fs.readFileSync(aboutPath, "utf8"), loadSiteConfig(coverDir)));
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

            // locale 剪枝（site.config.json 的 locales 非空时，issue #7）：App/WebView
            // 内嵌只需要自带语言，15 个语言包 ~1.1 MB 全是死重。剪在 finalizeForHosting
            // 之前，service-worker 清单与摘要会跟着收敛。en 无文件（Locale.load 对 en
            // 不 fetch），名单即产物里该有的全部；匹配的是 locale_<lang>.txt 的 <lang>。
            const keepLocales = loadSiteConfig(coverDir).locales;
            const localeDir = path.join(nested, "locale");
            if (keepLocales.length > 0 && fs.existsSync(localeDir)) {
                let pruned = 0;
                for (const f of fs.readdirSync(localeDir)) {
                    const m = f.match(/^locale_(.+)\.txt$/);
                    if (m && !keepLocales.includes(m[1])) {
                        fs.rmSync(path.join(localeDir, f));
                        pruned++;
                    }
                }
                console.log(`[ext] locale 剪枝：保留 ${keepLocales.join(", ")}，移除 ${pruned} 个语言包`);
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
        extSiteConfig(),
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
