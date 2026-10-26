// C05 — 紧凑编码 token 基准：373 语料逐例载入真实引擎（浏览器），dumpNetlist() →
// encodeCompact()（packages/netlist/src/compact.ts）后与语料 XML 文件字节数对比。
//   node tools/ext.mjs netlist bench
//   （或直接：node --test-style 运行 node tests/contract/netlist-bench.mjs）
//
// 口径（docs/task-board.md C05；spike 基线见 spike/netlist-codec/out/variants.json：
// jsonCompact 聚合 0.331× / 中位 0.320×；docs/format-strategy.md §1/§6 目标 0.32×）：
//   - 每例 ratio = JSON.stringify(encodeCompact(nl)) 的 UTF-8 字节数 / 语料 XML 文件字节数；
//   - 聚合 ratio = Σ compactBytes / Σ xmlBytes，验收线 **≤ 0.35×**，超过 → process.exitCode = 1；
//   - compact 编码是有损投影（剔除 WireElm 行 + 坐标字段 + 空壳段），见 compact.ts 文件头。
//
// 除体积外，本脚本还逐例对拍**解码器**（checkRoundtrip）：
//   · 幂等律 encode(decode(encode(nl))) ≡ encode(nl)（解码不引入新损失）；
//   · 内容对拍：摘掉"紧凑格式刻意丢的"导线/坐标后，元件类型/flags/属性/引脚连通性逐字段相等；
//   任一例不通过 → 退出码 1。只测体积的话，"编码变小了但解不回来"这种退化查不出来。
//
// 浏览器基准设施与 tests/contract/netlist-export.test.mjs（C02）同款：
//   EXT_PW_CORE（playwright-core index.mjs）/ EXT_CHROME / EXC_BASE（默认 http://127.0.0.1:5174）；
//   分批 evaluate（BATCH=20）、blank 例（fingerprint ok!==true）显式跳过并计数。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { encodeCompact, decodeCompact, compactTypes } from "../../packages/netlist/src/compact.ts";

const PW_CORE = process.env.EXT_PW_CORE
    ?? "D:\\DevEnv\\node_global\\npm_modules\\node_modules\\openclaw\\node_modules\\playwright-core\\index.mjs";
const CHROME = process.env.EXT_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.EXC_BASE ?? "http://127.0.0.1:5174";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FIX_DIR = path.join(ROOT, "tests/fixtures/corpus-xml");
const OUT_PATH = path.join(ROOT, "build/netlist-bench.json");
const RATIO_LIMIT = 0.35;
const BATCH = 20; // 每批电路数：与 C02 相同的分批 evaluate 序列

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

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    if (!s.length) return null;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 稳定序列化（key 排序）：对象插入顺序不该影响"是不是同一个编码"的判定 */
function canon(v) {
    if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
    if (v && typeof v === "object") {
        return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
    }
    return JSON.stringify(v) ?? "null";
}

const TYPE_SET = new Set(compactTypes());

/**
 * C05 解码器对拍（两件事，缺一不可）：
 *   1. **幂等律** `encode(decode(encode(nl))) ≡ encode(nl)` —— 解码不引入新的损失；
 *   2. **内容对拍** —— 把紧凑格式刻意丢掉的东西（导线行 / 坐标 / 未被引用的 net）摘掉后，
 *      元件类型、flags、属性、引脚连通性必须与原始网表逐字段相等。
 * 只证明 (1) 是不够的：一个"把属性全丢掉"的解码器同样满足 (1)。
 */
function checkRoundtrip(nl) {
    const c1 = encodeCompact(nl);
    const { netlist: back, losses } = decodeCompact(c1);
    const law = canon(encodeCompact(back)) === canon(c1);
    const problems = [];

    const orig = (nl.components ?? []).filter((c) => c.type !== "WireElm");
    if (orig.length !== back.components.length) problems.push(`元件数 ${back.components.length}≠${orig.length}`);

    const origNet = new Map((nl.nets ?? []).map((x, i) => [x.id, i]));
    const backNet = new Map(back.nets.map((x, i) => [x.id, i]));
    const n = Math.min(orig.length, back.components.length);
    for (let i = 0; i < n; i++) {
        const a = orig[i];
        const b = back.components[i];
        const wantType = TYPE_SET.has(a.type) ? a.type : "Unknown";
        if (b.type !== wantType) problems.push(`#${i} 类型 ${b.type}≠${wantType}`);
        if (b.f !== (a.f ?? 0)) problems.push(`#${i} flags ${b.f}≠${a.f}`);
        if (canon(b.props) !== canon(a.props)) problems.push(`#${i} props ${canon(b.props)}≠${canon(a.props)}`);
        const posts = new Set([...Object.keys(a.pins ?? {}), ...Object.keys(b.pins ?? {})]);
        for (const p of posts) {
            const ia = origNet.get(a.pins?.[p]) ?? -1;
            const ib = backNet.get(b.pins?.[p]) ?? -1;
            if (ia !== ib) problems.push(`#${i} post${p} net ${ib}≠${ia}`);
        }
    }

    // 原始 net 里"除导线外还有人连"的那些，解码后必须还在原下标上
    for (const [id, i] of origNet) {
        const live = (nl.nets[i].pins ?? []).some((pin) => {
            const cid = pin.slice(0, pin.lastIndexOf(":"));
            return (nl.components ?? []).some((c) => c.id === cid && c.type !== "WireElm");
        });
        if (live && backNet.get(id) !== i) problems.push(`net ${id} 落在下标 ${backNet.get(id)}≠${i}`);
    }
    // 计入"对拍过多少东西"：防止对拍写成空转（0 个元件对比也能全绿）
    return { law, problems, losses, checked: { components: orig.length, nets: origNet.size } };
}

async function main() {
    // ── 1) 语料清单（同 C02：fingerprints 驱动，blank/坏例显式跳过）──────────
    const fp = JSON.parse(fs.readFileSync(path.join(FIX_DIR, "fingerprints.json"), "utf8"));
    if (fp.schema !== "extcircuitjs/corpus@1") throw new Error("fingerprints schema 漂移");

    const skipped = [];
    const cases = [];
    for (const c of fp.circuits) {
        const base = c.source.split("/").pop().replace(/\.txt$/, ".xml");
        if (c.ok !== true || c.elmCount == null || !Array.isArray(c.elements)) {
            skipped.push({ name: base, reason: `fingerprint ok=${c.ok}（FAILURES.md 坏例，显式跳过）` });
            continue;
        }
        const xmlPath = path.join(FIX_DIR, base);
        cases.push({
            name: base.replace(/\.xml$/, ""),
            text: fs.readFileSync(xmlPath, "utf8"),
            xmlBytes: fs.statSync(xmlPath).size, // 语料 XML 文件字节数（基准分母）
        });
    }
    if (cases.length === 0) throw new Error("语料为空");

    // ── 2) 环境预检 ─────────────────────────────────────────────────────────
    if (!fs.existsSync(PW_CORE)) throw new Error(`playwright-core 不存在: ${PW_CORE}（可用 EXT_PW_CORE 覆盖）`);
    if (!fs.existsSync(CHROME)) throw new Error(`Chrome 不存在: ${CHROME}（可用 EXT_CHROME 覆盖）`);
    const status = await probeServer(`${BASE}/circuitjs.html`);
    if (!(status >= 200 && status < 400)) {
        throw new Error(`dev server 不可达（${BASE} → ${status}）；先起服务：node tools/ext.mjs dev --port 5174`);
    }

    // ── 3) 浏览器会话（与 C02 同款启动）────────────────────────────────────
    const { chromium } = await import("file:///" + PW_CORE.replace(/\\/g, "/"));
    const browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
    });
    let results;
    try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        // 个别语料 import 异常路径可能走 alert()；无人接管的 dialog 会卡死后续 evaluate
        page.on("dialog", (d) => d.dismiss().catch(() => {}));

        await page.goto(`${BASE}/circuitjs.html`, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => !!window.ExtCircuitJS, null, { timeout: 60000 });
        await page.waitForTimeout(1200); // 插件宿主 fetch + dynamic import

        // ── 4) 分批逐例取 dumpNetlist()（与 C02 相同的确定性分析序列）────────
        results = [];
        for (let i = 0; i < cases.length; i += BATCH) {
            const batch = cases.slice(i, i + BATCH)
                .map(({ name, text }) => ({ name, text }));
            const rs = await page.evaluate(async (items) => {
                const ext = window.ExtCircuitJS;
                const out = [];
                for (const c of items) {
                    const r = { name: c.name, nl: null, err: null };
                    try {
                        // analyzeCircuit 只同步 elmList，nodeList 在 preStampCircuit 里建
                        ext.api.loadCircuitText(c.text, false);
                        ext.app.needAnalyze();
                        ext.app.sim.analyzeCircuit();
                        ext.app.sim.preStampCircuit(false);
                        r.nl = ext.api.dumpNetlist();
                    } catch (e) {
                        r.err = String((e && e.message) || e).slice(0, 200);
                    }
                    out.push(r);
                }
                return out;
            }, batch);
            results.push(...rs);
        }
    } finally {
        await browser.close();
    }

    // ── 5) Node 侧编码 + 计字节数（任何例失败都算基准失败，不许缩小分母）────
    const errors = results.filter((r) => r.err);
    if (errors.length) {
        console.error(`[C05 netlist-bench] ${errors.length} 例引擎载入/导出抛错（不许跳过缩小分母）:`);
        for (const e of errors.slice(0, 10)) console.error(`  ${e.name}: ${e.err}`);
        process.exitCode = 1;
        return;
    }

    const rows = results.map((r) => {
        const byName = cases.find((c) => c.name === r.name);
        const rt = checkRoundtrip(r.nl);
        const compactBytes = Buffer.byteLength(JSON.stringify(encodeCompact(r.nl)), "utf8");
        return {
            file: r.name,
            xmlBytes: byName.xmlBytes,
            compactBytes,
            ratio: compactBytes / byName.xmlBytes,
            roundtrip: { law: rt.law, problems: rt.problems, losses: rt.losses, checked: rt.checked },
        };
    });

    const totalXml = rows.reduce((s, r) => s + r.xmlBytes, 0);
    const totalCompact = rows.reduce((s, r) => s + r.compactBytes, 0);
    const aggregateRatio = totalCompact / totalXml;
    const medianRatio = median(rows.map((r) => r.ratio));

    // ── 6) 解码器对拍汇总 ───────────────────────────────────────────────────
    const badLaw = rows.filter((r) => !r.roundtrip.law);
    const badContent = rows.filter((r) => r.roundtrip.problems.length > 0);
    const losses = rows.reduce((acc, r) => {
        acc.unresolved += r.roundtrip.losses.unresolved;
        acc.orphanProps += r.roundtrip.losses.orphanProps;
        acc.unreferencedNets += r.roundtrip.losses.unreferencedNets;
        acc.components += r.roundtrip.checked.components;
        acc.nets += r.roundtrip.checked.nets;
        return acc;
    }, { unresolved: 0, orphanProps: 0, unreferencedNets: 0, components: 0, nets: 0 });

    // ── 7) 报告 ────────────────────────────────────────────────────────────
    const report = {
        schema: "extcircuitjs/netlist-bench@1",
        generatedAt: new Date().toISOString(),
        ratioLimit: RATIO_LIMIT,
        encoding: "compact JSON (C05): 类型→registry 索引 / 组件数组化 / props 位置化；有损：剔除 WireElm 行 + 坐标字段（见 packages/netlist/src/compact.ts 文件头）",
        skipped,
        files: rows.length,
        rows,
        aggregate: { totalXml, totalCompact, ratio: aggregateRatio },
        median: medianRatio,
        roundtrip: {
            checked: rows.length,
            lawFailed: badLaw.map((r) => r.file),
            contentFailed: badContent.map((r) => ({ file: r.file, problems: r.roundtrip.problems.slice(0, 5) })),
            losses,
        },
    };
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

    const worst = [...rows].sort((a, b) => b.ratio - a.ratio).slice(0, 5)
        .map((r) => `${r.file} ${r.compactBytes}/${r.xmlBytes}=${r.ratio.toFixed(3)}`);
    console.log("[C05 netlist-bench] ─────────────────────────────────");
    console.log(`[C05 netlist-bench] 例数: ${rows.length}/${fp.circuits.length}（跳过 ${skipped.length}: ${
        skipped.map((s) => s.name).join(", ") || "无"}）`);
    console.log(`[C05 netlist-bench] 聚合: ${totalCompact}/${totalXml} = ${aggregateRatio.toFixed(4)}× XML（验收线 ≤ ${RATIO_LIMIT}×）`);
    console.log(`[C05 netlist-bench] 中位 ratio: ${medianRatio.toFixed(4)}×`);
    console.log(`[C05 netlist-bench] 最差 5 例: ${worst.join(", ")}`);
    console.log(`[C05 netlist-bench] 解码对拍: 幂等律 ${rows.length - badLaw.length}/${rows.length} 通过`
        + `，内容 ${rows.length - badContent.length}/${rows.length} 通过`
        + `（对比 ${losses.components} 个元件 / ${losses.nets} 个 net；未解析 ${losses.unresolved}、属性越位 ${losses.orphanProps}、空 net ${losses.unreferencedNets}）`);
    for (const r of badContent.slice(0, 5)) {
        console.log(`[C05 netlist-bench]   ✗ ${r.file}: ${r.roundtrip.problems.slice(0, 3).join(" | ")}`);
    }
    for (const r of badLaw.slice(0, 5)) console.log(`[C05 netlist-bench]   ✗ ${r.file}: 幂等律不成立`);
    console.log(`[C05 netlist-bench] 报告: ${OUT_PATH}`);
    console.log("[C05 netlist-bench] ─────────────────────────────────");

    if (badLaw.length || badContent.length) {
        console.error(`[C05 netlist-bench] FAIL：解码对拍不通过（幂等律 ${badLaw.length} 例 / 内容 ${badContent.length} 例）`);
        process.exitCode = 1;
    } else if (aggregateRatio > RATIO_LIMIT) {
        console.error(`[C05 netlist-bench] FAIL：聚合比 ${aggregateRatio.toFixed(4)}× 超过 ${RATIO_LIMIT}×`);
        process.exitCode = 1;
    } else {
        console.log(`[C05 netlist-bench] PASS：聚合比 ${aggregateRatio.toFixed(4)}× ≤ ${RATIO_LIMIT}×`);
    }
}

main().catch((e) => {
    console.error("[C05 netlist-bench]", e?.message ?? e);
    process.exitCode = 1;
});
