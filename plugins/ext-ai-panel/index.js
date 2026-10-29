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

import { chatStream, loadAiConfig, saveAiConfig, clearAiConfig, loadHistory, pushHistory, clearHistory } from "./chat.mjs";

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

/* ── 关键：所有 core 节点都在原位（#painel 直接子节点），只用 order 排版 ──
   order 0 = AI 页容器；1 = Tab 栏；2 = 顶部按钮；3 = 仿真设置相关。
   实际视觉顺序靠 order 值决定，与 DOM 顺序无关。 */
#painel > .ext-ai-tabs { order: 1; }

#painel > [data-ext-ai-slot="top"] { order: 0; }
#painel > .ext-ai-page--ai { order: 3; }
#painel > [data-ext-ai-slot="sim"] { order: 4; flex: 0 0 auto; }
/* 顶部按钮行：buttonPanel 是 core 的无名 div，含两个 .topButton */
#painel > [data-ext-ai-slot="top"] {
  display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important;
  gap: 6px; padding: 8px 8px 6px; flex: 0 0 auto; box-sizing: border-box; width: 100%;
}
#painel > [data-ext-ai-slot="top"] .topButton {
  flex: 1 1 0 !important; min-width: 0 !important; width: auto !important;
  margin: 0 !important; white-space: nowrap !important;
  overflow: hidden; text-overflow: ellipsis;
  font-size: 12px !important; padding: 7px 6px !important;
  display: inline-flex !important; align-items: center; justify-content: center;
}

/* Tab 栏 */
#painel > .ext-ai-tabs {
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

/* 页容器 */
#painel > .ext-ai-page { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 4px 8px 12px; box-sizing: border-box; }
#painel > .ext-ai-page[hidden] { display: none !important; }

/* ── 按当前 Tab 显隐 core 的节点（data-ext-ai-tab 挂在 #painel 上）── */
#painel[data-ext-ai-tab="ai"] > [data-ext-ai-slot="sim"] { display: none !important; }
#painel[data-ext-ai-tab="sim"] > .ext-ai-page--ai { display: none !important; }

/* 仿真设置页内的 core 元素跟随容器宽度（滑块 canvas 是定宽 166 画的） */
#painel[data-ext-ai-tab="sim"] > [data-ext-ai-slot="sim"] { max-width: 100%; box-sizing: border-box; }
#painel[data-ext-ai-tab="sim"] > canvas[data-ext-ai-slot="sim"] {
  width: calc(100% - 16px) !important; margin: 0 8px 6px !important; height: 18px !important; display: block;
}
#painel[data-ext-ai-tab="sim"] > div[data-ext-ai-slot="sim"].topSpace { padding: 2px 8px 0 !important; }
#painel[data-ext-ai-tab="sim"] > label[data-ext-ai-slot="sim"] { padding: 2px 8px 0 !important; display: block; }
#painel[data-ext-ai-tab="sim"] > iframe[data-ext-ai-slot="sim"] { width: calc(100% - 16px) !important; margin: 0 8px !important; }

/* 窄屏：保持 core 的抽屉行为 */
@media only screen and (max-width: 600px) {
  :root { --ext-ai-panel-w: 100vw; }
  #painel { width: 0 !important; }
  .trigger:checked ~ #painel { width: 88vw !important; }
  .mainToolbar, .canvasWrapper { right: 0 !important; }
  /* 工具栏按钮绝对定位横排，窄屏放不下 → 允许横向滑动查看后面的按钮
     （core 在元素上写了 style.overflow=hidden，内联优先级高，这里必须 !important + 指定子属性） */
  .mainToolbar {
    overflow-x: auto !important;
    overflow-y: hidden !important;
    -webkit-overflow-scrolling: touch;
  }
  .mainToolbar::-webkit-scrollbar { height: 4px; }
  .mainToolbar::-webkit-scrollbar-thumb { background: rgba(0,0,0,.25); border-radius: 2px; }
  /* 展开后把手会落到「重置/RUN」按钮区（core 的 right:128px 是按 128px 侧栏算的）。
     垂直下移到 Tab 栏下方，避开按钮行，保持可点。 */
  .triggerLabel { top: 108px !important; height: 42px !important; }
  .trigger:checked + .triggerLabel { right: 88vw !important; }
}
`;

// ── 状态 ────────────────────────────────────────────────────────────
let styleEl = null;
let painel = null;
let origAppendChild = null;
let origInsertBefore = null;
let tabsEl = null;
let pageAi = null;
let activeTab = TAB_AI;

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


/** 发送消息（当前：无模型时给出能力提示；有 Key 时走 OpenAI 兼容接口） */
async function sendMessage() {
    const text = (inputEl.value || "").trim();
    if (!text) return;
    inputEl.value = "";
    appendChat("user", text);
    pushHistory("user", text);

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

    const sys = { role: "system", content:
        "你是 ExtCircuitJS 的电路助手。回答要简短、给具体数值和单位。" +
        "涉及电路计算时优先说明依据；不要编造仿真结果。" +
        "当前电路有 " + (window.ExtCircuitJS?.api?.listComponents?.().length ?? 0) + " 个元件。" };
    const msgs = [sys, ...loadHistory().slice(-20)];

    // 流式气泡：边收边渲染（SSE 增量）
    const bubble = appendChat("assistant", "…");
    abortCtrl = new AbortController();
    try {
        const full = await chatStream({
            messages: msgs,
            signal: abortCtrl.signal,
            onDelta: (acc) => { bubble.innerHTML = renderInline(acc); chatLog.scrollTop = chatLog.scrollHeight; },
        });
        bubble.innerHTML = renderInline(full || "(空回复)");
    } catch (e) {
        bubble.parentElement?.remove();
        if (e?.name !== "AbortError") appendChat("assistant", `请求失败：${e?.message ?? e}`);
    } finally {
        abortCtrl = null;
    }
}

// ── 布局接管 ────────────────────────────────────────────────────────

/** 判断节点是否属于"顶部按钮行"（buttonPanel 及其子节点） */
function isTopbarNode(node) {
    const bp = window.ExtCircuitJS?.app?.ui?.buttonPanel;
    return bp != null && (node === bp || bp.contains(node));
}

/** 接管 #painel 的插入：只**打标记**，不搬节点。
 *
 *  早期版本把 core 的节点搬进自建容器，代价是：
 *   · core 的 setiFrameHeight() 按 #painel 子节点算高度，搬走后算错 → 大片空白；
 *   · 移动正在加载的 iframe 会中断请求（CI 上 net::ERR_ABORTED）；
 *   · removeWidgetFromVerticalPanel 的 `parentNode === verticalPanel` 判定失效 → 泄漏。
 *  现在改为「**原位不动，只按页打 data 属性**」，由 CSS 的 order/display 完成布局：
 *   · 所有节点仍是 #painel 的直接子节点，core 的一切判定与高度计算都不受影响；
 *   · 新增节点时 appendChild 只负责打标记（isTopbarNode → data-ext-ai-slot=top）。
 */
function installRedirects() {
    origAppendChild = painel.appendChild.bind(painel);

    painel.appendChild = function (node) {
        const r = origAppendChild(node);
        try {
            if (node !== tabsEl && node !== pageAi) {
                markSlot(node);
            }
        } catch { /* 标记失败不影响插入 */ }
        return r;
    };

    // insertBefore 同样只放行 + 打标记（core 的 addWidgetToVerticalPanel 会用它插到 iframe 前）
    origInsertBefore = painel.insertBefore.bind(painel);
    painel.insertBefore = function (node, ref) {
        const r = origInsertBefore(node, ref);
        try {
            if (node !== tabsEl && node !== pageAi) {
                markSlot(node);
            }
        } catch { /* ignore */ }
        return r;
    };
}

/** 给节点打槽位标记：顶部按钮行 or 仿真设置页 */
function markSlot(node) {
    if (node == null || node.nodeType !== 1) return;
    if (isTopbarNode(node)) {
        node.dataset.extAiSlot = "top";
    } else if (node.tagName === "IFRAME") {
        node.dataset.extAiSlot = "sim";   // iframe 属仿真设置页
    } else {
        node.dataset.extAiSlot = "sim";
    }
}

/** 给 #painel 里已存在的子节点打标记（首次安装时执行一次） */
function partitionExisting() {
    for (const node of Array.from(painel.children)) {
        if (node === tabsEl || node === pageAi) continue;
        markSlot(node);
    }
}

/** 建骨架：只插入 Tab 栏与 AI 页容器。
 *  **不建"仿真设置页"容器**：core 的节点必须留在 #painel 原位（否则高度计算错、iframe 中断），
 *  所以「仿真设置页」不是一个容器，而是「所有 data-ext-ai-slot=sim 的节点」这个集合，
 *  由 CSS 的 order 排在 Tab 栏下方、按 data-ext-ai-tab 整体显隐。 */
function buildSkeleton() {
    tabsEl = document.createElement("div");
    tabsEl.className = "ext-ai-tabs";

    pageAi = buildAiPage();

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

    origAppendChild(tabsEl);
    origAppendChild(pageAi);
}

function selectTab(id) {
    activeTab = id;
    for (const b of tabsEl.querySelectorAll(".ext-ai-tab")) {
        b.setAttribute("aria-selected", String(b.dataset.tab === id));
    }
    pageAi.hidden = id !== TAB_AI;
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
        clearAiConfig();
        clearHistory();
        if (chatLog) chatLog.innerHTML = "";
        for (const id of ["#ext-ai-baseurl", "#ext-ai-key", "#ext-ai-model"]) settingsEl.querySelector(id).value = "";
        settingsEl.querySelector("#ext-ai-hint").textContent = "已清除。";
    });

    // MCP 状态：定时轮询即可（不订阅仿真事件——那是 sim.observe 的语义，
    // 也会干扰插件计数的契约测试；状态变化是秒级事件，1.5s 轮询足够）。
    const mcpTimer = setInterval(renderMcpStatus, 1500);
    ctx.effect(() => clearInterval(mcpTimer));

    ctx.effect(() => {
        if (!wired) return;
        // 还原接管（节点从未被搬走，无需搬回；只还原被包装的方法与标记）
        if (origAppendChild) painel.appendChild = origAppendChild;
        if (origInsertBefore) painel.insertBefore = origInsertBefore;
        for (const n of Array.from(painel.querySelectorAll("[data-ext-ai-slot]"))) {
            try { delete n.dataset.extAiSlot; } catch { /* ignore */ }
        }
        tabsEl?.remove(); pageAi?.remove();
        styleEl?.remove(); styleEl = null;
        painel = null; tabsEl = pageAi = null;
        chatLog = inputEl = sendBtn = settingsEl = mcpStatusEl = null;
        wired = false;
    });

    ctx.log("activated: 侧栏已重构（AI 助手 / 仿真设置 双 Tab）");
}

export function deactivate() {
    // 清理在 ctx.effect 里；这里留空（宿主会调 effect）
}
