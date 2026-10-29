#!/usr/bin/env node
/**
 * 导出单文件 HTML：把 dist/ 的 JS + CSS 内联成一个可**双击打开**的 .html。
 *
 *   node tools/ext-bundle-single.mjs [--out build/circuitjs-single.html]
 *
 * 为什么需要：产物是 ES module（含顶层 await），浏览器禁止 file:// 加载 module。
 * 本脚本把 bundle 包进 async IIFE、内联全部样式，得到零依赖单文件——
 * 发给别人、塞进 skill、挂网盘都能直接开。
 *
 * 已知限制（如实说明，不做假承诺）：
 *   · 内置电路菜单（setuplist.txt / circuits/）需要 http 才能 fetch → 单文件下空列表；
 *     用户仍可手动粘贴/导入电路文本。
 *   · 字体图标（fontello.woff2）走相对路径，单文件下不加载 → 按钮显示文字标签而非图标。
 *   · Service Worker 自动关闭（file:// 不支持）。
 *   · 需要 http 完整功能（含 MCP 驱动）时，仍应使用 `ext build && ext serve`。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(root, "dist");

const args = process.argv.slice(2);
const argOf = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const outFile = path.resolve(argOf("out", path.join(root, "build", "circuitjs-single.html")));

if (!fs.existsSync(path.join(dist, "circuitjs.html"))) {
    console.error("缺少 dist/circuitjs.html —— 先运行 node tools/ext.mjs build");
    process.exit(1);
}

const html = fs.readFileSync(path.join(dist, "circuitjs.html"), "utf8");

// ── 收集要内联的样式 ────────────────────────────────────────────────
function readCss(href) {
    const rel = href.replace(/^\.\//, "").replace(/^\/+/, "");
    const file = path.join(dist, rel);
    if (!fs.existsSync(file)) return null;
    let css = fs.readFileSync(file, "utf8");
    // 字体在单文件里失效：把整个 @font-face 的 src 段换成内联的 woff2 base64。
    // fontello.css 的路径形如 ../font/fontello.woff2?xxx（相对该 css 文件自身）。
    const fontFile = path.resolve(path.dirname(file), "../font/fontello.woff2");
    if (fs.existsSync(fontFile)) {
        const b64 = fs.readFileSync(fontFile).toString("base64");
        // 匹配从 "src:" 开始到 "font-weight" 之前的整块（含 eot/woff2/woff/ttf/svg 多行）
        css = css.replace(
            /src:\s*url\([^)]*\)[^;]*;[\s\S]*?url\([^)]*\)\s*format\('svg'\);/,
            `src: url(data:font/woff2;base64,${b64}) format('woff2');`,
        );
        // 单独那条 eot 的 src（第一行）也要去掉
        css = css.replace(/^\s*src:\s*url\([^)]*\.eot[^)]*\);\s*$/m, "");
    }
    return css;
}

let out = html;

// 1) 内联所有 <link rel="stylesheet">
for (const m of [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)]) {
    const tag = m[0];
    const href = /href="([^"]+)"/.exec(tag)?.[1];
    if (!href || /^https?:/.test(href)) continue;
    const css = readCss(href);
    if (css == null) {
        // 取不到就不内联（例如 ext-cover.css 在 circuitjs/ 下——已尝试相对路径）
        out = out.replace(tag, "");
        continue;
    }
    out = out.replace(tag, () => `<style>/* ${href} */\n${css}\n</style>`);
}

// 2) 把 module script 换成内联的 async IIFE
const scriptTag = /<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/;
const sm = scriptTag.exec(out);
if (!sm) {
    console.error("找不到 module script —— 产物结构变了？");
    process.exit(1);
}
const jsRel = sm[1].replace(/^\.\//, "").replace(/^\/+/, "");
const jsPath = path.join(dist, jsRel);
if (!fs.existsSync(jsPath)) {
    console.error(`找不到 bundle: ${jsPath}`);
    process.exit(1);
}
let js = fs.readFileSync(jsPath, "utf8");

// 先把 import.meta 换掉（在包装之前——否则会污染自己注入的声明行）
// bundle 里只有 import.meta.url 一种用法（Vite 算静态资源基址），换成注入对象的 url
js = js.split("import.meta.url").join("__singleMeta.url");
js = js.split("import.meta").join("__singleMeta");

// 再包进 async IIFE —— 顶层 await 在函数体里合法，且不再是 module（file:// 可执行）
js = `(async () => {\nconst __singleMeta = { url: (typeof document !== "undefined" ? document.baseURI : "file:///") };\n${js}\n})().catch((e) => { console.error("[single] boot failed:", e); });`;

// Service Worker 注册在 file:// 下无意义且会报错：直接跳过
js = js.replace(
    /registerServiceWorker\s*\(\s*\)/g,
    "(()=>{})()",
);

// 用**函数式替换**：bundle 里含 `$`` 等字符，直接当替换串会被 String.replace
// 当成特殊模式展开（$& / $' / $` / $$），把代码改坏。函数返回值不做展开。
out = out.replace(sm[0], () => `<script>\n${js}\n</script>`);

// 3) 去掉 file:// 下无意义的标签
out = out.replace(/<link[^>]+rel="manifest"[^>]*>/g, "<!-- manifest: 单文件模式跳过 -->");
out = out.replace(/<link[^>]+rel="icon"[^>]*>/g, "");

// 4) 加一句提示（顶部细条），说明单文件模式的能力边界
const banner = `<div id="ext-single-banner" style="position:fixed;left:0;right:0;top:0;z-index:99999;
  background:#2f6fed;color:#fff;font:12px/1.6 system-ui,sans-serif;padding:3px 10px;text-align:center;">
  单文件离线模式 · 内置电路列表不可用（需 http）；完整功能请用 <code>ext serve</code>
  <button onclick="this.parentNode.remove()" style="margin-left:8px;background:#fff3;color:#fff;
  border:0;border-radius:4px;padding:1px 6px;cursor:pointer">×</button></div>`;
out = out.replace(/<body([^>]*)>/, `<body$1>\n${banner}`);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out, "utf8");

const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`[single] ${outFile}`);
console.log(`[single] ${kb} KB（内联 1 个 bundle + ${(out.match(/<style>/g) ?? []).length} 段样式）`);
console.log(`[single] 双击即可打开（file:// 可运行）；内置电路列表与字体图标不可用，见文件头注释`);
