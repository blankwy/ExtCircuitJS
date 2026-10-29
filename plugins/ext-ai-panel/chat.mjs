// ext-ai-panel —— AI 会话逻辑（流式 SSE + 会话历史），独立模块便于维护
//
// 设计（调研结论，见 docs/SKILL-DELEGATION.md）：
//   · 不引 Vercel AI SDK（unpacked 11.6MB，打进产物 +150-300KB gzip，侧栏用不上那么多）
//   · 手写 OpenAI 兼容 SSE 流式解析（~60 行零依赖）——OpenAI/DeepSeek/ollama/one-api 全是这套协议
//   · 会话历史存 localStorage（最近 40 条），Key/Provider 配置也是 localStorage

const HISTORY_KEY = "ext.ai.history";
const CFG_KEY = "ext.ai.config";

export function loadAiConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch { return {}; }
}
export function saveAiConfig(cfg) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* 隐私模式 */ }
}
export function clearAiConfig() {
    try { localStorage.removeItem(CFG_KEY); } catch { /* ignore */ }
}

let history = [];
try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { history = []; }

export function loadHistory() { return history.slice(); }
export function pushHistory(role, content) {
    history.push({ role, content, t: Date.now() });
    if (history.length > 40) history = history.slice(-40);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* 隐私模式 */ }
}
export function clearHistory() {
    history = [];
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}

/**
 * 流式对话。onDelta(text) 逐段回调（增量），返回完整回复。
 * 兼容所有 OpenAI 协议的 provider（用户在设置里填 baseURL）。
 */
export async function chatStream({ messages, onDelta, signal }) {
    const cfg = loadAiConfig();
    if (!cfg.apiKey || cfg.provider === "none") {
        throw new Error("NO_KEY");
    }
    const baseUrl = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const model = cfg.model || "gpt-4o-mini";

    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model, messages, stream: true, temperature: 0.3 }),
        signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let acc = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop(); // 最后一段可能不完整，留给下一轮
        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            try {
                const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
                if (delta) {
                    acc += delta;
                    try { onDelta?.(acc); } catch { /* UI 错误不中断流 */ }
                }
            } catch { /* SSE 跨块 JSON：忽略，后续块补上 */ }
        }
    }
    pushHistory("assistant", acc);
    return acc;
}
