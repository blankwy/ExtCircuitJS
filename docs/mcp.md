# ExtCircuitJS MCP 全链路指南

> 目标：新人 30 分钟内跑通「读网表 → 改参数 → 跑仿真 → 读电压」闭环。
> 架构一句话：外部客户端（Node/任一 MCP 宿主）→ 本地环回 WebSocket（D02 桥）→ 页面内 `ExtMcpBridge`（挂在 `window.ExtCircuitJS.mcp`）→ 真实引擎。会话式 RPC（spike C 结论：必须会话式，重建会丢时间轴与 scope 状态）。

```
Node 客户端 (AttachToolset)  ── ws://127.0.0.1:<port> ──  页面内桥 (ExtMcpBridge)
      packages/mcp/src/tools.ts            cover/ts/ExtMcpBridge.ts
                    └──────── 同一活电路（会话内存活）─────────┘
```

## 0. 环境（5 分钟）

- Node ≥ 22；本机 Chrome；playwright-core（任意安装位置，路径用 `EXT_PW_CORE` 指定）。
- 启动 dev server：

```bash
cd ExtCircuitJS
node tools/ext.mjs dev --port 5174        # 终端 1，保持运行
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5174/circuitjs.html   # 应 200
```

环境变量（都有默认值，可按需覆盖）：`EXT_PW_CORE`（playwright-core 的 index.mjs 绝对路径）、
`EXT_CHROME`（chrome.exe 绝对路径）、`EXC_BASE`（默认 `http://127.0.0.1:5174`）。

## 1. echo 自测（2 分钟）

```bash
node --test tests/contract/mcp-bridge.browser.test.mjs   # 7 例：协议层/echo/会话链路/重连存活/SSRF 守护
node --test tests/contract/mcp-session.test.mjs          # 11 例：会话 RPC 顺序与错误语义（纯 Node，无浏览器）
```

两条全绿即桥与会话层就绪。

## 2. ai-loop 闭环 demo（3 分钟）

```bash
node examples/ai-loop.mjs
```

一条命令输出（真实值示例）：

```
── 基线 R=10Ω ──           ── 改参 R=2.2kΩ ──
V(n1) = 4.80356 V           V(n1) = 8.53706 V
V(n2) = 4.36153 V           V(n2) = -0.856021 V
demo OK: 电压随参数变化且有限（max |ΔV(n2)| = 5.21755 V > 0.01）
```

demo 做的事：载入 lrc.txt → `circuit.get_netlist` 读元件与稳定 id → `circuit.set_param` 改电阻
10Ω→2.2kΩ → 桥 `step` 推进 2ms（确定性：页面侧冻结墙钟 + analyzeCircuit → preStampAndStampCircuit
→ runCircuit）→ `sim.read_measurements` 读全网电压 → 前后对比。

## 3. 工具速查（AttachToolset）

`new AttachToolset(bridge, { timeoutMs })` 后 `await tools.call(name, args)`；所有返回结构化
JSON，失败形如 `{ok:false, error:{code,message}}`，**绝不抛异常**。

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `circuit.get_netlist` | 读 JSON 网表（稳定 id e1..eN + 参数 + nets） | `layout`（带坐标） |
| `circuit.load_netlist` | 载入电路文本（重置时间轴） | `text` |
| `circuit.list_components` | 元件清单（id/类型/参数） | — |
| `circuit.set_param` | 按稳定 id 改参数，自动重分析 | `target, prop, value` |
| `sim.run` / `sim.stop` | 恢复/暂停宿主实时步进（墙钟） | — |
| `sim.reset` | t=0、状态复位、scope 清空（保持会话） | — |
| `sim.read_measurements` | 瞬时电压/电流/功率 | `nets` 或 `components`（缺省=全网电压） |
| `sim.read_scope` | scope 波形全量（**不降采样**，防爆 token 由调用方负责） | `index` |
| `schematic.screenshot` | 画布截图 | `format: png\|svg` |

会话管理：`tools.openSession()` 显式开会话；`tools.id` 即 sessionId；`bridge.request("step",
{sessionId, params:{seconds}})` 做确定性步进；页面断线重连后会话仍存活（连接与会话解耦）。

## 4. 最小 Node 客户端骨架（复制即用）

```js
import { register } from "node:module";
register(new URL("../tests/contract/helpers/ts-resolve.mjs", import.meta.url));
const { McpBridgeClient } = await import("../packages/mcp/src/bridge-client.ts");
const { AttachToolset } = await import("../packages/mcp/src/tools.ts");

const bridge = await McpBridgeClient.listen({ port: 0 });     // 环回 WS 服务器（仅 127.0.0.1）
// …启动浏览器并打开 /circuitjs.html 后，页面内执行：
//   const mod = await import("/@fs/<仓库绝对路径>/cover/ts/ExtMcpBridge.ts");
//   (mod.getMcpBridge() ?? mod.attachMcpBridge(window.ExtCircuitJS)).connect("<bridge.url>");
await bridge.waitPage(15000);
const tools = new AttachToolset(bridge);
await tools.openSession();
console.log(await tools.call("circuit.list_components"));     // 第一个工具调用
```

完整可运行版本：`examples/ai-loop.mjs`（含环境检查与错误处理）。

## 5. 错误语义

| 层 | 形态 | 例 |
|---|---|---|
| 会话 RPC | `{ok:false, error:{code,message}}`，code ∈ `invalid_state / unknown_session / bridge_unavailable …` | 未 open 就 load → `invalid_state` |
| 工具层 | `{ok:false, error:{code,message}}`，code ∈ `unknown_tool / invalid_args / bridge_unavailable …` | set_param 传未知 id → 引擎层 `unknown target` |
| 传输层 | `BridgeTransportError`（页面断线期间挂起请求被拒；重连后新请求正常） | 页面关闭瞬间的调用 |

## 6. 常见问题

- **连接不上**：dev server 没起（§0 探活）；页面没装桥（看 `window.ExtCircuitJS.mcp` 是否存在）。
- **SSRF 纪律**：桥只允许环回（`127.0.0.1`）监听与连接，非环回地址一律拒绝——这是设计约束不是 bug。
- **确定性**：`sim.run` 是墙钟实时步进（不确定）；要可复现数值一律走 `step`。
- **不改 core**：桥对引擎只做只读投影 + 公开序列调用（analyze/stamp/run），仿真循环零改动。
