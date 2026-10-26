// @ext/netlist — 紧凑 JSON 投影（C05）
//
// 用途：批量 / 长上下文场景的 AI 读取格式（docs/format-strategy.md §1/§6）。
// 编码思路移植自 spike/netlist-codec/src/variants.mjs 的 jsonCompact（实测聚合 0.331× XML，
// 中位 0.320×），适配到 packages/netlist 的 Netlist 对象上。
//
// 有损设计（刻意为之，见 docs/format-strategy.md §6——省 token 大头是
// 去导线 −32.3% + 去坐标 −49.3%，不是 JSON 语法）：
//   1. 纯导线元件（WireElm）整行剔除：连通性已由 nets（net 索引）表达，
//      导线本身不携带任何参数；
//   2. 坐标字段（x / y / x2 / y2）剔除：layout 语义不进入紧凑通道；
//   3. meta / models / probes / subcircuits 等空壳段不输出。
//
// 解码所需 schema = packages/netlist/src/registry.json（一次性注入上下文）：
//   - 类型：registry.elements 键的**字典序**即类型索引（compactTypes() 可取回该表）；
//   - 属性：该类型 xmlAttrs 的出现顺序即 props 数组位置（跳过 field 为 null 的
//     dump-only 项与上述坐标项）；靠前的缺失属性用 null 占位，尾部缺失省略。
//
// 输出形状：
//   { v: 1,
//     g?: <ground 的 net 索引>,          // 仅存在接地时
//     n?: { <net 索引>: <名称> },        // 仅有命名的 net（来自 LabeledNode 等）
//     c: [ [typeIdx, flags, [netIdx|-1...], [props...]], ... ],
//     u?: [ ...unsupported... ] }
// net 索引 = nl.nets 数组下标；-1 表示该 post 无 net（内部节点 / 未连）。
//
// ── 解码（decodeCompact）────────────────────────────────────────────────
// 有损格式不可能"解回原样"，所以解码器的正确性用一条**幂等律**来钉：
//
//     encode(decode(encode(nl)))  ≡  encode(nl)          // 对所有合法 nl 成立
//
// 即"解码不引入新的信息损失"。逐字段看为什么成立：
//   · typeIdx → 类名 → typeIdx：TYPE_TABLE 是双向的；
//   · pins：解码把 ≥0 的槽位还原成 `{ <post>: <netId> }`，再编码时 maxPost 与空洞完全一致；
//   · props：解码只把非 null 值按位置放回字段名，再编码时前导 null 由 pending 补回、尾部照旧省略；
//   · flags / unsupported 原样往返。
// 真正解不回来的只有三件（见 `CompactLosses`）：坐标、导线行、以及"整张 net 表里没有被任何
// 非导线元件引用的 net"——紧凑格式不写 net 总数，只能从引用反推下标上界。
//
// 解码输出是 `CompactInputNetlist`（schema + components + nets + unsupported），也就是
// encodeCompact 的输入形状：可以直接再编码，也可以喂给 `circuit.load_netlist` 那类"网表 JSON"
// 入口。net id 按 `GND` / `n0..` 还原（与 index.ts 的 exportNetlist 命名同一规则），
// 元件 id 按 `e1..eN`（紧凑数组顺序；导线的 id 缺口无法还原，见 CompactLosses.wires）。

import registryJson from "./registry.json" with { type: "json" };

// ── 输入类型（与 index.ts 的 Netlist 结构对齐的最小投影。刻意不 import "./index"：
// ── 扩展名less 的相对导入 Node 不认，带 .ts 的 tsc 不认——复制这两段接口让本文件
// ── 可被 Node 直接 type-stripping 加载，供 bench 使用）────────────────────────

export interface CompactInputComponent {
    id: string;
    type: string;
    f: number;
    props: Record<string, number | string | boolean>;
    pins: Record<string, string>;
}

export interface CompactInputNet {
    id: string;
    pins: string[];
    ground?: boolean;
    name?: string | null;
}

export interface CompactInputNetlist {
    schema: string;
    components: CompactInputComponent[];
    nets: CompactInputNet[];
    unsupported?: unknown[];
}

type AttrDef = { attr: string; field: string | null; kind: string };
type ElemDef = { cls: string; xmlType?: string | null; xmlAttrs?: AttrDef[] };
type Registry = { elements: Record<string, ElemDef> };

const REGISTRY: Registry = registryJson as unknown as Registry;

/** 类型索引表：registry.elements 键的字典序。紧凑输出里的 typeIdx 指向这张表。 */
const TYPE_TABLE: string[] = Object.keys(REGISTRY.elements).sort();
const TYPE_INDEX = new Map(TYPE_TABLE.map((cls, i) => [cls, i]));

/** 取类型索引表（消费方据此把 typeIdx 还原为类名 / xmlType）。 */
export function compactTypes(): string[] {
    return TYPE_TABLE;
}

/** 纯导线：紧凑通道整行剔除（连通性由 nets 表达）。 */
const WIRE_CLS = "WireElm";
/** 坐标字段：紧凑通道剔除（format-strategy §6 去坐标）。 */
const GEOMETRY_FIELDS = new Set(["x", "y", "x2", "y2"]);

export function encodeCompact(nl: CompactInputNetlist): unknown {
    const netIdx = new Map<string, number>();
    (nl.nets ?? []).forEach((net, i) => netIdx.set(net.id, i));

    let ground = -1;
    const named: Record<number, string> = {};
    (nl.nets ?? []).forEach((net, i) => {
        if (net.ground && ground < 0) ground = i;
        if (net.name) named[i] = net.name;
    });

    const comps: unknown[] = [];
    for (const c of nl.components ?? []) {
        if (c.type === WIRE_CLS) continue; // 有损：见文件头
        const t = TYPE_INDEX.get(c.type);
        const def = t != null ? REGISTRY.elements[TYPE_TABLE[t]] : null;

        // pins：post 序号 → net 索引；空洞补 -1，尾部按最大出现的 post 截断
        let maxPost = -1;
        for (const k of Object.keys(c.pins ?? {})) {
            const p = Number(k);
            if (Number.isInteger(p) && p > maxPost) maxPost = p;
        }
        const pins: number[] = [];
        for (let p = 0; p <= maxPost; p++) {
            const nid = (c.pins ?? {})[String(p)];
            const ni = nid != null ? netIdx.get(nid) : undefined;
            pins.push(ni == null ? -1 : ni);
        }

        // props：按 registry xmlAttrs 顺序位置化；靠前缺失用 null 占位，尾部缺失省略
        const vals: unknown[] = [];
        let pending = 0;
        for (const a of def?.xmlAttrs ?? []) {
            if (!a?.field) continue; // dump-only 属性（如打包的 x 串）不占位
            if (GEOMETRY_FIELDS.has(a.field)) continue; // 有损：去坐标
            const v = (c.props ?? {})[a.field];
            if (v === undefined || v === null) {
                pending++;
                continue;
            }
            for (; pending > 0; pending--) vals.push(null);
            vals.push(v);
        }

        comps.push([t ?? -1, c.f ?? 0, pins, vals]);
    }

    const out: Record<string, unknown> = { v: 1, c: comps };
    if (ground >= 0) out.g = ground;
    if (Object.keys(named).length) out.n = named;
    if (nl.unsupported?.length) out.u = nl.unsupported;
    return out;
}

// ── 解码 ────────────────────────────────────────────────────────────────────

/**
 * 紧凑格式**固有**的信息损失（不是 bug，是有损设计的账目）。
 * 解码器把这三笔账如实报出来，消费方据此决定"够不够用"：
 * 要坐标就得走 layout:true 的命名 JSON，要导线就得导 XML。
 */
export interface CompactLosses {
    /** 坐标（x/y/x2/y2）不在紧凑通道里：恢复出的元件必须重新布局（place.ts / 引擎默认位置） */
    geometry: true;
    /**
     * 纯导线被整行剔除，**原始数量不可知**（连通性已由 net 索引表达，但"原来有几根导线"
     * 这个信息彻底没了）。元件 id 也因此有缺口：原电路的 e7 解码后可能叫 e5。
     */
    wires: "unknown";
    /** 类型索引无法解析（typeIdx = -1，或越出 compactTypes() 长度）的元件数 */
    unresolved: number;
    /** props 位置越出该类型的属性表（编码端 registry 与解码端版本不一致的典型症状） */
    orphanProps: number;
    /** 反推出的 net 里没有任何引脚引用（只剩一个空 net；计入这个数说明电路里有悬空导线网） */
    unreferencedNets: number;
}

export interface CompactDecoded {
    /** 与 encodeCompact 的输入同形（schema / components / nets / unsupported） */
    netlist: CompactInputNetlist;
    losses: CompactLosses;
}

/** 类型索引解析不出时的占位类名（不在 registry 里，所以再编码会如实回到 -1） */
const UNRESOLVED_CLS = "Unknown";

/** 该类型在 props 数组里占位的字段名（与 encodeCompact 的遍历条件必须逐字一致） */
function propFields(cls: string | null): string[] {
    const def = cls != null ? REGISTRY.elements[cls] : null;
    const out: string[] = [];
    for (const a of def?.xmlAttrs ?? []) {
        if (!a?.field) continue; // dump-only
        if (GEOMETRY_FIELDS.has(a.field)) continue;
        out.push(a.field);
    }
    return out;
}

/**
 * 紧凑 JSON → 网表投影。幂等律见文件头：`encode(decode(encode(nl))) ≡ encode(nl)`。
 *
 * 形状不对时抛 `Error`（消息以 `decodeCompact:` 开头）：紧凑格式是**机器产出**的，
 * 遇到非法输入说明链路坏了，静默返回半个电路比报错更贵。
 */
export function decodeCompact(x: unknown): CompactDecoded {
    const src = x as any;
    if (!src || typeof src !== "object" || Array.isArray(src)) {
        throw new Error("decodeCompact: 紧凑网表必须是对象");
    }
    if (src.v !== 1) {
        throw new Error(`decodeCompact: 不支持的版本 v=${JSON.stringify(src.v)}（只认 1）`);
    }
    if (!Array.isArray(src.c)) throw new Error("decodeCompact: 缺少组件数组 c");

    // ── 1) net 下标上界：紧凑格式不写 net 总数，只能从引用反推 ────────────────
    // 引用来三处：组件 pins、ground、命名表。三者之外的下标无法得知（见 losses.wires）。
    let maxNet = -1;
    const touch = (v: unknown) => {
        if (typeof v === "number" && Number.isInteger(v) && v > maxNet) maxNet = v;
    };
    for (const [i, row] of src.c.entries()) {
        if (!Array.isArray(row)) throw new Error(`decodeCompact: c[${i}] 不是数组`);
        if (!Array.isArray(row[2])) throw new Error(`decodeCompact: c[${i}][2]（pins）不是数组`);
        for (const p of row[2]) touch(p);
    }
    const groundIdx = Number.isInteger(src.g) && src.g >= 0 ? (src.g as number) : -1;
    touch(groundIdx);
    const named = src.n && typeof src.n === "object" && !Array.isArray(src.n) ? (src.n as Record<string, string>) : {};
    for (const k of Object.keys(named)) touch(Number(k));

    // ── 2) net 表：索引即 id 序（GND / n0..，与 exportNetlist 同一命名规则）────
    const netIds: string[] = [];
    let seq = 0;
    for (let i = 0; i <= maxNet; i++) netIds.push(i === groundIdx ? "GND" : `n${seq++}`);
    const nets: CompactInputNet[] = netIds.map((id, i) => {
        const net: CompactInputNet = { id, pins: [] };
        if (i === groundIdx) net.ground = true;
        const nm = named[String(i)];
        if (typeof nm === "string") net.name = nm;
        return net;
    });

    // ── 3) 组件 ──────────────────────────────────────────────────────────────
    let unresolved = 0;
    let orphanProps = 0;
    const components: CompactInputComponent[] = src.c.map((row: any[], i: number) => {
        const [t, f, pins, vals] = row;
        const cls = typeof t === "number" && Number.isInteger(t) ? (TYPE_TABLE[t] ?? null) : null;
        if (cls == null) unresolved++;

        const comp: CompactInputComponent = {
            id: `e${i + 1}`,
            type: cls ?? UNRESOLVED_CLS,
            f: typeof f === "number" && Number.isInteger(f) ? f : 0,
            props: {},
            pins: {},
        };

        // props：位置 → 字段名（null 是"靠前缺失"的占位，跳过即可，再编码会补回来）
        const fields = propFields(cls);
        const arr: unknown[] = Array.isArray(vals) ? vals : [];
        for (let k = 0; k < arr.length; k++) {
            const v = arr[k];
            if (v === null || v === undefined) continue;
            const field = fields[k];
            if (field === undefined) { orphanProps++; continue; } // registry 漂移：别静默吞掉
            if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") comp.props[field] = v;
        }

        // pins：数组下标 = post 序号，-1 = 该 post 无 net
        (pins as unknown[]).forEach((ni, post) => {
            if (typeof ni !== "number" || !Number.isInteger(ni) || ni < 0) return;
            const id = netIds[ni];
            if (id == null) return; // 同 maxNet 取自同一批引用，理论上到不了这里
            comp.pins[String(post)] = id;
            nets[ni].pins.push(`${comp.id}:${post}`);
        });
        return comp;
    });

    // ── 4) 空 net：只被导线连接、或干脆没人引用（见 losses.unreferencedNets）─────
    let unreferencedNets = 0;
    for (const n of nets) if (n.pins.length === 0) unreferencedNets++;

    return {
        netlist: {
            schema: "netlist/0.1",
            components,
            nets,
            unsupported: Array.isArray(src.u) ? src.u : [],
        },
        losses: { geometry: true, wires: "unknown", unresolved, orphanProps, unreferencedNets },
    };
}
