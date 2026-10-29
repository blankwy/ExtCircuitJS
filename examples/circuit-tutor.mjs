// Circuit Tutor —— 「读 → 改 → 步进 → 读数 → 出图」标准回合示例。
//
//   node examples/circuit-tutor.mjs [--circuit lrc] [--out build/tutor]
//
// 这是给 AI 助手（MCP 宿主 / skill）参考的**标准动作序列**，一次跑完输出：
//   1. 载入电路、读网表（元件 + 稳定 id + 连接关系）
//   2. 定位一个可调元件，改参数（ops set 补丁，不动坐标）
//   3. 确定性步进（冻结墙钟 + analyze → stamp → run），读数可复现
//   4. 读全网电压 + 示波器波形（降采样保峰谷）
//   5. 把波形渲染成 **SVG 文件**（AI 回复里直接嵌图，不依赖浏览器）
//
// 为什么用 SVG 而不是截图：截图是整块画布（含工具栏/侧栏），信息密度低、体积大、
// 无法切分通道；从 scope 数据自己画 SVG 可以只画关注的通道、标注峰值、随文字一起排版。
// 需要"电路长什么样"时再用 schematic.screenshot 出 PNG。
//
// 环境：dev server 或静态产物都能驱动（后端会优先用页面内建桥）。
//   node tools/ext.mjs dev --port 5174      → 开发态（Vite 热更新）
//   node tools/ext.mjs build && node tools/ext.mjs serve  → 静态产物
// 前置：playwright-core（EXT_PW_CORE）、Chrome（EXT_CHROME）。

import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";

register(new URL("../tests/contract/helpers/ts-resolve.mjs", import.meta.url));
const { startAttachBackend } = await import("../packages/mcp/src/backend.ts");

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CIRCUIT = argOf("circuit", "lrc");
const OUT_DIR = path.resolve(argOf("out", "build/tutor"));
const BASE = process.env.EXC_BASE ?? "http://127.0.0.1:5174";

const CIRCUIT_FILE = path.resolve(import.meta.dirname, `../core/ts/public/circuits/${CIRCUIT}.txt`);

function fail(msg) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}
if (!fs.existsSync(CIRCUIT_FILE)) fail(`电路不存在: ${CIRCUIT_FILE}`);

/** 从 scope plot（min/max 成对）渲染成折线 SVG。 */
function scopeToSvg(plot, { width = 640, height = 200, title = "" } = {}) {
    const pts = [];
    const n = Math.min(plot.minValues.length, plot.maxValues.length);
    for (let i = 0; i < n; i++) {
        // 每个桶有 min/max 两点：都画进去，峰谷都在
        pts.push(plot.minValues[i]);
        pts.push(plot.maxValues[i]);
    }
    if (pts.length === 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`;

    const pad = { l: 56, r: 12, t: 26, b: 26 };
    const w = width - pad.l - pad.r;
    const h = height - pad.t - pad.b;
    let lo = Math.min(...pts), hi = Math.max(...pts);
    if (lo === hi) { lo -= 1; hi += 1; }
    const span = hi - lo;
    const x = (i) => pad.l + (pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * w);
    const y = (v) => pad.t + h - ((v - lo) / span) * h;

    const d = pts.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
        const gy = pad.t + h - f * h;
        const val = lo + f * span;
        return `<line x1="${pad.l}" y1="${gy}" x2="${width - pad.r}" y2="${gy}" stroke="#e3e8ef" stroke-width="1"/>` +
            `<text x="${pad.l - 6}" y="${gy + 4}" font-size="10" fill="#7b8794" text-anchor="end">${val.toPrecision(3)}</text>`;
    }).join("");

    const unit = plot.unitsName ?? "";
    const label = title || `${plot.elmType ?? plot.elm} ${plot.valueName}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${pad.l}" y="16" font-size="12" font-weight="600" fill="#33475b">${label} (${unit})</text>
  ${gridLines}
  <path d="${d}" fill="none" stroke="#2f6fed" stroke-width="1.6" stroke-linejoin="round"/>
  <text x="${width - pad.r}" y="${height - 8}" font-size="10" fill="#7b8794" text-anchor="end">${n} 点（降采样保峰谷）</text>
</svg>`;
}

let backend = null;
try {
    console.log(`=== Circuit Tutor: ${CIRCUIT} ===`);
    backend = await startAttachBackend({ baseUrl: BASE, log: (s) => console.log("  " + s) });
    const tools = backend.toolset;

    // ── 1) 载入 + 读网表 ────────────────────────────────────────────────
    const text = fs.readFileSync(CIRCUIT_FILE, "utf8");
    const loaded = await tools.call("circuit.load_netlist", { text });
    if (!loaded.ok) fail(`载入失败: ${JSON.stringify(loaded)}`);
    const nl = (await tools.call("circuit.get_netlist")).netlist;
    console.log(`\n[1] 网表: ${nl.components.length} 元件 / ${nl.nets.length} 网`);
    for (const c of nl.components.slice(0, 6)) {
        const props = Object.entries(c.props).map(([k, v]) => `${k}=${v}`).join(" ");
        console.log(`    ${c.id.padEnd(4)} ${c.type.padEnd(18)} ${props}`);
    }

    // ── 2) 找个可调元件改参数 ──────────────────────────────────────────
    const target = nl.components.find((c) => c.type === "ResistorElm");
    if (!target) fail("电路里没有电阻可演示改参");
    const before = target.props.resistance ?? 100;
    const after = Math.round(before * 3);
    const setRes = await tools.call("circuit.set_param", { target: target.id, prop: "resistance", value: after });
    if (!setRes.ok) fail(`改参失败: ${JSON.stringify(setRes)}`);
    console.log(`\n[2] 改参: ${target.id}.resistance ${before}Ω → ${after}Ω (applied=${setRes.applied})`);

    // ── 3) 确定性步进 ──────────────────────────────────────────────────
    const step = await tools.call("sim.step", { seconds: 0.01 });
    if (!step.ok) fail(`步进失败: ${JSON.stringify(step)}`);
    console.log(`\n[3] 步进: t=${(+step.t).toFixed(6)}s, ${step.timeStepCount} engine steps`);

    // ── 4) 读测量 + 波形 ───────────────────────────────────────────────
    const meas = await tools.call("sim.read_measurements");
    if (!meas.ok) fail(`测量失败: ${JSON.stringify(meas)}`);
    const nets = Object.entries(meas.values).slice(0, 6);
    console.log(`\n[4] 测量 @ t=${(+meas.t).toFixed(6)}s:`);
    for (const [k, v] of nets) console.log(`    V(${k}) = ${(+v.toPrecision(6))} V`);

    const scope = await tools.call("sim.read_scope", { maxPoints: 240 });
    if (!scope.ok) fail(`读波形失败: ${JSON.stringify(scope)}`);

    // ── 5) 渲染 SVG ────────────────────────────────────────────────────
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const written = [];
    const plots = [];
    for (const sc of scope.scopes ?? []) {
        for (const p of sc.plots ?? []) {
            if (p.maxValues.every((v) => v === 0) && (p.lastValue ?? 0) === 0) continue; // 空通道跳过
            plots.push({ scope: sc.index, plot: p });
        }
    }
    for (let i = 0; i < plots.length; i++) {
        const { scope: si, plot } = plots[i];
        const name = `scope${si}-${plot.elmType ?? "elm"}-${plot.valueName}.svg`;
        const file = path.join(OUT_DIR, name);
        fs.writeFileSync(file, scopeToSvg(plot, {
            title: `scope ${si} · ${plot.elmType} ${plot.valueName}`,
        }));
        written.push({ file, points: plot.minValues.length, full: plot.fullPointCount });
    }
    console.log(`\n[5] 波形渲染: ${written.length} 个 SVG → ${OUT_DIR}`);
    for (const w of written) {
        console.log(`    ${path.basename(w.file)}  (${w.points}/${w.full} 点${w.points < w.full ? "，已降采样" : ""})`);
    }

    // ── 汇总（给 AI 复述用的紧凑结论）────────────────────────────────────
    console.log("\n── 结论 ──");
    console.log(`电路 ${CIRCUIT}: ${nl.components.length} 元件, ${nl.nets.length} 网; ` +
        `${target.id}.resistance ${before}→${after}Ω; t=${(+step.t).toFixed(4)}s 时 ${nets.length} 个可读网络电压`);
    console.log(`SVG 输出目录: ${OUT_DIR}`);
    if (written.length === 0) console.log("（注意：本例无示波器通道数据——该电路未配置 scope）");
    console.log("\ntutor OK");
} catch (e) {
    fail(String(e && e.stack || e).slice(0, 800));
} finally {
    try { await backend?.dispose(); } catch { /* ignore */ }
}
