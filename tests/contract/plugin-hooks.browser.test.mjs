// 插件打开/保存钩子契约（ctx.hook，真实 Chromium）
//   node --test tests/contract/plugin-hooks.browser.test.mjs
//
// 断言（"插件的 load/save 钩子到底接没接线"的完整判据）：
//   1. 示例插件 ext-hook 随启动 ready
//   2. 保存侧生效：app.dumpCircuit()（= 保存/导出走的唯一出口）带插件写入的标记
//   3. 幂等：连续保存三次标记仍只有一个；保存 → 打开 → 再保存不累积
//   4. 载入侧生效：带标记的存档能读回，元件类型与数量不变（钩子把标记还原掉才可能成立）
//   5. 来源过滤：撤销快照（dumpCircuit 经 undoManager.pushUndo）**不带**标记，
//      即插件的 save 钩子按 meta.source 跳过了内部序列化；撤销后电路仍完整
//   6. normalize：带 UTF-8 BOM + CRLF 的文件能正常打开（BOM 会让核心的
//      `text.startsWith("<")` 判成纯文本格式，是"存档打不开"的经典成因）
//   7. 卸载后：钩子数归 0、dumpCircuit 不再带标记、同一段 BOM 文本又打不开了
//      （证明第 6 条的效果确实来自插件，而不是本来就成立）
//   8. 全程无 pageerror、无宿主/插件 console error
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

const MARK = "<!-- ext-circuitjs:1 -->";

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

test("plugin-hooks：load/save 钩子接线、幂等、来源过滤、卸载回滚", { timeout: 180_000 }, async () => {
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
        // 站点配置默认禁用示例插件：显式激活 ext-hook（load/save 钩子示例）
        await activatePlugins(page, ["ext-hook"], BASE);
        await page.waitForFunction(
            () => window.ExtCircuitJS?.plugins?.list().some((p) => p.id === "ext-hook" && p.state === "ready"),
            null,
            { timeout: 60000 },
        );
        // 启动电路是异步装载的：等它落定再显式清空，基准才不受"演示电路"影响
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

        const MARK_IN_PAGE = MARK;
        const r = await page.evaluate(async (mark) => {
            const out = { steps: [] };
            const ext = window.ExtCircuitJS;
            const app = ext.app;
            const countMarks = (s) => s.split(mark).length - 1;
            const types = () => ext.api.listComponents().map((c) => c.type);

            // ── 1) 插件就绪 ────────────────────────────────────────────────
            out.plugin = ext.plugins.list().find((p) => p.id === "ext-hook") ?? null;

            // 先放一个可识别的电路（R + 电池），后面所有往返都拿它当基准
            app.clearCircuit();
            ext.api.loadCircuitText("r 100 100 300 100 0 1000\nv 100 100 100 300 0 0 5\n");
            out.baselineTypes = types();

            // ── 2) 保存侧生效 ─────────────────────────────────────────────
            const saved = app.dumpCircuit();
            out.savedMarked = saved.includes(mark);
            out.savedMarks = countMarks(saved);

            // ── 3) 幂等：连存三次不累积 ────────────────────────────────────
            app.dumpCircuit();
            const third = app.dumpCircuit();
            out.idempotentMarks = countMarks(third);

            // ── 4) 载入侧生效：保存 → 打开 → 再保存 ────────────────────────
            ext.api.loadCircuitText(third);
            out.roundtripTypes = types();
            out.roundtripMarks = countMarks(app.dumpCircuit());

            // ── 5) 来源过滤：撤销快照不带标记，且撤销后电路完整 ────────────
            app.undoManager.pushUndo();
            const snap = app.undoManager.undoStack[app.undoManager.undoStack.length - 1];
            out.undoSnapshotMarked = String(snap?.dump ?? "").includes(mark);
            app.undoManager.doUndo();
            out.afterUndoTypes = types();

            // ── 6) BOM + CRLF：核心自己认不出的文件，钩子先规范化 ──────────
            const bomText = "\uFEFF" + third.replace(/\r?\n/g, "\r\n");
            ext.api.loadCircuitText(bomText);
            out.bomTypesWithHook = types();

            // ── 7) 卸载 → 三件事同时归零 ──────────────────────────────────
            await ext.plugins.deactivate("ext-hook");
            out.after = {
                hooksLeft: ext.hooks.count(),
                savedMarked: app.dumpCircuit().includes(mark),
            };
            // 同一段 BOM 文本，没有插件就还原不出来了（对照组，证明第 6 条不是白给的）
            ext.api.loadCircuitText(bomText);
            out.after.bomTypes = ext.api.listComponents().length;
            return out;
        }, MARK_IN_PAGE);

        const pageErrors = logs.filter((l) => l.startsWith("[pageerror]"));
        const hostErrors = logs.filter((l) => l.startsWith("[error]") &&
            (l.includes("[ExtCircuitJS]") || l.includes("plugin:")));

        assert.equal(r.plugin?.state, "ready", "ext-hook 未就绪");
        assert.equal(r.plugin?.error ?? null, null);
        assert.deepEqual(r.baselineTypes, ["ResistorElm", "VoltageElm"], "基准电路没摆好");

        assert.equal(r.savedMarked, true, "保存出口没有经过 save 钩子");
        assert.equal(r.savedMarks, 1, "标记应恰好出现一次");
        assert.equal(r.idempotentMarks, 1, "连续保存三次后标记应仍只有一个（改写不幂等）");

        assert.deepEqual(r.roundtripTypes, r.baselineTypes, "带标记的存档读不回来（load 钩子没还原）");
        assert.equal(r.roundtripMarks, 1, "保存→打开→再保存后标记累积了");

        assert.equal(r.undoSnapshotMarked, false, "撤销快照被 save 钩子污染（meta.source 过滤失效）");
        assert.deepEqual(r.afterUndoTypes, r.baselineTypes, "撤销后电路不完整");

        assert.deepEqual(r.bomTypesWithHook, r.baselineTypes, "BOM/CRLF 文件在钩子规范化后仍打不开");

        assert.equal(r.after.hooksLeft, 0, "卸载后钩子仍留在总线里");
        assert.equal(r.after.savedMarked, false, "卸载后 dumpCircuit 仍带标记");
        assert.equal(r.after.bomTypes, 0, "对照组失败：没有插件时 BOM 文本本应打不开（测试没测到钩子）");

        assert.deepEqual(pageErrors, [], `pageerror: ${pageErrors.join(" | ")}`);
        assert.deepEqual(hostErrors, [], `宿主/插件 console error: ${hostErrors.join(" | ")}`);
    } finally {
        await browser.close();
    }
});
