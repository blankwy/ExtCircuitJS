// ext-share —— 电路分享（URL / 单 HTML）
//
// 三个命令（命令面板可搜）：
//   ext-share.url    生成分享链接（当前页 + ?ctz=<LZString 压缩电路>）并复制到剪贴板
//   ext-share.copy   同上，但只复制（不弹提示条）
//   ext-share.html   下载自包含单 HTML（含电路，双击即开）
//
// 为什么用 ?ctz=：core 启动时读 `?ctz` → `decompress()` → `startCircuitText`，
// 这是上游既有的分享机制（CommandManager 的 exportasurl 同款），本插件只是把它
// 变成"一键 + 自动复制"，并补上单 HTML 打包。
//
// 单 HTML 的实现思路：**不发起任何网络请求**。
// 页面里已经加载了完整应用，把它需要的资源引用（<script>/<link>）从当前 DOM 里
// 收集出来，连同电路一起拼成一份新的 HTML 文档；电路通过注入的启动脚本在
// window.ExtCircuitJS 就绪后 loadCircuitText 载入。

const KEY_LAST = "ext.share.last";

/** LZString 压缩（core 全局已挂 window.LZString，来自 main.ts 的 import） */
function compressCircuit(text) {
    const LZ = window.LZString;
    if (LZ?.compressToEncodedURIComponent) return LZ.compressToEncodedURIComponent(text);
    return null; // 无 LZString 时降级（调用方处理）
}

/** 当前页 + ?ctz=<压缩电路> */
function buildShareUrl() {
    const ext = window.ExtCircuitJS;
    const xml = ext.api.dumpCircuitXml();
    const ctz = compressCircuit(xml);
    const u = new URL(window.location.href);
    u.searchParams.delete("ctz");
    u.hash = "";
    if (ctz != null) u.searchParams.set("ctz", ctz);
    return { url: u.toString(), xml, compressed: ctz != null, ctz };
}

/** 复制到剪贴板（带降级） */
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;left:-9999px;top:0";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            return ok;
        } catch {
            return false;
        }
    }
}

/** 极简提示条（不打断操作，自动消失） */
function toast(msg, ms = 2600) {
    const el = document.createElement("div");
    el.dataset.extShareToast = "1";
    el.textContent = msg;
    el.style.cssText = [
        "position:fixed", "left:50%", "bottom:28px", "transform:translateX(-50%)",
        "background:#22303f", "color:#fff", "font:13px/1.5 system-ui,sans-serif",
        "padding:9px 16px", "border-radius:8px", "z-index:99999",
        "box-shadow:0 6px 20px rgba(0,0,0,.28)", "max-width:80vw",
        "white-space:pre-wrap", "word-break:break-all", "pointer-events:none",
    ].join(";");
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
}

/** 分享链接（并尝试复制） */
async function shareUrl(showToast) {
    const { url, compressed } = buildShareUrl();
    try { localStorage.setItem(KEY_LAST, url); } catch { /* 隐私模式 */ }
    const ok = await copyText(url);
    if (showToast) {
        toast(ok ? "分享链接已复制（发出去，对方打开即见电路）" : "链接已生成，但复制失败——请手动复制地址栏");
    }
    return { url, compressed, copied: ok };
}

/**
 * 下载自包含单 HTML —— **零网络请求**。
 *
 * 从当前 DOM 收集应用需要的资源引用（script src / link href），绝对化成完整 URL，
 * 再拼一份最小 HTML，附加一段启动脚本：等 window.ExtCircuitJS 就绪后载入电路并开跑。
 *
 * 这样产出的文件依赖**原站点**（脚本仍从原 URL 拉），是"轻量分享页"而不是离线包；
 * 需要真正离线自包含请用 `node tools/ext.mjs bundle-single`（构建期把 JS/CSS 内联）。
 */
function buildShareHtml() {
    const ext = window.ExtCircuitJS;
    const xml = ext.api.dumpCircuitXml();
    const ctz = compressCircuit(xml);

    // 收集当前文档里加载应用所需的外链资源（保持原顺序）
    const pick = (sel, attr) =>
        Array.from(document.querySelectorAll(sel))
            .map((el) => el.getAttribute(attr))
            .filter((v) => !!v && !v.startsWith("data:"))
            .map((v) => new URL(v, document.baseURI).href);
    const scripts = pick("script[src]", "src");
    const styles = pick('link[rel="stylesheet"]', "href");

    const bootShim = ctz == null ? "" : `
<script>
(function(){
  var ctz = ${JSON.stringify(ctz)};
  var t = setInterval(function(){
    var ext = window.ExtCircuitJS;
    if (!ext || !ext.api) return;
    clearInterval(t);
    try {
      var LZ = window.LZString;
      var text = LZ && LZ.decompressFromEncodedURIComponent ? LZ.decompressFromEncodedURIComponent(ctz) : null;
      if (text) { ext.api.loadCircuitText(text, false); ext.api.run(true); }
    } catch (e) { console.warn("[ext-share] load failed", e); }
  }, 50);
  setTimeout(function(){ clearInterval(t); }, 15000);
})();
</script>`;

    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CircuitJS · 分享的电路</title>
${styles.map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join("\n")}
</head>
<body style="margin:0">
${scripts.map((s) => `<script src="${esc(s)}"></script>`).join("\n")}
${bootShim}
</body>
</html>`;

    return { html, hasCircuit: ctz != null, size: new Blob([html]).size };
}

/** 触发浏览器下载 */
function saveAs(html, name) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function activate(ctx) {
    ctx.command({
        id: "ext-share.url",
        label: "分享：生成链接并复制",
        category: "Ext",
        keywords: "share url link 分享 链接 复制",
        run: async () => {
            try { await shareUrl(true); } catch (e) { toast(`生成失败：${e?.message ?? e}`); }
        },
    });

    ctx.command({
        id: "ext-share.copy",
        label: "分享：仅复制链接",
        category: "Ext",
        keywords: "share copy clipboard 分享 复制",
        run: async () => {
            const r = await shareUrl(false);
            toast(r.copied ? "链接已复制" : "复制失败，请手动复制地址栏");
        },
    });

    ctx.command({
        id: "ext-share.html",
        label: "分享：下载单 HTML（含电路）",
        category: "Ext",
        keywords: "share html single file 分享 单文件 下载 离线",
        run: async () => {
            try {
                const r = buildShareHtml();
                const stamp = new Date().toISOString().slice(0, 10);
                saveAs(r.html, `circuit-${stamp}.html`);
                toast(`已下载分享页（${(r.size / 1024).toFixed(1)} KB${r.hasCircuit ? "，含电路" : "（无 LZString，电路未打包）"}）`);
            } catch (e) {
                toast(`打包失败：${e?.message ?? e}`);
            }
        },
    });

    ctx.log("activated: ext-share（3 个命令）");
}

export function deactivate() {
    // 命令由 fiber 自动撤销；无业务级清理
}
