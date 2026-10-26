# Stage 5 handoff（2026-10-26）

- 做了什么：D01 会话式 RPC + InMemory 假实现（944bf50）；D02 浏览器 WebSocket 桥（85eedf7，环回守护+自动重连+会话跨重连存活）；D03 十工具 attach 工具集（69fd544，每工具成功调用记录）；D04 ai-loop 闭环 demo（b1bc840，Lead 代提交——worker 被 Mimosa 对仓库外 spike/ 旧产物硬拦，按 stage4-design §9.3 处置）；D05 docs/mcp.md 30 分钟跑通指南（d298415）。
- 证据：`node --test tests/contract/mcp-session.test.mjs` 11 pass 0 fail EXIT=0；`node examples/ai-loop.mjs` EXIT=0，输出 V(n1) 4.80356V→8.53706V、V(n2) 4.36153V→-0.856021V（Δ-5.22V>0.01 自检过）；`node --test tests/contract/mcp-bridge.browser.test.mjs` 7 pass（echo/重连存活/SSRF 守护）；`mcp-tools.browser.test.mjs` 10/10 工具成功调用。
- 卡在哪：无。执行侧说明：GLM-5.3-Flash 免费额度耗尽（provider code 1005），工作流停在 D03 复验后；D04 由 Lead 代提交，D05 起全部 Lead 直做（用户批准）。
- 下一步：Stage 6（A04 CI / A03 sync-drill / A06 菜单插槽 / REL 发布）。用户收尾三件事：push 看 GitHub Actions 首绿、打 tag v0.1.0、spike/ 扫描发现处置（豁免或销账）。
- 消耗：工作流期 F/G worker 约 500 万+ token（Stage 3/4/5 前四卡）；额度耗尽后 D05 起由 Lead（GLM-5.3）直做，约 20 万。

## 各卡要点

- **D01**：SessionRpc 六方法（open/load/step/measure/export/close）+ isAlive 存活校验；结构化错误 `{ok:false,error:{code,message}}` 不抛异常；InMemorySessionRpc 每会话独立时间轴（步长 5e-6 对齐 CircuitLoader）；handleSessionRequest 线协议分发器供 D02 复用。
- **D02**：页面内桥动态 import 后自挂 `window.ExtCircuitJS.mcp`（不进主包图、不动 ExtBoot）；环回守护（仅 127.0.0.1）+ 自动重连，会话/连接解耦——跨重连存活；step 按 G2 冻结墙钟配方拉取步进，不改 core 仿真循环；Node 侧零依赖 RFC6455 实现仅监听环回。
- **D03**：MCP_TOOLS 10 工具声明 + AttachToolset（懒开会话持同一活电路，参数校验+结构化返回）；sim.read_scope 全量环形缓冲不降采样（禁止项遵守）；set_param 经 applyOps+G2 重 stamp。
- **D04**：ai-loop 一条命令全链路（桥+工具面），两组参数各自重载 lrc 干净初始条件，ΔV 退出码自检。
- **D05**：环境/echo 自测/demo/工具速查/错误语义/最小客户端骨架，全部命令可复制执行。

## G4 门禁（Lead 亲跑，2026-10-26）

```
node --test tests/contract/mcp-session.test.mjs   → 11 pass / 0 fail, EXIT=0
node examples/ai-loop.mjs                          → EXIT=0, "demo OK: 电压随参数变化且有限"
```
外部标准 stdio 客户端接入留待 push 后按 docs/mcp.md §4 骨架验证（本阶段内以 ai-loop 全链路等价覆盖）。
