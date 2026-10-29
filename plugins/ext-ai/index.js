// ext-ai —— 顶部菜单「AI」：MCP 连接配置 + Agent Skill 安装说明
//
// 为什么做成菜单而不是侧栏卡片：这是**一次性配置**，用户配好就不再看；
// 常驻侧栏只会占地方（hello 示例面板的教训）。
//
// 两个菜单项：
//   MCP 配置      弹出可直接复制的 JSON 配置（含绝对路径）+ 连接步骤 + 可用工具表
//   Skill 安装    弹出 npm / git 两种安装方式 + 用法示例
//
// 实现要点：
//   · 顶部菜单在 core 里由私有方法 addTopItem 组装；这里按其 DOM 结构（td.gwt-MenuItem
//     内含 ul.menuDropdown）自行构造，不改 core、不依赖私有 API。
//   · 弹窗用宿主 verticalPanel 之外的 fixed 覆盖层，卸载时随 fiber 一起清理。

const MCP_PKG = "https://www.npmjs.com/package/ee-circuit-draw-simulator";
const SKILL_REPO = "https://github.com/blankwy/ee-circuit-draw-simulator";

// ── 工具函数 ────────────────────────────────────────────────────────

/** 弹窗（阻塞式覆盖层）。返回 close 函数。 */
function openDialog(title, buildBody) {
    const mask = document.createElement("div");
    mask.dataset.extAiDialog = "1";
    mask.style.cssText = [
        "position:fixed", "inset:0", "background:rgba(15,23,42,.45)",
        "display:flex", "align-items:center", "justify-content:center",
        "z-index:99998", "padding:20px", "overflow:auto",
    ].join(";");

    const box = document.createElement("div");
    box.style.cssText = [
        "background:#fff", "color:#1f2937", "border-radius:12px",
        "max-width:760px", "width:100%", "max-height:86vh", "overflow:auto",
        "box-shadow:0 18px 48px rgba(0,0,0,.28)",
        "font:14px/1.65 system-ui,-apple-system,'Segoe UI',Arial,sans-serif",
    ].join(";");

    const head = document.createElement("div");
    head.style.cssText = [
        "display:flex", "align-items:center", "justify-content:space-between",
        "padding:16px 20px", "border-bottom:1px solid #e5e7eb",
        "position:sticky", "top:0", "background:#fff", "z-index:1",
    ].join(";");
    const h = document.createElement("strong");
    h.textContent = title;
    h.style.cssText = "font-size:16px";
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "关闭";
    x.style.cssText = [
        "background:none", "border:0", "font-size:22px", "line-height:1",
        "cursor:pointer", "color:#6b7280", "padding:0 4px",
    ].join(";");
    head.append(h, x);

    const body = document.createElement("div");
    body.style.cssText = "padding:18px 20px 22px";
    buildBody(body);

    box.append(head, body);
    mask.appendChild(box);
    document.body.appendChild(mask);

    const close = () => mask.remove();
    x.addEventListener("click", close);
    mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
    const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
    return close;
}

/** 代码块（带复制按钮） */
function codeBlock(text) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;margin:10px 0 16px";

    const pre = document.createElement("pre");
    pre.textContent = text;
    pre.style.cssText = [
        "background:#0f172a", "color:#e2e8f0", "padding:14px 16px",
        "border-radius:8px", "overflow-x:auto", "margin:0",
        "font:12.5px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace",
        "white-space:pre",
    ].join(";");

    const btn = document.createElement("button");
    btn.textContent = "复制";
    btn.style.cssText = [
        "position:absolute", "top:8px", "right:8px",
        "background:#334155", "color:#e2e8f0", "border:0", "border-radius:5px",
        "padding:4px 9px", "font-size:11.5px", "cursor:pointer",
    ].join(";");
    btn.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(text);
            btn.textContent = "已复制";
        } catch {
            // 降级：选中 pre 内容
            const range = document.createRange();
            range.selectNodeContents(pre);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            btn.textContent = "请按 Ctrl+C";
        }
        setTimeout(() => { btn.textContent = "复制"; }, 1800);
    });

    wrap.append(pre, btn);
    return wrap;
}

/** 段落 / 小标题 / 提示 */
function para(html) {
    const p = document.createElement("p");
    p.innerHTML = html;
    p.style.cssText = "margin:0 0 10px;color:#374151";
    return p;
}
function h3(text) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "font-weight:600;font-size:13.5px;color:#111827;margin:18px 0 6px";
    return el;
}
function note(html) {
    const el = document.createElement("div");
    el.innerHTML = html;
    el.style.cssText = [
        "background:#f0f9ff", "border-left:3px solid #0ea5e9",
        "padding:10px 12px", "border-radius:4px", "margin:10px 0",
        "color:#0c4a6e", "font-size:13px",
    ].join(";");
    return el;
}

/** 推断本页所在站点的根 URL（用于生成 MCP baseUrl 提示） */
function siteRoot() {
    const u = new URL(window.location.href);
    // 页面可能是 /circuitjs.html 或 /<repo>/circuitjs.html
    const dir = u.pathname.replace(/\/[^/]*$/, "");
    return `${u.origin}${dir}`;
}

/** 猜仓库根绝对路径（MCP 配置里需要）。
 *  页面在 dev 或 dist 下都无法得知仓库绝对路径，给占位让用户替换。 */
function guessRepoRoot() {
    return "C:/path/to/ExtCircuitJS";
}

// ── 两个弹窗 ────────────────────────────────────────────────────────

function showMcpDialog() {
    openDialog("接入 MCP（让 AI 直接操作电路）", (body) => {
        body.append(
            para("MCP 服务器让 Claude Desktop / Cline / 任何 MCP 客户端<b>直接读写当前电路</b>：读网表、改参数、跑仿真、读电压、截图。"),
            note("前提：本机装了 <b>Node ≥ 22</b> 和 <b>Chrome 或 Edge</b>。<br>服务器会自己拉起 dev server 和无头浏览器，不用手动开。"),
        );

        body.append(h3("1. 在 MCP 客户端配置里加这一段"));
        const repo = guessRepoRoot();
        body.append(codeBlock(JSON.stringify({
            mcpServers: {
                extcircuitjs: {
                    command: "node",
                    args: [`${repo}/tools/ext.mjs`, "mcp"],
                },
            },
        }, null, 2)));
        body.append(para(`把 <code>${repo}</code> 换成你仓库的实际路径（<code>/</code> 与 <code>\\\\</code> 都可以）。`));

        body.append(h3("2. 重启客户端，确认工具出现"));
        body.append(para("连接成功后会看到这些工具："));

        const table = document.createElement("table");
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0 4px";
        const rows = [
            ["circuit.get_netlist", "读网表（元件 / 稳定 id / 连接）"],
            ["circuit.load_netlist", "载入电路文本 / XML / 网表 JSON"],
            ["circuit.list_components", "元件清单"],
            ["circuit.set_param", "改元件参数"],
            ["sim.step", "确定性步进（数值可复现）"],
            ["sim.run / sim.stop", "实时步进 开/关"],
            ["sim.reset", "复位"],
            ["sim.read_measurements", "读电压 / 电流"],
            ["sim.read_scope", "读波形（默认降采样）"],
            ["schematic.screenshot", "电路截图"],
        ];
        for (const [name, desc] of rows) {
            const tr = document.createElement("tr");
            const td1 = document.createElement("td");
            td1.textContent = name;
            td1.style.cssText = "padding:5px 8px;border-bottom:1px solid #f1f5f9;font-family:ui-monospace,Consolas,monospace;color:#0f766e;white-space:nowrap";
            const td2 = document.createElement("td");
            td2.textContent = desc;
            td2.style.cssText = "padding:5px 8px;border-bottom:1px solid #f1f5f9;color:#374151";
            tr.append(td1, td2);
            table.appendChild(tr);
        }
        body.appendChild(table);

        body.append(h3("3. 试试这句"));
        body.append(codeBlock("载入 lrc 电路，把电阻改成 2.2k，跑 2ms，告诉我 n1 的电压"));
        body.append(note(`当前页面地址：<code>${siteRoot()}</code><br>也可用环境变量 <code>EXC_BASE</code> 指向已有服务，避免重复启动。`));
    });
}

function showSkillDialog() {
    openDialog("安装 Agent Skill（让 AI 助手会画电路）", (body) => {
        body.append(
            para("<b>ee-circuit-draw-simulator</b> 是一个 Agent Skill：让 AI 助手真的把电路跑起来——载入或现造电路、改参数、确定性推进仿真、读电压、采波形、扫参数、出 SVG，最后给一个点开就能拖滑块调参的分享链接。"),
            para(`数值来自真实引擎（本项目的 ExtCircuitJS），不是模型背下来的公式。<br>包地址：<a href="${MCP_PKG}" target="_blank" rel="noopener noreferrer">${MCP_PKG}</a>`),
        );

        body.append(h3("方式一：npm（最省事）"));
        body.append(codeBlock([
            "# 一次性准备（克隆引擎 + 装依赖 + 构建，约 2–4 分钟）",
            "npx ee-circuit-draw-simulator@latest setup",
            "",
            "# 之后直接问电路问题，或手动跑：",
            "npx ee-circuit-draw-simulator run --circuit lrc --step 0.005 --measure all",
        ].join("\n")));

        body.append(h3("方式二：克隆（当技能用，推荐）"));
        body.append(codeBlock([
            `git clone ${SKILL_REPO}.git ~/ee-circuit-draw-simulator`,
            "cd ~/ee-circuit-draw-simulator",
            "node scripts/circuitlab.mjs setup",
        ].join("\n")));

        body.append(h3("装进你的助手"));
        body.append(para("技能就是一个根目录带 <code>SKILL.md</code> 的文件夹，各家只有搜索路径不同："));

        const table = document.createElement("table");
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0 12px";
        const hdr = document.createElement("tr");
        for (const t of ["助手", "用户级路径"]) {
            const th = document.createElement("th");
            th.textContent = t;
            th.style.cssText = "text-align:left;padding:6px 8px;border-bottom:2px solid #e5e7eb;font-size:12px;color:#6b7280";
            hdr.appendChild(th);
        }
        table.appendChild(hdr);
        for (const [name, path] of [
            ["Claude Code", "~/.claude/skills/"],
            ["Codex CLI", "~/.codex/skills/"],
            ["DeepSeek Harness", "~/.dsh/skills/ 或 ~/.agents/skills/"],
        ]) {
            const tr = document.createElement("tr");
            const td1 = document.createElement("td");
            td1.textContent = name;
            td1.style.cssText = "padding:5px 8px;border-bottom:1px solid #f1f5f9";
            const td2 = document.createElement("td");
            td2.textContent = path;
            td2.style.cssText = "padding:5px 8px;border-bottom:1px solid #f1f5f9;font-family:ui-monospace,Consolas,monospace;color:#0f766e";
            tr.append(td1, td2);
            table.appendChild(tr);
        }
        body.appendChild(table);

        body.append(codeBlock([
            "# macOS / Linux",
            "mkdir -p ~/.claude/skills",
            "ln -s ~/ee-circuit-draw-simulator ~/.claude/skills/ee-circuit-draw-simulator",
            "",
            "# Windows PowerShell",
            'New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\\.claude\\skills\\ee-circuit-draw-simulator" -Target "$env:USERPROFILE\\ee-circuit-draw-simulator"',
        ].join("\n")));

        body.append(h3("怎么用"));
        body.append(para("装好后直接问电路问题，问题匹配时会自动触发："));
        body.append(codeBlock([
            "这个 RC 滤波器的截止频率是多少？",
            "555 定时器的 R2 换成 22k 会怎样？",
            "画个输出波形给我看",
            "我想自己调调看",
        ].join("\n")));

        body.append(note("已经有本仓库的引擎？设 <code>EXTCIRCUIT_HOME</code> 指过去，可跳过 setup 的克隆步骤。"));
    });
}

// ── 顶部菜单挂载 ────────────────────────────────────────────────────

/** 在顶部菜单栏（File/Edit/Draw/...）末尾加一个「AI」顶级项 */
function installAiMenu() {
    const app = window.ExtCircuitJS?.app;
    const row = app?.menus?.menuBarRow;
    if (!row) return { ok: false, reason: "menuBarRow 未就绪" };
    if (row.querySelector('[data-ext-menu-root="ai"]')) return { ok: true };

    // 按 core addTopItem 的 DOM 结构自建：td.gwt-MenuItem > ul.menuDropdown
    const td = document.createElement("td");
    td.className = "gwt-MenuItem";
    td.setAttribute("role", "menuitem");
    td.setAttribute("aria-haspopup", "true");
    td.dataset.extMenuRoot = "ai";
    td.textContent = "AI";

    const ul = document.createElement("ul");
    ul.className = "menuDropdown";

    const item = (label, hint, onClick) => {
        const li = document.createElement("li");
        li.className = "menuItem";
        li.style.cssText = "cursor:pointer";
        li.innerHTML = `<span class="itemLabel">${label}</span>` +
            (hint ? `<span class="shortcutHint" style="opacity:.6;margin-left:10px;font-size:11px">${hint}</span>` : "");
        li.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
        li.addEventListener("click", (e) => {
            e.stopPropagation();
            // 关掉所有打开的菜单（与 core 的 closeAllMenus 同语义）
            document.querySelectorAll(".gwt-MenuItem.open, .topMenuItem.open, li.hasSubmenu.open")
                .forEach((el) => el.classList.remove("open"));
            onClick();
        });
        return li;
    };

    ul.append(
        item("MCP 配置", "让 AI 直接操作电路", showMcpDialog),
        item("Skill 安装", "让 AI 会画电路", showSkillDialog),
    );

    td.appendChild(ul);
    row.appendChild(td);

    // 顶层项的开合行为（与 core addTopItem 一致）
    td.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasOpen = td.classList.contains("open");
        document.querySelectorAll(".gwt-MenuItem.open, .topMenuItem.open")
            .forEach((el) => el.classList.remove("open"));
        if (!wasOpen) td.classList.add("open");
    });
    td.addEventListener("mouseover", () => {
        if (document.querySelector(".gwt-MenuItem.open, .topMenuItem.open")) {
            document.querySelectorAll(".gwt-MenuItem.open, .topMenuItem.open")
                .forEach((el) => el.classList.remove("open"));
            td.classList.add("open");
        }
    });

    return { ok: true, el: td };
}

// ── 插件入口 ────────────────────────────────────────────────────────

let menuEl = null;

export async function activate(ctx) {
    const r = installAiMenu();
    menuEl = r.el ?? null;
    if (!r.ok) {
        ctx.log(`AI 菜单安装失败: ${r.reason}`);
    }

    // 命令面板里也放两条（菜单不方便时用）
    ctx.command({
        id: "ext-ai.mcp",
        label: "AI：MCP 配置",
        category: "Ext",
        keywords: "ai mcp config 配置 接入",
        run: showMcpDialog,
    });
    ctx.command({
        id: "ext-ai.skill",
        label: "AI：Skill 安装",
        category: "Ext",
        keywords: "ai skill install 安装 技能",
        run: showSkillDialog,
    });

    ctx.effect(() => {
        menuEl?.remove();
        menuEl = null;
        document.querySelectorAll("[data-ext-ai-dialog]").forEach((el) => el.remove());
    });

    ctx.log("activated: ext-ai（顶部菜单 + 2 个命令）");
}

export function deactivate() {
    menuEl?.remove();
    menuEl = null;
    document.querySelectorAll("[data-ext-ai-dialog]").forEach((el) => el.remove());
}
