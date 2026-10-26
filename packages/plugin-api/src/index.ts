// @ext/plugin-api — 插件契约（不依赖 cordis；AbortSignal 作为 dispose 原语）
// 语义对齐 cordis 的 fiber/effect/dispose/inject，但实现只有 ~100 行，浏览器/Node 通用。

export * from "./permissions";
// export * 不建立本地绑定，本文件自己用到这两个名字要单独引
import type { ExtPermission } from "./permissions";

export type PluginState = "discovered" | "loading" | "ready" | "failed" | "disposing" | "disposed";

export type ExtDisposer = () => void;

export interface ExtCommand {
    /** 全局唯一，建议 `${pluginId}.${name}` */
    id: string;
    label: string;
    category?: string;
    keywords?: string;
    run(): void;
}

/** 自定义元件声明。ctor 必须是继承自 ctx.element.base(...) 的类。 */
export interface ExtElementDef {
    /** 元件类名，也是 ElementFactory 的键 */
    className: string;
    ctor: any;
    /** 文本存档类型号；用 ctx.element.freeDumpType() 取空号 */
    dumpType: number;
    /** 菜单文案，缺省 "Add " + 去 Elm 的类名 */
    label?: string;
    /** XML 存档标签，缺省类名去 Elm */
    xmlType?: string;
    /** 是否进 Draw / 右键菜单，缺省 true */
    menu?: boolean;
}

export interface ExtElementFacet {
    /** 注册元件（类 + 存档类型 + 菜单）；失败抛错并随 fiber 回滚，卸载时自动撤销 */
    register(def: ExtElementDef): ExtDisposer;
    /** 立即注销本插件注册的某个元件；返回是否撤销成功 */
    unregister(className: string): boolean;
    /** 本插件当前在册的元件类名 */
    list(): string[];
    /** 取核心元件构造函数作为基类（插件不可 import core，只能这样拿） */
    base(className: string): any;
    /** 找一个未被占用的文本存档类型号 */
    freeDumpType(from?: number): number | null;
}

// ── 文档钩子 ────────────────────────────────────────────────────────────────
// 语义：包住 `loader.readCircuit(text)` 与 `app.dumpCircuit()`，让插件能看见并改写存档文本。
// 这两处也是撤销/恢复/粘贴的内部通道，所以每次回调都带 meta.source：

export type ExtHookName = "load" | "save";

export type ExtHookSource = "document" | "undo" | "recovery" | "paste" | "internal";

export interface ExtHookMeta {
    hook: ExtHookName;
    /** `document` = 用户真的在开/存文件，插件应只在这个来源上改写 */
    source: ExtHookSource;
    /** load：readCircuit 的 flags（RC_RETAIN / RC_NO_CENTER / …） */
    flags?: number;
    /** save：dumpCircuit(saveState)，false 表示不含仿真状态的快照 */
    saveState?: boolean;
}

/** 返回字符串 = 用返回值替换文本；返回其它任何值 = 不改动。
 *  ⚠ 改写必须**幂等**（同一段文本过两遍结果相同），否则 保存→打开→保存 会越改越多。 */
export type ExtHookHandler = (text: string, meta: ExtHookMeta) => string | void | null;

/**
 * 事件名（都由 `ctx.on(name, h)` 订阅，需要 "sim.observe"）。
 *
 * | 事件 | payload | 时机 |
 * |---|---|---|
 * | analyze / update / timestep / svgren | 上游回调参数 | 仿真钩子（单槽覆盖原语的多路复用） |
 * | select | `{ count, elms, indices, ids }` | 选中集合变了（用户动作后比对一次，不是每次点击都发） |
 * | elemclick | `{ elm, index, type, grid, screen, button }` | 真的点在某个元件上 |
 * | elemdrag | `{ phase, elms, indices, ids, grid, delta }` | 按下期间元件几何变了；phase = start/move/end |
 * | elementschange | `{ added, removed, count, source }` | elmList 增删（按下标无关的对象身份判定） |
 *
 * 两条使用纪律：
 *   1. `elementschange.source` 要按需过滤 —— 撤销/恢复/载入也走这条路，只有 "pointer"/"ui"/"keyboard"
 *      才是用户真的在改电路；
 *   2. `elemdrag` 是**合并帧**语义（一帧最多一条），不要在里面做重活，也别指望拿到每个像素。
 */
export type ExtEventName =
    | "analyze"
    | "update"
    | "timestep"
    | "svgren"
    | "select"
    | "elemclick"
    | "elemdrag"
    | "elementschange";

export interface ExtPluginContext {
    readonly id: string;
    readonly version: string;
    readonly signal: AbortSignal;
    readonly state: PluginState;
    /** 实际授予的权限（manifest 声明 ∩ 未被站点策略拒绝） */
    readonly permissions: readonly ExtPermission[];
    /** 能力探测：想在缺权限时优雅降级就先问它，别靠 try/catch 摸 */
    permits(permission: ExtPermission): boolean;
    /** 注册清理函数；dispose 时逆序执行 */
    effect(fn: ExtDisposer): ExtDisposer;
    /** 需要 "sim.observe" */
    on(event: ExtEventName, h: (payload?: any) => void): ExtDisposer;
    /** 打开/保存钩子（可改写文本）；需要 "document.hook"。见 ExtHookHandler 的幂等要求 */
    hook(name: ExtHookName, h: ExtHookHandler): ExtDisposer;
    /** 需要 "ui.command" */
    command(cmd: ExtCommand): ExtDisposer;
    /** 需要 "ui.panel" */
    panel(el: HTMLElement, slot?: string): ExtDisposer;
    /** 自定义元件（类/存档类型/菜单一次到位）；需要 "element.register"（带菜单还要 "ui.menu"） */
    element: ExtElementFacet;
    /** 需要 "sim.control"；未声明时**取属性即抛** ExtPermissionError */
    readonly api: any;
    /** 存储按插件 id 隔离，不需要权限 */
    storage: {
        get<T = any>(key: string): T | null;
        set(key: string, value: any): void;
    };
    log(...args: any[]): void;
}

export interface ExtPluginModule {
    name?: string;
    activate(ctx: ExtPluginContext): void | Promise<void>;
    deactivate?(): void | Promise<void>;
}

/**
 * Fiber：一个插件实例的"生命周期容器"。
 * 不变式（见 docs/development-plan.md §3.3）：
 *  1. 激活后所有注册自动绑定到本 fiber；
 *  2. activate 抛错 -> 调用方必须 dispose（无条件 LIFO 回滚）；
 *  3. dispose 后 signal 已 abort，任何后续注册立即执行清理。
 */
export class Fiber {
    readonly ctrl = new AbortController();
    private disposers: ExtDisposer[] = [];
    state: PluginState = "discovered";

    get signal(): AbortSignal {
        return this.ctrl.signal;
    }

    add(d: ExtDisposer): ExtDisposer {
        if (this.state === "disposing" || this.state === "disposed") {
            try { d(); } catch (e) { console.error("[ExtCircuitJS] late dispose failed:", e); }
            return d;
        }
        this.disposers.push(d);
        return d;
    }

    effect(fn: ExtDisposer): ExtDisposer {
        return this.add(fn);
    }

    dispose(): void {
        if (this.state === "disposing" || this.state === "disposed") return;
        this.state = "disposing";
        try { this.ctrl.abort(); } catch { /* noop */ }
        const list = this.disposers.splice(0).reverse();
        for (const d of list) {
            try { d(); } catch (e) { console.error("[ExtCircuitJS] disposer failed:", e); }
        }
        this.state = "disposed";
    }
}

/** 极简拓扑排序：用于 manifest 里的 after/before 依赖（Kahn）。返回 null 表示有环。 */
export function topoSort<T extends { id: string; after?: string[] }>(items: T[]): T[] | null {
    const byId = new Map(items.map((i) => [i.id, i]));
    const indeg = new Map<string, number>();
    const edges = new Map<string, string[]>();
    for (const it of items) {
        indeg.set(it.id, 0);
        edges.set(it.id, []);
    }
    for (const it of items) {
        for (const dep of it.after ?? []) {
            if (!byId.has(dep)) continue;
            edges.get(dep)!.push(it.id);
            indeg.set(it.id, (indeg.get(it.id) ?? 0) + 1);
        }
    }
    const q = items.filter((i) => (indeg.get(i.id) ?? 0) === 0).map((i) => i.id);
    const out: T[] = [];
    while (q.length) {
        const id = q.shift()!;
        out.push(byId.get(id)!);
        for (const next of edges.get(id) ?? []) {
            const d = (indeg.get(next) ?? 0) - 1;
            indeg.set(next, d);
            if (d === 0) q.push(next);
        }
    }
    return out.length === items.length ? out : null;
}
