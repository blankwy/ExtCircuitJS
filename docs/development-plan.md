# ExtCircuitJS 开发计划

> 配套评估：`docs/architecture-review.md`（结论与证据）。
> 三个 spike 的实测数据：`docs/spikes/`。
> 本计划的排期按 **1 名全职主力** 估算；括号内为并行 2 人时的压缩值。

---

## 1. 目标与非目标

### 目标（v1 必须达成）

1. **可跟进的上游基线**：`core/` 钉死在某个 commit，`ext core sync` 能把上游更新变成一次可评审的 PR，而不是一场灾难。
2. **Cover 覆盖层**：按路径镜像覆盖 + 新增文件，构建期生效，有冲突扫描与契约回归。
3. **插件系统**：动态加载/卸载/热重载，命令与元件可扩展，冲突可检测，泄漏可控。
4. **AI 友好的网表 JSON**：能导出（省 token、去坐标）、能导入（保布局 1:1；自动布局另立项）。
5. **AI 可调用的 API + MCP**：读电路、改参数、跑仿真、读测量值，形成闭环。

### 非目标（v1 明确不做）

- 不重写上游核心，不做"多仿真实例"（核心是单例密集的，见评估 §1.3）。
- 不做 JSON 自动布局（`layout:auto`）——除排期允许的 v0 实验。
- 不做插件市场的服务端/账号体系。
- 不承诺闭源分发（GPLv2 约束，先按开源规划）。

### 治理铁律（写进 CONTRIBUTING，违反即打回）

> 定位澄清：ExtCircuitJS 是**二开（core 与 cover 同属一个产品）**，不是第三方启动器。因此区分两类文件：
> **自有文件**（你的功能：插件宿主、netlist codec、API facade、UI 插槽）——随便改，不参与三方合并；
> **跟随文件**（只做接线的上游文件：`main.ts`、`ElementFactory.ts`、`HookRegistry.ts`）——才需要 anchor + 契约测试。
> 实测跟随文件只有 **1 个 58 行 + 2 个微型文件**，所以"覆盖面失控"对二开模式其实不成立；真正的风险是**自有代码与上游 API 的耦合**（静态单例、`elmList`/`nodes[]` 结构），用契约测试兜。

1. `core/` 永远保持上游原样（**唯一例外：`ext core sync` 的机械更新**）。任何人工改动都进 `cover/`。
2. 覆盖只走分级：能 L0 不 L1；一旦决定覆盖，**默认整文件复制**（薄影子只用于 ≤20 行小补丁，有 `instanceof` 双份类陷阱）。
3. 覆盖文件**不许改类名**（`ElementFactory` 与 `keepNames` 依赖）。
4. 生成物（`registerElements.ts` 等）不许覆盖；走追加注册。
5. 每个新特性先问："能不能只靠 seam？"——能就不扩覆盖。

---

## 2. 目录结构（目标形态）

```
ext-circuitjs/
├─ core/                        # 上游镜像（完整 git 历史，pinned SHA，pristine）
│  └─ ts/…                      # 上游 TS 工程
├─ cover/
│  ├─ cover.manifest.json       # 覆盖清单（upstreamPath / forkPoint / anchors / owner / reason）
│  ├─ SEAMS.md                  # 最小 poke 面契约（版本化）
│  ├─ ts/                       # 与 core/ts 同构的覆盖文件 + 新增文件
│  │  ├─ ExtBridge.ts           # L0：暴露 app/sim/api 给外部
│  │  ├─ ExtSeams.ts            # L0：追加钩子与注册
│  │  ├─ ExtPluginHost.ts       # L0：插件宿主（也可放 packages/plugin-api）
│  │  └─ …（L2/L3 文件）
│  └─ public/                   # 静态资源覆盖（icons / setuplist / locale）
├─ plugins/                     # 动态插件（运行期加载，不参与核心打包）
│  ├─ plugins.manifest.json
│  ├─ hello/{plugin.json,index.js}
│  ├─ netlist-viewer/…
│  └─ mcp-bridge/…
├─ packages/
│  ├─ plugin-api/               # ctx 实现 + 类型（cordis 语义）
│  ├─ netlist/                  # JSON schema / codec / legacy txt 适配
│  ├─ layout/                   # 布局合成（P3 之后）
│  └─ mcp/                      # MCP server（Node）
├─ tools/                       # ext CLI（dev/build/cover/plugin/netlist/core）
├─ tests/
│  ├─ fixtures/corpus/          # 373 个 txt + 生成的 XML 快照
│  ├─ fixtures/fingerprints.json# 电气指纹 golden
│  ├─ contract/                 # 契约回归（覆盖生效后指纹不变）
│  └─ unit/
├─ docs/{adr,spikes,guides}/
└─ package.json                 # npm workspaces
```

**为什么 `plugins/` 不参与核心打包**：插件是运行期资产的动态加载语义（热重载、可选安装、权限声明）。把它编译进主包会让"卸载"变成"重新构建"，也就失去了插件体系的意义。

---

## 3. 接口契约草案

### 3.1 `cover/cover.manifest.json`

```jsonc
{
  "schema": "extcover/1",
  "core": { "repo": "pfalstad/circuitjs1", "commit": "e952e788a4135a693bfd4cee7883f9b3314e3e76", "versionString": "5.0.3" },
  "entries": [
    {
      "upstreamPath": "ts/CircuitLoader.ts",
      "localPath": "cover/ts/CircuitLoader.ts",
      "kind": "override",            // override | add
      "tier": "L2",                  // L0 add | L1 hook | L2 thin-shadow | L3 full-copy
      "forkPointBlob": "…",          // 上游该文件的 git blob hash（同步基线）
      "anchors": [                    // 语义锚点：我们依赖的上游签名
        "readCircuit(text: string, flags: number = 0)",
        "readCircuitText(text: string, flags: number)"
      ],
      "owner": "netlist-json",
      "reason": "在 XML/遗留 txt 分派前插入 JSON codec 钩子",
      "contracts": ["tests/contract/netlist-roundtrip.test.ts"]
    }
  ]
}
```

`ext cover scan` 输出 5+1 态（`clean/local-only/upstream-changed/both-changed/orphan/anchor-broken`），退出码 `0` 干净、`1` 需人工。

### 3.2 `plugins/<id>/plugin.json`

```jsonc
{
  "id": "netlist-viewer",
  "name": "Netlist Viewer",
  "version": "0.1.0",
  "apiVersion": "^1.0.0",
  "entry": "index.js",
  "mode": "in-page",              // in-page（可信）| worker（不可信/AI 生成）
  "inject": ["sim", "circuit", "ui.commands"],   // 依赖的服务，就绪才激活
  "permissions": ["netlist.read", "ui.panel"],   // 未声明的能力 ctx 直接拒绝
  "claims": {                      // 声明式占用，供冲突粗扫描
    "commands": ["ext.netlist.export"],
    "hooks": ["onanalyze"],
    "panels": ["right.sidebar"],
    "elementTypes": []
  }
}
```

### 3.3 插件 ctx（cordis 语义，自研轻量实现）

```ts
export interface PluginContext {
  plugin<T>(p: Plugin, config?: any): Promise<void>;   // 子插件
  inject(deps: string[], cb: (ctx) => void): void;     // 依赖就绪后执行
  effect(fn: () => void | Disposer): void;             // 自动逆序释放
  on(event: ExtEvent, cb: (...a: any[]) => void): Disposer;
  provide(name: string, impl: unknown): void;
  get<T>(name: string): T;
  api: ExtApi;                                         // 受限能力面（按 permissions 裁剪）
  storage: { get(k: string): any; set(k: string, v: any): void };  // 命名空间隔离
  log: (...a: any[]) => void;
  readonly status: 'loading' | 'ready' | 'disposing' | 'failed';
}
export interface Plugin { name?: string; apply(ctx: PluginContext, config?: any): void; }
```

规则：**一切注册都返回 disposer**（命令、事件、DOM、定时器、元件类型、面板）。宿主在 `deactivate` 时逆序调用；任何未释放项在 `ext plugin lint --leak` 下报错。

**不依赖 cordis 也能落地（推荐先这样）**：把 `AbortSignal` 当唯一 dispose 原语，标准库就够，300 行以内：

```ts
class PluginFiber {
  ctrl = new AbortController();
  disposers: (() => void)[] = [];
  get signal() { return this.ctrl.signal; }          // 可直接给 addEventListener({signal})
  effect<T extends () => void>(fn: T): T { this.disposers.push(fn); return fn; }
  dispose() { this.ctrl.abort(); for (const d of this.disposers.reverse()) d(); }
}
// 注册即绑定：ctx.on / ctx.command / ctx.element 全部内部 `ctx.signal.addEventListener`
```

`inject`（依赖就绪才激活）+ 拓扑排序 + 热重载用一个 60 行的调度器即可；cordis 的价值是**语义纪律**（fiber/effect/dispose），不是代码量。若以后要换 `@cordisjs/core`，接口形状保持一致即可平移。

**六条不变式（spike C 实测得出，写进契约测试）**：

1. `activate(ctx)` 返回后，ctx 内的所有注册自动绑定到本插件 fiber。
2. **`activate` 中途抛错 → 无条件 LIFO 回滚**（实测漏洞：中途失败会留下已注册监听）。
3. **单槽钩子必须由宿主做多路复用**（`CircuitJS1.onanalyze` 是覆盖式单槽，N>1 插件会互踩）。
4. 卸载后：钩子订阅数、命令数、DOM 节点数、定时器数全部回基线（实测可达：{1,1,1}→{0,0,0}，命令 208→207）。
5. 热重载用 `?v=<buildId>` 破 ESM 缓存；同一 URL 必须返回同一实例（实测成立）。
6. 插件永不得直接持有 `CirSim` 内部对象超过一次事件回调（防悬垂引用）。

**错误隔离**：插件回调异常只记日志 + 标记 `failed`，不得中断仿真循环或宿主回调链；连续失败 N 次自动停用（熔断）。

### 3.4 网表 JSON（`netlist/0.1`，以 spike A 草案为准）

详见 `docs/spikes/netlist-codec.md` §7。要点（每条都有实测支撑）：

- **`pins` 用 net id，不用坐标**；net id 短（`n0/n1/…`）。
- **导线不是元件**：导出时被吸收进 net（语料里 4,909 根导线 = 元件 46.5%，**删导线 −32.3%**），需要保留视觉电流时用 `nets[].via: ["w3"]`。
- **`layout` 可选且默认不写**：写了 = 可无损回写（体积 2.75× XML）；不写 = 只能导出，导入需布局合成。
- **默认值省略**：语料众数即默认（写进 schema 约定，不逐条硬编码）。
- **`unsupported[]` 必填**：多脚元件几何缺失时点名，不猜。
- **三档编码**：命名键 JSON（2.29× XML，给人/工具看）／紧凑 JSON（0.32×，喂 LLM）／网表文本（0.19×，最省）。**别宣传"JSON 省 token"，要宣传"紧凑编码 + 去导线去坐标省 token"**。
- **`props` 用字段名**（`resistance`），XML 属性名作为 `tagProps` 别名表放在 registry 里（已抽到 105 个元素 × 86 个 txtType）。

```jsonc
{
  "schema": "netlist/0.1",
  "meta": { "core": "5.0.3", "source": { "format": "txt", "bytes": 667 }, "counts": { "components": 10, "nets": 4 } },
  "models": [{ "id": "m0", "kind": "mosfet", "tag": "mm", "nm": "old-mosfet-2", "props": { "vt": -1.75 } }],
  "components": [
    { "id": "c0", "type": "ResistorElm", "tag": "r", "f": 0, "props": { "resistance": 1000 },
      "pins": { "0": "n1", "1": "GND" }, "layout": [200, 100, 300, 100], "model": null }
  ],
  "nets": [{ "id": "n1", "pins": ["c0:0", "c1:1"] }, { "id": "GND", "ground": true, "pins": ["c0:1"] }],
  "probes": [{ "kind": "scope", "inputs": ["n1", "n2"] }],
  "subcircuits": [],
  "unsupported": [{ "component": "c7", "reason": "post geometry" }]
}
```

### 3.5 MCP 工具集（v1）

| 工具 | 作用 | 备注 |
|---|---|---|
| `circuit.get_netlist` | 读当前电路为 JSON 网表 | `includeLayout` 可选 |
| `circuit.load_netlist` | 从 JSON 载入（要求 layout 或报 `requires_layout`） | 返回结构化错误 |
| `circuit.list_components` | 元件清单 + 稳定 id + 参数 | AI 编辑的前置 |
| `circuit.set_param` | 改元件参数（按稳定 id） | 写操作 |
| `sim.run` / `sim.stop` / `sim.reset` | 仿真控制 | |
| `sim.read_measurements` | 节点电压 / 元件电流 / 功率 | 可指定 net/component 过滤 |
| `sim.read_scope` | scope 波形数据（降采样） | 防爆 token |
| `schematic.screenshot` | 当前画布 PNG | 视觉兜底 |

传输：`stdio`（本地）+ 可选 `http`。后端两种模式：`attach`（WebSocket 桥到浏览器）与 `headless`（后续）。

**协议形态（spike C 的结论）**：不要做成无状态工具调用。网表编解码/diff 可以在 Node 侧做，但**载入 + 仿真 + 读指纹必须在浏览器内**，所以用**会话式 RPC**：

```
open()  → sessionId
load(sessionId, netlist|text)      → {ok, unsupported[]}
step(sessionId, {steps|seconds})   → {t, timeStepCount}
measure(sessionId, {nets?, components?, quantity}) → {values}
export(sessionId, {format, layout}) → {payload, bytes}
close(sessionId)
```

这样 AI 的多次调用落在同一个活电路上，而不是每次都重建（重建会丢掉时间轴与 scope 状态）。

---

### 3.6 写通道：ops 补丁 API（AI 只产生意图，坐标由引擎生成）

详见 [format-strategy.md](format-strategy.md)。核心取舍：**不让 AI 手写 XML/坐标**（坐标差 1px = 静默开路），写入统一走语义 ops。

```jsonc
{ "ops": [
  { "op": "set",    "target": "c3", "prop": "resistance", "value": 2200 },
  { "op": "add",    "type": "ResistorElm", "between": ["n1", "n2"], "props": { "resistance": 1000 } },
  { "op": "delete", "target": "c7" },
  { "op": "probe",  "target": "c3", "quantity": "current" }
] }
```

- `set/delete/probe` **不需要布局**，第 3–4 天就能上；
- `add` 用**增量放置**：在目标 net 上选可分裂导线点 → `WireElm.split()`（`WireElm.ts:240`）→ 放元件 → 必要时补正交导线 → 网格对齐 → `app.needAnalyze()`。**不是整电路自动布局**，工作量小一个数量级。
- 返回 `{ok, applied, created, atoms[], unsupported[]}`；`atoms` 记录"分裂/新增了哪些元件"，便于回滚与审计。
- 禁止路径：插件/AI 直接改 `elm.nodes[]`、手拼 XML、绕过 `UndoManager`。

## 4. 阶段计划

### P0 · 骨架与基线（2–3 天）

| 任务 | 产出 | 验收 |
|---|---|---|
| 建仓 + npm workspaces | 根 `package.json`、`tsconfig.base.json` | `npm i` 通过 |
| 纳入 core（subtree + 完整历史 + 自建 tag） | `core/`、`core.lock.json`、`up/core/5.0.3-e952e78` | `ext core verify` 校验 commit 与文件清单 |
| `ext` CLI 骨架 | `ext doctor / dev / build` | 能在 5174 起 dev、产出 `dist/` |
| CI | GitHub Actions：win+ubuntu，`build + test` | 首绿 |
| ADR 三篇 | 分层、覆盖分级、seam 策略 | 评审通过 |

### P1 · Cover 机制 + 最小 seam（6–8 天）★ 关键路径

| 任务 | 要点 | 验收 |
|---|---|---|
| `coverOverlay()` Vite 插件 | `resolveId/load` 影子解析；**必须把 cover 文件里的相对导入显式指回 core**（否则 `Failed to resolve import`）；dev/build/HMR 三态都验 | dev 命中覆盖；dist 含覆盖标记；改 cover 热更新（≈3 s） |
| public/ 静态资源覆盖 | 复刻上游 `copyPublicAssets` 映射（`circuits/locale/images/font/setuplist`）；CSS 相对 `url()` 需重写 | 覆盖 `style.css` 与新增 public 文件在 dev/dist 双端命中 |
| `tsconfig.cover.json` | `rootDirs` 就地检查（实测 4.7–6.9 s），不要独立 program 复制一份工程 | 覆盖文件类型错误 → TS2322 / EXIT 2 |
| `ext cover scan/status/apply` | manifest + git blob + anchors（空白归一化子串匹配）；`apply` 物化（1.1 s / 691 文件） | 模拟上游变更：5 类 + `collision`/`orphan` 判定正确；退出码进 CI |
| **最小 seam 补丁集** | 见下 S1–S5 | 每条都有单测；`SEAMS.md` 版本化 |
| **菜单插槽**（新增元件必需） | `Menus.ts:490` 是硬编码 "Add …" 列表；必须给覆盖层/插件留注入点（或物化后重跑生成器） | 自定义元件能在菜单里点到 |
| 契约测试基座 | 373 语料 → XML 快照 + 电气指纹 golden（5.49 s / 372 例） | 覆盖生效后指纹不变；故意改一个电阻能让测试红 |
| 覆盖冒烟 | `ResistorElm` **整文件覆盖**加一个属性 | app 正常、`ElementFactory` 仍按类名创建、`dumpXml` 含新属性（实测 4 断言通过） |

**最小 seam 清单（P1 的唯一允许"改上游"的地方，之后冻结；详情与代码见 `docs/seams.md`）**：

| 编号 | 手段 | 目标 | 改动 | 必需 |
|---|---|---|---|---|
| S1 | 整文件覆盖（L3） | `ts/main.ts`（58 行） | 末尾 +2 行 `await ExtBoot(app)` | ✅ |
| S2 | 实例级包装（L0） | `app.jsInterface.call*Hook`、`app.importCircuitFromText`、`app.loader.readCircuit` | 0 覆盖，事件与导入全接管 | ✅ |
| S3 | 微影（L3，40 行） | `ts/ElementFactory.ts` | +`deregisterClass/listClasses/hasConflict` | 推荐 |
| S4 | 无覆盖（L0） | `CommandPaletteRegistry` | 宿主记账 + 卸载 | ✅ |
| S5 | 微影（L3，30 行） | `ts/HookRegistry.ts` | 结构性钩子（`readCircuitInterceptor` 等） | 暂缓 |

关键点：**`CirSim.ts` / `UIManager.ts` / `CircuitLoader.ts` / `CircuitElm.ts` 一律不覆盖**——事件走实例方法（`CirSim.ts:315/355`），导入走实例方法（`ImportFromTextDialog.ts:68`、`UIManager.ts:795`、`JSInterface.ts:55`），UI 插槽用现成的 `app.addWidgetToVerticalPanel()`（`UIManager.ts:1879`）。

> **G1 决策门（P1 末）**：若 seam 需要动 > 20 个文件，或单个热点文件（`CirSim.ts`/`UIManager.ts`）被覆盖 > 3 次 → 停，切 fork-merge 模型（评估 §5 方案 B），overlay 只保留给新文件。

### P2 · 插件宿主（5–8 天）

| 任务 | 要点 | 验收 |
|---|---|---|
| `packages/plugin-api` | ctx 六件套 + 状态机 + 错误隔离 + 依赖拓扑；**事件多路复用总线**（对抗单槽钩子） | 单测覆盖正常/失败/循环依赖/热重载 |
| 失败路径回滚 | `activate` 抛错 → LIFO 回滚全部注册（spike C 的漏洞） | 注入一个中途抛错的插件，订阅计数回基线 |
| 插件加载与清单 | manifest 校验（schema）、`apiVersion` 兼容、`?rev=` 破缓存 | 装/卸/改版本三种场景 |
| 冲突粗扫描 | claims 比对（命令 id、hook、panel、元件类型）+ 策略（error/warn/first-wins） | 两个插件抢同一命令 → 后启动者被拦并给可读报告 |
| 静态 lint | 禁 `document/window/eval/new Function`、禁直连核心模块、权限声明校验 | CI 里对一个故意违规的样例报错 |
| UI 插槽（最小） | 右栏面板 + 命令面板条目 + 菜单项 | 面板能开合、能随插件卸载消失 |
| 示例插件 ×3 | hello / netlist-viewer / scope-export | 三个同时启停，监听器计数归零 |
| Worker 模式 | 不可信插件跑 Worker，只走数据面 API | 一个 AI 生成的样例插件跑通 |

### P3 · Netlist JSON v1（5–8 天）

| 任务 | 要点 | 验收 |
|---|---|---|
| schema v1 + JSON Schema 文件 + 类型 | 按 `netlist/0.1` 草案；三档编码（命名/紧凑/网表文本） | schema 校验器拒绝非法输入；三档互相可转 |
| 元件描述表自动生成 | 从 `ts/*Elm.ts` 抽 `getDumpType/getXmlDumpType/dumpXml/undumpXml` + 构造参数槽；**31/85 个 type 参数个数随 flag 变 ⇒ 必须按 type 生成小解析器，不用扁平表** | registry 进 CI diff；`elmCount`/`postCount` 双对拍回归（基线 372/372、93.84%） |
| 导出（引擎算 nets，codec 只序列化） | 从 **引擎对象**直接生成 JSON（不经 XML 文本解析）：正确序列 `importCircuit → analyzeCircuit → preStampCircuit`，读 `sim.nodeList`/`links`；**不要用自研并查当权威**（oracle 对拍：clean 桶仅 56.25% 一致） | 与引擎 `nodeList` 对拍 100%（这是 P3 的硬指标） |
| 导入（`layout:keep`） | 构造元素 → 注入 `elmList` → 让引擎自己分析；返回 `{ok, unsupported[]}` | 335/335 回写后引脚划分不变（基线已达成） |
| XML 双路 tag | 修 `GateElm.ts:144` 计算式 tag（约 5 行）+ `Scope` tag 冲突白名单 + `n`→Noise 别名 | XML 路径解析从 96.78% → ≥99% |
| 扁平化/压缩 | 去导线（net 吸收）、去坐标、去默认值 | 紧凑 JSON ≤0.35× XML、网表文本 ≤0.25×（基线 0.32/0.19） |
| token 基准 | 固定 20 例，chars/4 估算 + 可选 BPE 实测 | 记录中位数与最差；**禁止用命名键 JSON 做节省论证** |

> **G2 决策门（P3 中）**：XML/txt 解析支持率 < 90%、或紧凑编码 > 0.5× XML、或"引擎 nodeList 对拍"不一致率 > 1% → 把 JSON 降级为"AI 只读导出格式"，不做双向编辑。

### P4 · AI API + MCP（5–7 天）

| 任务 | 要点 | 验收 |
|---|---|---|
| `window.ExtCircuitJS.api` | 读/写/仿真/事件；稳定 id（`WeakMap` + 导出时落 `id`） | API 契约测试（vitest + 浏览器冒烟） |
| MCP server（attach 模式） | Node + WebSocket 桥；工具按 §3.5 | Claude 侧闭环：读 → 改电阻 → 跑 2ms → 读电压 |
| 无头求解器 spike（可选） | `HeadlessApp` shim（约 17 个成员） | 决策记录：v1 是否内置 headless |
| 文档与示例 | 「让 AI 改电路」教程 | 新人 30 分钟能跑通 |

### P5 · 持续运营

- **上游同步 SOP**：`ext core sync` → 自动分类报告 → 契约回归 → PR → 人工 review（目标：每次 < 2 小时）。
- 可上游化的改动回 PR 给 pfalstad（降低长期维护成本）。
- 插件示例库、文档站、发布流水线（`ext release`）。

---

## 5. 里程碑与工作量

> 两个口径：**A 串行全量**（单人、含自动布局/无头求解器/Worker 沙箱等全部特性）≈ 5–7 周；
> **B 14 天冲刺**（多 agent 并行、砍掉非核心、复用 spike 代码）≈ 2 周出可用 v1。你说"最慢两周"——按 B 口径成立，见 §5.2。

### 5.1 串行全量（参考）

| 阶段 | 工期（1 人） | 压缩（1.5–2 人） | 交付物 |
|---|---|---|---|
| P0 | 2–3 天 | 2 天 | 骨架 + CI + ADR |
| P1 | 6–8 天 | 5–6 天 | Cover 机制 + 胶水（相对导入/public/tsc）+ seam + 菜单插槽 + 契约基座 |
| P2 | 5–8 天 | 4–5 天 | 插件系统 + 3 示例 |
| P3 | 5–8 天 | 4–5 天 | 网表 JSON v1 |
| P4 | 5–7 天 | 3–4 天 | API + MCP 闭环 |
| **合计** | **23–34 天**（约 5–7 周） | **18–22 天**（约 4 周） | 可用 v1 |

并行建议：P2 与 P3 无强依赖，可两人并行（P2 改 UI/宿主，P3 改 loader/codec，写作用域不重叠）。

### 5.2 14 天冲刺（多 agent 并行，推荐执行口径）

前提：spike 的代码直接当起点（`coverOverlay.mjs`、`cover.mjs`、`plugin-host`、`registry-gen`、`corpus-xml` 都能复用）；4 条轨道并行、写作用域互不重叠。

| 天 | 轨道 A（Cover/App） | 轨道 B（插件） | 轨道 C（网表） | 轨道 D（AI/MCP） |
|---|---|---|---|---|
| D1 | 建仓 + core 钉版 + `ext doctor` + CI | 读 spike C，定 ctx 契约与状态机 | registry 生成 + txt 读取 | — |
| D2 | `coverOverlay` 生产化（相对导入/public/tsc 胶水） | host 内核：ctx/fiber/effect/dispose | **引擎算 nets** 的语义 JSON 导出 | 定 MCP 会话 RPC 协议 |
| D3 | **S1 seam + ExtBoot + API facade**（关键路径） | 事件多路复用总线（对抗单槽钩子） | ops：`set/delete/probe` | WebSocket 桥骨架 |
| D4 | 契约基座（373 语料 + 指纹）进 CI | 命令/面板/菜单插槽 | ops：`add between nets`（导线分裂） | 工具集：read/set/run/measure |
| D5 | `cover scan/status/apply` 生产化 | 失败回滚 + 熔断 | 紧凑编码 + token 基准 | 闭环 demo：读→改→跑→读 |
| D6 | ElementFactory 注销 + 注册命名空间 | lint（危险 API/权限/claims 冲突） | round-trip + 对拍测试 | 截图/scope 数据工具 |
| D7 | **门禁：cover+seam 启动全绿** | 示例插件 ×3 + 文档 | **门禁：JSON 读/写闭环** | **门禁：MCP 全链路** |
| D8 | 覆盖冒烟 + 类身份回归 | Worker 模式（可选） | XML 双路 tag 修复（可选） | API 文档 + 教程 |
| D9–D10 | 上游同步演练（模拟一次 core sync） | 插件冲突矩阵测试 | 373 语料全量回归 | 演示脚本 / 录屏 |
| D11–D12 | 修红 + 补契约 | 修红 + 补契约 | 修红 + 补契约 | 修红 + 补契约 |
| D13–D14 | **缓冲 / 发布 v0.1 / 写 README 与贡献指南** | | | |

**必须砍掉（否则 2 周不成立）**：

| 砍掉 | 理由 | 以后再做 |
|---|---|---|
| 整电路自动布局（`layout:auto`） | 独立工程（无坐标仅 28.2% 可推断） | v0.2 |
| 无头求解器（`HeadlessApp`） | 需 canvas/DOM 桩，验证成本高 | v0.2（差异化能力，值得做） |
| Worker 沙箱 | 插件先按可信处理 | v0.2（AI 生成插件前必须补） |
| 插件市场 / 服务端 | 与 v1 无关 | 长期 |
| 完整 5 态冲突扫描的 UI | CLI + 退出码够用 | 需要时再加 |
| i18n、主题、移动端 | 上游已有，不重复造 | — |

**关键路径只有一条**：D3 的 `main.ts` seam + `ExtBoot`。它不通，B/C/D 全部空转——所以 D1–D2 就要把它的 patch 草案评审完，D3 一上班就落地。

**两个"最容易吃掉两天"的点**（现在就有对策）：
1. 网表拓扑正确性 → 只信引擎 `nodeList`（oracle 已建好，54/96 的教训）；
2. 插件卸载残留 → 六条不变式 + 失败回滚测试（spike C 已暴露失败路径泄漏）。

实现上按"**先跑通一条极窄的端到端，再横向加宽**"：D3 结束时应能做到 `window.ExtCircuitJS.api.dumpNetlist()` 返回语义 JSON；D5 结束时应能 `set R1=2.2k → run → read V(n1)`。这两条通了，剩下的都是加壳。

---

## 6. 质量门禁（CI）

```
ext doctor              # 环境 + core.lock 校验
tsc (core)              # 上游自身类型检查
tsc -p tsconfig.cover   # 覆盖层类型检查
vitest run              # 上游单测 + 我们新增单测
ext cover scan          # 覆盖冲突/漂移（失败即红）
ext plugin lint         # 插件静态扫描（权限/危险 API/claims 冲突）
contract tests          # 373 语料电气指纹 + 网表 round-trip
size budget             # 主包体积增量上限（如 ≤ +15%）
```

平台：Windows + Ubuntu 双跑（你在 Windows 开发，部署大概率 Linux）。

---

## 7. 测试策略（这是"能跟进上游"的本钱）

1. **电气指纹回归**：373 个语料在固定步数后的节点电压/元件电流，存 golden；任何覆盖/升级导致的语义变化必须显式 diff。
2. **网表 round-trip**：JSON → 电路 → JSON，逐元件/逐网络比对（0 容差）。
3. **覆盖契约**：每个 L2/L3 覆盖文件必须挂一个测试，"如果上游改了这个方法签名，测试要红"。
4. **插件泄漏**：启停 N 次后 `listener/command/DOM` 计数回到基线。
5. **token 基准**：固定 20 个代表性电路，记录三种格式的 token 数（防"优化后变大"）。
6. **构建冒烟**：覆盖生效的构建产物必须能加载并跑一个电路（防 rolldown 把影子解析摇掉）。
7. **引擎 nodeList 对拍**（独立 oracle）：codec 算出的 net 划分 vs 浏览器里 `app.sim.nodeList` 的 `links` 划分，逐例比对；这是"拓扑正确"的唯一独立证据（spike A 未完成，P3 必补）。
8. **元件表回归**：`registry.json` 进 CI，上游改动导致的覆盖率下降（txtType 数、属性数）直接红；再叠加 `elmCount`/`postCount` 双对拍（基线 372/372、93.84%）。
9. **插件契约**：六条不变式各一条测试；`activate` 失败回滚单列一条。

---

## 8. 立即开始的下一步（本周可做）

1. **P0 建仓**：`core/` subtree 纳入 + `ext doctor` + CI 首绿（1 天）。
2. **P1 的 seam 评审**：把 `docs/seams.md` 的 S1–S5 逐条写成 patch 草案 + 影响面分析，**先评审再动手**（半天）。
3. **契约语料固化**：把 spike C 产出的 XML 语料 + 指纹纳入 `tests/fixtures/`（半天）。
4. **G1 预演**：拿 3 个真实特性（JSON codec、插件面板、AI 参数编辑）各写一遍"最小改动清单"，统计会碰多少上游文件——这个数字决定架构要不要转向。
