// 插件自定义元件契约（ctx.element 全链路，真实 Chromium）
//   node --test tests/contract/plugin-element.browser.test.mjs
//
// 断言（一条"自定义元件到底能不能用"的完整判据，缺一条就是半成品）：
//   1. 示例插件 ext-element 随启动 ready，声明了 ExtShuntElm
//   2. 类进工厂：base("ResistorElm") 拿得到基类、create 出实例、默认阻值 0.5
//   3. 类型映射：CirSim.dumpTypeMap[dumpType] / xmlDumpTypeMap["ExtShunt"] 都指向它
//      （否则存档读不回来 —— 这是这类功能最容易漏的一半）
//   4. 菜单：Draw 菜单 + 右键弹出菜单各一条，点击进入放置模式
//   5. 文本存档往返：以 dumpType 写文本 → 读回仍是自定义类 → dump XML 含 ExtShunt
//      → 再按 XML 读回，元件数与类型不变
//   6. 卸载：菜单条目消失、类从工厂消失、两份映射清空、放置模式复位；
//      再读同一段文本得到 0 元件（不会半死不活地留个空壳）
//   7. 全程无 pageerror
//
// 环境约定同 boot.browser.mjs：EXT_PW_CORE / EXT_CHROME / EXC_BASE（默认 5174）。

import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { activatePlugins } from "./helpers/activate-plugins.mjs";

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? "http://127.0.0.1:5174";

function probeServer(url) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on("error", () => resolve(0));
        req.setTimeout(5000, () => { req.destroy(); resolve(0); });
    });
}

test("plugin-element：自定义元件注册/存档往返/卸载", { timeout: 180_000 }, async () => {
    assert.ok(fs.existsSync(PW_CORE), `playwright-core 不存在: ${PW_CORE}（可用 EXT_PW_CORE 覆盖）`);
    assert.ok(fs.existsSync(CHROME), `Chrome 不存在: ${CHROME}（可用 EXT_CHROME 覆盖）`);
    const status = await probeServer(`${BASE}/circuitjs.html`);
    assert.ok(status >= 200 && status < 400, `dev server 未就绪: ${BASE}（先跑 node tools/ext.mjs dev --port 5174）`);

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
    page.on("console", (m) => { if (m.type() === "error") logs.push(`[error] ${m.text()}`); });

    try {
        await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
        // 站点配置默认禁用示例插件：显式激活 ext-element（自定义元件示例）
        await activatePlugins(page, ["ext-element"], BASE);
        // window.ExtCircuitJS 在 plugins.load() **之前**就挂上（ExtBoot 的顺序），
        // 所以不能只等它出现——等插件真正进入 ready（确定性等待，不用 sleep 兜底）
        await page.waitForFunction(
            () => window.ExtCircuitJS?.plugins?.list().some((p) => p.id === "ext-element" && p.state === "ready"),
            null,
            { timeout: 60000 },
        );

        const r = await page.evaluate(async () => {
            const out = { steps: [] };
            const ext = window.ExtCircuitJS;
            const app = ext.app;
            const CirSim = app.constructor;

            // ── 1) 插件就绪 ────────────────────────────────────────────────
            out.plugin = ext.plugins.list().find((p) => p.id === "ext-element") ?? null;

            // ── 2) 类进工厂（一律经 app 自己的入口，不另外 import 模块实例：
            //        dev 下 HMR 的 ?t= 会让动态 import 拿到与页面不同的模块实例，
            //        那种"身份断言"测的是测试自己，不是产品） ──────────────────
            const inst = app.constructElement("ExtShuntElm", 100, 100);
            out.hasClass = inst != null;
            out.baseIsResistor = app.constructElement("ResistorElm", 0, 0) != null;
            out.instantiated = inst != null;
            out.defaultResistance = inst?.resistance ?? null;

            // ── 3) 类型映射（存档可读回的前提） ─────────────────────────────
            let dumpType = null;
            for (const [t, name] of CirSim.dumpTypeMap) if (name === "ExtShuntElm") dumpType = t;
            out.dumpType = dumpType;
            out.xmlType = CirSim.xmlDumpTypeMap.get("ExtShunt") ?? null;

            // ── 4) 菜单：文档内 Draw 菜单 + 右键弹出菜单 ────────────────────
            out.drawHas = document.querySelectorAll("li[data-ext-menu='ExtShuntElm']").length;
            out.popupHas = app.menus.mainMenuBar?.querySelector("li[data-ext-menu='ExtShuntElm']") != null;
            const li = document.querySelector("li[data-ext-menu='ExtShuntElm']");
            li?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            out.mouseModeStr = app.ui?.mouseModeStr ?? null;

            // ── 5) 文本/XML 往返 ──────────────────────────────────────────
            // ResistorElm 文本格式：<dumpType> x1 y1 x2 y2 flags resistance
            const text = `${dumpType} 100 100 200 100 0 0.5\n`;
            ext.api.loadCircuitText(text);
            out.textComponents = ext.api.listComponents().map((c) => c.type);
            const xml = ext.api.dumpCircuitXml();
            out.xmlHasCustom = xml.includes("ExtShunt");
            ext.api.loadCircuitXml(xml);
            out.xmlComponents = ext.api.listComponents().map((c) => c.type);

            // ── 6) 卸载 ───────────────────────────────────────────────────
            await ext.plugins.deactivate("ext-element");
            out.after = {
                drawHas: document.querySelectorAll("li[data-ext-menu='ExtShuntElm']").length,
                popupHas: app.menus.mainMenuBar?.querySelector("li[data-ext-menu='ExtShuntElm']") != null,
                hasClass: app.constructElement("ExtShuntElm", 0, 0) != null,
                dumpTypeLeft: CirSim.dumpTypeMap.get(dumpType) ?? null,
                xmlTypeLeft: CirSim.xmlDumpTypeMap.get("ExtShunt") ?? null,
                mouseModeStr: app.ui?.mouseModeStr ?? null,
            };
            // 卸载后再读同一段文本：应认不出来（0 元件），而不是崩或留个空壳
            ext.api.loadCircuitText(text);
            out.after.textComponents = ext.api.listComponents().length;

            // ── 7) 重新装载：证明是可重复的生命周期，不是一次性魔术 ─────────
            //     entry 一律从 manifest 取，别手写：权限、claims 都挂在里面，
            //     手写等于让测试自带一份会过期的副本（插件加权限后这里就红）。
            const manifest = await (await fetch("/plugins/plugins.manifest.json", { cache: "no-store" })).json();
            const entry = manifest.plugins.find((p) => p.id === "ext-element");
            await ext.plugins.activate({ ...entry, rev: Date.now() });
            out.remounted = {
                state: ext.plugins.list().find((p) => p.id === "ext-element")?.state ?? null,
                drawHas: document.querySelectorAll("li[data-ext-menu='ExtShuntElm']").length,
                hasClass: app.constructElement("ExtShuntElm", 0, 0) != null,
            };
            return out;
        });

        const pageErrors = logs.filter((l) => l.startsWith("[pageerror]"));
        const hostErrors = logs.filter((l) => l.includes("plugin") && l.startsWith("[error]"));

        assert.equal(r.plugin?.state, "ready", "ext-element 未就绪");
        assert.equal(r.plugin?.error ?? null, null);
        assert.equal(r.hasClass, true, "类未进 ElementFactory");
        assert.equal(r.baseIsResistor, true, "getClass('ResistorElm') 取不到基类");
        assert.equal(r.instantiated, true, "create 出不来实例");
        assert.equal(r.defaultResistance, 0.5, "默认阻值不是 0.5");

        assert.equal(typeof r.dumpType, "number", "dumpTypeMap 未收录");
        assert.equal(r.xmlType, "ExtShuntElm", "xmlDumpTypeMap 未收录");

        assert.equal(r.drawHas, 1, "Draw 菜单条目数不对");
        assert.equal(r.popupHas, true, "右键菜单条目缺失");
        assert.equal(r.mouseModeStr, "ExtShuntElm", "点击后未进入放置模式");

        assert.deepEqual(r.textComponents, ["ExtShuntElm"], "文本存档读回失败");
        assert.equal(r.xmlHasCustom, true, "XML 导出不含 ExtShunt");
        assert.deepEqual(r.xmlComponents, ["ExtShuntElm"], "XML 存档读回失败");

        assert.equal(r.after.drawHas, 0, "卸载后 Draw 菜单仍有条目");
        assert.equal(r.after.popupHas, false, "卸载后右键菜单仍有条目");
        assert.equal(r.after.hasClass, false, "卸载后类仍在工厂");
        assert.equal(r.after.dumpTypeLeft, null, "卸载后 dumpTypeMap 残留");
        assert.equal(r.after.xmlTypeLeft, null, "卸载后 xmlDumpTypeMap 残留");
        assert.notEqual(r.after.mouseModeStr, "ExtShuntElm", "卸载后仍停在已删除元件的放置模式");
        assert.equal(r.after.textComponents, 0, "卸载后旧文本仍能加载出元件");

        assert.equal(r.remounted.state, "ready", "重新装载后未 ready");
        assert.equal(r.remounted.drawHas, 1, "重新装载后菜单条目缺失");
        assert.equal(r.remounted.hasClass, true, "重新装载后类未回到工厂");

        assert.deepEqual(pageErrors, [], `pageerror: ${pageErrors.join(" | ")}`);
        assert.deepEqual(hostErrors, [], `宿主/插件 console error: ${hostErrors.join(" | ")}`);
    } finally {
        await browser.close();
    }
});
