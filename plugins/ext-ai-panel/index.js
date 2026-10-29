// ext-ai-panel —— 右侧栏重构：顶部按钮横排 + 两个 Tab（AI 助手 / 仿真设置）
//
// 布局目标：
//   ┌─────────────────────────┐
//   │  [重置]  [RUN / Stop]   │  ← 横排同一行
//   ├─────────────────────────┤
//   │  [AI 助手] [仿真设置]    │  ← Tab 栏
//   ├─────────────────────────┤
//   │                         │
//   │  当前 Tab 的内容         │
//   │                         │
//   └─────────────────────────┘
//
// 实现关键：core 一直在往 #painel 里 appendChild（滑块、标签、iframe，且载入电路时会重建），
// 所以不能"搬一次节点"了事。做法是**接管 #painel 的 appendChild / insertBefore**：
//   · 顶部按钮（buttonPanel）保持直接挂在 #painel（横排）
//   · 其余一切（仿真设置相关）转发到"仿真设置"页容器
//   · iframe 也归"仿真设置"页
// 插件自己的 AI 面板则作为一个独立页容器插在 Tab 栏之后。

const TAB_AI = "ai";
const TAB_SIM = "sim";

const STYLE_ID = "ext-ai-panel-style";
const CSS = `
/* 侧栏加宽：166px 装不下两个横排按钮 + 聊天面板，这里放到 340px。
   画布与工具栏的 right 偏移要同步（core 用内联 style 写死，所以这里 !important 覆盖）。 */
:root { --ext-ai-panel-w: 340px; }
#painel {
  display: flex !important; flex-direction: column !important; padding: 0 !important;
  width: var(--ext-ai-panel-w) !important;
}
.mainToolbar { right: var(--ext-ai-panel-w) !important; }
.canvasWrapper { right: var(--ext-ai-panel-w) !important; }
/* 窄屏（core 的移动端布局）保持原样，别撑爆手机 */
@media only screen and (max-width: 600px) {
  :root { --ext-ai-panel-w: 100vw; }
  #painel { width: 0 !important; }
  .trigger:checked ~ #painel { width: 88vw !important; }
  .mainToolbar, .canvasWrapper { right: 0 !important; }
}
#painel > .ext-ai-topbar {
  display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important;
  gap: 6px; padding: 8px 8px 6px; flex: 0 0 auto; box-sizing: border-box; width: 100%;
}
/* topbar 里包着 core 的 buttonPanel（无名 div，内含两个 .topButton），
   所以选择器要下钻两层；buttonPanel 自己也要撑满横向。 */
#painel > .ext-ai-topbar > div {
  display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important;
  gap: 6px; flex: 1 1 auto !important; min-width: 0 !important; width: 100% !important;
}
#painel > .ext-ai-topbar .topButton {
  flex: 1 1 0 !important; min-width: 0 !important; width: auto !important;
  margin: 0 !important; white-space: nowrap !important;
  overflow: hidden; text-overflow: ellipsis;
  font-size: 12px !important; padding: 7px 6px !important;
  display: inline-flex !important; align-items: center; justify-content: center;
}
.ext-ai-tabs {
  display: flex; flex: 0 0 auto; gap: 4px; padding: 0 8px 6px; box-sizing: border-box; width: 100%;
}
.ext-ai-tab {
  flex: 1 1 0; min-width: 0; text-align: center; padding: 8px 4px;
  font: 600 12.5px/1.15 system-ui, sans-serif; white-space: nowrap;
  color: #4b5563; background: #eef1f5; border: 0; border-radius: 8px 8px 0 0;
  cursor: pointer; transition: background .15s, color .15s;
}
.ext-ai-tab:hover { background: #e3e8ef; }
.ext-ai-tab[aria-selected="true"] { background: #fff; color: #111827; box-shadow: 0 -2px 6px rgba(0,0,0,.06); }
.ext-ai-page { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 4px 8px 12px; box-sizing: border-box; }
.ext-ai-page[hidden] { display: none !important; }
.ext-ai-page--sim > * { max-width: 100%; }
/* 加宽后 core 画的滑块 canvas 仍是 166px 固定宽（构造时按 VERTICALPANELWIDTH 定的）——
   用 CSS 拉伸到容器宽度；canvas 内部坐标按原宽绘制，横向拉伸只是视觉放大，交互偏移仍准确
   （鼠标事件用 offsetX，浏览器会按 CSS 尺寸换算）。 */
.ext-ai-page--sim canvas {
  width: 100% !important; max-width: 100% !important; height: 18px !important;
}
.ext-ai-page--sim iframe { width: 100% !important; }
.ext-ai-page--ai textarea { font-size: 12px !important; }
/* iframe 留在 #painel 原位（不移动，避免中断其加载）；仅在「AI 助手」页时隐藏。
   data-ext-ai-tab 挂在 #painel 上，由 selectTab 更新。 */
#painel[data-ext-ai-tab="ai"] > iframe { display: none !important; }
#painel[data-ext-ai-tab="sim"] > iframe { display: block !important; }
`;

// ── 状态 ────────────────────────────────────────────────────────────
let styleEl = null;
let painel = null;
let origAppendChild = null;
let origInsertBefore = null;
let origRemoveChild = null;
let origRemoveWidget = null;
let topbar = null;       // 顶部横排容器（含 Reset / RUN）
let tabsEl = null;
let pageAi = null;
let pageSim = null;
let activeTab = TAB_AI;
let movedNodes = [];     // 已转发到 sim 页的节点（卸载时还原判断用）

// ── AI 面板 UI（聊天 + 设置 + MCP 状态）──────────────────────────────

let chatLog = null;
let inputEl = null;
let sendBtn = null;
let settingsEl = null;
let mcpStatusEl = null;

/** 极简 markdown-ish 渲染：只处理 **粗体**、`代码`、换行 */
function renderInline(text) {
    const esc = String(text)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/`([^`]+)`/g, "<code style=\"background:#eef2f7;padding:1px 4px;border-radius:3px;font-size:11.5px\">$1</code>")
        .replace(/\n/g, "<br>");
}

function appendChat(role, text) {
    const row = document.createElement("div");
    row.dataset.role = role;
    const isUser = role === "user";
    row.style.cssText = [
        "margin:8px 0", "display:flex", isUser ? "justify-content:flex-end" : "justify-content:flex-start",
    ].join(";");
    const bubble = document.createElement("div");
    bubble.style.cssText = [
        "max-width:92%", "padding:8px 10px", "border-radius:10px", "font-size:12.5px", "line-height:1.55",
        isUser ? "background:#2f6fed;color:#fff;border-bottom-right-radius:3px"
               : "background:#f1f5f9;color:#1f2937;border-bottom-left-radius:3px",
        "word-break:break-word", "white-space:normal",
    ].join(";");
    bubble.innerHTML = renderInline(text);
    row.appendChild(bubble);
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
    return bubble;
}

/** MCP 连接状态条 */
function renderMcpStatus() {
    if (!mcpStatusEl) return;
    const mcp = window.ExtCircuitJS?.mcp;
    const st = mcp?.status?.() ?? null;
    const online = st?.state === "online";
    mcpStatusEl.innerHTML =
        `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${online ? "#22c55e" : "#9ca3af"};margin-right:6px"></span>` +
        (online ? `MCP 已连接 · ${st.sessions ?? 0} 会话` : "MCP 未连接（点击「MCP 配置」查看怎么连）");
    mcpStatusEl.style.color = online ? "#166534" : "#6b7280";
}

function buildAiPage() {
    const page = document.createElement("div");
    page.className = "ext-ai-page ext-ai-page--ai";

    // MCP 状态 + 设置入口
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0 8px;font:11.5px/1.4 system-ui,sans-serif";
    mcpStatusEl = document.createElement("div");
    mcpStatusEl.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    renderMcpStatus();
    const gear = document.createElement("button");
    gear.textContent = "⚙";
    gear.title = "AI 设置（Provider / Key）";
    gear.style.cssText = [
        "background:#eef1f5", "border:0", "border-radius:6px", "width:24px", "height:24px",
        "cursor:pointer", "font-size:13px", "color:#4b5563", "flex:0 0 auto",
    ].join(";");
    gear.addEventListener("click", () => toggleSettings());
    head.append(mcpStatusEl, gear);
    page.appendChild(head);

    // 设置面板（默认折叠）
    settingsEl = document.createElement("div");
    settingsEl.hidden = true;
    settingsEl.style.cssText = [
        "background:#f8fafc", "border:1px solid #e2e8f0", "border-radius:8px",
        "padding:10px 12px", "margin-bottom:10px", "font:11.5px/1.6 system-ui,sans-serif",
    ].join(";");
    settingsEl.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;color:#111827">AI 设置</div>
      <label style="display:block;margin-bottom:6px">Provider
        <select id="ext-ai-provider" style="width:100%;margin-top:2px;padding:4px;border:1px solid #cbd5e1;border-radius:5px">
          <option value="openai">OpenAI 兼容（自定义 baseURL）</option>
          <option value="anthropic">Anthropic</option>
          <option value="local-cli">本地 Agent CLI</option>
          <option value="none">不接（仅用 MCP 工具）</option>
        </select>
      </label>
      <label style="display:block;margin-bottom:6px">Base URL
        <input id="ext-ai-baseurl" placeholder="https://api.openai.com/v1" style="width:100%;margin-top:2px;padding:4px;border:1px solid #cbd5e1;border-radius:5px;box-sizing:border-box">
      </label>
      <label style="display:block;margin-bottom:6px">API Key
        <input id="ext-ai-key" type="password" placeholder="sk-..." style="width:100%;margin-top:2px;padding:4px;border:1px solid #cbd5e1;border-radius:5px;box-sizing:border-box">
      </label>
      <label style="display:block;margin-bottom:8px">模型
        <input id="ext-ai-model" placeholder="gpt-4o-mini" style="width:100%;margin-top:2px;padding:4px;border:1px solid #cbd5e1;border-radius:5px;box-sizing:border-box">
      </label>
      <div style="display:flex;gap:6px">
        <button id="ext-ai-save" style="flex:1;background:#2f6fed;color:#fff;border:0;border-radius:6px;padding:6px;cursor:pointer;font-size:11.5px">保存</button>
        <button id="ext-ai-clear" style="flex:0 0 auto;background:#eef1f5;color:#4b5563;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:11.5px">清除</button>
      </div>
      <div id="ext-ai-hint" style="margin-top:8px;color:#94a3b8;font-size:11px;line-height:1.5">
        配置存在浏览器 localStorage（仅本机）。未配置时可用下方 MCP 工具直接操作电路。
      </div>
    `;
    page.appendChild(settingsEl);

    // 聊天区
    chatLog = document.createElement("div");
    chatLog.style.cssText = [
        "flex:1", "min-height:120px", "max-height:46vh", "overflow-y:auto",
        "border:1px solid #e2e8f0", "border-radius:8px", "padding:8px",
        "background:#fff", "margin-bottom:8px",
    ].join(";");
    page.appendChild(chatLog);
    appendChat("assistant", "我是电路助手。可以：\n· 问我电路问题（我会用真实引擎算）\n· 让我改参数、跑仿真、读电压\n· 点 ⚙ 配置自己的模型 Key");

    // 输入区
    const inputRow = document.createElement("div");
    inputRow.style.cssText = "display:flex;gap:6px;align-items:flex-end";
    inputEl = document.createElement("textarea");
    inputEl.rows = 2;
    inputEl.placeholder = "问点什么…（Enter 发送，Shift+Enter 换行）";
    inputEl.style.cssText = [
        "flex:1", "resize:none", "padding:6px 8px", "border:1px solid #cbd5e1",
        "border-radius:6px", "font:12px/1.5 system-ui,sans-serif", "box-sizing:border-box",
    ].join(";");
    sendBtn = document.createElement("button");
    sendBtn.textContent = "发送";
    sendBtn.style.cssText = [
        "background:#2f6fed", "color:#fff", "border:0", "border-radius:6px",
        "padding:7px 12px", "cursor:pointer", "font-size:12px", "flex:0 0 auto",
    ].join(";");
    inputRow.append(inputEl, sendBtn);
    page.appendChild(inputRow);

    return page;
}

function toggleSettings() {
    if (!settingsEl) return;
    settingsEl.hidden = !settingsEl.hidden;
    if (!settingsEl.hidden) {
        const cfg = loadAiConfig();
        settingsEl.querySelector("#ext-ai-provider").value = cfg.provider ?? "openai";
        settingsEl.querySelector("#ext-ai-baseurl").value = cfg.baseUrl ?? "";
        settingsEl.querySelector("#ext-ai-key").value = cfg.apiKey ?? "";
        settingsEl.querySelector("#ext-ai-model").value = cfg.model ?? "";
    }
}

const AI_CFG_KEY = "ext.ai.config";
function loadAiConfig() {
    try { return JSON.parse(localStorage.getItem(AI_CFG_KEY) || "{}"); } catch { return {}; }
}
function saveAiConfig(cfg) {
    try { localStorage.setItem(AI_CFG_KEY, JSON.stringify(cfg)); } catch { /* 隐私模式 */ }
}

/** 发送消息（当前：无模型时给出能力提示；有 Key 时走 OpenAI 兼容接口） */
async function sendMessage() {
    const text = (inputEl.value || "").trim();
    if (!text) return;
    inputEl.value = "";
    appendChat("user", text);

    const cfg = loadAiConfig();
    if (!cfg.apiKey || cfg.provider === "none" || cfg.provider === "local-cli") {
        appendChat("assistant",
            cfg.provider === "local-cli"
                ? "本地 Agent CLI 模式：请在你本机终端里运行 agent，让它通过 MCP 连到本页（顶部菜单 AI → MCP 配置）。\n\n" +
                  "面板内直连本地 CLI 需要宿主提供进程桥，当前版本暂未启用。"
                : "还没配置模型 Key。点右上角 ⚙ 填写 Provider / Base URL / Key 后即可对话。\n\n" +
                  "想让我操作电路（改参数、跑仿真、读电压），用顶部菜单 **AI → MCP 配置** 把 MCP 接上。");
        return;
    }

    // OpenAI 兼容 chat/completions（Anthropic 若 baseURL 兼容也可用）
    const baseUrl = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const model = cfg.model || "gpt-4o-mini";
    const thinking = appendChat("assistant", "…");
    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({
                model,
                messages: [
                    {
                        role: "system",
                        content:
                            "你是 ExtCircuitJS 的电路助手。回答要简短、给具体数值和单位。" +
                            "涉及电路计算时优先说明依据；不要编造仿真结果。",
                    },
                    { role: "user", content: text },
                ],
                temperature: 0.3,
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        const reply = data?.choices?.[0]?.message?.content ?? "(空回复)";
        thinking.parentElement.remove();
        appendChat("assistant", reply);
    } catch (e) {
        thinking.parentElement.remove();
        appendChat("assistant", `请求失败：${e?.message ?? e}`);
    }
}

// ── 布局接管 ────────────────────────────────────────────────────────

/** 判断节点是否属于"顶部按钮行"（buttonPanel 及其子节点） */
function isTopbarNode(node) {
    const bp = window.ExtCircuitJS?.app?.ui?.buttonPanel;
    return bp != null && (node === bp || bp.contains(node));
}

/** 接管 #painel 的插入：顶部按钮归 topbar，其余归 simulation 页 */
function installRedirects() {
    origAppendChild = painel.appendChild.bind(painel);
    origInsertBefore = painel.insertBefore.bind(painel);

    painel.appendChild = function (node) {
        if (node === topbar || node === tabsEl || node === pageAi || node === pageSim) {
            return origAppendChild(node);
        }
        if (isTopbarNode(node)) {
            topbar.appendChild(node);
            return node;
        }
        pageSim.appendChild(node);
        movedNodes.push(node);
        return node;
    };

    painel.insertBefore = function (node, ref) {
        if (node === topbar || node === tabsEl || node === pageAi || node === pageSim) {
            return origInsertBefore(node, ref);
        }
        if (isTopbarNode(node)) {
            topbar.insertBefore(node, null);
            return node;
        }
        pageSim.insertBefore(node, null);
        movedNodes.push(node);
        return node;
    };

    // **关键 2**：core 的 removeWidgetFromVerticalPanel 先判定
    //   `if (w.parentNode === this.verticalPanel) removeChild(...)`
    // 节点已被转发进 pageSim，判定不成立 → 插件面板卸载时删不掉（泄漏）。
    // 包装该方法：节点在 pageSim/topbar 里也算"在侧栏里"。
    const ui = window.ExtCircuitJS?.app?.ui;
    if (ui && typeof ui.removeWidgetFromVerticalPanel === "function") {
        origRemoveWidget = ui.removeWidgetFromVerticalPanel.bind(ui);
        ui.removeWidgetFromVerticalPanel = function (w) {
            try {
                if (w != null && (w.parentElement === pageSim || w.parentElement === topbar)) {
                    w.remove();
                    const i = movedNodes.indexOf(w);
                    if (i >= 0) movedNodes.splice(i, 1);
                    try { ui.setiFrameHeight?.(); } catch { /* ignore */ }
                    return;
                }
            } catch { /* 落到原实现 */ }
            return origRemoveWidget(w);
        };
    }

    // 兜底：也接管 removeChild（core 有直接调 removeChild 的路径）
    origRemoveChild = painel.removeChild.bind(painel);
    painel.removeChild = function (node) {
        if (node.parentElement === pageSim) {
            pageSim.removeChild(node);
            const i = movedNodes.indexOf(node);
            if (i >= 0) movedNodes.splice(i, 1);
            return node;
        }
        if (node.parentElement === topbar) {
            topbar.removeChild(node);
            return node;
        }
        return origRemoveChild(node);
    };
}

/** 把 #painel 现有子节点按类型分派（首次安装时执行一次） */
function partitionExisting() {
    const ui = window.ExtCircuitJS?.app?.ui;
    const bp = ui?.buttonPanel ?? null;
    const kids = Array.from(painel.children);
    for (const node of kids) {
        if (node === topbar || node === tabsEl || node === pageAi || node === pageSim) continue;
        // **不要移动 iframe**：它是 core 按需创建、自己管高度/加载的；
        // 移动节点会中断其进行中的请求（CI 上表现为 iframe.html net::ERR_ABORTED）。
        // 保持原位，用 CSS 在「AI 助手」页时隐藏即可（见 CSS 的 #painel > iframe 规则）。
        if (node.tagName === "IFRAME") continue;
        if (bp != null && node === bp) {
            topbar.appendChild(node);          // 按钮面板整体进 topbar
        } else {
            pageSim.appendChild(node);
            movedNodes.push(node);
        }
    }
}

/** 建骨架：topbar / tabs / 两个 page */
function buildSkeleton() {
    topbar = document.createElement("div");
    topbar.className = "ext-ai-topbar";

    tabsEl = document.createElement("div");
    tabsEl.className = "ext-ai-tabs";

    pageAi = buildAiPage();
    pageSim = document.createElement("div");
    pageSim.className = "ext-ai-page ext-ai-page--sim";

    const mkTab = (id, label) => {
        const b = document.createElement("button");
        b.className = "ext-ai-tab";
        b.type = "button";
        b.dataset.tab = id;
        b.textContent = label;
        b.addEventListener("click", () => selectTab(id));
        return b;
    };
    tabsEl.append(mkTab(TAB_AI, "AI 助手"), mkTab(TAB_SIM, "仿真设置"));

    origAppendChild(topbar);
    origAppendChild(tabsEl);
    origAppendChild(pageAi);
    origAppendChild(pageSim);
}

function selectTab(id) {
    activeTab = id;
    for (const b of tabsEl.querySelectorAll(".ext-ai-tab")) {
        b.setAttribute("aria-selected", String(b.dataset.tab === id));
    }
    pageAi.hidden = id !== TAB_AI;
    pageSim.hidden = id !== TAB_SIM;
    // iframe 留在 #painel 原位，用属性驱动 CSS 显隐
    if (painel) painel.dataset.extAiTab = id;
    // 切到仿真设置时，让 core 重算 iframe 高度（它按 verticalPanel 子节点算）
    if (id === TAB_SIM) {
        try { window.ExtCircuitJS?.app?.ui?.setiFrameHeight?.(); } catch { /* ignore */ }
    }
}

// ── 插件入口 ────────────────────────────────────────────────────────

let wired = false;

export async function activate(ctx) {
    painel = document.getElementById("painel");
    if (!painel) { ctx.log("找不到 #painel，放弃"); return; }

    if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = STYLE_ID;
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);
    }

    // 顺序很重要：先接管 appendChild（拿到 origAppendChild），再建骨架，
    // 否则 buildSkeleton 里用 origAppendChild 会拿到 null。
    installRedirects();
    buildSkeleton();
    partitionExisting();
    selectTab(TAB_AI);
    wired = true;

    // 发送按钮 / 快捷键
    sendBtn.addEventListener("click", sendMessage);
    inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    // 设置保存/清除
    settingsEl.querySelector("#ext-ai-save").addEventListener("click", () => {
        saveAiConfig({
            provider: settingsEl.querySelector("#ext-ai-provider").value,
            baseUrl: settingsEl.querySelector("#ext-ai-baseurl").value.trim(),
            apiKey: settingsEl.querySelector("#ext-ai-key").value.trim(),
            model: settingsEl.querySelector("#ext-ai-model").value.trim(),
        });
        const hint = settingsEl.querySelector("#ext-ai-hint");
        hint.textContent = "已保存。";
        hint.style.color = "#22c55e";
        setTimeout(() => { hint.style.color = "#94a3b8"; hint.textContent = "配置存在浏览器 localStorage（仅本机）。未配置时可用下方 MCP 工具直接操作电路。"; }, 1800);
    });
    settingsEl.querySelector("#ext-ai-clear").addEventListener("click", () => {
        localStorage.removeItem(AI_CFG_KEY);
        for (const id of ["#ext-ai-baseurl", "#ext-ai-key", "#ext-ai-model"]) settingsEl.querySelector(id).value = "";
        settingsEl.querySelector("#ext-ai-hint").textContent = "已清除。";
    });

    // MCP 状态：定时轮询即可（不订阅仿真事件——那是 sim.observe 的语义，
    // 也会干扰插件计数的契约测试；状态变化是秒级事件，1.5s 轮询足够）。
    const mcpTimer = setInterval(renderMcpStatus, 1500);
    ctx.effect(() => clearInterval(mcpTimer));

    ctx.effect(() => {
        if (!wired) return;
        // 还原接管
        if (origAppendChild) painel.appendChild = origAppendChild;
        if (origInsertBefore) painel.insertBefore = origInsertBefore;
        if (origRemoveChild) painel.removeChild = origRemoveChild;
        if (origRemoveWidget) {
            const ui = window.ExtCircuitJS?.app?.ui;
            if (ui) ui.removeWidgetFromVerticalPanel = origRemoveWidget;
        }
        // 把转发走的节点放回 #painel（避免 core 持有的引用失效）
        for (const n of movedNodes) {
            try { if (n.parentElement === pageSim) origAppendChild(n); } catch { /* ignore */ }
        }
        movedNodes = [];
        topbar?.remove(); tabsEl?.remove(); pageAi?.remove(); pageSim?.remove();
        styleEl?.remove(); styleEl = null;
        painel = null; topbar = tabsEl = pageAi = pageSim = null;
        chatLog = inputEl = sendBtn = settingsEl = mcpStatusEl = null;
        wired = false;
    });

    ctx.log("activated: 侧栏已重构（AI 助手 / 仿真设置 双 Tab）");
}

export function deactivate() {
    // 清理在 ctx.effect 里；这里留空（宿主会调 effect）
}
