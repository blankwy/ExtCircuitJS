// @ext/netlist — 网表 → 电路 的几何层（C07）：自动布局 + 绕障布线
//
// 为什么单独一层：`compile.ts` 要在真引擎里 constructElement 才能拿到准确 post 坐标，
// 而「元件摆哪、导线怎么走」是纯几何问题，不该被引擎挡住。这里只有数字，
// Node 下可直接对着手写网表断言（`tests/contract/compile.test.mjs`）。
//
// 布局（同一张网表有无数种摆法，这里钉死一种，且**可复现**）：
//   1. 连接序：从第一个元件起 BFS 展开共享网的邻居 → 相连的元件在网格里相邻，
//      连线短、交叉少；未访问的按输入顺序续排（纯数组，不依赖 Map 迭代顺序）。
//   2. 网格：元件一律水平摆（x1,y)-(x1+span,y)，行距留出 gapY 作为布线通道。
//      行列按 grid 对齐，避免后端 drag() 的 snapGrid 悄悄改坐标。
//   3. 只自动布局 2 端元件。多端元件（晶体管/运放/子电路）的 post 位置由 core 几何
//      决定、推不出来，硬摆只会得到穿本体的图 → 直接拒绝，让调用方用带 layout 的网表。
//
// 布线：**A* 网格搜索**，不是"L 形候选"。原因很实在：L 形只有两种拐法，
// 一旦两个元件之间隔着别的元件（网格布局里很常见），导线就只能穿本体过去 ——
// 穿过的导线在视觉上是连接，在电气上什么都没连（上游 §1.1 的"视觉谎报"）。
// 网格 = 所有坐标 / grid，障碍 = 元件本体线段 + 别人家的 post + **别的网已布的导线**
// （后者保证不会把两个网短接）。代价 = 步长 + 转弯惩罚，让走线尽量少拐。
// 找不到路时按 bbox 外扩重试，仍失败 → 退回 L 形并记 conflict（拓扑优先，但必须报）。

export interface GeomComponent {
    id: string;
    type: string;
    /** pin 名 → 网 id */
    pins: Record<string, string>;
    layout?: [number, number, number, number];
}

export interface GeomNet {
    id: string;
    pins: string[];
}

export interface Pt { x: number; y: number; }
export interface Seg { x1: number; y1: number; x2: number; y2: number; }
export interface Box { x1: number; y1: number; x2: number; y2: number; }

export interface LayoutOptions {
    grid?: number;
    /** 2 端元件本体跨度 */
    span?: number;
    gapX?: number;
    /** 行间距，同时是布线通道宽度 */
    gapY?: number;
    margin?: number;
    cols?: number;
}

export interface LayoutResult {
    boxes: Record<string, Box>;
    order: string[];
    cols: number;
    rows: number;
}

export const DEFAULTS = { grid: 16, span: 32, gapX: 48, gapY: 64, margin: 32 };

const snap = (v: number, g: number): number => Math.round(v / g) * g;

/**
 * 连接序 BFS：共享任意网即相邻。确定性：起点/邻居都按输入数组顺序，
 * 与 Object/Map 迭代顺序无关。
 */
export function connectionOrder(components: GeomComponent[]): string[] {
    const netsOf = new Map<string, string[]>();
    const members = new Map<string, string[]>();
    for (const c of components) {
        const ns = Object.values(c.pins ?? {});
        netsOf.set(c.id, ns);
        for (const n of ns) {
            const list = members.get(n) ?? [];
            list.push(c.id);
            members.set(n, list);
        }
    }
    const seen = new Set<string>();
    const order: string[] = [];
    const index = new Map(components.map((c, i) => [c.id, i]));

    const visitFrom = (startId: string): void => {
        const queue: string[] = [startId];
        seen.add(startId);
        while (queue.length) {
            const id = queue.shift()!;
            order.push(id);
            const neighbours: string[] = [];
            for (const n of netsOf.get(id) ?? []) {
                for (const other of members.get(n) ?? []) {
                    if (other !== id && !seen.has(other)) neighbours.push(other);
                }
            }
            neighbours.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
            for (const n of neighbours) {
                if (seen.has(n)) continue;
                seen.add(n);
                queue.push(n);
            }
        }
    };

    for (const c of components) if (!seen.has(c.id)) visitFrom(c.id);
    return order;
}

/** 自动布局：只在无 layout（或调用方要求强制重排）时使用 */
export function autoLayout(components: GeomComponent[], opts: LayoutOptions = {}): LayoutResult {
    const grid = opts.grid ?? DEFAULTS.grid;
    const span = snap(opts.span ?? DEFAULTS.span, grid) || DEFAULTS.span;
    const gapX = snap(opts.gapX ?? DEFAULTS.gapX, grid);
    const gapY = snap(opts.gapY ?? DEFAULTS.gapY, grid);
    const margin = snap(opts.margin ?? DEFAULTS.margin, grid);

    const order = connectionOrder(components);
    const n = order.length;
    const cols = Math.max(1, Math.min(opts.cols ?? Math.ceil(Math.sqrt(n)), Math.max(1, n)));
    const boxes: Record<string, Box> = {};

    order.forEach((id, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const x1 = margin + c * (span + gapX);
        const y = margin + r * (span + gapY);
        boxes[id] = { x1, y1: y, x2: x1 + span, y2: y };
    });

    return { boxes, order, cols, rows: Math.ceil(n / cols) };
}

// ── 布线与避让 ───────────────────────────────────────────────────────────────

export interface RouteOptions {
    grid?: number;
    /** 搜索窗口在两点 bbox 外扩的格数（第一次 / 失败后第二次） */
    pad?: number;
    padGrow?: number;
    /** 转弯惩罚（格数当量） */
    turnPenalty?: number;
}

export interface RouteConflict {
    net: string;
    from: string;
    to: string;
    reason: "no_path" | "fallback_l";
    at: Pt;
}

export interface RouteResult {
    wires: Seg[];
    conflicts: RouteConflict[];
    /** 布不通、退回 L 形的边数 */
    stats: { nets: number; edges: number; segments: number; routed: number };
}

const K = (i: number, j: number): string => `${i},${j}`;
const isHoriz = (s: Seg): boolean => s.y1 === s.y2;

interface Edge { a: Pt; b: Pt; from: string; to: string; }

/** Prim MST（曼哈顿权）；一个网的 pin 数很小，O(n²) 足够 */
function spanningTree(points: { key: string; p: Pt }[]): Edge[] {
    const n = points.length;
    if (n < 2) return [];
    const inTree = new Array<boolean>(n).fill(false);
    const best = new Array<number>(n).fill(Infinity);
    const from = new Array<number>(n).fill(-1);
    best[0] = 0;
    const edges: Edge[] = [];
    for (let iter = 0; iter < n; iter++) {
        let pick = -1;
        for (let i = 0; i < n; i++) if (!inTree[i] && (pick < 0 || best[i] < best[pick])) pick = i;
        if (pick < 0) break;
        inTree[pick] = true;
        if (from[pick] >= 0) {
            edges.push({
                a: points[from[pick]].p, b: points[pick].p,
                from: points[from[pick]].key, to: points[pick].key,
            });
        }
        for (let i = 0; i < n; i++) {
            if (inTree[i]) continue;
            const d = Math.abs(points[i].p.x - points[pick].p.x) + Math.abs(points[i].p.y - points[pick].p.y);
            if (d < best[i]) { best[i] = d; from[i] = pick; }
        }
    }
    return edges;
}

/** 二叉堆（A* 的 open 集）；同 f 时按插入序，保证确定性 */
class Heap {
    private items: { f: number; g: number; i: number; j: number; d: number; seq: number }[] = [];
    private seq = 0;
    push(f: number, g: number, i: number, j: number, d: number): void {
        const node = { f, g, i, j, d, seq: this.seq++ };
        this.items.push(node);
        let k = this.items.length - 1;
        while (k > 0) {
            const p = (k - 1) >> 1;
            if (this.less(this.items[k], this.items[p])) { [this.items[k], this.items[p]] = [this.items[p], this.items[k]]; k = p; }
            else break;
        }
    }
    pop() {
        const top = this.items[0];
        const last = this.items.pop()!;
        if (this.items.length) {
            this.items[0] = last;
            let k = 0;
            for (;;) {
                const l = k * 2 + 1, r = l + 1;
                let s = k;
                if (l < this.items.length && this.less(this.items[l], this.items[s])) s = l;
                if (r < this.items.length && this.less(this.items[r], this.items[s])) s = r;
                if (s === k) break;
                [this.items[k], this.items[s]] = [this.items[s], this.items[k]];
                k = s;
            }
        }
        return top;
    }
    get size(): number { return this.items.length; }
    private less(a: { f: number; seq: number }, b: { f: number; seq: number }): boolean {
        return a.f !== b.f ? a.f < b.f : a.seq < b.seq;
    }
}

const DIRS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

interface AStarInput {
    start: [number, number];
    goal: [number, number];
    blocked: Set<string>;
    lo: [number, number];
    hi: [number, number];
    turnPenalty: number;
}

/** A* 于格点图；返回格点路径（含首尾），失败 → null */
function astar(input: AStarInput): [number, number][] | null {
    const { start, goal, blocked, lo, hi, turnPenalty } = input;
    if (start[0] === goal[0] && start[1] === goal[1]) return [start];
    const h = (i: number, j: number): number => Math.abs(i - goal[0]) + Math.abs(j - goal[1]);
    const key = (i: number, j: number, d: number): string => `${i},${j},${d}`;
    const gScore = new Map<string, number>();
    const cameFrom = new Map<string, [number, number, number]>();
    const open = new Heap();

    // d: 进入该格的方向（0..3），起点用 4 表示"无方向"（首步不计转弯）
    const startKey = key(start[0], start[1], 4);
    gScore.set(startKey, 0);
    open.push(h(start[0], start[1]), 0, start[0], start[1], 4);

    const inBounds = (i: number, j: number): boolean => i >= lo[0] && i <= hi[0] && j >= lo[1] && j <= hi[1];
    const goalKeyBase = goal;

    let guard = 0;
    while (open.size) {
        if (++guard > 400000) return null;
        const cur = open.pop();
        const [ci, cj, cd] = [cur.i, cur.j, cur.d];
        const ck = key(ci, cj, cd);
        if (cur.g > (gScore.get(ck) ?? Infinity)) continue;
        if (ci === goalKeyBase[0] && cj === goalKeyBase[1]) {
            const path: [number, number][] = [];
            let k: string | undefined = ck;
            let i = ci, j = cj;
            path.push([i, j]);
            while (k) {
                const prev = cameFrom.get(k);
                if (!prev) break;
                [i, j] = prev;
                path.push([i, j]);
                k = key(prev[0], prev[1], prev[2]);
            }
            return path.reverse();
        }
        for (let d = 0; d < 4; d++) {
            const ni = ci + DIRS[d][0], nj = cj + DIRS[d][1];
            if (!inBounds(ni, nj)) continue;
            const isGoal = ni === goal[0] && nj === goal[1];
            if (!isGoal && blocked.has(K(ni, nj))) continue;
            if (d === (cd + 2) % 4 && cd !== 4) continue;   // 不走回头路
            const turn = cd === 4 || cd === d ? 0 : turnPenalty;
            const ng = cur.g + 1 + turn;
            const nk = key(ni, nj, d);
            if (ng < (gScore.get(nk) ?? Infinity)) {
                gScore.set(nk, ng);
                cameFrom.set(nk, [ci, cj, cd]);
                open.push(ng + h(ni, nj), ng, ni, nj, d);
            }
        }
    }
    return null;
}

/** 格点路径 → 合并同向的原点（保留拐点），再转成坐标线段 */
function pathToSegs(path: [number, number][], unit: number): Seg[] {
    if (path.length < 2) return [];
    const pts: [number, number][] = [path[0]];
    for (let k = 1; k < path.length - 1; k++) {
        const [pi, pj] = path[k - 1], [ci, cj] = path[k], [ni, nj] = path[k + 1];
        const d1 = [ci - pi, cj - pj], d2 = [ni - ci, nj - cj];
        if (d1[0] !== d2[0] || d1[1] !== d2[1]) pts.push([ci, cj]);
    }
    pts.push(path[path.length - 1]);
    const segs: Seg[] = [];
    for (let k = 1; k < pts.length; k++) {
        const [ax, ay] = pts[k - 1], [bx, by] = pts[k];
        if (ax === bx && ay === by) continue;
        segs.push({ x1: ax * unit, y1: ay * unit, x2: bx * unit, y2: by * unit });
    }
    return segs;
}

/** 线段经过的格点（含端点） */
function segCells(s: Seg, unit: number): [number, number][] {
    const out: [number, number][] = [];
    const x1 = Math.round(s.x1 / unit), y1 = Math.round(s.y1 / unit);
    const x2 = Math.round(s.x2 / unit), y2 = Math.round(s.y2 / unit);
    if (x1 === x2) {
        const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
        for (let y = lo; y <= hi; y++) out.push([x1, y]);
    } else if (y1 === y2) {
        const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
        for (let x = lo; x <= hi; x++) out.push([x, y1]);
    } else {
        // 斜线（多端元件 bbox 边缘）：只取两端 + 粗采样，够用
        const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
        for (let t = 1; t <= steps; t++) {
            out.push([Math.round(x1 + (x2 - x1) * t / steps), Math.round(y1 + (y2 - y1) * t / steps)]);
        }
    }
    return out;
}

export interface RouteInput {
    nets: GeomNet[];
    /** "compId:pinNum" → 坐标（真引擎从 elm.getPost(n) 取；测试直接给） */
    pinPoints: Map<string, Pt>;
    /** 元件本体线段 */
    bodies?: Seg[];
    /** 所有 post 坐标（导线不得压过别人的脚） */
    posts?: Pt[];
}

/**
 * 布线：每网 MST + A* 绕障。返回导线线段与冲突明细。
 * 线段端点互不相同（零长段剔除），调用方按段生成 WireElm 即可。
 */
export function routeNets(input: RouteInput, opts: RouteOptions = {}): RouteResult {
    const unit = opts.grid ?? DEFAULTS.grid;
    const pad = opts.pad ?? 4;
    const padGrow = opts.padGrow ?? 12;
    const turnPenalty = opts.turnPenalty ?? 2;

    const bodies = input.bodies ?? [];
    const posts = input.posts ?? [];
    const wires: Seg[] = [];
    const conflicts: RouteConflict[] = [];
    /** 已被别的网占用的格点：防止异网导线重叠（重叠 = 真短路） */
    const taken = new Set<string>();

    // 静态障碍：元件本体 + 全部 post
    const staticBlocked = new Set<string>();
    for (const s of bodies) for (const [i, j] of segCells(s, unit)) staticBlocked.add(K(i, j));
    const postCells: [number, number][] = posts.map((p) => [Math.round(p.x / unit), Math.round(p.y / unit)]);
    for (const [i, j] of postCells) staticBlocked.add(K(i, j));

    let edges = 0;
    let routed = 0;
    let segments = 0;

    for (const net of input.nets) {
        const points = (net.pins ?? [])
            .map((k) => ({ key: k, p: input.pinPoints.get(k) }))
            .filter((x): x is { key: string; p: Pt } => x.p != null);
        if (points.length < 2) continue;

        // 本网已占格（同网共用导线是合法的，也允许新导线接上去）
        const mine = new Set<string>();

        for (const e of spanningTree(points)) {
            edges++;
            const si = Math.round(e.a.x / unit), sj = Math.round(e.a.y / unit);
            const gi = Math.round(e.b.x / unit), gj = Math.round(e.b.y / unit);
            const blocked = new Set<string>([...staticBlocked, ...taken]);
            // 两端必须可通行（它们是元件自己的 post）；本网已占的格子也可复用
            blocked.delete(K(si, sj));
            blocked.delete(K(gi, gj));
            for (const c of mine) blocked.delete(c);

            const lo: [number, number] = [Math.min(si, gi) - pad, Math.min(sj, gj) - pad];
            const hi: [number, number] = [Math.max(si, gi) + pad, Math.max(sj, gj) + pad];

            let path = astar({ start: [si, sj], goal: [gi, gj], blocked, lo, hi, turnPenalty });
            if (path == null) {
                // 外扩重试：绕远一点通常就有路了（网格布局的通道可能被别的网占满）
                const lo2: [number, number] = [Math.min(si, gi) - padGrow, Math.min(sj, gj) - padGrow];
                const hi2: [number, number] = [Math.max(si, gi) + padGrow, Math.max(sj, gj) + padGrow];
                path = astar({ start: [si, sj], goal: [gi, gj], blocked, lo: lo2, hi: hi2, turnPenalty });
            }
            let segs: Seg[];
            if (path == null) {
                conflicts.push({ net: net.id, from: e.from, to: e.to, reason: "no_path", at: e.a });
                segs = fallbackL(e.a, e.b);
            } else {
                routed++;
                segs = pathToSegs(path, unit);
            }
            for (const s of segs) {
                wires.push(s);
                segments++;
                for (const [i, j] of segCells(s, unit)) { mine.add(K(i, j)); taken.add(K(i, j)); }
            }
        }
        // 一个网的线都布完了，同网格子仍算占用（别的网不能踩）
    }

    return { wires, conflicts, stats: { nets: input.nets.length, edges, segments, routed } };
}

/** 兜底：先横后竖（最后手段，必然有 conflict 记录） */
function fallbackL(a: Pt, b: Pt): Seg[] {
    const out: Seg[] = [];
    if (a.x !== b.x) out.push({ x1: a.x, y1: a.y, x2: b.x, y2: a.y });
    if (a.y !== b.y) out.push({ x1: b.x, y1: a.y, x2: b.x, y2: b.y });
    if (!out.length) return [{ x1: a.x, y1: a.y, x2: b.x, y2: b.y }];
    return out;
}

/** 元件本体线段（2 端元件即一条；多端元件由调用方传 bbox 四边） */
export function bodySegments(components: GeomComponent[], boxes: Record<string, Box>): Seg[] {
    const out: Seg[] = [];
    for (const c of components) {
        const b = boxes[c.id];
        if (!b) continue;
        if (c.layout) { out.push({ x1: c.layout[0], y1: c.layout[1], x2: c.layout[2], y2: c.layout[3] }); continue; }
        out.push({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 });
    }
    return out;
}

/** 导线交叉点（真交叉），供将来生成 junction dot 用；v1 只统计 */
export function crossings(wires: Seg[]): Pt[] {
    const out: Pt[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < wires.length; i++) {
        const a = wires[i];
        for (let j = i + 1; j < wires.length; j++) {
            const b = wires[j];
            if (isHoriz(a) === isHoriz(b)) continue;
            const h = isHoriz(a) ? a : b;
            const v = isHoriz(a) ? b : a;
            const x = v.x1, y = h.y1;
            const hlo = Math.min(h.x1, h.x2), hhi = Math.max(h.x1, h.x2);
            const vlo = Math.min(v.y1, v.y2), vhi = Math.max(v.y1, v.y2);
            if (x < hlo || x > hhi || y < vlo || y > vhi) continue;
            const k = `${x},${y}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ x, y });
        }
    }
    return out;
}
