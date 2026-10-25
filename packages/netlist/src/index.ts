// @ext/netlist — CircuitJS1 网表的 JSON 投影 + ops 写通道（v0.1 骨架）
//
// 设计要点（见 docs/format-strategy.md）：
//  - 真源是引擎对象（app.elmList + app.sim.nodeList），**不解析 XML 文本**；
//  - 坐标默认不输出；layout:true 时才带 x1 y1 x2 y2；
//  - 写入走 ops（set/delete/probe），add 的增量布局留待 v0.2（接口已定）。
//
// TODO(v0.2)：add between nets（WireElm.split + 正交补线）；probe 映射到 ScopeElm。

import registryJson from "./registry.json";

type AttrDef = { attr: string; field: string | null; kind: string };
type ElemDef = { cls: string; parent?: string; xmlType?: string | null; xmlAttrs?: AttrDef[] };
type Registry = { elements: Record<string, ElemDef> };

const REGISTRY: Registry = registryJson as unknown as Registry;

export interface NetlistComponent {
    id: string;
    type: string;
    tag: string;
    f: number;
    props: Record<string, number | string | boolean>;
    pins: Record<string, string>;
    layout?: [number, number, number, number];
}

export interface NetlistNet {
    id: string;
    pins: string[];
    ground?: boolean;
    name?: string | null;
}

export interface Netlist {
    schema: "netlist/0.1";
    meta: {
        core: string;
        source: { format: "engine" };
        counts: { components: number; nets: number };
        options: Record<string, unknown>;
    };
    models: any[];
    components: NetlistComponent[];
    nets: NetlistNet[];
    probes: any[];
    subcircuits: any[];
    unsupported: any[];
}

export interface ExportOptions {
    /** 输出 x1 y1 x2 y2（默认 false） */
    layout?: boolean;
    /** 省略等于默认值的属性（v0.2；当前只做 null/undefined 省略） */
    dropDefaults?: boolean;
}

export function exportNetlist(app: any, opts: ExportOptions = {}): Netlist {
    const sim = app?.sim;
    const elms: any[] = app?.elmList ?? [];

    // 确保节点表是最新的：analyzeCircuit 只同步 elmList，nodeList 在 preStampCircuit 里建
    if (!sim?.nodeList?.length) {
        try {
            sim?.analyzeCircuit?.();
            sim?.preStampCircuit?.(false);
        } catch (e) {
            // 电路本身不合法时仍返回尽量完整的投影
            console.warn("[ext/netlist] analyze failed during export:", e);
        }
    }

    const idx = new Map<any, number>();
    elms.forEach((e, i) => idx.set(e, i));
    const unsupported: any[] = [];

    // ── 组件 ────────────────────────────────────────────────────────────────
    const components: NetlistComponent[] = elms.map((ce, i) => {
        const cls: string = ce?.getClassName?.() ?? "Unknown";
        const def = REGISTRY.elements[cls];
        const props: Record<string, number | string | boolean> = {};
        if (!def) unsupported.push({ component: `c${i}`, type: cls, reason: "not in registry" });
        for (const a of def?.xmlAttrs ?? []) {
            if (!a.field) continue;
            const v = ce[a.field];
            if (v === undefined || v === null) continue;
            if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") props[a.field] = v;
        }
        const c: NetlistComponent = {
            id: `c${i}`,
            type: cls,
            tag: ce?.getXmlDumpType?.() ?? "?",
            f: ce?.flags ?? 0,
            props,
            pins: {},
        };
        if (opts.layout) c.layout = [ce.x, ce.y, ce.x2, ce.y2];
        return c;
    });

    // ── 网络（引擎权威 nodeList）─────────────────────────────────────────────
    const groundNode = (() => {
        const g = elms.find((e) => e?.isGroundElm?.());
        return g?.nodes?.[0] ?? null;
    })();

    const nets: NetlistNet[] = [];
    let n = 0;
    for (const cn of sim?.nodeList ?? []) {
        const pins: string[] = [];
        for (const link of cn?.links ?? []) {
            const i = idx.get(link.elm);
            if (i == null) continue;
            const postCount = link.elm?.getPostCount?.() ?? 0;
            if (link.num >= postCount) continue; // 内部节点
            pins.push(`c${i}:${link.num}`);
        }
        if (pins.length === 0) continue;
        const isGround = cn === groundNode;
        nets.push({ id: isGround ? "GND" : `n${n++}`, pins, ...(isGround ? { ground: true } : {}) });
    }

    // 把 net id 回填到组件引脚
    for (const net of nets) {
        for (const p of net.pins) {
            const m = /^c(\d+):(\d+)$/.exec(p);
            if (!m) continue;
            const c = components[Number(m[1])];
            if (c) c.pins[m[2]] = net.id;
        }
    }

    return {
        schema: "netlist/0.1",
        meta: {
            core: app?.versionString ?? "",
            source: { format: "engine" },
            counts: { components: components.length, nets: nets.length },
            options: { layout: !!opts.layout, dropDefaults: !!opts.dropDefaults },
        },
        models: [],
        components,
        nets,
        probes: [],
        subcircuits: [],
        unsupported,
    };
}

// ── 写通道：ops ─────────────────────────────────────────────────────────────

export type NetlistOp =
    | { op: "set"; target: string; prop: string; value: number | string | boolean }
    | { op: "delete"; target: string }
    | { op: "probe"; target: string; quantity: "voltage" | "current" }
    | { op: "add"; type: string; between: [string, string]; props?: Record<string, any> };

export interface ApplyResult {
    ok: boolean;
    applied: number;
    created: Record<string, string>;
    atoms: any[];
    unsupported: any[];
}

function indexOfTarget(app: any, target: string): number {
    const m = /^c(\d+)$/.exec(String(target));
    const i = m ? Number(m[1]) : Number(target);
    if (!Number.isInteger(i) || i < 0 || i >= (app?.elmList?.length ?? 0))
        throw new Error(`unknown target "${target}"`);
    return i;
}

function fieldOf(elm: any, prop: string): string {
    const cls = elm?.getClassName?.() ?? "";
    const attrs = REGISTRY.elements[cls]?.xmlAttrs ?? [];
    const hit = attrs.find((a) => a.field === prop) ?? attrs.find((a) => a.attr === prop);
    if (!hit?.field) throw new Error(`unknown prop "${prop}" for ${cls}`);
    return hit.field;
}

export function applyOps(app: any, ops: NetlistOp[]): ApplyResult {
    const result: ApplyResult = { ok: true, applied: 0, created: {}, atoms: [], unsupported: [] };
    for (const op of ops ?? []) {
        try {
            switch (op.op) {
                case "set": {
                    const i = indexOfTarget(app, op.target);
                    const elm = app.elmList[i];
                    const field = fieldOf(elm, op.prop);
                    const v = typeof op.value === "string" && op.value.trim() !== "" && !Number.isNaN(Number(op.value))
                        ? Number(op.value) : op.value;
                    elm[field] = v;
                    result.applied++;
                    result.atoms.push({ set: `c${i}.${field}`, value: v });
                    break;
                }
                case "delete": {
                    const i = indexOfTarget(app, op.target);
                    app.elmList.splice(i, 1);
                    result.applied++;
                    // 注意：删除会让后续 c{i} 编号整体前移；v0.2 改用稳定 id
                    result.atoms.push({ deleted: `c${i}`, warning: "subsequent ids shift" });
                    break;
                }
                case "probe":
                    result.unsupported.push({ op, reason: "probe mapping not implemented (v0.2)" });
                    break;
                case "add":
                    result.unsupported.push({
                        op,
                        reason: "incremental placement not implemented; see docs/format-strategy.md §5",
                    });
                    result.ok = false;
                    break;
                default:
                    throw new Error(`unknown op ${(op as any).op}`);
            }
        } catch (e: any) {
            result.ok = false;
            result.unsupported.push({ op, reason: e?.message ?? String(e) });
        }
    }
    if (result.applied > 0) app?.needAnalyze?.();
    return result;
}

/** 元件表只读访问（插件/工具用） */
export function elementRegistry(): Registry {
    return REGISTRY;
}
