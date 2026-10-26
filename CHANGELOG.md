# Changelog

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
