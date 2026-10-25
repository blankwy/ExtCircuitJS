// 示例插件（B07）· command：只演示命令插槽。
// run() 把执行次数写进 ctx.storage（localStorage: ext.plugin.ext-command.pings），
// 契约测试用它验证命令不仅"在册"而且"可执行"；撤销由 ctx.command 的 disposer 完成。
export const name = "ext-command";

export async function activate(ctx) {
    ctx.log("activating");

    let pings = 0;
    ctx.command({
        id: "ext.command.ping",
        label: "Ext Command: Ping",
        category: "Ext",
        keywords: "extension demo command ping",
        run() {
            pings++;
            ctx.storage.set("pings", pings);
            ctx.log(`ping #${pings}`);
        },
    });

    ctx.log("activated");
}

export async function deactivate() {
    // 命令由 fiber 的 disposer 撤销；无业务级清理
}
