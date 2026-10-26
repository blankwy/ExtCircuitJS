// @ext/netlist — 增量放置：add between nets（C04，设计见 docs/handoffs/stage4-design.md）
//
// 能力：在 between 指定的两个网之间放入一个 2 端元件：
//   1. 每个网枚举"接入点"（tap）：既有 post（零改动接入）或轴对齐导线的内部格点（执行期 split）；
//   2. 为 (tapA, tapB) 枚举有界的正交路线——R0 直连 / R1 L 形 / R2 单折让（拐角外推 ±1..2 格）；
//      硬约束：新增线段（含元件本体）不得穿过任何既有 post 的严格内点（§1.1：穿过≠连接，
//      视觉谎报/静默改拓扑），新中间端点不压既有 post、格点对齐，元件端点间距 ≥ 32px（2 格）；
//      软约束打分：本体叠加数*100 + 跳线总长 + 转角数，取最小（不是整电路自动布局，局部有界）。
//   3. 执行：split 导线（WireElm.split；新半段由调用方 push，MouseManager.splitWireAt 同款）→
//      constructElement + drag 放元件 → 必要时补正交跳线 → 应用 props。
//   4. 自校验（硬闸）：强制重分析 → 重导出网表 → 断言 net 数不变且新元件两脚恰落两目标网；
//      不满足 → 按 journal 机械回滚（split 精确可逆）→ ok:false。绝不静默开路/静默串线。
//
// 纪律：不 import core（鸭子类型，与 index.ts 一致）；不动 elm.nodes[]；
//       改动前 app.undoManager?.pushUndo?.()（可选链，假 app 无此属性不受影响），
//       失败回滚不依赖 UndoManager。绝不抛异常：一切失败以 { ok:false, reason } 返回（对齐 C03 语义）。

import { exportNetlist, elementRegistry } from "./index";
import { idOf } from "./ids";

export interface PlaceOp {
    type: string;
    between: [string, string];
    props?: Record<string, any>;
    /** v1 只有 auto；存在则忽略，不报错（format-strategy §5 草案字段） */
    place?: { mode?: string };
}

export interface PlaceSplit {
    wireId: string | null;
    at: [number, number];
}

export interface PlaceWire {
    id: string | null;
    p1: [number, number];
    p2: [number, number];
}

export interface PlaceOk {
    ok: true;
    elementId: string;
    splits: PlaceSplit[];
    wires: PlaceWire[];
}

export interface PlaceFail {
    ok: false;
    reason: string;
}

export type PlaceResult = PlaceOk | PlaceFail;

// ── 内部数据结构 ─────────────────────────────────────────────────────────────

interface Pt { x: number; y: number; }
interface Pin { elm: any; num: number; point: Pt; }
interface NetInfo { cn: any; name: string; pins: Pin[]; }
/** 接入点：wire 为 null 表示既有 post（零改动），否则为待分裂导线及其内点 */
interface Tap { point: Pt; wire: any | null; }
interface Seg { x1: number; y1: number; x2: number; y2: number; }

interface RoutePlan {
    ax: number; ay: number;               // 元件 post1（= tapA）
    bx: number; by: number;               // 元件 post2
    splits: { wire: any; x: number; y: number }[];
    segs: Seg[];                          // 正交跳线段
    score: number;
}

type JournalEntry =
    | { kind: "split"; wire: any; half: any; ox2: number; oy2: number }
    | { kind: "remove"; elm: any };

const MIN_LEN = 32;      // 元件端点最小间距（2 格）
const MAX_TAPS = 12;     // 每网接入点截断（设计 §3 步骤 3）
const MAX_WIRE_SAMPLES = 8; // 每条导线的内部格点采样上限

const key = (x: number, y: number): string => `${x},${y}`;
const manhattan = (a: Pt, b: Pt): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function gridSizeOf(app: any): number {
    const g = Number(app?.gridSize);
    return Number.isFinite(g) && g > 0 ? g : 16;
}

/** app.snapGrid 的鸭子类型兜底（CirSim.ts:581：(x+7)&~15，即就近取格点） */
export function gridSnapped(app: any, v: number): number {
    if (typeof app?.snapGrid === "function") return app.snapGrid(v);
    const g = gridSizeOf(app);
    return Math.round(v / g) * g;
}

// ── 引擎状态 ─────────────────────────────────────────────────────────────────

/**
 * 强制重建节点表（netlist-g2.browser.mjs 的 analyzeNow 同款顺序）：
 * analyzeCircuit 只同步 elmList，nodeList 在 preStampCircuit 里建；
 * preStampAndStampCircuit 是其超集（顺带 stamp），可用则用。
 */
export function ensureFreshAnalysis(app: any): string | null {
    const sim = app?.sim;
    if (typeof sim?.analyzeCircuit !== "function" || typeof sim?.preStampCircuit !== "function")
        return "app has no sim (analyzeCircuit/preStampCircuit unavailable)";
    try {
        app.needAnalyze?.();
        sim.analyzeCircuit();
        app.analyzeFlag = false;
        if (typeof sim.preStampAndStampCircuit === "function") sim.preStampAndStampCircuit();
        else sim.preStampCircuit(false);
    } catch (e: any) {
        return `analysis failed: ${e?.message ?? String(e)}`;
    }
    return null;
}

/**
 * 收集网（命名规则逐行复刻 index.ts exportNetlist：显式 GroundElm 网名 "GND"，
 * 其余按 nodeList 顺序 n0,n1,...；跳过 pins 为空的 cn）。保活 cn 引供 GND 别名解析。
 */
function collectNets(app: any): NetInfo[] {
    const sim = app?.sim;
    const elms: any[] = app?.elmList ?? [];
    const groundNode = (() => {
        const g = elms.find((e) => e?.isGroundElm?.());
        return g?.nodes?.[0] ?? null;
    })();
    const nets: NetInfo[] = [];
    let n = 0;
    for (const cn of sim?.nodeList ?? []) {
        const pins: Pin[] = [];
        for (const link of cn?.links ?? []) {
            const elm = link?.elm;
            const postCount = elm?.getPostCount?.() ?? 0;
            if (link.num >= postCount) continue; // 内部节点（与 index.ts 同语义）
            const p = elm?.getPost?.(link.num);
            if (!p) continue;
            pins.push({ elm, num: link.num, point: { x: p.x, y: p.y } });
        }
        if (pins.length === 0) continue;
        const isGround = cn === groundNode;
        nets.push({ cn, name: isGround ? "GND" : `n${n++}`, pins });
    }
    return nets;
}

/**
 * 网名解析：先按导出名；"GND" 作为别名兜底到引擎地网（nodeList[0] 恒为地，
 * SimulationManager.setGroundNode；lrc.txt 无显式 GroundElm 时地网导出名为 n0——设计 §1.4 实测）。
 */
function resolveNet(name: string, nets: NetInfo[], app: any): NetInfo | null {
    const hit = nets.find((net) => net.name === name);
    if (hit) return hit;
    if (name === "GND") {
        const first = app?.sim?.nodeList?.[0];
        return nets.find((net) => net.cn === first) ?? null;
    }
    return null;
}

/** 既有 post 索引：坐标集合 + 行/列表，供"线段穿过 post 内点"的硬约束检查 */
class PostIndex {
    points = new Set<string>();
    private rows = new Map<number, number[]>(); // y → xs
    private cols = new Map<number, number[]>(); // x → ys

    static build(app: any): PostIndex {
        const idx = new PostIndex();
        for (const elm of app?.elmList ?? []) {
            const count = elm?.getPostCount?.() ?? 0;
            for (let i = 0; i < count; i++) {
                const p = elm?.getPost?.(i);
                if (!p) continue;
                idx.add(p.x, p.y);
            }
        }
        return idx;
    }

    add(x: number, y: number): void {
        this.points.add(key(x, y));
        pushTo(this.rows, y, x);
        pushTo(this.cols, x, y);
    }

    has(k: string): boolean { return this.points.has(k); }

    /** 轴对齐线段是否穿过某个既有 post 的严格内点（端点不算） */
    segHitsInterior(s: Seg): boolean {
        if (s.y1 === s.y2) {
            const xs = this.rows.get(s.y1);
            if (!xs) return false;
            const lo = Math.min(s.x1, s.x2), hi = Math.max(s.x1, s.x2);
            return xs.some((x) => x > lo && x < hi);
        }
        if (s.x1 === s.x2) {
            const ys = this.cols.get(s.x1);
            if (!ys) return false;
            const lo = Math.min(s.y1, s.y2), hi = Math.max(s.y1, s.y2);
            return ys.some((y) => y > lo && y < hi);
        }
        return false; // 不会出现斜线段（路线构造保证轴对齐）
    }
}

function pushTo(m: Map<number, number[]>, k: number, v: number): void {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
}

/** 既有元件本体的轴对齐几何线段（软约束：叠加打分） */
function bodySegments(app: any): Seg[] {
    const out: Seg[] = [];
    for (const elm of app?.elmList ?? []) {
        if (elm?.x == null || elm?.x2 == null) continue;
        if (elm.x === elm.x2 || elm.y === elm.y2) out.push({ x1: elm.x, y1: elm.y, x2: elm.x2, y2: elm.y2 });
    }
    return out;
}

/** 轴对齐共线叠加（重叠长度 > 0 才算；垂直交叉不算——原理图里交叉不导通是正常画法）。
 *  端点次序无关：元件可能从右往左/从下往上画（x1 > x2），须先归一化。 */
function colinearOverlap(a: Seg, b: Seg): boolean {
    if (a.y1 === a.y2 && b.y1 === b.y2 && a.y1 === b.y1) {
        const lo = Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2));
        const hi = Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2));
        return hi - lo > 0;
    }
    if (a.x1 === a.x2 && b.x1 === b.x2 && a.x1 === b.x1) {
        const lo = Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2));
        const hi = Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2));
        return hi - lo > 0;
    }
    return false;
}

function countTurns(path: Seg[]): number {
    let turns = 0;
    for (let i = 1; i < path.length; i++) {
        const h0 = path[i - 1].y1 === path[i - 1].y2;
        const h1 = path[i].y1 === path[i].y2;
        if (h0 !== h1) turns++;
    }
    return turns;
}

// ── 接入点枚举 ───────────────────────────────────────────────────────────────

function centroid(net: NetInfo): Pt {
    let x = 0, y = 0;
    for (const p of net.pins) { x += p.point.x; y += p.point.y; }
    const n = Math.max(1, net.pins.length);
    return { x: x / n, y: y / n };
}

/**
 * 网的接入点：既有 post（零改动）+ 可分裂导线的内部格点（采样 ≤ MAX_WIRE_SAMPLES，
 * 须 pointOnWireInterior 严格内点、格点对齐、不压既有 post）。
 * 按离对网质心近排序，截断 ≤ MAX_TAPS。
 */
function enumerateTaps(net: NetInfo, app: any, foreign: PostIndex, toward: Pt): Tap[] {
    const taps: Tap[] = [];
    const seen = new Set<string>();
    const aligned = (x: number, y: number) => gridSnapped(app, x) === x && gridSnapped(app, y) === y;

    for (const pin of net.pins) {
        const { x, y } = pin.point;
        const k = key(x, y);
        if (seen.has(k) || !aligned(x, y)) continue;
        seen.add(k);
        taps.push({ point: { x, y }, wire: null });
    }

    const wires = new Set<any>();
    for (const pin of net.pins) {
        const w = pin.elm;
        if (wires.has(w)) continue;
        wires.add(w);
        if (w?.getClassName?.() !== "WireElm") continue;        // RoutedWireElm / 其它导线类不接
        if ((w.getPostCount?.() ?? 2) !== 2) continue;           // 总线（busWidth > 1）
        const horiz = w.y === w.y2 && w.x !== w.x2;
        const vert = w.x === w.x2 && w.y !== w.y2;
        if (!horiz && !vert) continue;                           // 斜线段没有可分裂点（设计 §1.2）

        const g = gridSizeOf(app);
        const lo = horiz ? Math.min(w.x, w.x2) : Math.min(w.y, w.y2);
        const hi = horiz ? Math.max(w.x, w.x2) : Math.max(w.y, w.y2);
        const cand: number[] = [];
        let v = gridSnapped(app, lo + 1);
        if (v <= lo) v += g;
        for (; v < hi; v += g) cand.push(v);                     // (lo, hi) 开区间内的格点

        const count = Math.min(MAX_WIRE_SAMPLES, cand.length);
        const picked: number[] = [];
        for (let i = 0; i < count; i++)
            picked.push(cand[Math.round((i * (cand.length - 1)) / Math.max(1, count - 1))]);

        for (const c of picked) {
            const x = horiz ? c : w.x;
            const y = horiz ? w.y : c;
            const k = key(x, y);
            if (seen.has(k) || foreign.has(k)) continue;         // 分裂点不得压既有 post（§4 硬约束）
            if (typeof w.pointOnWireInterior === "function" && !w.pointOnWireInterior(x, y)) continue;
            seen.add(k);
            taps.push({ point: { x, y }, wire: w });
        }
    }

    taps.sort((a, b) => manhattan(a.point, toward) - manhattan(b.point, toward));
    return taps.slice(0, MAX_TAPS);
}

// ── 路线枚举（设计 §4：R0 直连 / R1 L 形 / R2 单折让，局部有界） ─────────────

function candidateRoutes(a: Tap, b: Tap, app: any, foreign: PostIndex, bodies: Seg[]): RoutePlan[] {
    const out: RoutePlan[] = [];
    const seen = new Set<string>();
    const ax = a.point.x, ay = a.point.y, bx = b.point.x, by = b.point.y;

    const emit = (elen: Seg, segs: Seg[]): void => {
        const clean = segs.filter((s) => s.x1 !== s.x2 || s.y1 !== s.y2); // 去零长度段
        // 元件长 ≥ MIN_LEN（轴对齐下即曼哈顿长度）
        if (Math.abs(elen.x2 - elen.x1) + Math.abs(elen.y2 - elen.y1) < MIN_LEN) return;
        // 格点对齐（构造上已保证，防御性复核）
        const all = [elen, ...clean];
        for (const s of all) {
            if (gridSnapped(app, s.x1) !== s.x1 || gridSnapped(app, s.y1) !== s.y1) return;
            if (gridSnapped(app, s.x2) !== s.x2 || gridSnapped(app, s.y2) !== s.y2) return;
        }
        // 硬约束：新中间顶点（元件 post2 与跳线拐点）不得压既有 post；
        // 路径首（tapA）尾（tapB）端点按定义就是接入点，不检查。
        // 拐点压 tapA 会把 A 网并进跳线（短路），同样必须拒绝。
        for (let i = 0; i < all.length - 1; i++) {
            const k = key(all[i].x2, all[i].y2);
            if (foreign.has(k)) return;
        }
        // 硬约束：任何新增线段不得穿过既有 post 的严格内点
        for (const s of all) if (foreign.segHitsInterior(s)) return;

        const dedupe = JSON.stringify(all);
        if (seen.has(dedupe)) return;
        seen.add(dedupe);

        const overlaps = bodies.reduce(
            (n, body) => n + (all.some((s) => colinearOverlap(s, body)) ? 1 : 0), 0);
        const turns = countTurns(all);
        const wireLen = clean.reduce((s, w) => s + Math.abs(w.x2 - w.x1) + Math.abs(w.y2 - w.y1), 0);
        const splits: RoutePlan["splits"] = [];
        if (a.wire) splits.push({ wire: a.wire, x: ax, y: ay });
        if (b.wire) splits.push({ wire: b.wire, x: bx, y: by });
        out.push({ ax, ay, bx: elen.x2, by: elen.y2, splits, segs: clean, score: overlaps * 100 + wireLen + turns });
    };

    // R0 直连：两接入点轴对齐且间距 ≥ MIN_LEN
    if ((ax === bx || ay === by) && Math.abs(bx - ax) + Math.abs(by - ay) >= MIN_LEN)
        emit({ x1: ax, y1: ay, x2: bx, y2: by }, []);

    // R1/R2：元件自 tapA 沿某轴放 MIN_LEN（4 个朝向），再从 post2 正交连到 tapB
    const g = gridSizeOf(app);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const px = ax + dx * MIN_LEN, py = ay + dy * MIN_LEN;
        const elen: Seg = { x1: ax, y1: ay, x2: px, y2: py };
        // R1 L 形：post2 → corner → tapB（两种拐角）
        emit(elen, [{ x1: px, y1: py, x2: bx, y2: py }, { x1: bx, y1: py, x2: bx, y2: by }]);
        emit(elen, [{ x1: px, y1: py, x2: px, y2: by }, { x1: px, y1: by, x2: bx, y2: by }]);
        // R2 单折让：拐角外推 ±g/±2g（3 段），两种走序
        for (const off of [g, -g, 2 * g, -2 * g]) {
            emit(elen, [
                { x1: px, y1: py, x2: bx + off, y2: py },
                { x1: bx + off, y1: py, x2: bx + off, y2: by },
                { x1: bx + off, y1: by, x2: bx, y2: by },
            ]);
            emit(elen, [
                { x1: px, y1: py, x2: px, y2: by + off },
                { x1: px, y1: by + off, x2: bx, y2: by + off },
                { x1: bx, y1: by + off, x2: bx, y2: by },
            ]);
        }
    }
    return out;
}

// ── 执行与回滚 ───────────────────────────────────────────────────────────────

/** split 的精确逆：删新半段 + 原导线 drag 回原端点（WireElm.split 只做了 drag + 造新段） */
function rollback(app: any, journal: JournalEntry[]): void {
    for (let i = journal.length - 1; i >= 0; i--) {
        const j = journal[i];
        try {
            const elm = j.kind === "split" ? j.half : j.elm;
            const idx = app?.elmList?.indexOf(elm) ?? -1;
            if (idx >= 0) app.elmList.splice(idx, 1);
            elm?.delete?.();
            if (j.kind === "split") j.wire.drag(j.ox2, j.oy2);
        } catch {
            // 回滚尽力而为；调用方已判定失败并将返回 ok:false
        }
    }
}

/** props 预校验（改动前）：全部键须能经 registry 的 attr/field 映射解析 */
export function validateProps(cls: string, props: Record<string, any>): string | null {
    const attrs = elementRegistry().elements?.[cls]?.xmlAttrs ?? [];
    for (const k of Object.keys(props ?? {})) {
        const hit = attrs.find((x) => x.field === k) ?? attrs.find((x) => x.attr === k);
        if (!hit?.field) return `unknown prop "${k}" for ${cls}`;
    }
    return null;
}

export function applyProps(elm: any, props: Record<string, any>): void {
    const cls = elm?.getClassName?.() ?? "";
    const attrs = elementRegistry().elements?.[cls]?.xmlAttrs ?? [];
    for (const [k, v] of Object.entries(props ?? {})) {
        const hit = attrs.find((x) => x.field === k) ?? attrs.find((x) => x.attr === k);
        if (!hit?.field) continue; // 已由 validateProps 前置拦截，此处防御
        // 与 applyOps set 同款强转：纯数字字符串 → number
        elm[hit.field] = typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))
            ? Number(v) : v;
    }
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

export function placeElement(app: any, op: PlaceOp): PlaceResult {
    try {
        // ── 0) 前置校验（全部无副作用）────────────────────────────────────
        const type = op?.type;
        const between = op?.between;
        if (typeof type !== "string" || !Array.isArray(between) || between.length !== 2 ||
            typeof between[0] !== "string" || typeof between[1] !== "string")
            return { ok: false, reason: "add op requires { type, between: [netA, netB] }" };
        const [nameA, nameB] = between;
        if (nameA === nameB) return { ok: false, reason: `nets identical ("${nameA}")` };
        if (typeof app?.constructElement !== "function")
            return { ok: false, reason: "app.constructElement unavailable" };

        // 探测件：确认类型可造且为 2 端（不进 elmList，即刻丢弃，不领稳定 id）
        const probe = app.constructElement(type, 0, 0);
        if (probe == null) return { ok: false, reason: `unknown element type "${type}"` };
        const postCount = probe.getPostCount?.() ?? 0;
        const cls = probe.getClassName?.() ?? type;
        if (postCount !== 2) {
            probe.delete?.();
            return { ok: false, reason: `only 2-post elements supported (${cls} has ${postCount})` };
        }
        const propErr = validateProps(cls, op.props ?? {});
        if (propErr) {
            probe.delete?.();
            return { ok: false, reason: propErr };
        }
        probe.delete?.();

        // ── 1) 新鲜节点表 + 网收集 ─────────────────────────────────────────
        const freshErr = ensureFreshAnalysis(app);
        if (freshErr) return { ok: false, reason: freshErr };
        const nets = collectNets(app);
        const netA = resolveNet(nameA, nets, app);
        const netB = resolveNet(nameB, nets, app);
        if (netA == null) return { ok: false, reason: `unknown net "${nameA}"` };
        if (netB == null) return { ok: false, reason: `unknown net "${nameB}"` };
        if (netA === netB) return { ok: false, reason: `nets identical ("${nameA}" resolves to ${netA.name})` };
        const netsBefore = nets.length;

        // ── 2) 接入点 + 路线规划（局部有界，非整电路布局）──────────────────
        const foreign = PostIndex.build(app);
        const bodies = bodySegments(app);
        const tapsA = enumerateTaps(netA, app, foreign, centroid(netB));
        const tapsB = enumerateTaps(netB, app, foreign, centroid(netA));
        if (tapsA.length === 0) return { ok: false, reason: `no tappable point on net "${netA.name}"` };
        if (tapsB.length === 0) return { ok: false, reason: `no tappable point on net "${netB.name}"` };

        let plan: RoutePlan | null = null;
        for (const ta of tapsA) {
            for (const tb of tapsB) {
                for (const cand of candidateRoutes(ta, tb, app, foreign, bodies)) {
                    if (plan == null || cand.score < plan.score) plan = cand;
                }
            }
        }
        if (plan == null)
            return { ok: false, reason: `no collision-free placement between "${netA.name}" and "${netB.name}"` };

        // ── 3) 执行（记 journal 供机械回滚；先分裂后放件）──────────────────
        app.undoManager?.pushUndo?.(); // 改动前快照（可选链，与 CommandManager 惯例同款）
        const journal: JournalEntry[] = [];
        for (const s of plan.splits) {
            const ox2 = s.wire.x2, oy2 = s.wire.y2;
            const half = s.wire.split(s.x, s.y);   // WireElm.split：this 变前半，返回后半
            app.elmList.push(half);                // 调用方负责 push（MouseManager.ts:626 同款）
            journal.push({ kind: "split", wire: s.wire, half, ox2, oy2 });
        }
        const elm = app.constructElement(type, plan.ax, plan.ay);
        elm.drag(plan.bx, plan.by);                // drag 内部 snapGrid；坐标已对齐故为恒等
        applyProps(elm, op.props ?? {});
        app.elmList.push(elm);
        journal.push({ kind: "remove", elm });
        const jumpers: any[] = [];
        for (const seg of plan.segs) {
            const w = app.constructElement("WireElm", seg.x1, seg.y1);
            w.drag(seg.x2, seg.y2);
            app.elmList.push(w);
            journal.push({ kind: "remove", elm: w });
            jumpers.push(w);
        }

        // ── 4) 自校验（硬闸）：net 数不变 + 两脚恰落两目标网 ───────────────
        const verifyErr = ensureFreshAnalysis(app);
        if (verifyErr) {
            rollback(app, journal);
            app.needAnalyze?.();
            return { ok: false, reason: `verification failed: ${verifyErr}` };
        }
        const nl = exportNetlist(app); // 顺带为新增元件/导线分配稳定 id（ids.ts）
        const afterNets = nl.meta.counts.nets;
        const comp = nl.components.find((c) => c.id === idOf(elm));
        const pin0 = comp?.pins?.["0"] ?? "?";
        const pin1 = comp?.pins?.["1"] ?? "?";
        const okNets = afterNets === netsBefore;
        const okPins = comp != null &&
            ((pin0 === netA.name && pin1 === netB.name) || (pin0 === netB.name && pin1 === netA.name));
        if (!okNets || !okPins) {
            rollback(app, journal);
            app.needAnalyze?.();
            return {
                ok: false,
                reason: `verification failed: nets ${netsBefore}->${afterNets}` +
                    (okNets ? "" : " (net count changed)") +
                    `, new element pins ${pin0}/${pin1}, want ${netA.name}/${netB.name}`,
            };
        }

        // ── 5) 收尾 ───────────────────────────────────────────────────────
        app.needAnalyze?.(); // applyOps 末尾对 applied>0 也会调；幂等无害
        return {
            ok: true,
            elementId: idOf(elm) ?? "(unassigned)",
            splits: plan.splits.map((s) => ({ wireId: idOf(s.wire), at: [s.x, s.y] as [number, number] })),
            wires: jumpers.map((w) => ({
                id: idOf(w),
                p1: [w.x, w.y] as [number, number],
                p2: [w.x2, w.y2] as [number, number],
            })),
        };
    } catch (e: any) {
        return { ok: false, reason: `placement error: ${e?.message ?? String(e)}` };
    }
}
