// 示例插件（B07）· panel：只演示面板插槽。
// 约定同 hello：只用 ctx，不直接 import core 内部模块。
// ctx.panel 的 disposer 已进 fiber，deactivate 时自动把节点从侧栏移除。
export const name = "ext-panel";

export async function activate(ctx) {
    ctx.log("activating");

    const el = document.createElement("div");
    el.dataset.extPlugin = "ext-panel";
    el.className = "ext-plugin-panel";
    el.style.cssText = [
        "margin:6px 0", "padding:6px 8px", "border:1px solid #4a5568", "border-radius:6px",
        "font:12px/1.5 system-ui, sans-serif", "color:#e2e8f0", "background:#1a202c",
    ].join(";");
    el.textContent = "ExtCircuitJS · ext-panel";
    ctx.panel(el);

    ctx.log("activated");
}

export async function deactivate() {
    // 面板节点由 fiber 的 disposer 移除；无业务级清理
}
