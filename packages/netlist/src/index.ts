// @ext/netlist — CircuitJS1 网表的 JSON 投影 + ops 写通道（v0.1 骨架）
//
// 设计要点（见 docs/format-strategy.md）：
//  - 真源是引擎对象（app.elmList + app.sim.nodeList），**不解析 XML 文本**；
//  - 坐标默认不输出；layout:true 时才带 x1 y1 x2 y2；
//  - 写入走 ops（set/delete/add/probe）；add 的增量布局在 place.ts（C04，导线分裂放置）；
//    probe 映射到引擎停靠 scope（PRB1，见下方 probeScope 注释）。

import registryJson from "./registry.json";
import { assignStableIds, elmOf, idOf } from "./ids";
import { placeElement } from "./place";
import type { PlaceFail } from "./place";
export { resetIds, idOf, elmOf } from "./ids";
// 紧凑投影（C05）：编码 + 解码 + 图例。浏览器侧经 @ext/netlist 一并拿到，
// 免得 ExtApi / 页面桥各自去相对路径捞（v0.1.7 接 MCP 消费方时统一到这里）。
export { encodeCompact, decodeCompact, compactTypes } from "./compact";
export type { CompactEncodeOptions, CompactLegend, CompactLosses, CompactDecoded, CompactInputNetlist } from "./compact";

// 网表 → 电路（C07）：布局 + 布线 + 引擎内编译。算法层在 geom.ts（纯函数），
// 引擎事务在 compile.ts（预校验 / 硬闸拓扑校验 / 失败回滚）。
export { compileNetlist, netlistToCircuitText, loadNetlist } from "./compile";
export type { CompileOptions, CompileResult, CompileOk, CompileFail, CompileStats, CompileLosses } from "./compile";
export { autoLayout, routeNets, connectionOrder } from "./geom";
export type { LayoutOptions, RouteResult, RouteConflict, GeomComponent, GeomNet } from "./geom";

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

// ── probe → 引擎 scope 机制（PRB1）──────────────────────────────────────────
//
// 映射到「停靠 scope」（app.scopeManager.scopes），即 UI 右键 "View in New Scope"
// 的同一条创建路径（core/ts/CommandManager.ts:214 viewInScope），而不是浮动
// ScopeElm。权衡说明（为什么不需要"画布外固定槽位"）：
//  - ScopeElm 那条路必须给画布坐标，且它进 elmList —— 会被 exportNetlist 当元件
//    导出、挤占稳定 id 序列（e1..eN 出现影子元件）、混进 getMeasurements；
//  - 停靠 scope 与 elmList 完全解耦（只在 CircuitLoader.clearCircuit 载入时清空，
//    analyzeCircuit 不清），创建完全不需要坐标。
// 全程鸭子类型，不 import core（本包纪律，Node 侧 strip-only 加载不能碰 CirSim 图）。
function findScopeFor(app: any, elm: any): any | null {
    const sm = app?.scopeManager;
    for (let i = 0; sm && i < (sm.scopeCount ?? 0); i++)
        if (sm.scopes[i]?.showingElm?.(elm)) return sm.scopes[i];
    // 浮动 ScopeElm（elmList 内的 isScopeElm）上已有的 scope 也算"已存在"
    for (const e of app?.elmList ?? [])
        if (e?.isScopeElm?.() && e?.elmScope?.showingElm?.(elm)) return e.elmScope;
    return null;
}

function setQuantity(scope: any, quantity: "voltage" | "current"): void {
    // Scope.showVoltage/showCurrent（core/ts/Scope.ts:149/160）：设 show 开关 +
    // 缺图时自动补建对应 ScopePlot
    scope.showVoltage(quantity === "voltage");
    scope.showCurrent(quantity === "current");
}

/** 建/更新目标元件的 scope；返回是否新建（false = 幂等命中已有 scope） */
function probeScope(app: any, elm: any, quantity: "voltage" | "current"): boolean {
    const sm = app?.scopeManager;
    const mouse = app?.mouse;
    const commands = app?.commands;
    if (!sm || !mouse || typeof commands?.menuPerformed !== "function")
        throw new Error("probe needs engine scope UI (app.scopeManager/mouse/commands)");

    // 幂等：目标已有 scope（停靠或浮动）→ 只把 quantity 开关对齐，不新建
    const existing = findScopeFor(app, elm);
    if (existing) {
        setQuantity(existing, quantity);
        return false;
    }

    // 与 UI 完全同一条创建路径：CommandManager.menuPerformed("elm","viewInScope")
    // 读 mouse.menuElm 建（或复用空槽）停靠 scope；临时借用、用完还原。
    const prev = mouse.menuElm ?? null;
    mouse.menuElm = elm;
    try {
        commands.menuPerformed("elm", "viewInScope");
    } finally {
        mouse.menuElm = prev;
    }
    const scope = findScopeFor(app, elm);
    if (!scope)
        throw new Error("viewInScope produced no scope for target (scope slots full?)");
    setQuantity(scope, quantity);
    return true;
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
                case "probe": {
                    // PRB1：probe → 引擎 scope。quantity 先验（运行期数据可能越界，
                    // 与 C03 一致走结构化失败，不外抛）
                    if (op.quantity !== "voltage" && op.quantity !== "current")
                        throw new Error(`unknown quantity "${op.quantity}" (expected "voltage" | "current")`);
                    const i = indexOfTarget(app, op.target);
                    const elm = app.elmList[i];
                    const tid = idOf(elm) ?? `c${i}`;
                    const createdNew = probeScope(app, elm, op.quantity);
                    result.applied++;
                    // 只有真正新建才进 created；幂等重复 probe 不重复建、created 保持空
                    if (createdNew) result.created.probe = tid;
                    result.atoms.push({ probe: { target: tid, quantity: op.quantity, created: createdNew } });
                    break;
                }
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
