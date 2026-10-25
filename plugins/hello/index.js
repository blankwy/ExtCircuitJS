// 示例插件：验证 activate / 命令 / 面板 / 事件 / 卸载
// 约定：插件只使用 ctx，不直接 import core 内部模块。
export const name = "hello";

export async function activate(ctx) {
    ctx.log("activating");

    const el = document.createElement("div");
    el.className = "ext-plugin-hello";
    el.style.cssText = [
        "margin:6px 0", "padding:6px 8px", "border:1px solid #4a5568", "border-radius:6px",
        "font:12px/1.5 system-ui, sans-serif", "color:#e2e8f0", "background:#1a202c",
    ].join(";");
    el.textContent = "ExtCircuitJS · hello";
    // ctx.panel 的 disposer 会自动把节点从侧栏移除
    ctx.panel(el);

    let analyzes = 0;
    ctx.on("analyze", () => {
        analyzes++;
        const n = ctx.api.listComponents().length;
        el.textContent = `ExtCircuitJS · hello｜analyze #${analyzes}｜${n} components`;
    });

    ctx.command({
        id: "ext.hello.poke",
        label: "Hello: Poke",
        category: "Ext",
        keywords: "extension demo hello",
        run() {
            const t = ctx.api.getTime();
            ctx.log(`poke t=${t.toFixed(6)} components=${ctx.api.listComponents().length}`);
            ctx.api.applyOps([{ op: "set", target: "c0", prop: "resistance", value: 1000 }]);
        },
    });

    ctx.log("activated");
}

export async function deactivate() {
    // 所有注册（面板/命令/监听）由 fiber 自动释放；这里只放业务级清理
}
