// Cover 层新增：多路复用事件总线。
// 上游的 window.CircuitJS1.onanalyze 等是**单槽覆盖式**（谁后写谁生效），
// 多插件共存必须由宿主维护订阅表（见 docs/spikes/plugin-runtime.md 六条不变式）。

export type ExtEventName =
    | "analyze"
    | "update"
    | "timestep"
    | "svgren"
    // 元件交互（由 ExtElementEvents 旁观画布产生，见该文件头注释）
    | "select"
    | "elemclick";

type Handler = (payload?: any) => void;

export class ExtEvents {
    private map = new Map<ExtEventName, Set<Handler>>();

    on(name: ExtEventName, h: Handler): () => void {
        let set = this.map.get(name);
        if (!set) {
            set = new Set();
            this.map.set(name, set);
        }
        set.add(h);
        return () => {
            const s = this.map.get(name);
            if (s) s.delete(h);
        };
    }

    emit(name: ExtEventName, payload?: any): void {
        const set = this.map.get(name);
        if (!set) return;
        for (const h of Array.from(set)) {
            try {
                h(payload);
            } catch (e) {
                // 插件回调隔离：一个插件抛错不得中断宿主回调链与仿真
                console.error(`[ExtCircuitJS] event "${name}" handler failed:`, e);
            }
        }
    }

    /** 只用于测试/卸载诊断 */
    count(name?: ExtEventName): number {
        if (name) return this.map.get(name)?.size ?? 0;
        let n = 0;
        for (const s of this.map.values()) n += s.size;
        return n;
    }

    clear(): void {
        this.map.clear();
    }
}

/**
 * 把宿主实例方法包装成事件源。
 * 只包装**实例**，不动原型（避免污染同类实例）；返回 disposer 以便热重载回滚。
 */
export function wireAppEvents(app: any, events: ExtEvents): () => void {
    const ji = app?.jsInterface;
    if (!ji) return () => {};
    const pairs: [string, ExtEventName][] = [
        ["callAnalyzeHook", "analyze"],
        ["callUpdateHook", "update"],
        ["callTimeStepHook", "timestep"],
        ["callSVGRenderedHook", "svgren"],
    ];
    const restore: (() => void)[] = [];
    for (const [method, name] of pairs) {
        if (typeof ji[method] !== "function") continue;
        const orig = ji[method].bind(ji);
        ji[method] = (arg?: any) => {
            events.emit(name, arg);
            return orig(arg);
        };
        restore.push(() => { ji[method] = orig; });
    }
    return () => {
        for (const r of restore.reverse()) r();
    };
}
