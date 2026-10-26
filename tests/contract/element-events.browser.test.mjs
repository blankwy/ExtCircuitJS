// 元件交互事件契约（select / elemclick / elemdrag / elementschange，真实 Chromium + 真实鼠标/键盘）
//   node --test tests/contract/element-events.browser.test.mjs
//
// 为什么要真鼠标键盘：这些事件的整个价值就是"用户动了，插件知道"。
// 只调 API 再断言，测的是测试自己。所以这里用 Playwright 的光标与按键，
// 经由 core 自己的 MouseManager / UIManager 路径产生选择/拖动/删除。
//
// 用例一（select / elemclick）：
//   1. 在元件上真的点一下 → elemclick 带正确的元件、下标、类型、格点坐标
//   2. Ctrl+A（core 的全选命令）→ select 报出 count=1、ids=["c0"]
//   3. 点空白处（MODE_SELECT 下 mouseup 清空选择）→ select 报出 count=0
//   4. 插件/脚本自己改选择后调用 refreshSelection() → 同样发事件（手动同步通道）
//   5. 事件不重不漏：以上三步一共恰好 3 条 select，指纹无重复
//   6. 无 pageerror
//
// 用例二（elemdrag / elementschange）：
//   7. 真拖一个电阻（core 有 150ms 防误拖延迟，所以按下后要等）→
//      elemdrag start…move…end 成对、delta 与格点位移一致、只报动过的元件
//   8. 拖动不算结构变化（elementschange 不发）
//   9. Delete 键删元件 → elementschange(source=keyboard) removed=[ResistorElm]
//  10. Ctrl+Z 还原 → elementschange(source=undo) added=[ResistorElm]
//  11. 载入另一份电路 → elementschange(source=load) 且 count 正确
//  12. 示例插件（走 ctx.on 的正式通道）确实收到了 lastDrag/lastChange
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

test("element-events：拖动/删除/撤销/载入产生 elemdrag 与 elementschange", { timeout: 180_000 }, async () => {
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
        await page.waitForFunction(
            () => {
                const list = window.ExtCircuitJS?.plugins?.list?.() ?? [];
                return list.length > 0 && list.every((p) => p.state === "ready");
            },
            null,
            { timeout: 60000 },
        );

        // ── 布置：一个电阻 + 记录器；布置期间的载入事件不计入断言 ─────────────
        await page.evaluate(() => {
            const ext = window.ExtCircuitJS;
            const app = ext.app;
            window.__drag = [];
            window.__chg = [];
            ext.events.on("elemdrag", (p) => window.__drag.push({
                phase: p.phase, ids: p.ids, indices: p.indices, grid: p.grid, delta: p.delta,
            }));
            ext.events.on("elementschange", (p) => window.__chg.push({
                source: p.source, count: p.count,
                added: p.added.map((r) => r.type), removed: p.removed.map((r) => r.type),
            }));
            app.clearCircuit();
            ext.api.loadCircuitText("r 100 100 300 100 0 1000\n");
            app.showPropsOnClick = false; // 拖动/点击都不弹属性框（模态会吃掉后续按键）
        });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await page.evaluate(() => { window.__drag.length = 0; window.__chg.length = 0; });

        const geom = await page.evaluate(() => {
            const app = window.ExtCircuitJS.app;
            const rect = app.ui.cv.getBoundingClientRect();
            return {
                x: rect.left + app.mouse.transformX(200),
                y: rect.top + app.mouse.transformY(100),
                count: window.ExtCircuitJS.app.elmList.length,
                // 断言类型列表而不只是数量：少写一个字段时上游会静默丢元件，
                // 只报"数量不对"根本看不出是被吞了导线还是事件系统坏了
                types: window.ExtCircuitJS.api.listComponents().map((c) => c.type),
                // 一格 = 多少像素（缩放后不是 16；用大跨度取平均，避开 transformX 的取整）
                pxPerUnit: (app.mouse.transformX(100) - app.mouse.transformX(0)) / 100,
            };
        });
        assert.deepEqual(geom.types, ["ResistorElm"], `基准电路没摆好（types=${JSON.stringify(geom.types)}）`);

        // ── 7/8) 真拖：按下 → 等过 core 的 150ms 防误拖 → 拖 48px（3 格）→ 松开 ──
        await page.mouse.move(geom.x, geom.y);
        await page.mouse.down();
        await page.waitForTimeout(300);
        await page.mouse.move(geom.x + 48, geom.y, { steps: 8 });
        await page.waitForTimeout(50);
        await page.mouse.up();
        await page.waitForFunction(() => window.__drag.some((d) => d.phase === "end"), null, { timeout: 10000 });

        const dragOut = await page.evaluate(() => ({
            drag: window.__drag,
            chg: window.__chg,
            x: window.ExtCircuitJS.app.elmList[0]?.x ?? null,
            classes: window.ExtCircuitJS.app.elmList.map((e) => e.getClassName()),
        }));
        assert.equal(dragOut.drag[0].phase, "start", `第一条 elemdrag 应是 start：${JSON.stringify(dragOut.drag[0])}`);
        assert.equal(dragOut.drag.at(-1).phase, "end", "最后一条 elemdrag 应是 end");
        assert.ok(dragOut.drag.length >= 2, `拖动应至少 start+end 两条，实际 ${dragOut.drag.length}`);
        assert.deepEqual(dragOut.drag[0].ids, ["c0"], "拖动事件应报出被拖的元件");
        assert.deepEqual(dragOut.drag[0].indices, [0]);
        const wantDelta = 48 / geom.pxPerUnit;
        assert.ok(
            Math.abs(dragOut.drag.at(-1).delta.x - wantDelta) <= 1,
            `48px 应约等于 ${wantDelta.toFixed(1)} 格位移，实际 ${JSON.stringify(dragOut.drag.at(-1).delta)}`,
        );
        assert.ok(dragOut.x > 100, `元件没真的被拖走（x=${dragOut.x}）—— 先看 150ms 防误拖有没有等够`);
        assert.equal(dragOut.chg.length, 0, `只挪位置不该报结构变化：${JSON.stringify(dragOut.chg)}`);

        // ── 9) Delete 删掉选中的电阻 → elementschange(keyboard) ──────────────
        await page.keyboard.press("Delete");
        await page.waitForFunction(() => window.__chg.some((c) => c.removed.length > 0), null, { timeout: 10000 });
        const afterDelete = await page.evaluate(() => window.__chg.at(-1));
        assert.equal(afterDelete.source, "keyboard", `键盘删除的来源应是 keyboard：${JSON.stringify(afterDelete)}`);
        assert.deepEqual(afterDelete.removed, ["ResistorElm"]);
        assert.equal(afterDelete.count, 0);

        // ── 10) Ctrl+Z 还原 → elementschange(undo)。上游撤销是重解析，对象身份变了，
        //        所以这里如实报"一删一加"（不必假装是同一条元件，插件本来也拿不到稳定 id）
        await page.keyboard.press("Control+z");
        await page.waitForFunction(() => window.__chg.some((c) => c.source === "undo"), null, { timeout: 10000 });
        const afterUndo = await page.evaluate(() => window.__chg.at(-1));
        assert.equal(afterUndo.source, "undo");
        assert.deepEqual(afterUndo.added, ["ResistorElm"], `撤销后应报出恢复的元件：${JSON.stringify(afterUndo)}`);
        assert.equal(afterUndo.count, 1);

        // ── 11) 载入另一份电路 → elementschange(load) ─────────────────────────
        //       文本格式每行都要 5 个字段（x1 y1 x2 y2 flags）；导线少写 flags 会被上游静默丢掉
        await page.evaluate(() => {
            window.ExtCircuitJS.api.loadCircuitText("r 100 100 300 100 0 1000\nw 300 100 400 100 0\n");
        });
        const afterLoad = await page.evaluate(() => window.__chg.at(-1));
        assert.equal(afterLoad.source, "load", `载入的来源应是 load：${JSON.stringify(afterLoad)}`);
        assert.equal(afterLoad.count, 2);
        assert.deepEqual(afterLoad.added, ["ResistorElm", "WireElm"], "新电路的两个元件都要报出来");

        // ── 12) 示例插件走 ctx.on 的正式通道，也确实收到了 ────────────────────
        const plug = await page.evaluate(() => {
            const read = (k) => {
                const raw = localStorage.getItem("ext.plugin.ext-event." + k);
                return raw == null ? null : JSON.parse(raw);
            };
            return { drag: read("lastDrag"), change: read("lastChange") };
        });
        assert.ok(plug.drag && Array.isArray(plug.drag.ids), "示例插件没收到 elemdrag（ctx.on 通道）");
        assert.deepEqual(plug.drag.ids, ["c0"]);
        assert.equal(plug.change?.source, "load", `示例插件最后一条 elementschange 应是载入：${JSON.stringify(plug.change)}`);

        assert.deepEqual(pageErrors, [], `pageerror: ${pageErrors.join(" | ")}`);
    } finally {
        await browser.close();
    }
});
