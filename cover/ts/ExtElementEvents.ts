// Cover 层新增：元件交互事件（select / elemclick）。
//
// 上游没有"选中了什么"的事件：选择状态只是每个 CircuitElm 上的一个布尔位，
// 改它的地方散落在 MouseManager、CommandManager（全选/删除）、UndoManager、菜单里。
// 挨个包方法既易漏又绑死上游私有方法名，所以这里改成**旁观式**：
// 在画布/键盘上听用户的动作，动作结束后比对一次"选中集合"的指纹，变了才发事件。
//
// 指纹 = 选中元件在 elmList 里的下标序列。这样：
//   · 不依赖任何 core 私有方法（上游改内部实现不影响）；
//   · 无论选择是谁改的（框选、全选、撤销、插件自己改），都在下一次用户动作时同步；
//   · 鼠标拖动时每个 pointer 事件只调度一次 rAF，代价与帧率同阶，不会 O(n) 风暴。

import type { ExtEvents } from "./ExtEvents";

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

export interface ElementEventWiring {
    /** 主动比对一次（插件自己改了选择、或测试里直接 setSelected 后调用） */
    refresh(): void;
    dispose(): void;
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
    return { count: elms.length, elms, indices, ids };
}

export function wireElementEvents(app: any, events: ExtEvents): ElementEventWiring {
    const cv: HTMLCanvasElement | null = app?.ui?.cv ?? null;
    const noop: ElementEventWiring = { refresh: () => {}, dispose: () => {} };
    if (!cv || typeof cv.addEventListener !== "function") return noop;

    // 初始指纹取当前状态：启动那一刻不该凭空发一条"选择清空"
    let lastSig = selectionOf(app).indices.join(",");
    let disposed = false;
    let scheduled = false;

    const flush = () => {
        scheduled = false;
        if (disposed) return;
        let sel: ExtSelectionPayload;
        try {
            sel = selectionOf(app);
        } catch {
            return; // 电路正在重建，下次动作再同步
        }
        const sig = sel.indices.join(",");
        if (sig === lastSig) return;
        lastSig = sig;
        events.emit("select", sel);
    };

    const schedule = () => {
        if (disposed || scheduled) return;
        scheduled = true;
        // rAF 在隐藏标签页会停摆；兜底 setTimeout 保证事件不丢
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => { if (scheduled) flush(); });
            setTimeout(() => { if (scheduled) flush(); }, 100);
        } else {
            setTimeout(flush, 0);
        }
    };

    // 画布上任何可能改变选择/元件表的动作（注册顺序保证在 core 的处理器之后跑）
    const onUp = () => schedule();
    const onDown = () => schedule();
    const onKey = () => schedule();
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
            type: elm?.getClassName?.() ?? "Unknown",
            grid,
            screen,
            button: e.button,
        } satisfies ExtElementClickPayload);
    };

    cv.addEventListener("mousedown", onDown);
    cv.addEventListener("mouseup", onUp);
    cv.addEventListener("click", onClick);
    // 键盘全选（Ctrl/Cmd+A）、删除、撤销都要同步；document 级最稳
    document.addEventListener("keyup", onKey);

    return {
        refresh: () => flush(),
        dispose() {
            if (disposed) return;
            disposed = true;
            cv.removeEventListener("mousedown", onDown);
            cv.removeEventListener("mouseup", onUp);
            cv.removeEventListener("click", onClick);
            document.removeEventListener("keyup", onKey);
        },
    };
}
