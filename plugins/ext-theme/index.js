// ext-theme —— UI 外观（深色/浅色）切换插件
//
// 在【选项】菜单加一项【UI 外观：深色 / 浅色】，点击在两种模式间切换：
//   · 深色 = 画布黑底白线（core 默认）+ 深色 UI 外壳（本插件注入的 CSS）
//   · 浅色 = 画布白底黑线（复用 core 自带的 White Background 开关，含它的持久化）
//            + 默认浅色外壳
// 只改样式不改布局；选择记忆在 localStorage（ext.theme），下次启动自动应用。
//
// 画布联动走 core 的 printableCheckItem.toggle()——它自己会把状态写进
// localStorage（UIManager 的 setOptionInStorage），并且下一帧重绘时生效。

const STYLE_ID = "ext-theme-style";
const KEY = "ext.theme";
const DARK_CSS = `
html[data-ext-theme="dark"] body { background: #16181d; color: #d7dae0; }
html[data-ext-theme="dark"] .gwt-MenuItem,
html[data-ext-theme="dark"] .menuDropdown {
  background: #23262c !important; color: #d7dae0 !important;
  border-color: #33363d !important;
}
html[data-ext-theme="dark"] .gwt-MenuItem:hover,
html[data-ext-theme="dark"] li.hasSubmenu:hover { background: #31353d !important; }
html[data-ext-theme="dark"] .topButton,
html[data-ext-theme="dark"] button,
html[data-ext-theme="dark"] select,
html[data-ext-theme="dark"] input[type="text"],
html[data-ext-theme="dark"] input[type="number"] {
  background: #23262c !important; color: #d7dae0 !important;
  border: 1px solid #33363d !important;
}
html[data-ext-theme="dark"] .topButton:hover { background: #31353d !important; }
html[data-ext-theme="dark"] table td, html[data-ext-theme="dark"] label,
html[data-ext-theme="dark"] .topSpace { color: #d7dae0; }
html[data-ext-theme="dark"] .disabled { color: #6b7078 !important; }
html[data-ext-theme="dark"] ::-webkit-scrollbar { background: #23262c; }
html[data-ext-theme="dark"] ::-webkit-scrollbar-thumb { background: #3d424b; }
html[data-ext-theme="dark"] .gwt-DialogBox,
html[data-ext-theme="dark"] .ext-about { background: #23262c !important; color: #d7dae0 !important; }
`;

let styleEl = null;
let menuItems = [];

function findOptionsMenu() {
    // menuBarRow 固定序：File(0) Edit(1) Draw(2) Scopes(3) Options(4)（core Menus.ts addTopItem）
    const app = window.ExtCircuitJS?.app;
    const row = app?.menus?.menuBarRow;
    if (!row) return null;
    const td = row.children?.[4];
    return td?.querySelector("ul.menuDropdown") ?? null;
}

function makeItem(label) {
    const li = document.createElement("li");
    li.className = "menuItem";
    li.dataset.extThemeItem = "1";
    li.innerHTML = `<span class="itemLabel">${label}</span>`;
    return li;
}

function applyTheme(dark) {
    if (dark) {
        if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.id = STYLE_ID;
            styleEl.textContent = DARK_CSS;
            document.head.appendChild(styleEl);
        }
        document.documentElement.dataset.extTheme = "dark";
    } else {
        styleEl?.remove();
        styleEl = null;
        delete document.documentElement.dataset.extTheme;
    }
    // 画布联动：深色 = core 默认（black bg）；浅色 = White Background 打开。
    // 只在状态不同才 toggle，避免把用户手动选的白底翻回去。
    const printable = window.ExtCircuitJS?.app?.menus?.printableCheckItem;
    if (printable && printable.getState() === dark) printable.toggle();
    localStorage.setItem(KEY, dark ? "dark" : "light");
    for (const li of menuItems) {
        const lbl = li.querySelector(".itemLabel");
        if (lbl) lbl.textContent = dark ? "UI 外观：深色（点我切浅色）" : "UI 外观：浅色（点我切深色）";
    }
}

export async function activate(ctx) {
    // 样式 + 初始主题（记忆值；缺省跟随 core 默认 = 深色画布 + 浅色壳 → 算"浅色"态）
    styleEl = null;
    applyTheme(localStorage.getItem(KEY) === "dark");

    // 往【选项】菜单追加切换项
    const menu = findOptionsMenu();
    if (menu) {
        const li = makeItem("");
        li.addEventListener("click", (e) => {
            e.stopPropagation();
            applyTheme(localStorage.getItem(KEY) !== "dark");
        });
        menu.appendChild(li);
        menuItems.push(li);
    }

    ctx.effect(() => {
        // 卸载：摘样式与菜单项，主题回到浅色默认（画布交还用户自己的 White Background 设置）
        styleEl?.remove();
        styleEl = null;
        for (const li of menuItems) li.remove();
        menuItems = [];
        delete document.documentElement.dataset.extTheme;
    });
}

export function deactivate() {
    styleEl?.remove();
    styleEl = null;
    for (const li of menuItems) li.remove();
    menuItems = [];
    delete document.documentElement.dataset.extTheme;
}
