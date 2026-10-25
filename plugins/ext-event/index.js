// 示例插件（B07）· event：只演示事件订阅（多路复用总线的一个订阅者）。
// analyze 次数写进 ctx.storage（localStorage: ext.plugin.ext-event.analyzes），
// 契约测试触发一次 analyze 后读它验证"订阅确实收到"；退订由 fiber 的 disposer 完成。
export const name = "ext-event";

export async function activate(ctx) {
    ctx.log("activating");

    let analyzes = 0;
    ctx.on("analyze", () => {
        analyzes++;
        ctx.storage.set("analyzes", analyzes);
    });

    ctx.log("activated");
}

export async function deactivate() {
    // 监听由 fiber 的 disposer 退订；无业务级清理
}
