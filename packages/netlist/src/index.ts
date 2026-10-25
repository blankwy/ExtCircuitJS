// @ext/netlist — CircuitJS1 网表的 JSON 投影 + ops 写通道（v0.1 骨架）
//
// 设计要点（见 docs/format-strategy.md）：
//  - 真源是引擎对象（app.elmList + app.sim.nodeList），**不解析 XML 文本**；
//  - 坐标默认不输出；layout:true 时才带 x1 y1 x2 y2；
//  - 写入走 ops（set/delete/add）；add 的增量布局在 place.ts（C04，导线分裂放置）；
//    probe 映射到 ScopeElm 留待 v0.2。
//
// TODO(v0.2)：probe 映射到 ScopeElm。

import registryJson from "./registry.json";
import { assignStableIds, elmOf, idOf } from "./ids";
import { placeElement } from "./place";
import type { PlaceFail } from "./place";
export { resetIds, idOf, elmOf } from "./ids";

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

    // 稳定 id（C06）：按首次导出顺序分配 e1..eN；编辑不改变幸存者 id，
    // 全新电路（实例全部更换）时重置——见 ids.ts 头注释
    const stable = assignStableIds(elms);
    const unsupported: any[] = [];

    // ── 组件 ────────────────────────────────────────────────────────────────
    const components: NetlistComponent[] = elms.map((ce, i) => {
        const cls: string = ce?.getClassName?.() ?? "Unknown";
        const def = REGISTRY.elements[cls];
        const props: Record<string, number | string | boolean> = {};
        const id = stable.get(ce) ?? `x${i}`; // assignStableIds 覆盖全部 elm，此处仅防御
        if (!def) unsupported.push({ component: id, type: cls, reason: "not in registry" });
        for (const a of def?.xmlAttrs ?? []) {
            if (!a.field) continue;
            const v = ce[a.field];
            if (v === undefined || v === null) continue;
            if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") props[a.field] = v;
        }
        const c: NetlistComponent = {
            id,
            type: cls,
            tag: ce?.getXmlDumpType?.() ?? "?",
            f: ce?.flags ?? 0,
            props,
            pins: {},
        };
        if (opts.layout) c.layout = [ce.x, ce.y, ce.x2, ce.y2];
        return c;
    });
    const compById = new Map(components.map((c) => [c.id, c]));

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
            const cid = stable.get(link.elm);
            if (cid == null) continue; // 不在 elmList 的链接（防御，与原 idx 语义一致）
            const postCount = link.elm?.getPostCount?.() ?? 0;
            if (link.num >= postCount) continue; // 内部节点
            pins.push(`${cid}:${link.num}`);
        }
        if (pins.length === 0) continue;
        const isGround = cn === groundNode;
        nets.push({ id: isGround ? "GND" : `n${n++}`, pins, ...(isGround ? { ground: true } : {}) });
    }

    // 把 net id 回填到组件引脚（pin 形如 "<组件稳定id>:<post 序号>"）
    for (const net of nets) {
        for (const p of net.pins) {
            const sep = p.lastIndexOf(":");
            if (sep <= 0) continue;
            const c = compById.get(p.slice(0, sep));
            if (c) c.pins[p.slice(sep + 1)] = net.id;
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
    // 双轨 target（C06）：优先稳定 id（e1..eN，exportNetlist 产出）逆查实例；
    // 兼容旧 cN 下标格式与裸数字（boot.browser.mjs 走 ExtApi.listComponents 的 cN）
    const elm = elmOf(String(target));
    if (elm != null) {
        const i = app?.elmList?.indexOf(elm) ?? -1;
        if (i >= 0) return i;
    }
    const s = String(target);
    const i = Number(s.startsWith("c") ? s.slice(1) : s);
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
                    const elm = app.elmList[i];
                    app.elmList.splice(i, 1);
                    result.applied++;
                    // 稳定 id（e1..）不受删除影响；旧 cN 下标会整体前移，建议改用稳定 id
                    result.atoms.push({ deleted: idOf(elm) ?? `c${i}` });
                    break;
                }
                case "probe":
                    result.unsupported.push({ op, reason: "probe mapping not implemented (v0.2)" });
                    break;
                case "add": {
                    // 增量放置（C04）：委托 placeElement；成功记 created/atoms，
                    // 失败进 unsupported（结构化返回，不抛——与 C03 错误语义一致）
                    const r = placeElement(app, op);
                    if (r.ok === true) {
                        result.applied++;
                        result.created[`${op.type}#${Object.keys(result.created).length + 1}`] = r.elementId;
                        result.atoms.push({ add: { id: r.elementId, type: op.type }, splits: r.splits, wires: r.wires });
                    } else {
                        const fail = r as PlaceFail;
                        result.unsupported.push({ op, reason: fail.reason });
                        result.ok = false;
                    }
                    break;
                }
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
