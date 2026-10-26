// Cover 层新增：文档钩子（load / save）—— 插件唯一能"看见并改写存档文本"的地方。
//
// 上游没有打开/保存的扩展点，但所有入口最终都汇到两个方法：
//   · 读：loader.readCircuit(text, flags)   —— 文件、URL、剪贴板、导入、撤销、子电路全走这里
//   · 写：app.dumpCircuit(saveState)        —— 保存、导出文本/URL、撤销快照、崩溃恢复全走这里
// 所以只包这两个方法就能覆盖全路径；代价是它们**不是**"用户动作"语义，
// 撤销、恢复、粘贴也会经过。于是再给调用来源打标（meta.source）：
//   document  用户开/存文件（默认值，也是插件唯一该改写的时机）
//   undo      撤销/重做（dumpCircuit + readCircuit 都会被调用）
//   recovery  崩溃恢复的定时落盘与读取
//   paste     粘贴（RC_RETAIN 部分读入）
//   internal  宿主内部比较（isModified）与编辑上下文恢复（popContext）
//
// 两条纪律（写在 ctx.hook 的类型注释里，也是示例插件的写法）：
//   1. 只在 meta.source === "document" 时改写；否则撤销一类的内部往返会被反复改写；
//   2. 改写函数必须幂等 —— 同一段文本过两遍结果相同（保存→再打开→再保存 不会越改越多）。

export type ExtHookName = "load" | "save";

export type ExtHookSource = "document" | "undo" | "recovery" | "paste" | "internal";

export interface ExtHookMeta {
    hook: ExtHookName;
    source: ExtHookSource;
    /** load：CircuitLoader 的 readCircuit flags（RC_RETAIN / RC_NO_CENTER / …） */
    flags?: number;
    /** save：dumpCircuit(saveState)，false 表示不含仿真状态的快照 */
    saveState?: boolean;
}

/** 返回字符串 = 用返回值替换文本；返回其它任何值 = 不改（undefined/null/void） */
export type ExtHookHandler = (text: string, meta: ExtHookMeta) => string | void | null;

export class ExtHooks {
    private handlers = new Map<ExtHookName, Set<ExtHookHandler>>();
    /** 每个钩子的重入深度：处理器自己触发同类调用（如 save 里再 dumpCircuit）时不再套娃 */
    private busy: Record<ExtHookName, number> = { load: 0, save: 0 };
    private src: ExtHookSource = "document";
    /** 载入**完成**后的旁观者（宿主内部用：ExtBoot 拿它同步元件事件），拿不到也改不了文本 */
    private afterLoadSet = new Set<(meta: ExtHookMeta) => void>();
    private loadDepth = 0;
    private loadSrc: ExtHookSource = "document";

    get source(): ExtHookSource {
        return this.src;
    }

    on(name: ExtHookName, h: ExtHookHandler): () => void {
        let set = this.handlers.get(name);
        if (!set) {
            set = new Set();
            this.handlers.set(name, set);
        }
        set.add(h);
        let live = true;
        return () => {
            if (!live) return;
            live = false;
            const s = this.handlers.get(name);
            if (s) s.delete(h);
        };
    }

    /** 在执行 fn 期间把来源标成 src（同步语义；只用于包住一次入口调用） */
    withSource<T>(src: ExtHookSource, fn: () => T): T {
        const prev = this.src;
        this.src = src;
        try {
            return fn();
        } finally {
            this.src = prev;
        }
    }

    /** 依次跑处理器，串成一条加工链；单个处理器抛错只记日志，绝不阻断开/存文档 */
    run(name: ExtHookName, text: string, extra: { flags?: number; saveState?: boolean } = {}): string {
        const set = this.handlers.get(name);
        if (!set || set.size === 0) return text;
        if (this.busy[name] > 0) return text;
        this.busy[name]++;
        const meta: ExtHookMeta = { hook: name, source: this.src, ...extra };
        let cur = text;
        try {
            for (const h of Array.from(set)) {
                try {
                    const out = h(cur, meta);
                    if (typeof out === "string" && out !== cur) cur = out;
                } catch (e) {
                    console.error(`[ExtCircuitJS] hook "${name}" handler failed:`, e);
                }
            }
        } finally {
            this.busy[name]--;
        }
        return cur;
    }

    /** 只用于测试/诊断 */
    count(name?: ExtHookName): number {
        if (name) return this.handlers.get(name)?.size ?? 0;
        let n = 0;
        for (const s of this.handlers.values()) n += s.size;
        return n;
    }

    /**
     * 载入**完成后**的通知（不改文本、没有 ctx 入口，只给宿主自己用）。
     * 为什么要它：`readCircuit` 返回时 elmList 已经被整体重建，但这是普通方法调用，
     * 宿主之外没有任何可观察点 —— 元件事件（elementschange）需要在这里补一次同步。
     * 只在外层载入结束时触发一次（子电路/嵌套载入不会连发），meta.source 取**进入时**的来源。
     */
    afterLoad(h: (meta: ExtHookMeta) => void): () => void {
        this.afterLoadSet.add(h);
        let live = true;
        return () => {
            if (!live) return;
            live = false;
            this.afterLoadSet.delete(h);
        };
    }

    /** 记录一次载入开始（由 wireAppHooks 的包装调用；返回本次载入的层级） */
    noteLoadStart(): number {
        if (this.loadDepth === 0) this.loadSrc = this.src;
        return ++this.loadDepth;
    }

    /** 记录一次载入结束；最外层结束时才通知 afterLoad */
    noteLoadEnd(flags?: number): void {
        if (this.loadDepth > 0) this.loadDepth--;
        if (this.loadDepth > 0) return;
        if (this.afterLoadSet.size === 0) return;
        const meta: ExtHookMeta = { hook: "load", source: this.loadSrc, flags };
        for (const h of Array.from(this.afterLoadSet)) {
            try {
                h(meta);
            } catch (e) {
                console.error("[ExtCircuitJS] afterLoad handler failed:", e);
            }
        }
    }

    clear(): void {
        this.handlers.clear();
        this.afterLoadSet.clear();
    }
}

/**
 * 把宿主实例方法接上钩子总线。只包**实例**（不动原型），返回 disposer 供热重载/关站回滚。
 *
 * 说明：`app.isModified()` 内部会 dumpCircuit(false) 做文本比较，`pushUndo` 也会 dumpCircuit，
 * 若不标来源，插件每按一次键都会收到一次"保存"。标了之后插件按 source 过滤即可。
 */
export function wireAppHooks(app: any, hooks: ExtHooks): () => void {
    const restore: (() => void)[] = [];

    const loader = app?.loader;
    if (loader && typeof loader.readCircuit === "function") {
        const raw = loader.readCircuit;
        const wrapped = function (this: any, text: string, flags: number = 0) {
            // 非字符串输入（极少见：上游可能传 null）原样透传，别让钩子把加载搞坏
            if (typeof text !== "string") return raw.call(this, text, flags);
            hooks.noteLoadStart();
            try {
                return raw.call(this, hooks.run("load", text, { flags }), flags);
            } finally {
                // 载入完成：此刻 elmList 已经重建好，元件事件可以据此同步（见 afterLoad）
                hooks.noteLoadEnd(flags);
            }
        };
        loader.readCircuit = wrapped;
        restore.push(() => { loader.readCircuit = raw; });
    }

    if (typeof app?.dumpCircuit === "function") {
        const raw = app.dumpCircuit;
        const wrapped = function (this: any, saveState: boolean = true) {
            const dump = raw.call(this, saveState);
            if (typeof dump !== "string") return dump;
            return hooks.run("save", dump, { saveState });
        };
        app.dumpCircuit = wrapped;
        restore.push(() => { app.dumpCircuit = raw; });
    }

    const label = (obj: any, method: string, src: ExtHookSource) => {
        if (!obj || typeof obj[method] !== "function") return;
        const raw = obj[method];
        obj[method] = function (this: any, ...args: any[]) {
            return hooks.withSource(src, () => raw.apply(this, args));
        };
        restore.push(() => { obj[method] = raw; });
    };

    const um = app?.undoManager;
    label(um, "pushUndo", "undo");
    label(um, "doUndo", "undo");
    label(um, "doRedo", "undo");
    label(um, "writeRecoveryToStorage", "recovery");
    label(um, "readRecovery", "recovery");
    label(um, "doRecover", "recovery");
    label(app, "isModified", "internal");
    label(app, "popContext", "internal");
    label(app?.commands, "doPaste", "paste");

    return () => {
        for (const r of restore.reverse()) r();
        restore.length = 0;
    };
}
