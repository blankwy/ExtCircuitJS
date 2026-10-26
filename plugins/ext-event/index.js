// 示例插件（B07）· event：只演示事件订阅（多路复用总线的一个订阅者）。
//
// 三个订阅各演示一种"该在什么粒度上干活"：
//   analyze        仿真每步都会来 —— 只累加计数
//   elementschange 元件增删 —— 记一条摘要；**必须看 source**（撤销/载入/粘贴也走这条路）
//   elemdrag       一帧最多一条 —— 只在 phase === "end" 落盘，拖动过程中不做任何重活
//
// 契约测试读这几个 key：ext.plugin.ext-event.{analyzes,lastChange,lastDrag}
export const name = "ext-event";

export async function activate(ctx) {
    ctx.log("activating");

    let analyzes = 0;
    ctx.on("analyze", () => {
        analyzes++;
        ctx.storage.set("analyzes", analyzes);
    });

    ctx.on("elementschange", (p) => {
        ctx.storage.set("lastChange", {
            source: p.source,
            added: p.added.map((r) => r.type),
            removed: p.removed.map((r) => r.type),
            count: p.count,
        });
    });

    ctx.on("elemdrag", (p) => {
        // 拖动过程每帧都来；只关心结束时的最终位移
        if (p.phase !== "end") return;
        ctx.storage.set("lastDrag", { ids: p.ids, delta: p.delta });
    });

    ctx.log("activated");
}

export async function deactivate() {
    // 监听由 fiber 的 disposer 退订；无业务级清理
}
