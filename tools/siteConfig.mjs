// 站点配置（用户可改的那一份在 cover/site.config.json）
//
// 职责边界：这里只做「文件 → 字符串变换」，不关心站点挂在哪个域名、用哪种方式部署。
// 域名的归属是部署侧（Pages 设置 / 反向代理），配置文件里刻意不出现任何 URL 默认值。
//
// 被两处消费：
//   - cover/vite.cover.config.ts 的 extSiteConfig() 插件（dev 中间件 + build 收尾）
//   - 浏览器侧 cover/ts/SiteConfig.ts 只读 title（运行时覆盖 CirSim.baseTitle）

import fs from "node:fs";
import path from "node:path";

/** 字段缺省值 == 未配置时的行为，必须与上游原样一致（否则改配置前产物就变了） */
export const SITE_DEFAULTS = {
    /** 运行时浏览器标题基名（原 CirSim.baseTitle），电路名会拼成 "<电路名> - <title>" */
    title: "Circuit Simulator",
    /** 静态 <title>（首屏、SEO、分享卡片用） */
    htmlTitle: "CircuitJS",
    /** <meta name="description">；空字符串则不注入 */
    description: "",
    /** 关于页的返回主页链接；空字符串则不渲染 */
    homeurl: "",
    about: {
        /** 自定义关于内容的标题；空则不渲染标题 */
        heading: "",
        /** 自定义关于内容（原样插入的 HTML）；空则不渲染 */
        html: "",
    },
    /** 插件启停（部署侧）：默认不自动加载的插件 id 列表。空 = 全部按 manifest 的 enabled 走。
     *  只影响 load() 的自动加载；显式 activate(id) 不受限制。 */
    plugins: {
        disabled: [],
    },
};

const readJson = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
        throw new Error(`[site.config] 无法解析 ${file}: ${e.message}`);
    }
};

/** 读 cover/site.config.json 并与默认值深合并；文件缺失时全部用默认值 */
export function loadSiteConfig(coverRoot) {
    const file = path.join(coverRoot, "site.config.json");
    const raw = fs.existsSync(file) ? readJson(file) : {};
    const about = { ...SITE_DEFAULTS.about, ...(raw.about ?? {}) };
    const plugins = { ...SITE_DEFAULTS.plugins, ...(raw.plugins ?? {}) };
    const cfg = { ...SITE_DEFAULTS, ...raw, about, plugins };
    for (const key of ["title", "htmlTitle", "description", "homeurl"]) {
        if (typeof cfg[key] !== "string") throw new Error(`[site.config] ${key} 必须是字符串`);
    }
    for (const key of ["heading", "html"]) {
        if (typeof about[key] !== "string") throw new Error(`[site.config] about.${key} 必须是字符串`);
    }
    if (!Array.isArray(plugins.disabled) || plugins.disabled.some((x) => typeof x !== "string"))
        throw new Error(`[site.config] plugins.disabled 必须是字符串数组`);
    return cfg;
}

const escapeHtml = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 入口 HTML 后处理：title / description / cover 层自己的样式表。
 *
 * coverCssHref 由调用方给：dev 走 Vite 的 `/ext-cover.css`（cover/public 的影子路径），
 * build 给 `/circuitjs/ext-cover.css`（与 core public 同命名空间），随后由
 * finalizeForHosting 统一转成相对路径——所以这里一律用「站点根绝对路径」书写。
 */
export function applyToEntryHtml(html, cfg, { coverCssHref } = {}) {
    let out = html;
    // 运行时标题基名通过 data-* 传给浏览器（cover/ts/SiteConfig.ts 读它覆盖 CirSim.baseTitle）。
    // 走 HTML 而不是让 JS import JSON：dev 下改配置刷新即生效，不用等模块 HMR。
    // 先摘掉已有的属性保证幂等：dev 的 transformIndexHtml 会对同一次请求反复跑。
    out = out.replace(/\sdata-ext-site-title="[^"]*"/gi, "");
    out = out.replace(/<html([^>]*)>/i, `<html$1 data-ext-site-title="${escapeHtml(cfg.title)}">`);

    // 插件启停名单也走 data-*（浏览器侧 ExtPluginHost.load 读它过滤）。
    // 只在非空时注入——默认配置必须与上游原样一致（site-config 测试逐字节断言）。
    out = out.replace(/\sdata-ext-site-disabled="[^"]*"/gi, "");
    if (cfg.plugins?.disabled?.length > 0) {
        out = out.replace(/<html([^>]*)>/i, `<html$1 data-ext-site-disabled="${escapeHtml(JSON.stringify(cfg.plugins.disabled))}">`);
    }

    const titleTag = `<title>${escapeHtml(cfg.htmlTitle)}</title>`;
    out = out.includes("<title>")
        ? out.replace(/<title>[\s\S]*?<\/title>/, titleTag)
        : out.replace(/<\/head>/i, `  ${titleTag}\n</head>`);

    if (cfg.description) {
        const meta = `<meta name="description" content="${escapeHtml(cfg.description)}">`;
        if (/<meta\s+name="description"/i.test(out)) {
            out = out.replace(/<meta\s+name="description"[^>]*>/i, meta);
        } else {
            out = out.replace(/<\/head>/i, `  ${meta}\n</head>`);
        }
    }

    // cover 层自己的公共样式：A05 的 cover/public 覆盖样例。上游 circuitjs.html 是 core 文件，
    // 同步上游会把加进去的 link 冲掉，所以引用由本插件每次构建/启动时补回。
    if (coverCssHref && !out.includes(coverCssHref)) {
        out = out.replace(/<\/head>/i, `  <link rel="stylesheet" href="${coverCssHref}">\n</head>`);
    }
    return out;
}

/**
 * 关于页注入。
 *
 * 上游 about.html 里有一大段 GPL / 第三方许可声明——那是许可证要求保留的，不能因为
 * 「自定义关于内容」就被顶掉。所以自定义内容只插在正文最前面，原声明一段不动地留在下面。
 */
export function applyToAboutHtml(html, cfg) {
    const { heading, html: body } = cfg.about;
    if (!heading && !body && !cfg.homeurl) return html;

    const parts = ['<div class="ext-about">'];
    if (heading) parts.push(`  <h2>${escapeHtml(heading)}</h2>`);
    if (body) parts.push(body);
    if (cfg.homeurl) {
        parts.push(`  <p><a href="${escapeHtml(cfg.homeurl)}" target="_blank" rel="noopener">返回主页</a></p>`);
    }
    parts.push("</div>");
    const block = parts.join("\n") + "\n";

    // 注入点：about.html 是 HTML 片段（meta + style + div），插在第一个 <div> 之后最自然；
    // 模板被换掉时退化为插到最前面，不至于把内容丢掉。
    const m = html.match(/<div[^>]*>/i);
    if (m && m.index !== undefined) {
        const at = m.index + m[0].length;
        return html.slice(0, at) + "\n" + block + html.slice(at);
    }
    return block + html;
}
