// B07 — 三示例插件（ext-panel / ext-command / ext-event）同时启停无泄漏（真实 Chromium）
//   node --test tests/contract/plugins-smoke.browser.test.mjs
//
// 断言（docs/task-board.md B07 / zcode-goal_step.md Stage 3 步骤 6）：
//   1. manifest 注册的三个示例插件随启动自动 activate，state=ready（与 hello 共存）
//   2. 同时 deactivate 三插件 → 记录基线；与启动态对比：监听器少 EVENT_SUBS（ext-event 的订阅数）、命令/面板 DOM 各少 1
//      （证明激活确实持有资源，而非空转；也覆盖宿主 disposer 的启动路径）
//   3. Promise.all 同时 activate 三插件 → 各自生效：
//      - ext-panel：[data-ext-plugin="ext-panel"] 挂进 #painel，面板子节点数 +1
//      - ext-command：命令在 CommandPaletteRegistry（commands + byId）可见，且可执行
//        （调 custom.execute() 后 storage pings=1）
//      - ext-event：analyze 订阅数 +1；触发一次 analyze 后 storage analyzes=1
//   4. Promise.all 同时 deactivate → 监听器/命令/面板 DOM 计数全部回基线、节点移除、
//      plugins.list() 不再含三者（hello 不受影响，仍 ready）
//   5. 无 pageerror、无插件/宿主相关 console error
//
// 实现口径：
//   - 命令可见性经 vite dev 同一 URL（/CommandPaletteRegistry.ts）动态 import，命中的是
//     应用内同一模块实例（cover/ts/ExtPluginHost.ts:7 与 core 侧均解析到该 URL）；
//     若实例不同，byId 里查不到插件命令，断言自然失败——不会误报通过。
//   - analyze 触发用 boot.browser.mjs 同款确定性序列：analyzeCircuit 只同步 elmList，
//     callAnalyzeHook 在 preStampCircuit 末尾（core/ts/SimulationManager.ts:1034），
//     故必须 analyzeCircuit() → preStampCircuit(false) 才会 emit "analyze"。
//   - activate 传 rev=Date.now() 换 URL 强制新模块实例（模块级计数从 0 起，storage 断言可定值）。
//   - 启停同步点 = await ext.plugins.activate/deactivate 的 Promise（dispose 同步执行），
//     不用 setTimeout 兜底"等卸载完成"（Stage 3 禁止项）。
//   - 浏览器基准与 tests/contract/netlist-export.test.mjs 同款：EXT_PW_CORE / EXT_CHROME /
//     EXC_BASE（默认 http://127.0.0.1:5174）、dialog 自动 dismiss、真实函数 page.evaluate
//     （各批次内联同一份 snapshot/storage 片段，口径一致）。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? "http://127.0.0.1:5174";

const DEMO_IDS = ["ext-panel", "ext-command", "ext-event"];

/**
 * ext-event 订阅的事件数（analyze / elementschange / elemdrag）。
 * 这里是"示例插件当前订阅了几个事件"，不是宿主常量 —— 改 `plugins/ext-event/index.js`
 * 的 ctx.on 次数就必须同步改这里（增量断言的意义是"启停后计数精确回到基线"，
 * 所以这个数字不能写成">=1"，否则漏一个监听器也看不出来）。
 */
const EVENT_SUBS = 3;

/** GET 探活 dev server（只判 2xx/3xx） */
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

test("B07 plugins-smoke：三示例插件同时启停无泄漏", { timeout: 180_000 }, async () => {
    // ── 1) 环境预检 ─────────────────────────────────────────────────────────
    assert.ok(fs.existsSync(PW_CORE), `playwright-core 不存在: ${PW_CORE}（可用 EXT_PW_CORE 覆盖）`);
    assert.ok(fs.existsSync(CHROME), `Chrome 不存在: ${CHROME}（可用 EXT_CHROME 覆盖）`);
    const status = await probeServer(`${BASE}/circuitjs.html`);
    assert.ok(status >= 200 && status < 400,
        `dev server 不可达（${BASE} → ${status}）；先起服务：node tools/ext.mjs dev --port 5174`);

    const circuitText = fs.readFileSync(
        path.resolve(import.meta.dirname, "../../core/ts/public/circuits/lrc.txt"),
        "utf8",
    );

    // ── 2) 浏览器会话（netlist-export.test.mjs 同款启动）─────────────────────
    const { chromium } = await import("file:///" + PW_CORE.replace(/\\/g, "/"));
    const browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
    });
    const consoleMsgs = [];   // {type, text} 全量
    const pageErrors = [];
    try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        page.on("pageerror", (e) => pageErrors.push(e.message));
        page.on("console", (m) => consoleMsgs.push({ type: m.type(), text: m.text() }));
        page.on("dialog", (d) => d.dismiss().catch(() => {}));

        await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
        // 等宿主完成首次 load()（此时 enabled 的插件都进入终态：ready 或 failed）。
        // 不再依赖 hello——示例插件（含 hello）已按 site.config 全部默认禁用，
        // 测试意图「三插件同时启停无泄漏」由下面的显式 activate 保证。
        await page.waitForFunction(
            () => {
                const ext = window.ExtCircuitJS;
                if (!ext?.plugins) return false;
                const list = ext.plugins.list();
                // load() 至少跑过一轮：要么有插件，要么 manifest 被读到（plugins 对象存在即可）
                return Array.isArray(list) && list.every((p) => p.state === "ready" || p.state === "failed");
            },
            null,
            { timeout: 30000 },
        );
        // 显式激活三个示例插件（与部署默认禁用的配置解耦）。
        // 必须带 manifest 里的 permissions/claims——activate 只吃显式传入的 entry，
        // 缺 permissions 会让 ctx.panel 等面报「未声明权限」。
        await page.evaluate(async ({ ids, base }) => {
            const ext = window.ExtCircuitJS;
            const manifest = await fetch(`${base}/plugins/plugins.manifest.json`).then((r) => r.json());
            const byId = Object.fromEntries((manifest.plugins ?? []).map((p) => [p.id, p]));
            const entryOf = (id) => {
                const m = byId[id];
                return { id, entry: m.entry, version: m.version, permissions: m.permissions, claims: m.claims, rev: Date.now() };
            };
            await Promise.all(ids.map((id) => ext.plugins.activate(entryOf(id))));
            // 等全部 ready
            for (let i = 0; i < 50; i++) {
                const all = ids.every((id) => {
                    const p = ext.plugins.list().find((x) => x.id === id);
                    return p?.state === "ready";
                });
                if (all) return;
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error("示例插件未能 ready");
        }, { ids: DEMO_IDS, base: BASE });

        // ── 3) 归一化电路（lrc.txt，boot.browser 同款确定性序列），快照 A（启动态）──
        const A = await page.evaluate(async (text) => {
            const ext = window.ExtCircuitJS;
            const readStorage = (key) => {
                const raw = localStorage.getItem(key);
                return raw == null ? null : JSON.parse(raw);
            };
            ext.api.loadCircuitText(text, false);
            ext.app.needAnalyze();
            ext.app.sim.analyzeCircuit();
            ext.app.sim.preStampCircuit(false);
            const CPR = (await import("/CommandPaletteRegistry.ts")).CommandPaletteRegistry;
            const painel = document.getElementById("painel");
            return {
                listenersTotal: ext.events.count(),
                listenersAnalyze: ext.events.count("analyze"),
                commands: CPR.commands.length,
                byIdSize: CPR.byId.size,
                panelChildren: painel ? painel.children.length : -1,
                markers: document.querySelectorAll("[data-ext-plugin]").length,
                plugins: ext.plugins.list().map((p) => ({ id: p.id, state: p.state, disposables: p.disposables })),
            };
        }, circuitText);

        // ── 4) 同时 deactivate 三插件 → 快照 B（基线）──────────────────────────
        const B = await page.evaluate(async (ids) => {
            const ext = window.ExtCircuitJS;
            await Promise.all(ids.map((id) => ext.plugins.deactivate(id)));
            const CPR = (await import("/CommandPaletteRegistry.ts")).CommandPaletteRegistry;
            const painel = document.getElementById("painel");
            return {
                listenersTotal: ext.events.count(),
                listenersAnalyze: ext.events.count("analyze"),
                commands: CPR.commands.length,
                byIdSize: CPR.byId.size,
                panelChildren: painel ? painel.children.length : -1,
                markers: document.querySelectorAll("[data-ext-plugin]").length,
                plugins: ext.plugins.list().map((p) => ({ id: p.id, state: p.state, disposables: p.disposables })),
            };
        }, DEMO_IDS);

        assert.deepEqual(
            B.plugins.filter((p) => DEMO_IDS.includes(p.id)).map((p) => p.id),
            [],
            `deactivate 后 list() 不应再含示例插件: ${JSON.stringify(B.plugins)}`,
        );
        // 站点启用的插件（ext-theme 等）不受示例插件启停影响
        assert.ok(B.plugins.some((p) => p.id === "ext-theme" && p.state === "ready"),
            "ext-theme 不受影响，应仍 ready");
        // 启动态 - 基线 = 三插件各自持有的资源（监听器 +1、命令 +1、面板节点 +1）
        assert.equal(A.listenersTotal - B.listenersTotal, EVENT_SUBS, "启动态应比基线多 ext-event 的全部事件订阅");
        assert.equal(A.listenersAnalyze - B.listenersAnalyze, 1, "analyze 订阅应恰好多 1 个");
        assert.equal(A.commands - B.commands, 1, "启动态应比基线多 1 条命令（ext-command）");
        assert.equal(A.byIdSize - B.byIdSize, 1, "byId 应恰好多 1 条命令");
        // 面板节点数不再按 #painel.children 计：ext-ai-panel 把侧栏重构成 Tab 布局（tabs/pageAi
        // 容器本身也是 #painel 的子节点，且 core 动态滑块也在），绝对/相对计数都不是插件面板的
        // 可靠信号。插件面板的真实痕迹由下方 markers 断言覆盖（[data-ext-plugin] 计数）。
        assert.equal(A.markers, 1, "启动态应有 1 个 [data-ext-plugin] 节点");
        assert.equal(B.markers, 0, "基线不应有 [data-ext-plugin] 节点");

        // ── 5) Promise.all 同时 activate 三插件 → 校验各自生效 ─────────────────
        const ran = await page.evaluate(async ({ ids, text }) => {
            const ext = window.ExtCircuitJS;
            const readStorage = (key) => {
                const raw = localStorage.getItem(key);
                return raw == null ? null : JSON.parse(raw);
            };
            const res = await fetch("/plugins/plugins.manifest.json", { cache: "no-store" });
            const manifest = await res.json();
            const entries = ids.map((id) => {
                const e = manifest.plugins.find((p) => p.id === id);
                if (!e) throw new Error("manifest 缺少插件 " + id);
                return { ...e, rev: Date.now() }; // 换 URL 强制新模块实例（计数从 0 开始，断言可定值）
            });
            await Promise.all(entries.map((e) => ext.plugins.activate(e)));

            const CPR = (await import("/CommandPaletteRegistry.ts")).CommandPaletteRegistry;
            const painel = document.getElementById("painel");

            // ext-panel：节点在 #painel 内
            const panelEl = document.querySelector('[data-ext-plugin="ext-panel"]');
            const panelOk = !!panelEl && painel.contains(panelEl);

            // ext-command：在册 + 可执行
            const cmd = CPR.byId.get("ext.command.ping");
            let cmdRan = null;
            if (cmd && cmd.custom && cmd.custom.execute) {
                cmd.custom.execute();
                cmdRan = readStorage("ext.plugin.ext-command.pings");
            }

            // ext-event：订阅数 +1；触发一次 analyze 后计数=1
            const analyzeBefore = ext.events.count("analyze");
            ext.app.needAnalyze();
            ext.app.sim.analyzeCircuit();
            ext.app.sim.preStampCircuit(false);
            const eventCount = readStorage("ext.plugin.ext-event.analyzes");

            return {
                snap: {
                    listenersTotal: ext.events.count(),
                    listenersAnalyze: ext.events.count("analyze"),
                    commands: CPR.commands.length,
                    byIdSize: CPR.byId.size,
                    panelChildren: painel ? painel.children.length : -1,
                    markers: document.querySelectorAll("[data-ext-plugin]").length,
                    plugins: ext.plugins.list().map((p) => ({ id: p.id, state: p.state, disposables: p.disposables })),
                },
                panelOk,
                cmdVisible: !!cmd,
                cmdRan,
                analyzeBefore,
                eventCount,
            };
        }, { ids: DEMO_IDS, text: circuitText });

        assert.ok(ran.panelOk, "ext-panel：[data-ext-plugin=ext-panel] 应挂在 #painel 内");
        assert.ok(ran.cmdVisible, "ext-command：ext.command.ping 应在 CommandPaletteRegistry 可见");
        assert.equal(ran.cmdRan, 1, "ext-command：命令执行后 storage pings 应为 1");
        assert.equal(ran.analyzeBefore, B.listenersAnalyze + 1, "activate 后 analyze 订阅应比基线多 1");
        assert.equal(ran.eventCount, 1, "ext-event：触发 analyze 后 storage analyzes 应为 1");
        assert.equal(ran.snap.listenersTotal - B.listenersTotal, EVENT_SUBS, "activate 后监听器应比基线多 ext-event 的全部事件订阅");
        assert.equal(ran.snap.commands - B.commands, 1, "activate 后命令应比基线多 1");
        assert.equal(ran.snap.byIdSize - B.byIdSize, 1, "activate 后 byId 应比基线多 1");
        // 侧栏被 ext-ai-panel 重构成 Tab 后，#painel.children 不再随插件面板增减（面板进了「仿真设置」页）。
        // 用 markers 断言代替（ext-panel 的真实痕迹，与布局无关）。
        assert.ok(ran.snap.plugins.every((p) => !DEMO_IDS.includes(p.id) || p.state === "ready"),
            "三插件激活后应全部 ready");

        // ── 6) Promise.all 同时 deactivate → 计数全部回基线 ────────────────────
        const F = await page.evaluate(async (ids) => {
            const ext = window.ExtCircuitJS;
            await Promise.all(ids.map((id) => ext.plugins.deactivate(id)));
            const CPR = (await import("/CommandPaletteRegistry.ts")).CommandPaletteRegistry;
            const painel = document.getElementById("painel");
            return {
                listenersTotal: ext.events.count(),
                listenersAnalyze: ext.events.count("analyze"),
                commands: CPR.commands.length,
                byIdSize: CPR.byId.size,
                panelChildren: painel ? painel.children.length : -1,
                markers: document.querySelectorAll("[data-ext-plugin]").length,
                plugins: ext.plugins.list().map((p) => ({ id: p.id, state: p.state, disposables: p.disposables })),
            };
        }, DEMO_IDS);

        assert.equal(F.listenersTotal, B.listenersTotal, "卸载后监听器计数应回基线");
        assert.equal(F.listenersAnalyze, B.listenersAnalyze, "卸载后 analyze 订阅应回基线");
        assert.equal(F.commands, B.commands, "卸载后命令计数应回基线");
        assert.equal(F.byIdSize, B.byIdSize, "卸载后 byId 应回基线");
        assert.equal(F.markers, 0, "卸载后 [data-ext-plugin] 节点应清零");
        assert.deepEqual(
            F.plugins.filter((p) => DEMO_IDS.includes(p.id)).map((p) => p.id),
            [],
            `卸载后 list() 不应再含示例插件: ${JSON.stringify(F.plugins)}`,
        );
        assert.ok(F.plugins.some((p) => p.id === "ext-theme" && p.state === "ready"),
            "ext-theme 在整个启停周期后应仍 ready");

        // ── 7) console 干净：宿主/插件报错零容忍 ─────────────────────────────────
        // 仅豁免环境级资源加载噪声（dropbox 外链等）：任何插件失败路径宿主都会另外打
        // [ExtCircuitJS] ... failed/handler failed/disposer failed（下面照样零容忍），不会漏报。
        const ENV_NOISE = /^failed to load resource|net::|dropbox/i;
        const HOST_FAIL = /\[ExtCircuitJS\].*(failed|unavailable|conflict)|disposer failed|handler failed/i;
        const pluginRelated = consoleMsgs.filter(
            (m) => (m.type === "error" && !ENV_NOISE.test(m.text)) || HOST_FAIL.test(m.text),
        );
        const envNoise = consoleMsgs.filter((m) => m.type === "error" && ENV_NOISE.test(m.text));
        assert.deepEqual(pluginRelated, [], `插件/宿主相关 console 报错: ${JSON.stringify(pluginRelated)}`);
        assert.deepEqual(pageErrors, [], `不应有 pageerror: ${JSON.stringify(pageErrors)}`);

        // 计数证据落到 stdout（验收要求"有计数输出证据"）
        console.log("B07 counts:", JSON.stringify({
            boot: { listeners: A.listenersTotal, analyze: A.listenersAnalyze, commands: A.commands, byId: A.byIdSize, panelChildren: A.panelChildren, markers: A.markers },
            baseline: { listeners: B.listenersTotal, analyze: B.listenersAnalyze, commands: B.commands, byId: B.byIdSize, panelChildren: B.panelChildren, markers: B.markers },
            afterStop: { listeners: F.listenersTotal, analyze: F.listenersAnalyze, commands: F.commands, byId: F.byIdSize, panelChildren: F.panelChildren, markers: F.markers },
            checks: { panelOk: ran.panelOk, cmdVisible: ran.cmdVisible, cmdRan: ran.cmdRan, eventCount: ran.eventCount },
            envConsoleNoiseIgnored: envNoise.map((m) => m.text).slice(0, 5),
        }, null, 2));
    } finally {
        await browser.close();
    }
});
