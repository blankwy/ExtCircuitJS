// ext-neumorph —— 新拟态（Neumorphism）UI 主题插件
//
// 参考风格：浅灰同色系底（#e0e5ec）、柔和外阴影 + 高光内阴影的"浮雕"按钮、
// 大圆角卡片。只改样式（背景/阴影/圆角/描边），不改任何布局与元素位置。
//
// 实现：html 上挂 .ext-neumorph 类 + 注入一段覆盖 CSS（选择器带 !important
// 压过 core 的硬编码色）。画布联动：新拟态是浅色系，activate 时把 core 的
// White Background 打开（黑画布与新拟态不搭），deactivate 时恢复原状。
//
// 开关：在【选项】菜单追加【新拟态样式】项；状态记忆 localStorage（ext.neumorph）。

const STYLE_ID = "ext-neumorph-style";
const KEY = "ext.neumorph";

const CSS = `
html.ext-neumorph body { background: #e0e5ec !important; }
html.ext-neumorph .topButton,
html.ext-neumorph button {
  background: linear-gradient(145deg, #e6ebf2, #d6dbe2) !important;
  border: none !important;
  border-radius: 10px !important;
  box-shadow: 5px 5px 10px #b8bdc7, -5px -5px 10px #ffffff !important;
  color: #3d4a5c !important;
  transition: box-shadow .15s ease;
}
html.ext-neumorph .topButton:hover,
html.ext-neumorph button:hover {
  box-shadow: inset 4px 4px 8px #b8bdc7, inset -4px -4px 8px #ffffff !important;
}
html.ext-neumorph .menuDropdown {
  background: #e0e5ec !important;
  border: none !important;
  border-radius: 14px !important;
  box-shadow: 12px 12px 24px #b8bdc7, -12px -12px 24px #ffffff !important;
  padding: 6px !important;
}
html.ext-neumorph .gwt-MenuItem {
  background: transparent !important;
  border-radius: 8px !important;
  color: #3d4a5c !important;
}
html.ext-neumorph .gwt-MenuItem:hover { background: #d3d9e2 !important; }
html.ext-neumorph .gwt-DialogBox {
  background: #e0e5ec !important;
  border: none !important;
  border-radius: 16px !important;
  box-shadow: 16px 16px 32px #b8bdc7, -16px -16px 32px #ffffff !important;
}
html.ext-neumorph select, html.ext-neumorph input[type="text"], html.ext-neumorph input[type="number"] {
  background: #e0e5ec !important;
  border: none !important;
  border-radius: 8px !important;
  box-shadow: inset 3px 3px 6px #b8bdc7, inset -3px -3px 6px #ffffff !important;
  color: #3d4a5c !important;
}
html.ext-neumorph #painel > div,
html.ext-neumorph [data-ext-plugin] {
  background: #e0e5ec !important;
  border: none !important;
  border-radius: 12px !important;
  box-shadow: 6px 6px 12px #b8bdc7, -6px -6px 12px #ffffff !important;
  color: #3d4a5c !important;
}
`;

let styleEl = null;
let menuItems = [];
let canvasWasWhite = null; // activate 时的 White Background 状态（卸载时恢复）

function findOptionsMenu() {
    const app = window.ExtCircuitJS?.app;
    const row = app?.menus?.menuBarRow;
    if (!row) return null;
    const td = row.children?.[4];
    return td?.querySelector("ul.menuDropdown") ?? null;
}

function apply(on) {
    if (on) {
        if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.id = STYLE_ID;
            styleEl.textContent = CSS;
            document.head.appendChild(styleEl);
        }
        document.documentElement.classList.add("ext-neumorph");
        // 新拟态是浅色系：画布翻白（记录原状供卸载恢复）
        const printable = window.ExtCircuitJS?.app?.menus?.printableCheckItem;
        if (printable) {
            if (canvasWasWhite == null) canvasWasWhite = printable.getState();
            if (!printable.getState()) printable.toggle();
        }
    } else {
        styleEl?.remove();
        styleEl = null;
        document.documentElement.classList.remove("ext-neumorph");
        const printable = window.ExtCircuitJS?.app?.menus?.printableCheckItem;
        if (printable && canvasWasWhite != null && printable.getState() !== canvasWasWhite) printable.toggle();
        canvasWasWhite = null;
    }
    localStorage.setItem(KEY, on ? "on" : "off");
    for (const li of menuItems) {
        const lbl = li.querySelector(".itemLabel");
        if (lbl) lbl.textContent = on ? "新拟态样式：开（点我关）" : "新拟态样式：关（点我开）";
    }
}

export async function activate(ctx) {
    styleEl = null;
    apply(localStorage.getItem(KEY) !== "off"); // 缺省开（用户要看美化效果）

    const menu = findOptionsMenu();
    if (menu) {
        const li = document.createElement("li");
        li.className = "menuItem";
        li.dataset.extNeumorphItem = "1";
        li.innerHTML = `<span class="itemLabel"></span>`;
        li.addEventListener("click", (e) => {
            e.stopPropagation();
            apply(localStorage.getItem(KEY) === "off");
        });
        menu.appendChild(li);
        menuItems.push(li);
        apply(localStorage.getItem(KEY) !== "off"); // 刷一遍标签文案
    }

    ctx.effect(() => {
        styleEl?.remove();
        styleEl = null;
        document.documentElement.classList.remove("ext-neumorph");
        const printable = window.ExtCircuitJS?.app?.menus?.printableCheckItem;
        if (printable && canvasWasWhite != null && printable.getState() !== canvasWasWhite) printable.toggle();
        canvasWasWhite = null;
        for (const li of menuItems) li.remove();
        menuItems = [];
    });
}

export function deactivate() {
    styleEl?.remove();
    styleEl = null;
    document.documentElement.classList.remove("ext-neumorph");
    for (const li of menuItems) li.remove();
    menuItems = [];
}
