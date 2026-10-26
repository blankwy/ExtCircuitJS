// 站点配置契约测试（纯 Node，不需要浏览器）
//   node --test tests/contract/site-config.test.mjs
//
// 覆盖 cover/site.config.json → 产物 HTML 的变换（tools/siteConfig.mjs）：
//   1. 全部用默认值时，入口 HTML 除 `data-ext-site-title` 外与上游逐字一致（改配置前不改变行为）
//   2. htmlTitle / description 生效，description 重复注入不叠加
//   3. 关于页注入自定义内容时，上游 GPL / 第三方许可段落**原样保留**（许可证要求）
//   4. homeurl / heading 做 HTML 转义（配置值不进 HTML 结构）
//   5. 幂等：同一个 HTML 连跑两次，结果相同（dev 的 transformIndexHtml 会重复执行）
//   6. 配置字段类型不对时立刻报错，而不是静默产出坏页面

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const { SITE_DEFAULTS, loadSiteConfig, applyToEntryHtml, applyToAboutHtml } = await import(
    "file:///" + path.join(repoRoot, "tools/siteConfig.mjs").replace(/\\/g, "/")
);

const ENTRY = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>CircuitJS</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body></body>
</html>`;

const ABOUT = `<meta charset="UTF-8">
<div>
  <p>Original by Paul Falstad.</p>
  <p style="font-size:9px">This program is free software: GPL.</p>
</div>`;

const cfg = (over = {}) => ({ ...SITE_DEFAULTS, about: { ...SITE_DEFAULTS.about, ...(over.about ?? {}) }, ...over });

test("默认配置不改变上游入口 HTML（只多一个 data 属性）", () => {
    const out = applyToEntryHtml(ENTRY, cfg());
    assert.equal(
        out.replace(' data-ext-site-title="Circuit Simulator"', ""),
        ENTRY,
        "默认值必须与上游原样一致，否则用户改配置前产物就变了",
    );
    assert.match(out, /<html data-ext-site-title="Circuit Simulator">/);
});

test("htmlTitle / description 注入，且重复注入不叠加", () => {
    const c = cfg({ htmlTitle: "电路实验室", description: "自建实例" });
    const once = applyToEntryHtml(ENTRY, c);
    assert.match(once, /<title>电路实验室<\/title>/);
    assert.match(once, /<meta name="description" content="自建实例">/);

    const twice = applyToEntryHtml(once, c);
    assert.equal(twice, once, "transformIndexHtml 会重复跑，必须幂等");
    assert.equal((twice.match(/name="description"/g) ?? []).length, 1);
});

test("关于页自定义内容插在最前，上游许可声明原样保留", () => {
    const c = cfg({ homeurl: "https://example.com/", about: { heading: "关于本站", html: "<p>自建实例。</p>" } });
    const out = applyToAboutHtml(ABOUT, c);

    assert.ok(out.indexOf("关于本站") < out.indexOf("Paul Falstad"), "自定义内容应排在原作者信息之前");
    assert.match(out, /<p>自建实例。<\/p>/);
    assert.match(out, /href="https:\/\/example\.com\/"/);
    // 许可证段落是硬要求：不能被自定义内容顶掉
    assert.match(out, /Original by Paul Falstad\./);
    assert.match(out, /This program is free software: GPL\./);
});

test("默认配置下关于页完全不变", () => {
    assert.equal(applyToAboutHtml(ABOUT, cfg()), ABOUT);
});

test("配置值做 HTML 转义，不会破坏结构", () => {
    const c = cfg({
        htmlTitle: 'A"><script>alert(1)</script>',
        homeurl: 'https://x/" onmouseover="alert(1)',
        about: { heading: "<b>x</b>", html: "" },
    });
    const entry = applyToEntryHtml(ENTRY, c);
    assert.ok(!entry.includes("<script>alert(1)</script>"), "title 里的标签必须被转义");
    const about = applyToAboutHtml(ABOUT, c);
    assert.match(about, /&lt;b&gt;x&lt;\/b&gt;/, "heading 里的标签必须被转义");
    assert.ok(!about.includes('onmouseover="alert(1)"'), "homeurl 里的引号必须被转义");
});

test("按 coverDir 读配置；文件缺失时退回默认值", () => {
    const loaded = loadSiteConfig(path.join(repoRoot, "cover"));
    assert.equal(loaded.title, SITE_DEFAULTS.title);
    assert.equal(loaded.htmlTitle, SITE_DEFAULTS.htmlTitle);

    const empty = loadSiteConfig(path.join(repoRoot, "tests")); // 该目录没有 site.config.json
    assert.deepEqual(empty, SITE_DEFAULTS);
});

test("字段类型不对立刻报错，不静默产出坏页面", () => {
    const dir = fs.mkdtempSync(path.join(repoRoot, ".tmp-site-config-"));
    try {
        for (const bad of [{ title: 123 }, { about: { html: [] } }]) {
            fs.writeFileSync(path.join(dir, "site.config.json"), JSON.stringify(bad));
            assert.throws(() => loadSiteConfig(dir), /site\.config/);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
