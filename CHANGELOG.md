# Changelog

## v0.1.3（未发布）

插件补齐了"用户动作"这一层：**打开/保存**可以介入并改写文本，**选中/点击元件**有事件了。
此前插件只能订阅仿真事件，用户开档、存档、选元件对它完全不可见。

### 打开 / 保存钩子（`ctx.hook`）
- 新增 `cover/ts/ExtHooks.ts`：包住 `loader.readCircuit` 与 `app.dumpCircuit`
  —— 上游所有读写入口（文件、URL、剪贴板、导入、保存、导出、撤销、崩溃恢复）都汇到这两个方法
- 每次回调带 `meta.source`：`document`（用户真的在开/存）/ `undo` / `recovery` / `paste` / `internal`
  （`isModified` 的文本比较、`popContext` 的上下文恢复）。插件按 `source === "document"` 过滤即可，
  否则每按一个键都会收到一次"保存"
- 处理链：多个处理器顺序执行、后者看到前者结果；返回字符串即替换文本，返回其它值不改；
  单个处理器抛错只记日志（绝不阻断开档）；同名钩子重入直通（防止 `save` 里再 `dumpCircuit` 套娃）
- `packages/plugin-api`：`ExtPluginContext.hook(name, handler)` + `ExtHookName/ExtHookSource/ExtHookMeta`
- `ExtBoot` 在插件装载**之前**完成接线，插件 `activate` 里注册即刻生效

### 元件交互事件（`select` / `elemclick`）
- 新增 `cover/ts/ExtElementEvents.ts`：旁观画布与键盘（mouseup / click / keyup），
  比对"选中集合指纹"（选中元件在 `elmList` 的下标序列）后才发事件 —— 只包 `setSelected` 之类会漏，
  挨个包 MouseManager 私有方法又会绑死上游实现，所以改成观察-比对
- `select`：`{ count, elms, indices, ids }`；`elemclick`：`{ elm, index, type, grid, screen, button }`
- `window.ExtCircuitJS.refreshSelection()`：插件自己改完选择、或脚本直接 `setSelected` 后手动同步
- rAF 合并（同一帧多次指针事件只比对一次），另有 100ms 兜底，隐藏标签页也不丢事件

### 示例与测试
- 新增示例插件 `plugins/ext-hook`：载入时规范化（去 UTF-8 BOM、CRLF→LF、去掉尾部版本标记），
  保存时（仅 `document`）追加版本标记；两处改写都幂等
- 新增 `tests/contract/hooks.test.mjs`（9 例，纯 Node，进 CI）：加工链 / 非字符串返回值 / 错误隔离 /
  重入保护 / `withSource` 嵌套与抛错恢复 / disposer / `wireAppHooks` 的来源标注与还原
- 新增 `tests/contract/plugin-hooks.browser.test.mjs`：保存带标记 → 幂等 → 存档往返 →
  撤销快照不带标记（来源过滤生效）→ BOM+CRLF 文件可打开 → 卸载后钩子归零、对照组建档打不开
- 新增 `tests/contract/element-events.browser.test.mjs`：真实鼠标点元件 → `elemclick`；
  Ctrl+A → `select` count=1；点空白 → count=0；`refreshSelection()` 手动同步

### 修
- `tests/contract/reload.browser.mjs` 把插件数量与"卸载后只剩 hello"写死了（4 个），
  加示例插件后一直红。改为以 `plugins/plugins.manifest.json` 为准（数量、集合、卸载后剩余都派生），
  以后加插件不再需要改这个测试

## v0.1.2（未发布）

插件第一次能"改动仿真器本身"：自定义元件从类、存档类型到菜单入口连同卸载一次性打通。
此前 ElementFactory 的 owner/注销、ExtMenus 的菜单插槽都只被测试直接调用过，运行期从没接过线。

### 插件自定义元件（`ctx.element`）
- 新增 `cover/ts/ExtElements.ts`：一次注册把**四件事**同时做掉——类进 `ElementFactory`（可放置/可 create）、
  `dumpType`/`xmlType` 进 `CirSim` 的两张映射（文本与 XML 存档能读回）、Draw/右键菜单加条目、
  卸载时四样一起撤回（含"正停在放置模式"的复位）
- `packages/plugin-api`：`ExtPluginContext.element`（`register / unregister / list / base / freeDumpType`）；
  `register` 失败即抛错并随 fiber 回滚，与 `ctx.command` 同口径
- `cover/ts/ElementFactory.ts`：新增 `getClass()`——插件不能 import core 内部模块，
  基类只能经 `ctx.element.base("ResistorElm")` 这样拿
- `cover/ts/ExtMenus.ts`：新增 `unregisterMenuElement(className)`（原先只有按 owner 批量撤销）
- `cover/ts/ExtBoot.ts`：启动时装菜单插槽，并把菜单实现注入 `ExtElements`
  （`ExtElements` 必须能被 Node 契约测试直接加载，故不静态 import `CirSim`/`ExtMenus`）
- `window.ExtCircuitJS.elements`：暴露**同一份**元件工厂实例（`factory/list/has/ownerOf`）——
  dev 下 `import("/ElementFactory.ts")` 拿到的是另一个模块 URL、第二份 classMap

### 示例与测试
- 新增示例插件 `plugins/ext-element`（继承核心 `ResistorElm` 的 0.5Ω 分流电阻，自动进 Draw/右键菜单）
- 新增 `tests/contract/plugin-element.browser.test.mjs`：注册 → 放置 → 文本往返 → XML 往返 → 卸载
  （类/映射/菜单/放置模式全清）→ 重新装载，全程 0 pageerror
- `tests/contract/menu.browser.mjs`（A06）改用 `window.ExtCircuitJS.elements.factory` 与独立类名，
  修掉它对"模块实例恰好相同"的隐式依赖

## v0.1.1（未发布，tag 待维护者打）

这一版把 v0.1.0 之后「只有真部署 / 真宿主才会暴露」的缺口补齐：静态站能不能当网站用、
站点信息能不能配、外部 MCP 客户端能不能直接接。

### 部署（GitHub Pages 可用）
- `dist/` 是可挂任意前缀的静态站：构建期把 HTML/`manifest.json` 的绝对路径改相对，
  生成 `index.html`（站点根直接进仿真器）、`.nojekyll`、`service-worker.js`（此前生产页面每次报 SW 404）
- `cover/ts/ExtPluginHost.ts`：三处硬编码 `/plugins/` 改为按 `document.baseURI` 推导（子路径下才不 404）
- `tools/coverOverlay.mjs`：交还打包器的 id 统一正斜杠——修掉 Windows 上「同一源码成为两个模块、
  `dist` 里两个 `CirSim` 类、启动即 TypeError」的生产构建缺陷（**dev 全绿 ≠ dist 能用**）
- `.github/workflows/pages.yml`（main 自动部署）；`ci.yml` 保留双平台 dist artifact
- 站点域名不进仓库：产物不含 `CNAME`，构建脚本不读任何站点地址

### 站点配置（`cover/site.config.json`）
- `title`（运行时标题基名）/ `htmlTitle` / `description` / `homeurl` / `about.{heading,html}`
- dev 与 build 共用一条注入路径（`extSiteConfig()` 插件）；改完刷新即生效；全留空 = 产物与上游逐字一致
- 「关于」页的自定义内容插在正文最前，上游 GPL/第三方许可段落原样保留

### MCP（外部宿主可直接接）
- **新增 stdio 服务器**：`node tools/ext.mjs mcp`（`packages/mcp/src/{stdio,backend,dev-server,server}.ts`），
  零依赖实现 MCP JSON-RPC（initialize 版本协商 / tools/list / tools/call / ping），
  任何 MCP 宿主按 `docs/mcp.md §6` 的配置即可接入
- 后端**懒启动**且自管理：探活 dev server（不可达则拉起，退出时回收进程树）→ headless Chrome 打开页面
  → 注入页面桥 → 会话式工具集；浏览器缺失时以 `isError` 工具结果暴露，而不是让服务器启动失败
- **新增工具 `sim.step`**（`steps` | `seconds`）：确定性推进，外部客户端终于能对拍数值
  （此前工具面只有墙钟 `sim.run`，读数不可复现）；`examples/ai-loop.mjs` 与 mcp-tools 契约同步改用它
- `packages/mcp/src/index.ts` 从骨架（含 `createAttachTransport` 未实现桩与重复工具清单）改为真入口

### 测试
- 新增 `tests/contract/mcp-stdio.test.mjs`（11 例，纯 Node，进 CI）：握手/协商/工具清单/未知工具与方法的错误码/
  坏帧/串行/截图 image content/stop 等在途
- 新增 `tests/contract/mcp-stdio.browser.mjs`（端到端）：独立进程 + 纯协议跑通「载入 → 读网表 → 改参数 →
  确定性步进 → 读电压 → 截图」，并断言 dev server 由服务器自己拉起、退出后端口释放
- 新增 `tests/contract/dist-site.browser.mjs`、`site-config.test.mjs`（见上两节）
- `tools/ts-resolve.mjs` 上移为公共加载钩子（测试侧保留 re-export shim），运行时与测试共用一份

## v0.1.0（2026-10-26）

ExtCircuitJS 首个发布：CircuitJS1 二开——core 只读 + cover 覆盖层 + plugins 宿主 + packages API 四层结构，AI 友好网表读写全链路。

### Stage 1 · 基线与测试基座
- doctor/build/boot.browser 三连全绿；cover status/scan 干净（local-only，无冲突）
- cover/public 静态覆盖（ext-cover.css）；ElementFactory 契约测试 + Node 加载 TS 的测试基座（ts-resolve hook）

### Stage 2 · 网表读写闭环
- `ext netlist registry`：registry.json 从 core/ts 可再生成（重跑 diff 为空，255 类/txtType 124）
- 373 语料导出对拍：元件数 100%、引脚聚合比 103.48%（相对引擎 ΣgetPostCount 零损失）
- ops 错误语义契约（unknown target/prop、add 未实现均结构化失败不抛异常）
- round-trip 幂等：372/372 逐例 diff=0
- 紧凑编码 compact.ts：聚合 0.2583× XML（验收线 ≤0.35×），`ext netlist bench` 基准
- 稳定 id（WeakMap + 全新电路重置），编辑后未受影响元件 id 不变；applyOps 双轨 target
- **G2 门禁**：set R1 10Ω→2.2kΩ → V(n1) 4.73V→8.53V（确定性步进）

### Stage 3 · 插件宿主完备
- Fiber 单测（LIFO/幂等/late dispose/abort）；事件多路复用（3 订阅全收 + 抛错隔离）
- 命令插槽冲突拒绝；面板插槽 DOM 卸载清理；plugin lint 三禁令（双向验证）
- 三示例插件同时启停零泄漏（监听器/命令/面板计数回基线）
- 热重载 ?rev= 换版本（旧命令不可见、旧 fiber 全释放、全程事件驱动）

### Stage 4 · 增量放置
- C04 设计文档先行（引擎语义核对 + GND 别名发现 + 自校验回滚方案）
- `place.ts`：add between nets——导线分裂 + 有界正交路线 + 放置后自校验失败即回滚
- **G3 门禁**：place smoke + 三插件 smoke + ops 闭环全绿

### Stage 5 · MCP 全链路
- 会话式 RPC（open/load/step/measure/close，结构化错误不抛异常）
- WebSocket 桥（环回守护、自动重连、会话跨重连存活、不改 core 仿真循环）
- 10 工具 attach 模式（read_scope 不降采样）
- ai-loop demo（读网表 → set 电阻 → 跑 2ms → 读电压前后对比）；docs/mcp.md 30 分钟跑通指南
- **G4 门禁**：mcp-session 11 pass + ai-loop EXIT=0

### Stage 6 · 工程收尾
- GitHub Actions CI（Windows+Ubuntu 双平台，云端首绿：doctor / build / lint / scan + 40 Node 契约测试）
- `core sync-drill`：假上游演练，scan 判定 upstream-changed / both-changed
- 菜单插槽 ExtMenus.ts：自定义元件进 Draw/右键菜单且可点、可卸载
- 版本 0.1.0、README 状态表刷新

### 发布前修复（v0.1.0 首发同日）
- **CI 潜伏 bug**：`tools/ext.mjs` 的 `ensureCoverDeps()`（给 `cover/node_modules` 建到 `core/ts/node_modules` 的链接）从 Stage 1 起只定义、从未被调用。开发机靠手工链接兜住，干净检出下 `vite build` 必报 `[UNRESOLVED_IMPORT] Could not resolve 'vitest/config'` → `ERR_MODULE_NOT_FOUND: vitest`。修复：dev/build 入口先建链接（失败即退出），Windows 依次 junction → `mklink /J` → symlink，doctor 增加该前置的 WARN 行。本 tag 已随修复移到该提交。

### 已知限制
- 浏览器契约测试依赖本机 Chrome + playwright-core（EXT_PW_CORE/EXT_CHROME），CI 暂只跑 Node 侧
- 仓库外 spike/ 目录的历史构建产物会触发本地 Mimosa 安全扫描误报（与 ExtCircuitJS 无关）
