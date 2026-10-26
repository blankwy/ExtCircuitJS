# ExtCircuitJS MCP 全链路指南

> 目标：新人 30 分钟内跑通「读网表 → 改参数 → 跑仿真 → 读电压」闭环。
> 架构一句话：外部客户端（任一 MCP 宿主）→ **stdio（NDJSON 的 JSON-RPC）** → `packages/mcp` →
> 本地环回 WebSocket（D02 桥）→ 页面内 `ExtMcpBridge`（挂在 `window.ExtCircuitJS.mcp`）→ 真实引擎。
> 会话式 RPC（spike C 结论：必须会话式，重建会丢时间轴与 scope 状态）。

```
MCP 宿主 (Claude Desktop / Codebuddy / Cursor …)
      │  stdio: 一行一条 JSON-RPC
      ▼
`node tools/ext.mjs mcp`  ── stdio.ts 协议层 ── tools.ts（11 工具）──┐
      │  懒启动：dev server + headless Chrome + 页面桥                │
      │  ws://127.0.0.1:<port>                                        │
      ▼                                                               │
页面内桥 (ExtMcpBridge) ◀────────── 同一活电路（会话内存活）──────────┘
```

两条使用路径，选一条即可：

| 你是 | 用哪个 | 入口 |
|---|---|---|
| 想让 AI 助手直接操作电路 | **MCP 宿主接 stdio 服务器**（§6） | `node tools/ext.mjs mcp` |
| 自己写脚本（Node） | 直接 import `packages/mcp`（§2/§4） | `examples/ai-loop.mjs` |

## 0. 环境（5 分钟）

- Node ≥ 22；本机 Chrome/Edge；playwright-core（任意安装位置，路径用 `EXT_PW_CORE` 指定）。
  playwright-core **不是**仓库依赖（只跑 Node 契约的人不需要浏览器驱动），按需 `npm i -D playwright-core`
  或直接指向已有的安装。
- **stdio 服务器会自己管 dev server**（探活 5174 → 不可达就拉起，退出时回收进程树），
  所以用 §6 的宿主配置时**不需要**手工起服务。只有走「自写脚本」路径才需要下面这一步：


```bash
cd ExtCircuitJS
node tools/ext.mjs dev --port 5174        # 终端 1，保持运行
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5174/circuitjs.html   # 应 200
```

环境变量（都有默认值，可按需覆盖）：`EXT_PW_CORE`（playwright-core 的 index.mjs 绝对路径）、
`EXT_CHROME`（chrome.exe 绝对路径）、`EXC_BASE`（默认 `http://127.0.0.1:5174`）。

## 1. echo 自测（2 分钟）

```bash
node --test tests/contract/mcp-stdio.test.mjs            # 11 例：stdio 协议层（纯 Node，无浏览器，进 CI）
node --test tests/contract/mcp-session.test.mjs          # 11 例：会话 RPC 顺序与错误语义（纯 Node，无浏览器）
node --test tests/contract/mcp-bridge.browser.test.mjs   # 7 例：协议层/echo/会话链路/重连存活/SSRF 守护
node tests/contract/mcp-stdio.browser.mjs                # 端到端：独立进程起 `ext mcp`，纯协议跑通读改测截
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
10Ω→2.2kΩ → `sim.step` 推进 2ms（确定性：页面侧冻结墙钟 + analyzeCircuit → preStampAndStampCircuit
→ runCircuit）→ `sim.read_measurements` 读全网电压 → 前后对比。

## 3. 工具速查（AttachToolset）

`new AttachToolset(bridge, { timeoutMs })` 后 `await tools.call(name, args)`；所有返回结构化
JSON，失败形如 `{ok:false, error:{code,message}}`，**绝不抛异常**。

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `circuit.get_netlist` | 读 JSON 网表（稳定 id e1..eN + 参数 + nets） | `layout`（带坐标）、`format: netlist\|compact` |
| `circuit.load_netlist` | 载入电路文本（重置时间轴）；**网表 JSON 不能载入**（见下） | `text` |
| `circuit.list_components` | 元件清单（id/类型/参数） | — |
| `circuit.set_param` | 按稳定 id 改参数，自动重分析 | `target, prop, value` |
| `sim.run` / `sim.stop` | 恢复/暂停宿主实时步进（墙钟，**数值不可复现**） | — |
| `sim.step` | **确定性推进**（冻结墙钟 + G2 帧序列）；对拍数值只能用这个 | `steps` 或 `seconds`（二选一） |
| `sim.reset` | t=0、状态复位、scope 清空（保持会话） | — |
| `sim.read_measurements` | 瞬时电压/电流/功率 | `nets` 或 `components`（缺省=全网电压） |
| `sim.read_scope` | scope 波形全量（**不降采样**，防爆 token 由调用方负责） | `index` |
| `schematic.screenshot` | 画布截图 | `format: png\|svg` |

`circuit.get_netlist` 的两种形态（v0.1.7）：

| format | 形状 | 体积（372 例语料） | 什么时候用 |
|---|---|---|---|
| `netlist`（默认） | 命名 JSON：`components[{id,type,f,props,pins}]` + `nets[]` + `meta/models/probes` 空壳段 | 2.51× XML | 需要坐标（`layout:true`）、需要改完再喂回去 |
| `compact` | 紧凑投影：`{v,g?,n?,t?,c:[[typeIdx,f,[netIdx], [props]]]}` | **0.415× XML**，是命名 JSON 的 0.165（省 83%） | 长上下文批量读；**只读**视图 |

`compact` 是**自描述**的：`t` 是类型图例 `{ "<typeIdx>": ["ResistorElm", ["resistance"]] }`，
只含本电路用到的类型、且只报实际用到的属性名前缀。所以调用方不需要注入整份 registry 就能把
`[243,0,[0,1],[1,1000,5]]` 读成"VoltageElm，waveform=1, frequency=1000, maxVoltage=5"。
代价是每电路几十到几百字节（实测占自描述体积的 37.7%），`legend:false` 可关掉换体积。

`compact` **不能喂回 `load_netlist`**：它没有坐标、没有导线行，引擎也没有网表导入器
（`CircuitLoader.readCircuit` 只认 core 文本与 XML）。这样调用会得到
`{ok:false, unsupported:[{code:"netlist_json_not_loadable", reason:"…"}]}` —— 明确拒绝且**不动电路**，
不会静默变成"空电路"。改参数用 `circuit.set_param`，换电路用 XML/电路文本。

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

## 6. 接到 MCP 宿主（stdio 服务器，推荐）

Claude Desktop / Codebuddy / Cursor 这类宿主只需要一段配置：它负责拉起进程、在 stdio 上握手、
列工具、调工具；**dev server 与浏览器由 ExtCircuitJS 自己管**，不用你手工开。

### 6.1 宿主配置

```json
{
  "mcpServers": {
    "ext-circuitjs": {
      "command": "node",
      "args": ["<仓库绝对路径>/tools/ext.mjs", "mcp"],
      "env": {
        "EXT_PW_CORE": "<playwright-core/index.mjs 绝对路径>",
        "EXT_CHROME": "<Chrome 或 Edge 可执行文件绝对路径>",
        "EXC_BASE": "http://127.0.0.1:5174"
      }
    }
  }
}
```

- `command` 用绝对路径最稳（宿主的工作目录不一定是仓库根）。
- `env` 三项都可省：省 `EXT_PW_CORE` 会去仓库 `node_modules/playwright-core` 找
  （`npm i -D playwright-core`）；省 `EXT_CHROME` 按各平台默认安装路径依次试 Chrome → Edge → Chromium。
- 想换端口就改 `EXC_BASE`（`EXT_DEV_PORT` 只影响自动拉起时用的端口，默认取 `EXC_BASE` 的端口）。

### 6.2 生命周期（懒启动）

握手（`initialize` / `tools/list`）**不碰浏览器**；第一次 `tools/call` 才：

1. 探活 `EXC_BASE/circuitjs.html` → 已在跑就复用，不在跑就自己拉起 dev server；
2. 起 headless Chrome/Edge 打开页面，注入页面桥并连回本地环回 WebSocket；
3. 此后所有工具调用都落在**同一活电路**上（会话式：时间轴、scope 状态跨调用保持）。

宿主退出（关 stdin / SIGTERM）时释放浏览器、桥、以及自己拉起的 dev server（连同 vite 子进程）。
「找不到 Chrome」这类错误**不会**让服务器启动失败，而是作为 `isError` 的工具结果返回——
模型看得见、用户可以照错误提示修，比宿主只显示 "server failed to start" 有用。

### 6.3 协议细节（自己写客户端时看这里）

- 传输：**换行分隔的 JSON-RPC 2.0**（一行一帧）。服务器 stdout **只**写协议帧，日志一律走 stderr。
- 版本协商：支持 `2025-06-18` / `2025-03-26` / `2024-11-05`；客户端给哪个就沿用哪个，未知回最新。
- `tools/call` 返回 `content[]`（文本 JSON；截图是 `image/png` 的 image content）+ `structuredContent`；
  业务失败（`{ok:false,…}`）走 `isError:true`，只有未知工具/未知方法才是 JSON-RPC 错误（-32602 / -32601）。
- 消息**串行处理**：同一电路不能被并发踩，宿主并发调用时按到达顺序排队执行。

### 6.4 排障

| 现象 | 原因 / 处理 |
|---|---|
| 宿主说 server 启动失败 | `node tools/ext.mjs mcp --help` 能跑吗？Node ≥ 22 吗？（stdout 被任何日志污染都会立刻断连） |
| 工具返回 `backend_unavailable` | 消息里写了原始原因：playwright-core 找不到 / 浏览器找不到 / 端口被占（换 `EXC_BASE` 端口） |
| 数值每次都不一样 | 用了 `sim.run`（墙钟实时）。对拍数值一律用 `sim.step` |
| 改了代码但工具读到旧行为 | 复用了一个旧 dev server（跑着改动前的代码）：停掉它，让服务器自己拉起 |

## 7. 常见问题

- **连接不上**：dev server 没起（§0 探活）；页面没装桥（看 `window.ExtCircuitJS.mcp` 是否存在）。
  容器/CI 里没有浏览器时，工具会返回 `backend_unavailable`——这是环境问题，不是协议问题。
- **SSRF 纪律**：桥只允许环回（`127.0.0.1`）监听与连接，非环回地址一律拒绝——这是设计约束不是 bug。
- **确定性**：`sim.run` 是墙钟实时步进（不确定）；要可复现数值一律走 `sim.step`。
- **不改 core**：桥对引擎只做只读投影 + 公开序列调用（analyze/stamp/run），仿真循环零改动。
