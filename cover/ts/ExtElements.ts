// Cover 层新增：插件自定义元件的注册/注销（把 ElementFactory + dumpType 映射 + 菜单插槽接成一条链）
//
// 为什么需要这一层：
//   - core 只有 `ElementFactory.registerClass/create`，没有"按主人撤销"，`dumpTypeMap`
//     /`xmlDumpTypeMap` 也是单向写入（CirSim.register）——插件卸载后两份映射会留下悬空类名，
//     再加载含该元件的存档就变成 "unrecognized dump type"。
//   - 自定义元件要"能用"必须同时满足四件事：类进工厂（放置/加载）、dumpType 与 xmlType 进映射
//     （文本/XML 存档可读回）、Draw/右键菜单有条目（用户能找到）、卸载时全部撤回。
//     这四件事分散在三个模块里，插件不该自己拼（也不能 import core 内部模块）。
//
// 依赖纪律：本文件**只** import ElementFactory。菜单插槽（ExtMenus）与 CirSim/MouseManager
// 都由调用方注入或在运行时从 app 上取——因为 ExtPluginHost 会被 Node 契约测试以
// strip-only 模式直接加载，而 core 的 CirSim 图里有不可擦除的 TS 语法（参数属性），
// 静态 import 会在 Node 侧直接炸。见 tests/contract/fiber.test.mjs 的加载基座说明。

import { ElementFactory } from "./ElementFactory";

export interface ExtElementDef {
    /** 元件类名，也是 ElementFactory 的键（建议以 Elm 结尾，XML 类型默认取去掉 Elm 的名字） */
    className: string;
    /** 元件构造函数（插件用 ctx.element.base("ResistorElm") 之类的基类继承得到） */
    ctor: any;
    /** 文本存档类型号（getDumpType 的返回值）；核心已用的号段不可占用 */
    dumpType: number;
    /** 菜单文案，缺省 "Add " + 去 Elm 的类名 */
    label?: string;
    /** XML 存档标签，缺省沿用基类规则（类名去 Elm） */
    xmlType?: string;
    /** 是否进 Draw / 右键菜单，缺省 true */
    menu?: boolean;
}

export interface ExtElementResult {
    ok: boolean;
    reason?: string;
    className?: string;
    dumpType?: number;
    xmlType?: string;
}

/** 菜单插槽的最小接口（ExtMenus 的实现；由 ExtBoot 注入，避免本文件拖进 core 图） */
export interface ExtMenuSlot {
    register(label: string, className: string, owner: string): { ok: boolean; reason?: string };
    unregister(className: string): boolean;
}

let menuSlot: ExtMenuSlot | null = null;

/** 由 ExtBoot 在启动时调用一次，把菜单插槽接进来（Node 侧不接也不影响注册本身）。 */
export function configureMenuSlot(slot: ExtMenuSlot): void {
    menuSlot = slot;
}

/** className -> owner（插件 id / "ext"） */
const owners = new Map<string, string>();

const DUMP_TYPE_MIN = 190;
const DUMP_TYPE_MAX = 255;

function mapsOf(app: any): { dump: Map<number, string>; xml: Map<string, string> } {
    // 两张表是 CirSim 的 static 字段；从实例的 constructor 上取，既能拿到与页面
    // 完全一致的类（不会因为模块重复而分叉），也不需要静态 import CirSim。
    const Ctor: any = app?.constructor ?? {};
    return { dump: Ctor.dumpTypeMap ?? new Map(), xml: Ctor.xmlDumpTypeMap ?? new Map() };
}

function menuLabelOf(def: ExtElementDef): string {
    return def.label ?? "Add " + def.className.replace(/Elm$/, "");
}

/** 从 `from` 起找一个没被占用的文本类型号（核心多用 ASCII 码，190 以上基本空闲）。 */
export function findFreeDumpType(app: any, from: number = DUMP_TYPE_MIN): number | null {
    const used = mapsOf(app).dump;
    const start = Math.max(1, Math.floor(from));
    for (let t = start; t <= DUMP_TYPE_MAX; t++) if (!used.has(t)) return t;
    for (let t = 160; t < start && t <= DUMP_TYPE_MAX; t++) if (!used.has(t)) return t;
    return null;
}

/** 取已注册的元件构造函数（插件继承核心元件用；只给构造函数，不给模块）。 */
export function baseElement(name: string): any {
    return ElementFactory.getClass(name);
}

/** 当前仍在册的自定义元件类名（owner 省略 = 全部）。 */
export function listExtElements(owner?: string): string[] {
    const out: string[] = [];
    for (const [cls, own] of owners) {
        if (owner == null || own === owner) out.push(cls);
    }
    return out.sort();
}

/**
 * 注册一个插件元件。返回结构化结果（不抛）：宿主 facade 负责把失败翻成异常。
 * 顺序：校验 -> 类进工厂 -> 补 dumpType/xmlType 映射 -> 进菜单；任一步失败按逆序回滚。
 */
export function registerExtElement(app: any, owner: string, def: ExtElementDef): ExtElementResult {
    const className = String(def?.className ?? "").trim();
    if (!className) return { ok: false, reason: "className is required" };
    if (!/^[A-Za-z_$][\w$]*$/.test(className)) return { ok: false, reason: `invalid className "${className}"` };
    if (typeof def.ctor !== "function") return { ok: false, reason: "ctor must be a class/function" };
    if (def.menu !== false && menuSlot == null)
        return { ok: false, reason: "menu slot not configured (ExtBoot did not run?)" };

    const prevOwner = ElementFactory.ownerOf(className);
    if (prevOwner != null) {
        return {
            ok: false,
            reason: prevOwner === owner
                ? `"${className}" already registered by this plugin`
                : `element type conflict: "${className}" owned by "${prevOwner}"`,
        };
    }
    if (owners.has(className)) return { ok: false, reason: `"${className}" already registered by "${owners.get(className)}"` };

    const dumpType = def.dumpType;
    if (!Number.isInteger(dumpType) || dumpType <= 0)
        return { ok: false, reason: "dumpType must be a positive integer" };
    const anchors = mapsOf(app);
    const holder = anchors.dump.get(dumpType);
    if (holder != null && holder !== className)
        return { ok: false, reason: `dumpType ${dumpType} already used by "${holder}"` };

    const xmlType = (def.xmlType ?? className.replace(/Elm$/, "")).trim();
    if (!xmlType) return { ok: false, reason: "xmlType is empty" };
    const xmlHolder = anchors.xml.get(xmlType);
    if (xmlHolder != null && xmlHolder !== className)
        return { ok: false, reason: `xmlType "${xmlType}" already used by "${xmlHolder}"` };

    // 探针实例：构造函数必须能在"放置"形态下工作。基类的 getDumpType 会被继承下来
    // （例如继承 ResistorElm 就返回 'r'），若不覆盖，CirSim.register 会把 'r' 判给插件类
    // 并打 "dump type conflict"。因此把 def.dumpType / def.xmlType 钉在插件自己的原型上
    // （只影响该类，不动基类）。
    try {
        const probe = new def.ctor(0, 0);
        if (probe == null || typeof probe !== "object")
            return { ok: false, reason: "ctor did not produce an element instance" };
        def.ctor.prototype.getDumpType = () => dumpType;
        def.ctor.prototype.getXmlDumpType = () => xmlType;
    } catch (e: any) {
        return { ok: false, reason: `ctor(0,0) failed: ${e?.message ?? e}` };
    }

    const rollback: Array<() => void> = [];
    try {
        ElementFactory.registerClass(className, def.ctor, owner);
        rollback.push(() => ElementFactory.deregisterClass(className, owner));
        owners.set(className, owner);

        // 补两份类型映射（与 core 的 CirSim.register 同款写入；菜单项构造也会写一遍，幂等）
        app.register(className, new def.ctor(0, 0));
        rollback.push(() => {
            if (anchors.dump.get(dumpType) === className) anchors.dump.delete(dumpType);
            if (anchors.xml.get(xmlType) === className) anchors.xml.delete(xmlType);
        });

        if (def.menu !== false) {
            const r = menuSlot!.register(menuLabelOf(def), className, owner);
            if (!r.ok) throw new Error(r.reason ?? "menu registration failed");
            rollback.push(() => menuSlot?.unregister(className));
        }
    } catch (e: any) {
        for (const fn of rollback.reverse()) {
            try { fn(); } catch { /* 回滚失败不掩盖原始错误 */ }
        }
        owners.delete(className);
        return { ok: false, reason: String(e?.message ?? e) };
    }

    return { ok: true, className, dumpType, xmlType };
}

/** 注销单个自定义元件（owner 不匹配则拒绝，保护其他插件与核心）。 */
export function unregisterExtElement(app: any, className: string, owner: string): boolean {
    const own = owners.get(className);
    if (own == null) return false;
    if (own !== owner) {
        throw new Error(`refuse to unregister "${className}" owned by "${own}", not "${owner}"`);
    }
    owners.delete(className);
    menuSlot?.unregister(className);
    try { ElementFactory.deregisterClass(className, owner); } catch { /* 已被外部清理 */ }
    const { dump, xml } = mapsOf(app);
    for (const [t, name] of Array.from(dump)) if (name === className) dump.delete(t);
    for (const [t, name] of Array.from(xml)) if (name === className) xml.delete(t);
    // 用户可能正拿着该元件的放置模式；撤掉后必须回到选择模式，否则下一次点击会 create 出 null。
    // 注意 setMouseMode() 只管 numeric mode，mouseModeStr 是另一个字段（UIManager.ts:1839 同款写法）；
    // 常量从 ui.mouse 的 constructor 上取，避免 import core 的 MouseManager 拖进整个图。
    try {
        const ui: any = app?.ui;
        if (ui?.mouseModeStr === className) {
            ui.setMouseMode(ui.mouse?.constructor?.MODE_SELECT ?? 6);
            ui.mouseModeStr = "Select";
        }
    } catch { /* UI 已销毁 */ }
    return true;
}

/** 注销某 owner 的全部自定义元件（fiber dispose 调用），返回撤销数量。 */
export function unregisterExtElements(app: any, owner: string): number {
    let n = 0;
    for (const cls of listExtElements(owner)) {
        try { if (unregisterExtElement(app, cls, owner)) n++; } catch { /* 继续撤销其余 */ }
    }
    return n;
}
