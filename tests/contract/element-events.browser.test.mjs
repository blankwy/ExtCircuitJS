// 元件交互事件契约（select / elemclick，真实 Chromium + 真实鼠标/键盘）
//   node --test tests/contract/element-events.browser.test.mjs
//
// 为什么要真鼠标键盘：这两个事件的整个价值就是"用户动了，插件知道"。
// 只调 API 再断言，测的是测试自己。所以这里用 Playwright 的光标与按键，
// 经由 core 自己的 MouseManager / UIManager 路径产生选择变化。
//
// 断言：
//   1. 在元件上真的点一下 → elemclick 带正确的元件、下标、类型、格点坐标
//   2. Ctrl+A（core 的全选命令）→ select 报出 count=1、ids=["c0"]
//   3. 点空白处（MODE_SELECT 下 mouseup 清空选择）→ select 报出 count=0
//   4. 插件/脚本自己改选择后调用 refreshSelection() → 同样发事件（手动同步通道）
//   5. 事件不重不漏：以上三步一共恰好 3 条 select，指纹无重复
//   6. 无 pageerror
//
// 环境约定同 boot.browser.mjs：EXT_PW_CORE / EXT_CHROME / EXC_BASE（默认 5174）。

import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

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

test("element-events：select / elemclick 由真实交互产生", { timeout: 180_000 }, async () => {
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    try {
        await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
        // 等启动真正结束：window.ExtCircuitJS 在 plugins.load() **之前**就挂上了，
        // 而启动电路（演示电路）可能还在异步装载 —— 不等就会看见"我明明 load 了却有 7 个元件"
        await page.waitForFunction(
            () => {
                const list = window.ExtCircuitJS?.plugins?.list?.() ?? [];
                return list.length > 0 && list.every((p) => p.state === "ready");
            },
            null,
            { timeout: 60000 },
        );

        // ── 布置：一个电阻 + 事件记录器 ────────────────────────────────────
        await page.evaluate(() => {
            const ext = window.ExtCircuitJS;
            const app = ext.app;
            window.__sel = [];
            window.__click = [];
            ext.events.on("select", (p) => window.__sel.push({ count: p.count, ids: p.ids, indices: p.indices }));
            ext.events.on("elemclick", (p) => window.__click.push({ index: p.index, type: p.type, grid: p.grid }));

            app.clearCircuit();             // 显式清空启动电路，别让"演示电路"混进基准
            ext.api.loadCircuitText("r 100 100 300 100 0 1000\n");
            app.showPropsOnClick = false;   // 点元件别再弹属性对话框（模态会挡住后续点击）
        });
        // 电路载入后画布还要重绘一次（居中/缩放是在首帧里落的），
        // 不等这一帧算出来的坐标会打在空地上 —— 这是"我明明点了元件"最常见的假失败。
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

        const geom = await page.evaluate(() => {
            const ext = window.ExtCircuitJS;
            const app = ext.app;
            const cv = app.ui.cv;
            const rect = cv.getBoundingClientRect();
            const at = (gx, gy) => ({
                x: rect.left + app.mouse.transformX(gx),
                y: rect.top + app.mouse.transformY(gy),
            });
            return {
                onElm: at(200, 100),
                // 空白点按画布比例取，而不是按格点取：格点会随缩放跑到画布外，
                // 点到侧栏上就等于什么都没发生（本次踩到的坑）
                empty: { x: rect.left + rect.width * 0.4, y: rect.top + rect.height * 0.78 },
                rect: { l: rect.left, t: rect.top, w: rect.width, h: rect.height },
                types: ext.api.listComponents().map((c) => c.type),
            };
        });
        assert.deepEqual(geom.types, ["ResistorElm"], "基准电路没摆好");
        assert.ok(
            geom.empty.x < geom.rect.l + geom.rect.w && geom.empty.y < geom.rect.t + geom.rect.h,
            "空白点跑出画布了",
        );

        // ── 1) 点元件 → elemclick ─────────────────────────────────────────
        await page.mouse.move(geom.onElm.x, geom.onElm.y);
        const hovered = await page.evaluate(
            () => window.ExtCircuitJS.app.mouse.mouseElm?.getClassName?.() ?? null,
        );
        assert.equal(hovered, "ResistorElm", "坐标没落在电阻上（先看 transform 与两帧等待）");
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForFunction(() => window.__click.length >= 1, null, { timeout: 10000 });

        // ── 2) Ctrl+A（core 的全选）→ select count=1 ───────────────────────
        await page.keyboard.press("Control+a");
        await page.waitForFunction(() => window.__sel.some((e) => e.count === 1), null, { timeout: 10000 });

        // ── 3) 点空白 → 清空选择 → select count=0 ─────────────────────────
        await page.mouse.move(geom.empty.x, geom.empty.y);
        const overEmpty = await page.evaluate(
            () => window.ExtCircuitJS.app.mouse.mouseElm?.getClassName?.() ?? null,
        );
        assert.equal(overEmpty, null, "空白点上不该有元件");
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForFunction(() => window.__sel.some((e) => e.count === 0), null, { timeout: 10000 });

        // ── 4) 手动同步通道：脚本改完选择后 refreshSelection() ─────────────
        await page.evaluate(() => {
            const ext = window.ExtCircuitJS;
            ext.app.elmList[0].setSelected(true);
            ext.refreshSelection();
        });
        await page.waitForFunction(() => window.__sel[window.__sel.length - 1]?.count === 1, null, { timeout: 10000 });

        const out = await page.evaluate(() => ({
            click: window.__click,
            sel: window.__sel,
            // 收尾：别把选中态留给后续（同一页面还有别的断言会再来一遍时更好读）
            count: window.ExtCircuitJS.app.elmList.filter((e) => e.isSelected()).length,
        }));

        assert.equal(out.click.length, 1, `elemclick 应恰好 1 条，实际 ${out.click.length}`);
        assert.equal(out.click[0].index, 0, "elemclick 的元件下标不对");
        assert.equal(out.click[0].type, "ResistorElm", "elemclick 的元件类型不对");
        // 格点坐标是 inverseTransform 取整后的值（浮点像素 → floor），允许 ±1 误差
        assert.ok(
            Math.abs(out.click[0].grid.x - 200) <= 1 && Math.abs(out.click[0].grid.y - 100) <= 1,
            `elemclick 的格点坐标不对：${JSON.stringify(out.click[0].grid)}`,
        );

        assert.equal(out.sel.length, 3, `select 应恰好 3 条（全选/清空/手动同步），实际 ${JSON.stringify(out.sel)}`);
        assert.deepEqual(out.sel[0], { count: 1, ids: ["c0"], indices: [0] }, "Ctrl+A 后的选择快照不对");
        assert.deepEqual(out.sel[1], { count: 0, ids: [], indices: [] }, "点空白未清空选择");
        assert.deepEqual(out.sel[2], { count: 1, ids: ["c0"], indices: [0] }, "refreshSelection 未发出事件");
        assert.equal(out.count, 1, "收尾时选中态与最后一条事件不一致");

        assert.deepEqual(pageErrors, [], `pageerror: ${pageErrors.join(" | ")}`);
    } finally {
        await browser.close();
    }
});
