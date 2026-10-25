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
// spike 原型没有紧凑格式对应的解码器，故本文件同样不提供 decodeCompact。
//
// 输出形状：
//   { v: 1,
//     g?: <ground 的 net 索引>,          // 仅存在接地时
//     n?: { <net 索引>: <名称> },        // 仅有命名的 net（来自 LabeledNode 等）
//     c: [ [typeIdx, flags, [netIdx|-1...], [props...]], ... ],
//     u?: [ ...unsupported... ] }
// net 索引 = nl.nets 数组下标；-1 表示该 post 无 net（内部节点 / 未连）。

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
