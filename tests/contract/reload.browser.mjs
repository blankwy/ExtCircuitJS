// B05 — 热重载契约测试（真实 Chromium）：?rev= 换版本，旧资源全释放。
//   node tests/contract/reload.browser.mjs [--base http://127.0.0.1:5174]
//
// 断言（docs/task-board.md B05 / zcode-goal_step.md Stage 3 步骤 7）：
//   1. import 路径带 rev：page.on("request") 记录真实网络请求 —— 每次 reload 都出现
//      /plugins/<id>/index.js?rev=<显式rev>（round×plugin 全组合），且 manifest 被
//      reload 路径真实重新 fetch（findEntry 的 no-store fetch，计数可查）。
//   2. reload 后 state=ready（三个示例插件 + hello 全程 ready）。
//   3. 旧 command 不可见：reload 前记下 ext.command.ping 的 PaletteCommand 对象
//      （window.__b05.oldCmd，同一页面内跨 evaluate 保持引用），reload 后
//      byId.get(id) !== oldCmd 且 commands 数组不含 oldCmd —— 同 id 的新对象是
//      新模块实例注册的，不是旧的残留。
//   4. ?rev= 真的换了模块实例：boot 期执行命令 2 次 → storage pings=2；reload 后
//      执行 1 次 → pings 必须回到 1（新实例计数器从 0 起；若命中旧 ESM 条目会是 3）。
//      ext-event 同理：reload 后触发一次 analyze → analyzes=1 且订阅计数不增长。
//   5. 旧 fiber 全释放（事件驱动证据链，非轮询）：
//      a) reload 三轮（rev=b05-1/2/3），每轮后 listeners/commands/byId/panelChildren/
//         [data-ext-plugin] 计数与 boot 快照逐项相等（零增长 ⇒ 旧 disposer 已执行）；
//      b) plugins.list() 中每个插件恰 1 条（fibers 表无旧条目堆积）；
//      c) reload 能反复成功本身证明所有权已释放：commandOwners 未清空时同 id
//         再注册会抛 "command conflict"（ExtPluginHost.ts:178-181）；
//      d) 三轮 reload 后 deactivate 三插件 → 计数精确回落 boot-1（若旧 fiber 泄漏，
//         当前 fiber 的卸载不可能把计数拉回 boot-1）。
//   6. 同步点全部是 await 的 Promise（reload/deactivate/activate）与
//      waitForFunction（boot 就绪），零 setTimeout 兜底（Stage 3 禁止项）。
//   7. 无 pageerror、无插件/宿主相关 console error（与 B07 同口径的零容忍）。
//
// 浏览器基准与 tests/contract/netlist-export.test.mjs / plugins-smoke 同款：
// EXT_PW_CORE / EXT_CHROME / EXC_BASE（默认 http://127.0.0.1:5174）、dialog 自动
// dismiss、analyze 触发用确定性序列 analyzeCircuit() → preStampCircuit(false)
// （callAnalyzeHook 在 preStampCircuit 末尾，core/ts/SimulationManager.ts:1034）。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE
    ?? (process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://127.0.0.1:5174");

const DEMO_IDS = ["ext-panel", "ext-command", "ext-event"];
const REVS = ["b05-1", "b05-2", "b05-3"];

function fail(msg) {
    console.error("FAIL:", msg);
    process.exit(1);
}

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

if (!fs.existsSync(PW_CORE)) fail(`playwright-core not found: ${PW_CORE}`);
if (!fs.existsSync(CHROME)) fail(`chrome not found: ${CHROME}`);
{
    const status = await probeServer(`${BASE}/circuitjs.html`);
    if (!(status >= 200 && status < 400)) {
        fail(`dev server 不可达（${BASE} → ${status}）；先起服务：node tools/ext.mjs dev --port 5174`);
    }
}

const circuitText = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../core/ts/public/circuits/lrc.txt"),
    "utf8",
);

const { chromium } = await import("file:///" + PW_CORE.replace(/\\/g, "/"));
const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
});

const consoleMsgs = [];
const pageErrors = [];
/** 真实网络证据：/plugins/* 的每次请求（URL 含 query），reload 的 ?rev= 就在这里核验 */
const pluginRequests = [];
let manifestFetches = 0;

try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => consoleMsgs.push({ type: m.type(), text: m.text() }));
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    page.on("request", (r) => {
        const url = r.url();
        if (!url.includes("/plugins/")) return;
        if (url.split("?")[0].endsWith("/plugins/plugins.manifest.json")) manifestFetches++;
        pluginRequests.push(url.replace(BASE, ""));
    });

    await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
    // 事件驱动等待 boot：manifest 4 个插件全部 ready（fetch + dynamic import 完成的信号）
    await page.waitForFunction(() => {
        const ext = window.ExtCircuitJS;
        if (!ext?.plugins) return false;
        const want = ["hello", "ext-panel", "ext-command", "ext-event"];
        const list = ext.plugins.list();
        return want.every((id) => list.some((p) => p.id === id && p.state === "ready"));
    }, null, { timeout: 60000 });

    // 页内证据登记处：对象引用必须留在页面里（evaluate 只能传回可序列化数据）
    // window.__b05.oldCmd = reload 前的 PaletteCommand 实例，用于 reload 后的身份比对。
    const A = await page.evaluate(async (text) => {
        const ext = window.ExtCircuitJS;
        const readStorage = (key) => {
            const raw = localStorage.getItem(key);
            return raw == null ? null : JSON.parse(raw);
        };
        const CPR = (await import("/CommandPaletteRegistry.ts")).CommandPaletteRegistry;

        // 归一化电路 + 触发一次 analyze（确定性序列，见文件头）
        ext.api.loadCircuitText(text, false);
        ext.app.needAnalyze();
        ext.app.sim.analyzeCircuit();
        ext.app.sim.preStampCircuit(false);

        window.__b05 = { oldCmd: CPR.byId.get("ext.command.ping") };
        // boot 期执行命令 2 次：旧实例计数器到 2（reload 后新实例执行 1 次必须回到 1）
        CPR.byId.get("ext.command.ping").custom.execute();
        CPR.byId.get("ext.command.ping").custom.execute();

        const painel = document.getElementById("painel");
        return {
            listenersTotal: ext.events.count(),
            listenersAnalyze: ext.events.count("analyze"),
            commands: CPR.commands.length,
            byIdSize: CPR.byId.size,
            panelChildren: painel ? painel.children.length : -1,
            markers: document.querySelectorAll("[data-ext-plugin]").length,
            plugins: ext.plugins.list().map((p) => ({ id: p.id, state: p.state, disposables: p.disposables })),
            bootPings: readStorage("ext.plugin.ext-command.pings"),
            bootAnalyzes: readStorage("ext.plugin.ext-event.analyzes"),
        };
    }, circuitText);

    // boot 快照健全性：4 插件 ready、命令确实执行过两次、事件确实收到过一次
    assert.equal(A.plugins.length, 4, `boot 应有 4 个插件: ${JSON.stringify(A.plugins)}`);
    assert.ok(A.plugins.every((p) => p.state === "ready"), "boot 后全部 ready");
    assert.equal(A.bootPings, 2, `boot 期命令应执行 2 次（pings=2）: ${A.bootPings}`);
    assert.equal(A.bootAnalyzes, 1, `boot 期 analyze 应计数 1: ${A.bootAnalyzes}`);

    // ── reload 第 1 轮（显式 rev=b05-1）：核心断言全在这里 ─────────────────────
    const R1 = await page.evaluate(async ({ ids, rev, text }) => {
        const ext = window.ExtCircuitJS;
        const readStorage = (key) => {
            const raw = localStorage.getItem(key);
            return raw == null ? null : JSON.parse(raw);
        };
        const CPR = (await import("/CommandPaletteRegistry.ts")).CommandPaletteRegistry;

        await Promise.all(ids.map((id) => ext.plugins.reload(id, rev)));

        // reload 后触发一次 analyze + 执行一次命令（新实例的计数器应从 0 起）
        ext.app.needAnalyze();
        ext.app.sim.analyzeCircuit();
        ext.app.sim.preStampCircuit(false);
        CPR.byId.get("ext.command.ping").custom.execute();

        const painel = document.getElementById("painel");
        return {
            listenersTotal: ext.events.count(),
            listenersAnalyze: ext.events.count("analyze"),
            commands: CPR.commands.length,
            byIdSize: CPR.byId.size,
            panelChildren: painel ? painel.children.length : -1,
            markers: document.querySelectorAll("[data-ext-plugin]").length,
            plugins: ext.plugins.list().map((p) => ({ id: p.id, state: p.state, disposables: p.disposables })),
            oldCmdStillById: CPR.byId.get("ext.command.ping") === window.__b05.oldCmd,
            oldCmdInArray: CPR.commands.includes(window.__b05.oldCmd),
            pings: readStorage("ext.plugin.ext-command.pings"),
            analyzes: readStorage("ext.plugin.ext-event.analyzes"),
        };
    }, { ids: DEMO_IDS, rev: REVS[0], text: circuitText });

    // 2) reload 后 state=ready
    assert.ok(R1.plugins.every((p) => p.state === "ready"),
        `reload 后应全部 ready: ${JSON.stringify(R1.plugins)}`);
    // 3) 旧 command 不可见（对象身份比对：同 id 的新对象 ≠ 旧对象）
    assert.equal(R1.oldCmdStillById, false, "reload 后 byId 里的命令对象必须是新实例，不能还是旧的");
    assert.equal(R1.oldCmdInArray, false, "reload 后 commands 数组不得仍含旧命令对象");
    // 4) ?rev= 换了模块实例：新实例计数器从 0 起
    assert.equal(R1.pings, 1, `reload 后执行 1 次命令，新实例 pings 应为 1（旧实例会是 3）: ${R1.pings}`);
    assert.equal(R1.analyzes, 1, `reload 后触发 1 次 analyze，新实例计数应为 1: ${R1.analyzes}`);
    // 5a) 计数与 boot 快照逐项相等（零增长 ⇒ 旧 disposer 已执行、旧 fiber 已释放）
    assert.equal(R1.listenersTotal, A.listenersTotal, "reload 后监听器总数不得增长（旧订阅已退）");
    assert.equal(R1.listenersAnalyze, A.listenersAnalyze, "reload 后 analyze 订阅数不得增长");
    assert.equal(R1.commands, A.commands, "reload 后命令数不得增长");
    assert.equal(R1.byIdSize, A.byIdSize, "reload 后 byId 大小不得增长");
    assert.equal(R1.panelChildren, A.panelChildren, "reload 后面板子节点数不得增长（旧节点已摘、新节点已挂）");
    assert.equal(R1.markers, A.markers, "reload 后 [data-ext-plugin] 节点数不得增长");
    // 5b) fibers 表无旧条目堆积
    assert.equal(R1.plugins.length, 4, `reload 后 list() 仍应恰 4 条: ${JSON.stringify(R1.plugins)}`);

    // ── reload 第 2/3 轮（rev=b05-2/b05-3）：重复热重载零累积 ──────────────────
    const later = await page.evaluate(async ({ ids, revs }) => {
        const ext = window.ExtCircuitJS;
        const CPR = (await import("/CommandPaletteRegistry.ts")).CommandPaletteRegistry;
        const painel = document.getElementById("painel");
        const snap = () => ({
            listenersTotal: ext.events.count(),
            listenersAnalyze: ext.events.count("analyze"),
            commands: CPR.commands.length,
            byIdSize: CPR.byId.size,
            panelChildren: painel ? painel.children.length : -1,
            markers: document.querySelectorAll("[data-ext-plugin]").length,
            plugins: ext.plugins.list().map((p) => ({ id: p.id, state: p.state })),
        });
        const out = [];
        for (const rev of revs) {
            await Promise.all(ids.map((id) => ext.plugins.reload(id, rev)));
            out.push({ rev, snap: snap() });
        }
        return out;
    }, { ids: DEMO_IDS, revs: REVS.slice(1) });

    for (const round of later) {
        assert.ok(round.snap.plugins.every((p) => p.state === "ready"),
            `rev=${round.rev} reload 后应全部 ready: ${JSON.stringify(round.snap.plugins)}`);
        assert.equal(round.snap.plugins.length, 4, `rev=${round.rev} 后 list() 应恰 4 条`);
        assert.equal(round.snap.listenersTotal, A.listenersTotal, `rev=${round.rev} 监听器总数应与 boot 相等`);
        assert.equal(round.snap.listenersAnalyze, A.listenersAnalyze, `rev=${round.rev} analyze 订阅应与 boot 相等`);
        assert.equal(round.snap.commands, A.commands, `rev=${round.rev} 命令数应与 boot 相等`);
        assert.equal(round.snap.byIdSize, A.byIdSize, `rev=${round.rev} byId 应与 boot 相等`);
        assert.equal(round.snap.panelChildren, A.panelChildren, `rev=${round.rev} 面板子节点应与 boot 相等`);
        assert.equal(round.snap.markers, A.markers, `rev=${round.rev} [data-ext-plugin] 应与 boot 相等`);
    }

    // ── 5d) 三轮 reload 后 deactivate：计数精确回落 boot-1（泄漏则拉不回）─────
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
            plugins: ext.plugins.list().map((p) => ({ id: p.id, state: p.state })),
        };
    }, DEMO_IDS);

    assert.equal(F.listenersTotal, A.listenersTotal - 1, "三轮 reload 后卸载，监听器应精确回落 boot-1");
    assert.equal(F.listenersAnalyze, A.listenersAnalyze - 1, "analyze 订阅应精确回落 boot-1");
    assert.equal(F.commands, A.commands - 1, "命令数应精确回落 boot-1");
    assert.equal(F.byIdSize, A.byIdSize - 1, "byId 应精确回落 boot-1");
    assert.equal(F.panelChildren, A.panelChildren - 1, "面板子节点应精确回落 boot-1");
    assert.equal(F.markers, 0, "[data-ext-plugin] 节点应清零");
    assert.deepEqual(F.plugins.map((p) => p.id), ["hello"], "卸载后只余 hello");
    assert.equal(F.plugins[0].state, "ready", "hello 全程不受热重载影响");

    // ── 1) 网络证据：import 路径带 rev + manifest 真实重取 ─────────────────────
    // boot 1 次 + 三轮 × 3 插件各一次 findEntry fetch = 10 次 manifest 请求
    assert.ok(manifestFetches >= 10,
        `manifest 应被真实重新 fetch（boot 1 + reload 9，实际 ${manifestFetches}）`);
    for (const rev of REVS) {
        for (const id of DEMO_IDS) {
            // vite dev 会给动态 import 的模块 URL 前置 "?import"（请求形如
            // /plugins/<id>/index.js?import&rev=b05-1），故按 query 参数核验而非全等
            const hit = pluginRequests.some((u) => {
                const q = new URL(u, BASE);
                return q.pathname === `/plugins/${id}/index.js` && q.searchParams.get("rev") === rev;
            });
            assert.ok(hit, `应观测到真实模块请求 /plugins/${id}/index.js?..&rev=${rev}；实际: ${JSON.stringify(pluginRequests)}`);
        }
    }

    // ── 7) console 干净（与 B07 同口径：环境级资源噪声豁免，宿主/插件零容忍）────
    const ENV_NOISE = /^failed to load resource|net::|dropbox/i;
    const HOST_FAIL = /\[ExtCircuitJS\].*(failed|unavailable|conflict)|disposer failed|handler failed/i;
    const pluginRelated = consoleMsgs.filter(
        (m) => (m.type === "error" && !ENV_NOISE.test(m.text)) || HOST_FAIL.test(m.text),
    );
    assert.deepEqual(pluginRelated, [], `插件/宿主相关 console 报错: ${JSON.stringify(pluginRelated)}`);
    assert.deepEqual(pageErrors, [], `不应有 pageerror: ${JSON.stringify(pageErrors)}`);

    // 全部断言通过才走到这里；计数证据随 ok 一起落 stdout（验收要求有输出证据）
    console.log(JSON.stringify({
        ok: true,
        revs: REVS,
        counts: {
            boot: {
                listeners: A.listenersTotal, analyze: A.listenersAnalyze,
                commands: A.commands, byId: A.byIdSize,
                panelChildren: A.panelChildren, markers: A.markers,
                pings: A.bootPings, analyzes: A.bootAnalyzes,
            },
            afterReloadR1: {
                listeners: R1.listenersTotal, analyze: R1.listenersAnalyze,
                commands: R1.commands, byId: R1.byIdSize,
                panelChildren: R1.panelChildren, markers: R1.markers,
                pings: R1.pings, analyzes: R1.analyzes,
                oldCmdStillById: R1.oldCmdStillById, oldCmdInArray: R1.oldCmdInArray,
            },
            afterReloadR2R3: later.map((r) => ({ rev: r.rev, ...r.snap })),
            afterFinalDeactivate: {
                listeners: F.listenersTotal, analyze: F.listenersAnalyze,
                commands: F.commands, byId: F.byIdSize,
                panelChildren: F.panelChildren, markers: F.markers,
            },
        },
        net: {
            manifestFetches,
            // vite dev 会前置 ?import（见上方核验处），证据按 rev= 参数过滤
            pluginModuleRequests: pluginRequests.filter((u) => /(^|[?&])rev=/.test(u)),
        },
    }, null, 2));
} catch (e) {
    console.error("FAIL:", e && e.message ? e.message : e);
    console.error("--- console tail ---");
    console.error(consoleMsgs.slice(-20).map((m) => `[${m.type}] ${m.text}`).join("\n"));
    process.exitCode = 1;
} finally {
    await browser.close();
}
