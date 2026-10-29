// ext-neumorph —— 新拟态（Neumorphism）UI 主题插件 v2
//
// 设计要点（v1 的教训：只在底下叠了卡片，文字/滑块/间距全没变，反而更怪）：
//   1. 统一底色 + 三层明暗：底 #e0e5ec、凸起（按钮/菜单/卡片）线性渐变 + 双向外阴影、
//      凹槽（输入框/滑块轨道/选中态）双向内阴影。阴影色固定 #b8bdc7（暗）/#ffffff（亮）。
//   2. 文字层级：标签 12px/600、正文 13px、次要说明 11px + 降饱和 —— 不只是换颜色。
//   3. 间距节奏：侧栏条目 10px 间隔、按钮 8px、卡片内 14px，用统一 --nm-gap 变量。
//   4. canvas 滑块：Scrollbar 是 canvas.draw 画的，CSS 管不到 → 运行时给
//      Scrollbar.prototype.draw 打补丁（先画一层新拟态轨道/滑块，再交给原实现画箭头），
//      不改 core/ts 源码（HANDOVER 铁律：core 只读）。
//   5. 画布：浅色系主题，activate 时打开 core 的 White Background（记录原状，卸载还原）。
//
// 只改样式与绘制，不改任何布局结构（元素位置/尺寸由 core 决定）。

const STYLE_ID = "ext-neumorph-style";
const KEY = "ext.neumorph";

const CSS = `
:root {
  --nm-bg: #e0e5ec;
  --nm-dark: #b8bdc7;
  --nm-light: #ffffff;
  --nm-text: #3d4a5c;
  --nm-text-dim: #6b7787;
  --nm-gap: 10px;
  --nm-radius: 12px;
  --nm-raise: 6px 6px 12px var(--nm-dark), -6px -6px 12px var(--nm-light);
  --nm-raise-sm: 4px 4px 8px var(--nm-dark), -4px -4px 8px var(--nm-light);
  --nm-inset: inset 4px 4px 8px var(--nm-dark), inset -4px -4px 8px var(--nm-light);
}

/* ── 底色与文字基线 ───────────────────────────────────────────── */
html.ext-neumorph body { background: var(--nm-bg) !important; color: var(--nm-text) !important; }
html.ext-neumorph .layoutPanel,
html.ext-neumorph .canvasWrapper { background: var(--nm-bg) !important; }

/* ── 侧栏：整块做成一张凹槽面板，内部条目留出呼吸 ─────────────── */
html.ext-neumorph #painel {
  background: var(--nm-bg) !important;
  padding: 10px 8px 16px !important;
  box-sizing: border-box !important;
  border-radius: var(--nm-radius) 0 0 var(--nm-radius) !important;
  box-shadow: inset 3px 0 8px -4px var(--nm-dark) !important;
  color: var(--nm-text) !important;
  font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif !important;
}
html.ext-neumorph #painel > * { margin-bottom: var(--nm-gap) !important; }
html.ext-neumorph #painel > *:last-child { margin-bottom: 0 !important; }

/* ── 标签：字号/字重/字距（v1 只换色，所以看着"文字没变"）───────── */
html.ext-neumorph .topSpace,
html.ext-neumorph #painel label,
html.ext-neumorph #painel > div:not([class]) {
  font-size: 12px !important;
  font-weight: 600 !important;
  letter-spacing: .2px !important;
  color: var(--nm-text) !important;
  padding: 2px 2px 0 !important;
}
html.ext-neumorph .topSpace.disabled { color: var(--nm-text-dim) !important; }

/* ── 按钮：凸起浮雕（用 background 简写整体覆盖，v1 的渐变被 core 覆盖了） */
html.ext-neumorph .topButton,
html.ext-neumorph #painel button,
html.ext-neumorph .mainToolbar button,
html.ext-neumorph .mainToolbar td {
  background: linear-gradient(145deg, #e6ebf2, #d6dbe2) !important;
  border: 0 !important;
  border-radius: 10px !important;
  box-shadow: var(--nm-raise-sm) !important;
  color: var(--nm-text) !important;
  font-size: 12.5px !important;
  font-weight: 600 !important;
  padding: 7px 10px !important;
  margin: 0 2px !important;
  cursor: pointer !important;
  transition: box-shadow .14s ease, transform .14s ease !important;
}
html.ext-neumorph .topButton:hover,
html.ext-neumorph #painel button:hover {
  box-shadow: var(--nm-inset) !important;
  transform: translateY(1px) !important;
}
html.ext-neumorph .topButton:active { box-shadow: var(--nm-inset) !important; }

/* ── 顶部工具栏条：一整条凸起 + 内边距 ───────────────────────── */
html.ext-neumorph .mainToolbar {
  background: var(--nm-bg) !important;
  border-radius: 0 0 14px 14px !important;
  box-shadow: 0 5px 14px -6px var(--nm-dark) !important;
  padding: 3px 6px !important;
  box-sizing: border-box !important;
}

/* ── 菜单栏 + 下拉：凸起卡片 ─────────────────────────────────── */
html.ext-neumorph .gwt-MenuBar-horizontal {
  background: var(--nm-bg) !important;
  box-shadow: 0 4px 12px -6px var(--nm-dark) !important;
}
html.ext-neumorph td.gwt-MenuItem {
  background: transparent !important;
  color: var(--nm-text) !important;
  font-size: 12.5px !important;
  font-weight: 600 !important;
  padding: 4px 10px !important;
  border-radius: 8px !important;
}
html.ext-neumorph td.gwt-MenuItem:hover,
html.ext-neumorph td.gwt-MenuItem.open { background: #d8dde5 !important; }
html.ext-neumorph .menuDropdown {
  background: var(--nm-bg) !important;
  border: 0 !important;
  border-radius: 14px !important;
  box-shadow: 10px 10px 22px var(--nm-dark), -10px -10px 22px var(--nm-light) !important;
  padding: 8px !important;
  margin-top: 4px !important;
}
html.ext-neumorph .menuDropdown li {
  background: transparent !important;
  color: var(--nm-text) !important;
  font-size: 12.5px !important;
  border-radius: 8px !important;
  padding: 6px 10px !important;
  margin: 1px 0 !important;
}
html.ext-neumorph .menuDropdown li:hover { background: #d8dde5 !important; }
html.ext-neumorph .menuDropdown .submenuArrow { color: var(--nm-text-dim) !important; }

/* ── 对话框：大卡片 ─────────────────────────────────────────── */
html.ext-neumorph .gwt-DialogBox,
html.ext-neumorph .ext-about {
  background: var(--nm-bg) !important;
  border: 0 !important;
  border-radius: 18px !important;
  box-shadow: 14px 14px 30px var(--nm-dark), -14px -14px 30px var(--nm-light) !important;
  color: var(--nm-text) !important;
  padding: 16px !important;
}

/* ── 输入框：凹槽 ───────────────────────────────────────────── */
html.ext-neumorph input[type="text"],
html.ext-neumorph input[type="number"],
html.ext-neumorph select,
html.ext-neumorph textarea {
  background: var(--nm-bg) !important;
  border: 0 !important;
  border-radius: 9px !important;
  box-shadow: var(--nm-inset) !important;
  color: var(--nm-text) !important;
  padding: 7px 9px !important;
  font-size: 12.5px !important;
}

/* ── 侧栏里的 canvas（滑块）：底色垫平，具体轨道由 draw 补丁画 ── */
html.ext-neumorph #painel canvas { background: transparent !important; display: block !important; }

/* ── 滚动条 ─────────────────────────────────────────────────── */
html.ext-neumorph ::-webkit-scrollbar { width: 10px; height: 10px; background: var(--nm-bg); }
html.ext-neumorph ::-webkit-scrollbar-thumb {
  background: #ccd2db; border-radius: 6px;
  box-shadow: inset 2px 2px 4px var(--nm-dark), inset -2px -2px 4px var(--nm-light);
}

/* ── 窄屏（≤600px）侧栏开关：必须压在 #painel 之上，否则点不到 ────────
 * core 里 .triggerLabel 与 .verticalPanel 同为 z-index:1，DOM 顺序让后者盖住前者；
 * 新拟态给 #painel 加了不透明底色 + 阴影，把手彻底被埋。这里提到 z-index:10 并做同风格外观。 */
@media only screen and (max-width: 600px) {
  html.ext-neumorph .triggerLabel {
    z-index: 10 !important;
    background: var(--nm-bg) !important;
    box-shadow: -4px 0 10px -4px var(--nm-dark), inset 1px 0 2px var(--nm-light) !important;
    color: var(--nm-text) !important;
    border-radius: 10px 0 0 10px !important;
    cursor: pointer !important;
  }
  html.ext-neumorph .triggerLabel::before { color: var(--nm-text) !important; }
  html.ext-neumorph .toptriggerlabel {
    z-index: 10 !important;
    background: var(--nm-bg) !important;
    border-radius: 6px !important;
    box-shadow: var(--nm-raise-sm) !important;
    color: var(--nm-text) !important;
    cursor: pointer !important;
  }
  /* 展开后的 #painel 不要盖住把手 */
  html.ext-neumorph #painel { z-index: 5 !important; }
}

/* ── 插件面板：卡片化（自带内边距，避免 v1 那种"贴边卡片"）──────── */
html.ext-neumorph .ext-plugin-hello,
html.ext-neumorph [data-ext-plugin] {
  background: var(--nm-bg) !important;
  border: 0 !important;
  border-radius: var(--nm-radius) !important;
  box-shadow: var(--nm-raise-sm) !important;
  color: var(--nm-text) !important;
  font-size: 12px !important;
  padding: 10px 12px !important;
  line-height: 1.45 !important;
}
`;

let styleEl = null;
let menuItems = [];
let canvasWasWhite = null;
let drawPatched = false;
let origDraw = null;

/** 给 Scrollbar.prototype.draw 打补丁：**整体替换**为新拟态绘制。
 *  上一版只画了底色再调原 draw，原 draw 用 #fff 铺满 + 灰红轨道，覆盖掉了补丁 —— 必须完整接管。
 *  Scrollbar 由 core 的 UIManager 导出（core 只读，运行时改原型不改文件）。 */
async function patchScrollbars() {
    if (drawPatched) return;
    try {
        const mod = await import(/* @vite-ignore */ "/UIManager.ts");
        const Scrollbar = mod.Scrollbar;
        if (!Scrollbar?.prototype?.draw) return;
        origDraw = Scrollbar.prototype.draw;
        const BG = "#e0e5ec", DARK = "#b8bdc7", LIGHT = "#ffffff", TXT = "#3d4a5c";
        Scrollbar.prototype.draw = function () {
            const g = this.g;
            const vpw = this.vpw;
            const sh = 14;                       // Scrollbar.SCROLLHEIGHT
            const hm = 2, bm = 3;                // HMARGIN / BARMARGIN
            const enabled = this.enabled !== false;
            const tri = (x, dir) => {            // 小三角箭头
                g.beginPath();
                if (dir < 0) { g.moveTo(x + 5, sh / 2 - 4); g.lineTo(x, sh / 2); g.lineTo(x + 5, sh / 2 + 4); }
                else { g.moveTo(x - 5, sh / 2 - 4); g.lineTo(x, sh / 2); g.lineTo(x - 5, sh / 2 + 4); }
                g.closePath();
                g.fillStyle = enabled ? TXT : "#aab0ba";
                g.fill();
            };
            try {
                g.clearRect(0, 0, vpw, sh);
                // 凹槽：底色 + 上下双向内阴影线
                g.fillStyle = BG;
                g.fillRect(0, 0, vpw, sh);
                const x0 = hm + 5 + bm, x1 = vpw - hm - 5 - bm;
                g.strokeStyle = DARK; g.lineWidth = 1;
                g.beginPath(); g.moveTo(x0, sh / 2 + 3.5); g.lineTo(x1, sh / 2 + 3.5); g.stroke();
                g.strokeStyle = LIGHT; g.lineWidth = 1;
                g.beginPath(); g.moveTo(x0, sh / 2 + 4.5); g.lineTo(x1, sh / 2 + 4.5); g.stroke();

                tri(hm + 2, -1);                 // 左箭头
                tri(vpw - hm - 2, 1);            // 右箭头

                if (enabled && this.max > this.min) {
                    const span = x1 - x0;
                    const p = x0 + span * (this.val - this.min) / (this.max - this.min);
                    // 已填充段：新拟态凸起细条
                    g.strokeStyle = "rgba(61,74,92,.55)";
                    g.lineWidth = 4;
                    g.lineCap = "round";
                    g.beginPath(); g.moveTo(x0, sh / 2); g.lineTo(Math.max(x0, p), sh / 2); g.stroke();
                    // 手柄：凸起圆角胶囊
                    const hw = 6;
                    g.save();
                    g.shadowColor = DARK; g.shadowBlur = 3; g.shadowOffsetX = 1; g.shadowOffsetY = 1;
                    g.fillStyle = LIGHT;
                    g.beginPath();
                    const r = hw / 2 + 1;
                    g.roundRect?.(p - hw / 2, sh / 2 - hw / 2 - 1, hw, hw + 2, r);
                    if (!g.roundRect) g.rect(p - hw / 2, sh / 2 - hw / 2 - 1, hw, hw + 2);
                    g.fill();
                    g.restore();
                }
            } catch {
                // 绘制异常时退回原实现（保证功能不坏）
                if (origDraw) origDraw.call(this);
            }
        };
        drawPatched = true;
        redrawAllSliders();
    } catch { /* 装载失败：滑块保持原样，不影响其他样式 */ }
}

/** 补丁生效时，已有滑块是"补丁前画好"的旧画面 —— 必须统一重绘。
 *  UI 三个 bar + 所有 adjustables（元件属性滑块，如 Capacitance/Inductance/Resistance）。 */
function redrawAllSliders() {
    const app = window.ExtCircuitJS?.app;
    const ui = app?.ui;
    for (const bar of [ui?.speedBar, ui?.currentBar, ui?.powerBar]) {
        try { bar?.draw?.(); } catch { /* ignore */ }
    }
    for (const adj of app?.adjustables ?? []) {
        try { adj.slider?.draw?.(); } catch { /* ignore */ }
    }
}

function unpatchScrollbars() {
    if (!drawPatched) return;
    try {
        import(/* @vite-ignore */ "/UIManager.ts").then((mod) => {
            if (origDraw && mod.Scrollbar?.prototype) mod.Scrollbar.prototype.draw = origDraw;
        });
    } catch { /* ignore */ }
    drawPatched = false;
    origDraw = null;
}

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
        void patchScrollbars();
        const printable = window.ExtCircuitJS?.app?.menus?.printableCheckItem;
        if (printable) {
            if (canvasWasWhite == null) canvasWasWhite = printable.getState();
            if (!printable.getState()) printable.toggle();
        }
    } else {
        styleEl?.remove();
        styleEl = null;
        document.documentElement.classList.remove("ext-neumorph");
        unpatchScrollbars();
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
    apply(localStorage.getItem(KEY) !== "off");

    // 载入新电路后 adjustables 会重建（新滑块的首次绘制可能早于补丁生效顺序），
    // 跟随 update 事件补一次重绘（节流，只在主题开启时）。
    let lastRedraw = 0;
    const onUpdate = () => {
        if (!document.documentElement.classList.contains("ext-neumorph")) return;
        const now = Date.now();
        if (now - lastRedraw < 250) return; // 节流：避免每帧重绘
        lastRedraw = now;
        redrawAllSliders();
    };
    try { ctx.on("update", onUpdate); } catch { /* 无 sim.observe 权限时跳过 */ }

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
        apply(localStorage.getItem(KEY) !== "off");
    }

    ctx.effect(() => {
        styleEl?.remove();
        styleEl = null;
        document.documentElement.classList.remove("ext-neumorph");
        unpatchScrollbars();
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
    unpatchScrollbars();
    for (const li of menuItems) li.remove();
    menuItems = [];
}
