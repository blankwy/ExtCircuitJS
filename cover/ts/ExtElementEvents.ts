// Cover 层新增：元件交互事件（select / elemclick / elemdrag / elementschange）。
//
// 上游没有"选中了什么"或"元件表变了"的事件：选择状态只是每个 CircuitElm 上的一个布尔位，
// 元件表就是 UIManager 的一个裸数组（`elmList.push/splice` 散落在 MouseManager、
// CommandManager、CircuitLoader、WireConverter、WireElm、ScopeManager 里）。
// 挨个包方法既易漏又绑死上游私有方法名，所以这里改成**旁观式**：
// 在用户能动作的地方听事件，动作结束后比对一次指纹，变了才发事件。
//
// 两种指纹：
//   · 选择指纹 = 选中元件在 elmList 里的下标序列 → select
//   · 结构指纹 = elmList 的**对象身份**集合（不按下标：删中间一个元件会让后面全体错位）
//     → elementschange（added / removed，带最后已知下标）；纯换序不算变化
//   · 几何指纹 = 每个元件的 `x,y,x2,y2` → elemdrag（按下期间坐标变了就是在拖）
//
// 这样：
//   · 不依赖任何 core 私有方法（上游改内部实现不影响）；
//   · 无论变化是谁造成的（框选、全选、撤销、菜单、载入、插件自己改），下一次触发点就同步；
//   · 鼠标移动只做 O(n) 指纹比对并合并到 rAF，代价与帧率同阶，不会按 mousemove 次数发事件。
//
// 触发点（都必须保留，删一个就会漏一类变更）：
//   canvas mousedown/mouseup/move/click  编辑、拖元件、拖工具栏
//   document mousedown/mouseup/click     任何 DOM 交互（菜单项、对话框按钮、工具栏按钮）
//   document keyup                       键盘删除/撤销/粘贴/全选
//   after load（ExtHooks.afterLoad）      载入电路/示例/URL/恢复 —— 载入后 elmList 被整体重建
//   refresh()                            插件或外部脚本自己改完后手动同步
//
// 已知边界（写在这里，免得下一个人以为漏了）：
//   · 定时器/自动恢复（undoManager 的内部轮询）不会触发比对 —— 它不是用户动作；
//   · 拖动结束那一刻上游可能已经把导线重划分为新对象（`draggingDone`），所以 end 帧报的是
//     "本次拖动中动过的元件"，其中可能有不在此刻 elmList 里的实例；
//   · 只有几何真的变了才发 elemdrag：新建元件（预览元件不在 elmList 里）走 elementschange。

import type { ExtEvents } from "./ExtEvents";

/** 变化来源：与 ctx.hook 的 meta.source 同一套词汇（document → load），外加指针/键盘/UI 三类用户动作 */
export type ExtElementChangeSource =
    | "pointer"
    | "ui"
    | "keyboard"
    | "load"
    | "paste"
    | "undo"
    | "recovery"
    | "internal"
    | "manual";

export interface ExtSelectionPayload {
    count: number;
    /** 选中的元件实例（CircuitElm），顺序 = elmList 顺序 */
    elms: any[];
    /** 对应 elmList 下标 */
    indices: number[];
    /** 稳定 id（`c<index>`），与 api.listComponents() 同一套编号 */
    ids: string[];
}

export interface ExtElementClickPayload {
    elm: any;
    index: number;
    type: string;
    /** 电路坐标（格点） */
    grid: { x: number; y: number };
    /** 画布坐标（像素，相对画布左上角） */
    screen: { x: number; y: number };
    button: number;
}

/** 元件引用：`index`/`id` 都是**相对当前 elmList** 的（removed 的是移除前最后已知下标） */
export interface ExtElementRef {
    index: number;
    id: string;
    type: string;
    elm: any;
}

export interface ExtElementsChangePayload {
    added: ExtElementRef[];
    removed: ExtElementRef[];
    /** 变更后的元件总数 */
    count: number;
    source: ExtElementChangeSource;
}

export interface ExtElementDragPayload {
    phase: "start" | "move" | "end";
    /** 本次拖动中几何发生变化的元件（此刻仍在 elmList 里的） */
    elms: any[];
    indices: number[];
    ids: string[];
    /** 指针当前格点（已取整） */
    grid: { x: number; y: number };
    /** 相对按下的格点位移（已取整） */
    delta: { x: number; y: number };
}

export interface ElementEventWiring {
    /** 主动比对一次（插件自己改了电路/选择、或测试里直接改完 elmList 后调用） */
    refresh(source?: ExtElementChangeSource): void;
    dispose(): void;
}

// ── 纯函数部分（无 DOM 依赖，Node 契约直接测这几个）────────────────────────────

export function elementType(elm: any): string {
    try {
        const name = elm?.getClassName?.();
        if (typeof name === "string" && name) return name;
    } catch { /* 元件半构造状态下 getClassName 可能抛 */ }
    const ctor = elm?.constructor?.name;
    // 裸对象（{}/null）的构造函数名是 "Object"，对插件没有信息量，别把它当类型名报出去
    return typeof ctor === "string" && ctor && ctor !== "Object" ? ctor : "Unknown";
}

/** elmList → 元件引用（id 与 api.listComponents 同源：`c<index>`） */
export function refsOf(list: any[]): ExtElementRef[] {
    const out: ExtElementRef[] = [];
    for (let i = 0; i < list.length; i++) out.push({ index: i, id: `c${i}`, type: elementType(list[i]), elm: list[i] });
    return out;
}

/**
 * 按**对象身份**比对两份 elmList。
 * 不按下标比对：删掉中间一个元件会让后面全体下标 -1，按下标会报成"全删全加"。
 * 纯换序（同一批对象、顺序不同）不算变化 —— 结构没变，只是叠放次序变了。
 */
export function diffElementLists(
    prev: any[],
    cur: any[],
): { added: ExtElementRef[]; removed: ExtElementRef[] } {
    const before = new Set(prev);
    const after = new Set(cur);
    const added: ExtElementRef[] = [];
    const removed: ExtElementRef[] = [];
    for (let i = 0; i < cur.length; i++) {
        if (!before.has(cur[i])) added.push({ index: i, id: `c${i}`, type: elementType(cur[i]), elm: cur[i] });
    }
    for (let i = 0; i < prev.length; i++) {
        if (!after.has(prev[i])) removed.push({ index: i, id: `c${i}`, type: elementType(prev[i]), elm: prev[i] });
    }
    return { added, removed };
}

function coord(v: any): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function geoOf(elm: any): string {
    return `${coord(elm?.x)},${coord(elm?.y)},${coord(elm?.x2)},${coord(elm?.y2)}`;
}

/** 几何快照：元件实例 → `x,y,x2,y2`（拖动判定的基线） */
export function geometrySnapshot(list: any[]): Map<any, string> {
    const map = new Map<any, string>();
    for (const elm of list) map.set(elm, geoOf(elm));
    return map;
}

/** 相对快照动过的元件（快照里没有的新元件不算：那是"新建"不是"拖动"） */
export function movedSince(snap: Map<any, string>, list: any[]): any[] {
    const out: any[] = [];
    for (const elm of list) {
        const before = snap.get(elm);
        if (before === undefined) continue;
        if (geoOf(elm) !== before) out.push(elm);
    }
    return out;
}

function selectionOf(app: any): ExtSelectionPayload {
    const elms: any[] = [];
    const indices: number[] = [];
    const ids: string[] = [];
    const list: any[] = app?.elmList ?? [];
    for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e && typeof e.isSelected === "function" && e.isSelected()) {
            elms.push(e);
            indices.push(i);
            ids.push(`c${i}`);
        }
    }
    return { count: elms.length, indices, elms, ids };
}

// ── 接线 ────────────────────────────────────────────────────────────────────

export function wireElementEvents(app: any, events: ExtEvents): ElementEventWiring {
    const cv: HTMLCanvasElement | null = app?.ui?.cv ?? null;
    const noop: ElementEventWiring = { refresh: () => {}, dispose: () => {} };
    if (!cv || typeof cv.addEventListener !== "function") return noop;
    const hasDoc = typeof document !== "undefined" && typeof document.addEventListener === "function";

    // 初始指纹取当前状态：启动那一刻不该凭空发一条"选择清空"或"全部新增"
    let prevSel = selectionOf(app).indices.join(",");
    let prevList: any[] = [...(app?.elmList ?? [])];
    let disposed = false;
    let scheduled = false;
    let pending: ExtElementChangeSource = "manual";

    // 拖动状态：按下时打快照，移动时比对几何
    let drag: { snap: Map<any, string>; grid: { x: number; y: number }; moved: Set<any>; emitted: boolean } | null = null;
    let dragScheduled = false;
    let pointer = { x: 0, y: 0 };

    const gridAt = (): { x: number; y: number } => {
        try {
            const rect = cv.getBoundingClientRect();
            return {
                x: Math.round(app.mouse.inverseTransformX(pointer.x - rect.left)),
                y: Math.round(app.mouse.inverseTransformY(pointer.y - rect.top)),
            };
        } catch {
            return { x: 0, y: 0 }; // 坐标只作参考，取不到不影响事件本身
        }
    };
    const onCanvas = (target: any): boolean => target === cv || (typeof cv.contains === "function" && cv.contains(target));

    const emitDrag = (state: NonNullable<typeof drag>, phase: ExtElementDragPayload["phase"]) => {
        const list: any[] = app?.elmList ?? [];
        const elms: any[] = [];
        const indices: number[] = [];
        for (let i = 0; i < list.length; i++) {
            if (state.moved.has(list[i])) {
                elms.push(list[i]);
                indices.push(i);
            }
        }
        const grid = gridAt();
        events.emit("elemdrag", {
            phase,
            elms,
            indices,
            ids: indices.map((i) => `c${i}`),
            grid,
            delta: { x: grid.x - state.grid.x, y: grid.y - state.grid.y },
        } satisfies ExtElementDragPayload);
    };

    /**
     * 结构比对（**同步**）。调用点必须选在"上游已经把改动做完"之后，source 才不会张冠李戴：
     *   · 画布上：我们的监听器在 core 的处理器之后注册，所以 mouseup/click 回调里已经是最终状态；
     *   · 键盘：删除/撤销都在 keydown 里做，keyup 时必然已完成；
     *   · 菜单/工具栏：动作跑在目标元素的 click 里，捕获阶段看不到 → 用 0ms 定时器排到派发之后。
     * 不用 rAF 合并：结构变化是离散动作，同步判定既准又便宜（O(n) 身份比对）。
     */
    const checkStructure = (source: ExtElementChangeSource) => {
        if (disposed) return;
        let list: any[];
        try {
            list = [...(app?.elmList ?? [])];
        } catch {
            return; // 电路正在重建，下次触发点再比对
        }
        const change = diffElementLists(prevList, list);
        prevList = list;
        if (change.added.length === 0 && change.removed.length === 0) return;
        events.emit("elementschange", {
            added: change.added,
            removed: change.removed,
            count: list.length,
            source,
        } satisfies ExtElementsChangePayload);
    };

    /** 选择比对（合并到一帧）：按下和松开常常连着发生，逐条发会把"点一下"拆成两条 select */
    const flushSelection = () => {
        scheduled = false;
        if (disposed) return;
        let sel: ExtSelectionPayload;
        try {
            sel = selectionOf(app);
        } catch {
            return;
        }
        const sig = sel.indices.join(",");
        if (sig === prevSel) return;
        prevSel = sig;
        events.emit("select", sel);
    };

    const scheduleSelection = () => {
        if (disposed || scheduled) return;
        scheduled = true;
        // rAF 在隐藏标签页会停摆；兜底 setTimeout 保证事件不丢
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => { if (scheduled) flushSelection(); });
            setTimeout(() => { if (scheduled) flushSelection(); }, 100);
        } else {
            setTimeout(() => { if (scheduled) flushSelection(); }, 0);
        }
    };

    // ── 画布：编辑动作 ──────────────────────────────────────────────────────
    const onDown = (e: MouseEvent) => {
        pointer = { x: e.clientX, y: e.clientY };
        if (e.button !== 2) {
            // 右键在 core 里是菜单，不参与拖动；左键/中键按下就打几何基线
            drag = {
                snap: geometrySnapshot(app?.elmList ?? []),
                grid: gridAt(),
                moved: new Set(),
                emitted: false,
            };
        }
        scheduleSelection();
    };
    /** 结束一次拖动（可能在画布上松手，也可能拖到画布外松手 —— 两处都调，drag 判空去重） */
    const endDrag = (e: MouseEvent) => {
        pointer = { x: e.clientX, y: e.clientY };
        if (!drag) return;
        const state = drag;
        drag = null;
        dragScheduled = false; // 让待发的 rAF 失效，避免 end 之后再补一条 move
        if (state.moved.size === 0) return;
        // 极短的拖动可能一帧都没发出去：补一条 start，保证 start/end 成对
        if (!state.emitted) {
            state.emitted = true;
            emitDrag(state, "start");
        }
        emitDrag(state, "end");
    };
    const onUp = (e: MouseEvent) => {
        endDrag(e);
        scheduleSelection();
        checkStructure("pointer");
    };
    const onMove = (e: MouseEvent) => {
        if (disposed || !drag) return;
        pointer = { x: e.clientX, y: e.clientY };
        const moved = movedSince(drag.snap, app?.elmList ?? []);
        if (moved.length === 0) return;
        for (const elm of moved) drag.moved.add(elm);
        if (dragScheduled) return;
        dragScheduled = true;
        const fire = () => {
            if (!dragScheduled) return;
            dragScheduled = false;
            if (disposed || !drag) return;
            const phase = drag.emitted ? "move" : "start";
            drag.emitted = true;
            emitDrag(drag, phase);
        };
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(fire);
            setTimeout(fire, 100);
        } else {
            setTimeout(fire, 0);
        }
    };
    const onClick = (e: MouseEvent) => {
        if (disposed) return;
        const elm = app?.mouse?.mouseElm ?? null;
        if (!elm) return;
        const list: any[] = app?.elmList ?? [];
        const index = list.indexOf(elm);
        if (index < 0) return; // 悬停到的不在元件表里（如拖动预览元件）
        let screen = { x: 0, y: 0 };
        let grid = { x: 0, y: 0 };
        try {
            const rect = cv.getBoundingClientRect();
            screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            grid = { x: app.mouse.inverseTransformX(screen.x), y: app.mouse.inverseTransformY(screen.y) };
        } catch { /* 坐标只作参考，取不到也不影响主事件 */ }
        events.emit("elemclick", {
            elm,
            index,
            type: elementType(elm),
            grid,
            screen,
            button: e.button,
        } satisfies ExtElementClickPayload);
    };

    // ── 文档级：菜单 / 工具栏 / 对话框 / 键盘 ────────────────────────────────
    // 工具栏拖放建元件走的是 document 上的 mousemove/mouseup（MouseManager.register），
    // 菜单项的动作跑在 click 里 —— 这两种都可能既不在画布上、也不产生 keyup。
    const onDocUp = (e: MouseEvent) => {
        // 冒泡阶段：此刻 core 的 canvas mouseup 已经跑完（draggingDone 把导线重划过了），
        // 所以这里收尾既能拿到"最终几何"，也能覆盖"拖到画布外才松手"的情况
        endDrag(e);
        if (onCanvas(e.target)) return; // 画布上的已由 onUp 处理
        scheduleSelection();
        checkStructure("ui");
    };
    const onDocClick = (e: MouseEvent) => {
        // 捕获阶段：菜单项的 click 处理器可能会 stopPropagation，只有捕获才一定收得到。
        // 但此刻目标元素的处理器还没跑，所以结构比对要排到派发之后（0ms 定时器）。
        if (onCanvas(e.target)) return;
        scheduleSelection();
        setTimeout(() => checkStructure("ui"), 0);
    };
    const onKey = () => {
        scheduleSelection();
        checkStructure("keyboard");
    };

    cv.addEventListener("mousedown", onDown);
    cv.addEventListener("mouseup", onUp);
    cv.addEventListener("mousemove", onMove);
    cv.addEventListener("click", onClick);
    if (hasDoc) {
        document.addEventListener("mouseup", onDocUp);
        document.addEventListener("click", onDocClick, true);
        document.addEventListener("keyup", onKey);
    }

    return {
        refresh: (source: ExtElementChangeSource = "manual") => {
            checkStructure(source);
            flushSelection();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            drag = null;
            cv.removeEventListener("mousedown", onDown);
            cv.removeEventListener("mouseup", onUp);
            cv.removeEventListener("mousemove", onMove);
            cv.removeEventListener("click", onClick);
            if (hasDoc) {
                // ⚠ 移除时 capture 标志必须与注册时一致，否则监听器会留在 document 上
                document.removeEventListener("mouseup", onDocUp);
                document.removeEventListener("click", onDocClick, true);
                document.removeEventListener("keyup", onKey);
            }
        },
    };
}
