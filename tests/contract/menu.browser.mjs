// A06 菜单插槽浏览器契约：自定义元件出现在 Add(Draw) 菜单与右键菜单且可点
//   node tests/contract/menu.browser.mjs   （dev server 须在 5174）
// 断言：
//   1. registerMenuElement + installMenuSlot 结构化成功
//   2. 自定义项出现在 popup（mainMenuBar）与 Draw 菜单两处 DOM（计 2 条）
//   3. 点击后进入放置模式：app.ui.mouseModeStr === 自定义类名
//   4. unregisterMenuElements 后 DOM 条目清零（插件卸载语义）
// 环境约定同 boot.browser.mjs：EXT_PW_CORE / EXT_CHROME / EXC_BASE。

import fs from "node:fs";
import path from "node:path";

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

const EXT_MENUS_URL =
    "/@fs/" + path.resolve(import.meta.dirname, "../../cover/ts/ExtMenus.ts").replace(/\\/g, "/");

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
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));

try {
    await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
    await page.waitForTimeout(1200);

    const result = await page.evaluate(async (extMenusUrl) => {
        const out = { steps: [], errors: [] };
        try {
            // 1) 自定义元件类：继承 ResistorElm，空闲 dump 类型 + 专属 xml 类型 + 无快捷键。
            //    ⚠ 工厂必须用 window.ExtCircuitJS.elements.factory（页面/应用那份实例）：
            //    dev 下动态 import "/ElementFactory.ts" 是另一个模块 URL（应用内部走 @fs/…），
            //    会拿到第二份 classMap —— 类注册在那儿，app.constructElement 仍然找不到。
            const ElementFactory = window.ExtCircuitJS.elements.factory;
            const ResistorElm = ElementFactory.getClass("ResistorElm");
            // ExtMenus.ts 是 cover 新增文件（无 core 对应物），走 /@fs/ 绝对路径装载
            const extMenus = await import(extMenusUrl);
            class ExtMenuProbeElm extends ResistorElm {
                getDumpType() { return 199; } // 空闲 txt 类型，不与 core 撞注册表
                getXmlDumpType() { return "ExtShunt"; }
                getShortcut() { return 0; }
            }
            ElementFactory.registerClass("ExtMenuProbeElm", ExtMenuProbeElm, "ext-test");
            out.steps.push({ step: "registerClass", ok: ElementFactory.hasClass("ExtMenuProbeElm") });

            // 2) 登记 + 安装插槽
            const r1 = extMenus.registerMenuElement("Add Ext Shunt", "ExtMenuProbeElm", "ext-test");
            const r2 = extMenus.installMenuSlot();
            out.steps.push({ step: "registerMenuElement", ...r1 }, { step: "installMenuSlot", ...r2 });

            // 3) DOM 断言：右键弹出菜单（mainMenuBar，游离于文档外）与文档内 Draw 菜单各 1 条
            const app2 = window.ExtCircuitJS.app;
            const findItems = () =>
                Array.from(document.querySelectorAll("li[data-ext-menu='ExtMenuProbeElm']"));
            out.popupHas = app2.menus.mainMenuBar?.querySelector("li[data-ext-menu='ExtMenuProbeElm']") != null;
            out.domCount = findItems().length; // 文档内 = Draw 菜单那条

            // 4) 可点：dispatch click → 进入放置模式
            const li = findItems()[0];
            li?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            out.mouseModeStr = app2.ui?.mouseModeStr ?? null;

            // 5) 卸载语义
            const removed = extMenus.unregisterMenuElements("ext-test");
            out.removed = removed;
            out.popupHasAfter = app2.menus.mainMenuBar?.querySelector("li[data-ext-menu='ExtMenuProbeElm']") != null;
            out.domCountAfter = findItems().length;
            // 只看本次登记项是否清干净：示例插件也可能登记了自己的元件（全局计数不再为 0）
            out.entriesLeft = extMenus.extMenuEntries().filter((e) => e.className === "ExtMenuProbeElm").length;
        } catch (e) {
            out.errors.push(String((e && e.stack) || e));
        }
        return out;
    }, EXT_MENUS_URL);

    const bad = logs.filter((l) => l.startsWith("[pageerror]"));
    const ok =
        result.errors.length === 0 &&
        (result.steps ?? []).every((s) => s.ok === true) &&
        result.popupHas === true &&
        result.domCount === 1 &&
        result.mouseModeStr === "ExtMenuProbeElm" &&
        result.removed === 1 &&
        result.popupHasAfter === false &&
        result.domCountAfter === 0 &&
        result.entriesLeft === 0 &&
        bad.length === 0;
    const summary = { ok, ...result, pageErrors: bad.slice(0, 5) };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
        console.log("--- console tail ---");
        console.log(logs.slice(-20).join("\n"));
        process.exitCode = 1;
    }
} finally {
    await browser.close();
}
