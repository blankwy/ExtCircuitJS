// UI 外观 + 新拟态插件端到端契约
//   node tests/contract/ui-themes.browser.mjs  （dev server 须在 5174）
// 断言：
//   1. ext-theme / ext-neumorph 自动加载 ready（manifest enabled:true，不在禁用名单）
//   2. 新拟态默认开：html.ext-neumorph 类挂上、样式表注入、画布翻白（printable=true）
//   3. ext-theme 初始为浅色态（无 data-ext-theme）
//   4. 点【选项】菜单的 UI 外观项 → data-ext-theme="dark"、样式表注入
//   5. 再点新拟态项 → 类摘除、样式移除（可关）
//   6. deactivate ext-theme → 属性清理

import fs from "node:fs";

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? "http://127.0.0.1:5174";

function fail(msg) {
    console.error("FAIL:", msg);
    process.exit(1);
}
if (!fs.existsSync(PW_CORE)) fail(`playwright-core not found: ${PW_CORE}`);
if (!fs.existsSync(CHROME)) fail(`chrome not found: ${CHROME}`);

const { chromium } = await import("file:///" + PW_CORE.replace(/\\/g, "/"));
const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
});
const page = await browser.newPage();
page.on("dialog", (d) => d.dismiss().catch(() => {}));
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

try {
    await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
    await page.waitForTimeout(1500);

    const result = await page.evaluate(async () => {
        const out = { steps: [], errors: [] };
        const ext = window.ExtCircuitJS;
        try {
            const st = (id) => ext.plugins.list().find((p) => p.id === id)?.state;
            out.steps.push({ step: "themes-ready", ok: st("ext-theme") === "ready" && st("ext-neumorph") === "ready" });

            // 新拟态默认开
            out.steps.push({
                step: "neumorph-on",
                ok: document.documentElement.classList.contains("ext-neumorph")
                    && !!document.getElementById("ext-neumorph-style")
                    && ext.app.menus.printableCheckItem.getState() === true,
            });

            // ext-theme 初始浅色（无 data 属性）
            out.steps.push({ step: "theme-initial-light", ok: !document.documentElement.dataset.extTheme });

            // 点选项菜单的 UI 外观项 → 深色
            const optionsMenu = ext.app.menus.menuBarRow.children[4].querySelector("ul.menuDropdown");
            const themeLi = optionsMenu.querySelector("li[data-ext-theme-item]");
            const neuLi = optionsMenu.querySelector("li[data-ext-neumorph-item]");
            out.steps.push({ step: "menu-items-present", ok: !!themeLi && !!neuLi });
            themeLi?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            out.steps.push({
                step: "theme-dark-after-click",
                ok: document.documentElement.dataset.extTheme === "dark"
                    && !!document.getElementById("ext-theme-style"),
            });
            // 深色联动画布翻黑：printable 应为 false
            out.steps.push({ step: "canvas-dark", ok: ext.app.menus.printableCheckItem.getState() === false });

            // 点新拟态项 → 关
            neuLi?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            out.steps.push({
                step: "neumorph-off-after-click",
                ok: !document.documentElement.classList.contains("ext-neumorph")
                    && !document.getElementById("ext-neumorph-style"),
            });

            // deactivate ext-theme → 属性清理
            await ext.plugins.deactivate("ext-theme");
            out.steps.push({
                step: "theme-cleanup",
                ok: !document.documentElement.dataset.extTheme && !document.getElementById("ext-theme-style"),
            });
        } catch (e) {
            out.errors.push(String((e && e.stack) || e));
        }
        return out;
    });

    const ok = result.errors.length === 0 && (result.steps ?? []).every((s) => s.ok === true)
        && logs.filter((l) => l.startsWith("[pageerror]")).length === 0;
    console.log(JSON.stringify({ ok, ...result, pageErrors: logs.slice(0, 5) }, null, 2));
    if (!ok) process.exitCode = 1;
} finally {
    await browser.close();
}
