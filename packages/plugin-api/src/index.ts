// @ext/plugin-api — 插件契约（不依赖 cordis；AbortSignal 作为 dispose 原语）
// 语义对齐 cordis 的 fiber/effect/dispose/inject，但实现只有 ~100 行，浏览器/Node 通用。

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

export interface ExtPluginContext {
    readonly id: string;
    readonly version: string;
    readonly signal: AbortSignal;
    readonly state: PluginState;
    /** 注册清理函数；dispose 时逆序执行 */
    effect(fn: ExtDisposer): ExtDisposer;
    on(event: "analyze" | "update" | "timestep" | "svgren", h: (payload?: any) => void): ExtDisposer;
    command(cmd: ExtCommand): ExtDisposer;
    panel(el: HTMLElement, slot?: string): ExtDisposer;
    api: any;
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
