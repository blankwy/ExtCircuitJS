# Spike C — 运行时插件宿主 / JS API 面 / 浏览器验证夹具

**结论（一句话）**：在 **未改动 Core** 的前提下，用「页面内 ES 模块宿主 + Vite dev 的 ESM 按路径寻址」可以在真实 Chromium 里完成插件的 activate / deactivate / 热重载 / 失败隔离，并且监听器能干净归零；但这一切依赖一个**生产包不存在的**开发期红利（`import('/CirSim.ts')` → `CirSim.theApp`）。要让插件系统在正式构建里启动，**Cover 层只需 1 行补丁**（`ts/main.ts:20`）；其余（多路复用钩子、命令撤销、元素注销、权限、冲突检测）Core 全部缺失，必须由 Cover 补齐。

- 实测环境：上游 `_scratch/core` = pfalstad/circuitjs1 `e952e78`（`5.0.3ts`，全 TS + Vite 8.0.14），工作副本 `spike/plugin-runtime/work/ts`，dev server `http://127.0.0.1:5182/circuitjs.html`，Chromium（Playwright `playwright-core` 1.63 驱动本机 Chrome，**真浏览器**，非 jsdom）。
- 全部数字均可复现：`spike/plugin-runtime/scripts/{smoke,probe-api,plugin-host,corpus}.mjs`，证据 JSON + 截图在 `spike/plugin-runtime/evidence/`。

---

## 1. API 面测绘（`window.CircuitJS1` 实际成员）

### 1.1 只有 13 个成员，且**不含任何实例引用**

`ts/JSInterface.ts:62-81` 的 `setupJSInterface()` 把 `window.CircuitJS1` 赋成一个**纯对象字面量**，值全是箭头函数（闭包持有 `JSInterface` 实例 → `that.app`）。实测 `Object.keys`：

| # | 成员 | 签名（实测 arity） | 备注 |
|---|------|------|------|
| 1 | `setSimRunning` | (1) | 转发 `app.setSimRunning` |
| 2 | `getTime` | (0) | `app.sim.t` |
| 3 | `getTimeStep` | (0) | |
| 4 | `setTimeStep` | (1) | 上游注释「don't use this, see #843」 |
| 5 | `getMaxTimeStep` | (0) | |
| 6 | `setMaxTimeStep` | (1) | 同时写 timeStep |
| 7 | `isRunning` | (0) | |
| 8 | `getNodeVoltage` | (1) | 按**标号节点名**取电压（依赖 `HookRegistry.getLabeledNode`） |
| 9 | `setExtVoltage` | (2) | 遍历 elmList 找 ExtVoltage 元件 |
| 10 | `getElements` | (0) | 见 §1.4，**可能整体抛错** |
| 11 | `getCircuitAsSVG` | (0) | |
| 12 | `exportCircuit` | (0) | = `app.dumpCircuit()` → **XML 字符串** |
| 13 | `importCircuit` | (2) | `(circuit, subcircuitsOnly)` |

**没有** `app` / `sim` / `cirSim` / `instance` 之类的引用（`Object.keys` 无匹配，`typeof window.app === 'undefined'`）。回调位（`onupdate`/`ontimestep`/`onanalyze`/`onsvgrendered`/`oncircuitjsloaded`）由**调用方**自己挂到该对象上，且都是**单槽**（`CircuitJS1.onanalyze = fn` 覆盖式）。

### 1.2 app / CirSim 实例到底能不能拿到？——能，但只在 dev

| 路径 | 结果 | 生产包可用？ |
|---|---|---|
| `window` 全局 | ❌ 不存在（全仓库只有 `LZString`、`C2S`、`Adjustable/AboutBox/…Dialog` 等被挂到 window，见 §1.5） | — |
| 反射 `window.CircuitJS1.*` | ❌ 箭头函数闭包不可反射 | — |
| **`CirSim.theApp`**（`ts/CirSim.ts:193` `CirSim.theApp = this;` 写在 `init()` 里） | ✅ **实测拿到**：`const {CirSim} = await import('/CirSim.ts'); CirSim.theApp` → `ctor=CirSim`、`version=5.0.3ts`、`elmCount=7`、`sim/menus/ui/jsInterface` 全在 | ❌ 单文件 bundle 里类不可按 URL 寻址 |
| `HookRegistry`（`ts/HookRegistry.ts`） | ✅ `import('/HookRegistry.ts')` → **12/12 钩子全部已置位** | ❌ 同上 |
| `ElementFactory` | ✅ `registerClass/create/hasClass` | ❌ |
| `CommandPaletteRegistry` | ✅ **207 条命令 + 366 条电路命令** | ❌ |
| `document` 控件查询 | 只能拿到 DOM（canvas 1114×730 + 6 个按钮 canvas），拿不到 JS 对象 | 部分 |

> 结论：**dev 下能，prod 下不能**。dev 的红利来源是 Vite 的「模块即 URL」——`import('/CirSim.ts')` 命中的是页面里**已经求值过的同一模块实例**（不是重新加载），所以 `CirSim.theApp` 是活的单例。这条路径在 `vite build`（`codeSplitting:false` 单文件）后彻底消失。

### 1.3 元素代理（`getElements()` 的返回值）能做什么 / 不能做什么

每个代理**只有 6 个方法**（实测 `Object.keys(elm)`）：

```
getType()  getInfo()  getVoltageDiff()  getVoltage(i)  getCurrent()  getPostCount()
```

- ✅ 读：类型名（`ResistorElm`/`VoltageElm`/…）、信息串、端间电压差、第 i 个 post 的节点电压、元件电流、post 数。
- ❌ 写/深访问全部 `undefined`：`setVoltage`、`setResistance`、`setProperty`、`setNodeVoltage`、`getElm`、`getElmList`、`getXml`、`dumpXml`。
- ⚠️ **`getElements()` 是急切构建整个数组**：任一元件取 post 失败就整体抛 `Cannot read properties of undefined (reading 'v')`。语料里 6 个电路（`alu74181`、`td4`、`td4-ctr`、`td4-ctr-up-dn`、`td4-add2`、`td4-ctr`）因此整批失败 → 插件/夹具必须假定它可能整体抛错，逐元件降级到 `app.elmList`。

### 1.4 钩子的真实触发频率（1.2 s 自由运行实测）

| 钩子 | 触发次数 | 真实语义 |
|---|---|---|
| `ontimestep` | **2031** | 每个仿真步（`CirSim.ts:355`） |
| `onupdate` | **75** | UI 帧节流刷新（`UIManager.ts:1268`） |
| `onsvgrendered` | 0 | 仅在导出 SVG 时（`ImageExporter.ts:110`） |
| `onanalyze` | **0**（自由运行）/ **1**（载入一份新电路后） | 只在**电路重新分析**时（`SimulationManager.ts:1034`，`preStampCircuit()` 成功返回前） |

> 想「每步都读电学量」用 `ontimestep`；`onanalyze` 不是每帧回调，别当帧钩子用。

### 1.5 其它既有全局（顺带记录，均非 app 引用）

`window.LZString`、`window.C2S`、`window.Adjustable`、`window.AboutBox`、`window.ShortcutsDialog`、`window.SliderDialog`、`window.SubcircuitDialog`、`window.ExportAsImageDialog`、`window.ExportAsUrlDialog`、`window.ImportFromDropboxDialog`、`window.ScopeExportImageDialog`、`window.__circuitSubmenuObserver`。

---

## 2. 插件宿主原型：实测通过了什么

宿主：`spike/plugin-runtime/work/ts/public/plugins/host.js`（页面内 ES 模块，**不改 Core**）；样例插件 `plugins/hello/index.js`（v1）、`plugins/hello/index.v2.js`（热重载载荷）、`plugins/boom.js`（故意失败）。驱动：`scripts/plugin-host.mjs`，证据 `evidence/plugin-host.json`。

| 能力 | 结果 | 证据 |
|---|---|---|
| 动态 `import('/plugins/hello/index.js')` + `activate(ctx)` | ✅ `state=active`，`VERSION=hello@1` | `steps.activate` |
| (a) 挂 `onanalyze`/`ontimestep`/`onupdate` | ✅ 计数 0/2031/75（见 §1.4） | `steps.hooksFired` |
| (b) 读当前电路 XML | ✅ `exportCircuit()` → 984 B / 7 元件 | `steps.capabilities.xmlProbe` |
| (c) 载入一段电路 | ✅ `importCircuit(text,false)` → 4 元件 `VoltageElm/ResistorElm/GroundElm/WireElm` | `steps.capabilities.afterLoad` |
| (d) 注册/撤销命令（注册表可达时） | ✅ 注册 `plugin:hello@1:poke` 进 `CommandPaletteRegistry`，`search('poke')` 命中第 1，`custom.execute()` 实跑；撤销后 `byId` 里 `plugin:*` 为空 | `steps.capabilities`、`steps.deactivate` |
| (e) 卸载后监听器归零 | ✅ `hookSubs {onanalyze:0, ontimestep:0, onupdate:0, onsvgrendered:0}`，且**钩子槽位回到 `null`**（多路复用器让位）；命令数回 207；计数器冻结在 2031/75 不再增长 | `steps.deactivate.after`、`countersAfterUnload` |
| 热重载（deactivate → 新版本 import） | ✅ `?v=1` → `?v=2` → `?v=3`；换 `index.v2.js` 后 `VERSION=hello@2`；`import('…index.js?v=900') !== import('…index.js?v=901')`（**ESM 缓存按完整 URL 打键，query 串可穿透**），同一 URL 重复 import 返回同一实例 | `steps.hotReload` |
| 失败隔离（`activate()` 抛异常） | ✅ `state: failed → inactive`，宿主与 app 均存活，事后仍能 `importCircuit`（3 元件 / 209 B XML） | `steps.failureIsolation` |

### 2.1 原型自身暴露的两个**契约级**缺陷（这不是宿主写错，是 Core 的形状逼出来的）

1. **`activate()` 中途抛异常 → 已挂的监听器泄漏**。`hookSubsAfterUnload.onanalyze = 1`：插件在 `ctx.hooks.onAnalyze(fn)` 之后、把 dispose 塞进 `ctx.disposables` 之前抛错，宿主就没有回滚入口。→ 契约必须要求 **`onX()` 自己就把 dispose 记进当前记录的 disposables**（插件不需要手动 add），并且 `activate()` 失败时宿主**无条件 LIFO 回滚**。
2. **钩子槽位是单槽**。两个插件各写 `window.CircuitJS1.onanalyze = fn` 会互相覆盖。宿主必须做多路复用（`get` 返回聚合分发器、`set` 落回原始值、计数为 0 时还原 `null`），否则「卸载干净」在 N>1 时不可能成立。Core 不认识这件事。

---

## 3. 「今天能做到 / 必须由 Cover 补」

### 3.1 今天就能做到（零改动，dev 环境）

| 能力 | 靠什么 |
|---|---|
| 动态加载/卸载/热重载插件模块 | 浏览器原生 ESM + query 串 |
| 钩子挂载与聚合分发 | 改写 `window.CircuitJS1.on*`（可配置属性） |
| 读当前电路 XML、载入电路、读写仿真时间/步长 | 13 个公开 API |
| 读每个元件的类型/端电压/电流 | `getElements()` 代理（需容忍整体抛错） |
| 注册命令面板命令 | dev 下 `import('/CommandPaletteRegistry.ts')` |
| 失败隔离 | 宿主 try/catch + disposables LIFO |

### 3.2 必须由 Cover 补（按阻塞性排序）

| # | 缺口 | 现状（含行号） | 建议的最小补丁 |
|---|---|---|---|
| **C1** | **app 实例暴露** | `window.CircuitJS1` 无引用；`CirSim.theApp` 只在 dev 可达 | **`ts/main.ts:20`**：`HookRegistry.createJSInterface = (app:any) => { (window as any).__extApp = app; return new JSInterface(app); }` —— 1 行、生产包同样生效、不动 `CirSim.ts`。备选 `ts/CirSim.ts:193` 后加 `(window as any).__extApp = this;` |
| **C2** | 插件槽位 / 注册表 | 无任何插件概念 | Cover 新增 `PluginHost`（状态机 + disposables + 多路复用），对外只暴露 `ExtCircuitJS.plugins` |
| **C3** | 命令与菜单注册（可撤销） | `CommandPaletteRegistry` 有 `add/addToggle/get/search`，**无 `remove`**（`CommandPaletteRegistry.ts:96-116`）；`Menus` 无运行时增删项 API | Cover 补 `removeCommand(id)` / `dispose()` 句柄；菜单项走 Cover 自己的叠加菜单，别改 `Menus.ts` 的静态表 |
| **C4** | 元素注册表扩展 + **注销** | `ElementFactory.classMap` 是 `private static Map`，仅 `registerClass/create/hasClass`（`ElementFactory.ts:26-46`），**无 remove / clear / 列名 / 冲突检测** | Cover 补 `deregisterClass(name, ctor?)`、`listClasses()`、注册时「名字/typeId 已被占用」的**主动**拒绝（Core 只有 `CirSim.ts:637-654` 里 `console("xml dump type conflict …")` 这种被动告警） |
| **C5** | netlist codec 钩子 | 序列化写死在 `CircuitXMLSerializer` / 读在 `CircuitXMLDeserializer.ts:170`（`CirSim.xmlDumpTypeMap.get(tag)`），无扩展点 | Cover 在 `dump/undump` 前后加 hook（`HookRegistry` 已是无 import 的现成孔位，加 2 项即可），或 Cover 侧独立 codec + 只在边界调用 Core |
| **C6** | 权限与沙箱 | 插件与 Core 同 realm、同 `window`、可直接改 `CircuitJS1` 任意成员 | Cover 里用 iframe/Worker + postMessage 做隔离通道；同 realm 下只能做「能力白名单」（ctx 只交必要 API，不给 `app` 原始引用） |
| **C7** | 失败隔离策略 | 无（`jsInterface?.` 全是可选链，插件抛错直接冒泡到 rAF 循环） | 宿主侧 `try/catch` + 熔断（连续 N 次抛错 → 自动 deactivate + 上报） |
| **C8** | 钩子多样性 | `HookRegistry` 固定 12 项、全在 Core 内部语义上 | Cover 再加：`beforeDump` / `afterLoad` / `onElmAdded` / `onCommandExecuted` 等业务钩子（用 Cover 自己的 `HookBus`，不碰 Core 文件） |
| **C9** | 单槽回调冲突检测 | 无 | Cover 多路复用器里记录每个槽位的订阅者 id，插入即比对（同 id 重复 / 槽位被外部覆写 → 告警） |

> **C1 是唯一的硬阻塞**：不做 C1，正式构建里插件系统连 app 都拿不到；做了 C1 + C2/C3/C7（全在 Cover 目录内），就能跑「数据类插件」（读电路、跑仿真、出指纹、加命令）而不覆盖任何 Core 大文件。

---

## 4. `@extcircuitjs/plugin-api` 契约草案

```ts
// 插件模块默认导出（或具名导出 activate/deactivate）
export interface PluginModule {
  meta?: { id: string; name: string; version: string; apiVersion: '1'; requires?: string[] };
  activate(ctx: PluginCtx): void | Promise<void>;
  deactivate?(ctx: PluginCtx): void | Promise<void>;
}
```

### 4.1 `ctx`（宿主构造，插件**不得**直接碰 `window.CircuitJS1` / `app`）

```ts
interface PluginCtx {
  readonly id: string;
  readonly apiVersion: '1';
  readonly log: (msg: string, level?: 'info'|'warn'|'error') => void;
  readonly settings: KV;                       // Cover 提供的持久化命名空间（按 plugin id 隔离）

  readonly sim: {
    getTime(): number; getTimeStep(): number; setTimeStep(ts: number): void;
    isRunning(): boolean; setRunning(v: boolean): void;
  };
  readonly circuit: {
    getXml(): string;                          // exportCircuit()
    load(text: string, subcircuitsOnly?: boolean): void;
    elementCount(): number;                    // 宿主兜住 getElements() 的整体抛错
    forEachElement(fn: (e: ElementView, i: number) => void): void;
  };
  readonly elements: {                         // 只读视图，与上游代理同形
    // ElementView = { getType/getInfo/getVoltage(i)/getVoltageDiff/getCurrent/getPostCount }
  };
  readonly hooks: {                            // 全部返回 dispose
    onTimeStep(fn: () => void): Dispose;
    onUpdate(fn: () => void): Dispose;
    onAnalyze(fn: () => void): Dispose;
    onSvgRendered(fn: (svg: string) => void): Dispose;
    onCircuitLoaded(fn: () => void): Dispose;  // ← 需 Cover 补（Core 无此语义）
  };
  readonly commands: {
    register(cmd: { id: string; label: string; category?: string; keywords?: string; run(): void }): Dispose;
    // Cover 负责 id 前缀强制 = `<pluginId>:`，防冲突
  };
  readonly ui: {
    addMenuItem(path: string[], label: string, run: () => void): Dispose;
    addToolbarButton(opts: { icon: string; tooltip: string; run(): void }): Dispose;
  };
  readonly disposables: DisposableBag;         // { add(d), disposeAll() }
  readonly state: Record<string, unknown>;     // 插件自用；宿主不快照、不序列化
}
type Dispose = () => void;
```

### 4.2 生命周期状态机（宿主强制）

```
         load            activate() ok
unloaded ─────► loading ─────────────► active
                  │                      │
                  │ activate() throws    │ deactivate()
                  ▼                      ▼
               failed ──(unload)──► inactive ──(reload: deactivate→新的 import)──► loading
```

不变式（每一条都要能被自动化测试断言，Spike C 已给出断言套路）：

1. `active` 期间 `ctx` 上注册的**每一个**回调/命令/菜单项**必须**在 `inactive` 之前撤销；宿主在 `deactivate()` 末尾用「订阅计数快照」比对基线（本 Spike 的 `host.snapshot()` 就是最小实现）。
2. `activate()` 抛错 → 状态 `failed`，**无条件 LIFO 回滚**本次 activate 期间产生的所有订阅（见 §2.1 缺陷 1）。
3. `deactivate()` 抛错不阻断回滚，但计入 `failures` 并上报（不允许「抛错就不清理」）。
4. 同一 id 不能并发两次 `loading`；`reload` 必须在 `inactive` 之后才开始（本 Spike 的 `seq` 递增即实现）。
5. `active` 期间 `ctx` 保持同一对象（插件可把它存到模块级变量）；`reload` 后是**新 ctx**，旧引用必须视为失效。
6. 钩子槽位在「订阅数 = 0」时必须恢复为宿主装载前的原始值（本 Spike：`null`）。

### 4.3 冲突检测点（Cover 必须显式覆盖）

| 冲突类 | 检测时机 | 处理 |
|---|---|---|
| 命令 id 撞车 | `commands.register` | id 必须带 `<pluginId>:` 前缀；撞车 → 拒绝 + 告警（不静默覆盖） |
| 元素类名 / typeId 撞车 | `ElementFactory.registerClass` | 主动拒绝（Core 只有 console 告警） |
| XML 标签撞车 | `getXmlDumpType()` 映射 | 同上 |
| 钩子槽位被外部覆写 | 每帧校验 `window.CircuitJS1.onanalyze !== 我们的分发器` | 重新安装 + 告警 |
| 同一事件多个插件写同一设置 | `ctx.settings` 写入 | 后写者胜 + 记审计（禁止跨插件命名空间） |
| 插件互相 import | 静态扫描插件入口 | 只允许 `@extcircuitjs/plugin-api` 类型导入 |

### 4.4 依赖与激活顺序

- `meta.requires: string[]`（插件 id）+ 可选 `meta.priority: number`。
- 拓扑排序；**环检测必须报错**而不是静默跳过。
- `activate` 串行（保持可预测），`deactivate` 逆序。
- 依赖插件 `failed` → 依赖它的插件**不激活**（`blocked`），不是「照常激活」。

---

## 5. MCP / Node 侧接口的可行边界

| 侧 | 能做 | 不能做 |
|---|---|---|
| **Node 侧（无浏览器）** | 文本/XML 解析与 schema 校验；`dumpTypeMap` 码表复现（静态抽源码即可）；语料 diff（比 `fingerprints.json`）；批量文件操作 | **任何**需要 app 的操作：载入电路、跑仿真、读电压电流、注册命令 |
| **浏览器内（`page.evaluate`）** | 全部：载入、步进、读电学量、钩子、命令、插件生命周期 | 长驻任务受 page 生命周期约束；性能受 headless 调度影响（但 §1.4 的 2031 步/1.2 s 说明足够快） |
| **桥接（本 Spike 采用）** | Playwright/CDP 常驻连接 → 页面内 host → Node 侧 RPC 批量下任务 | 需要一次「真浏览器会话」的成本；建议 MCP 侧做成 **session（开一次浏览器，跑 N 个请求）** 而不是每请求开一次 |

推荐 MCP 工具面（3 个即可覆盖本 Spike 全部能力）：
`sim_session.open(baseUrl)` → `sim.eval(steps)`（载入 + 步进 + 读指纹，一次往返）→ `sim_session.close()`。
插件管理单独一组：`plugins.list/activate/deactivate/reload`，映射到页面内 host 的同名方法。

---

## 6. 夹具使用说明（`_scratch/corpus-xml/`，其他队友只读）

```
_scratch/corpus-xml/
├── <name>.xml          373 个，来自 public/circuits/<name>.txt → window.CircuitJS1.exportCircuit()
├── fingerprints.json   清单 + 每例电学指纹（schema: extcircuitjs/corpus@1）
└── FAILURES.md         失败清单（只有 blank.txt = 空电路，非真失败）
```

**覆盖率：372/373 = 99.73%；总耗时 5.49 s（单例 14.7 ms）；10,555 个元件；560,289 字节 XML。**

### 6.1 XML 格式（重要，别按「单字符标签」写死 schema）

- 根：`<cir f="1" ts="0.000005" ic="10.634…" cb="50" pb="50" vr="5" mts="5e-11">`（`ts`=timeStep、`mts`=maxTimeStep、`ic`、`cb/pb`=电流/功率条、`vr`）
- 位置统一 `x="x1 y1 x2 y2"`；翻转/标志 `f`；模型引用 `mo=`；模型本身（`<mm nm=… vt=… be=…>`）与元件**同级**挂在 `<cir>` 下。
- **标签 = `elm.getXmlDumpType()`，没有就退回类名**（`CirSim.ts:616-655 register()`）。所以单字符（`w R c l d v L M f g p o t x ln a rw I s cc bs sw ext adj tl h`）与类名（`And Nand Or Xor Nor JKFlipFlop DFlipFlop LED ExtVoltage VarRail Timer ctr2 as2 aout rlm pt …`）**混排**。
- 频次 Top20：`w` 5004、`R` 1646、`p` 969、`o` 707、`g` 702、`cir` 373、`L` 363、`c` 361、`ln` 277、`t` 275、`x` 254、`M` 190、`f` 149、`v` 146、`And` 115、`a` 112、`rw` 104、`d` 99、`I` 76、`Nand` 74。
- 完整真实样本见 `_scratch/corpus-xml/3-f211.xml`。

### 6.2 `fingerprints.json` 结构

```jsonc
{ "schema": "extcircuitjs/corpus@1",
  "app": { "upstream": "pfalstad/circuitjs1 e952e78 (5.0.3ts, TS+Vite)", "served": "http://127.0.0.1:5182" },
  "determinism": { "method": "Date.now() frozen; runCircuit() driven until timeStepCount >= budget", "stepBudget": 400 },
  "totals": { "circuits": 373, "ok": 372, "failed": 1, "coveragePct": 99.73, "totalMs": 5490,
              "avgMsPerCircuit": 14.7, "totalElements": 10555, "totalXmlBytes": 560289 },
  "circuits": [ { "source": "public/circuits/3-f211.txt", "ok": true, "ms": 16,
                  "t": 2.15e-3, "stepCount": 400, "frames": 26, "elmCount": 11,
                  "elementsVia": "jsapi",            // 或 "app.elmList"（6 例，getElements() 整体抛错时降级）
                  "apiError": null, "xmlBytes": 667,
                  "elements": [ { "i":0, "type":"ResistorElm", "info":"…", "posts":[0.0,4.9], "vd":4.9, "cur":0.0049 } ] } ],
  "failures": [ { "name":"blank", "file":"blank.txt", "error":"" } ] }
```

### 6.3 确定性约定（复现要点）

`SimulationManager.runCircuit()` 的步进**受 `Date.now()` 门控**（`steprate`、`frameTimeLimit`），所以不能「跑 N 帧」。夹具的做法：**冻结 `Date.now()`** + 自己调 `runCircuit(false)`，**以 `sim.timeStepCount >= 400` 为停止条件**（计数器，不是墙钟）→ 换机器/换负载结果一致。驱动代码见 `scripts/corpus.mjs` 里的 `window.__exReadElements` / `__simRunCircuit`。

### 6.4 消费方式（给 T1 / netlist-codec）

```js
// 1) schema 定型：直接读 XML（合约束：<cir> 根 + 子元素 = 元件 或 模型）
// 2) 回归：重新生成指纹，与本 json 逐字段比 (elements[].vd / .cur / posts[])
// 3) 元素代理兜底：elementsVia === "app.elmList" 的 6 例必须走逐元件路径
// 4) 「空电路」blank.txt 是唯一的 ok:false，判定脚本里请当特例白名单
```

---

## 7. 最大风险（按影响排序）

1. **C1 未落 → 生产包插件系统起不来**。dev 里的全部能力都建立在 `import('/CirSim.ts')` 上，`vite build` 后消失；Spike 的「全部通过」只对 dev 成立。**Cover 必须先把 `ts/main.ts:20` 那一行吃下来，再谈其它**。
2. **`getElements()` 会整体抛错**（6/373 电路实测），且元素代理只有 6 个只读方法。任何「遍历元件」的插件/夹具都必须有逐元件降级路径，否则 1.6% 的电路直接消失。
3. **钩子单槽 + 命令注册表无 remove + ElementFactory 无注销**：三处「只能加不能减」。N>1 插件共存时，卸载干净这件事**在 Core 形状下不可靠**——宿主必须自己做多路复用和撤销（本 Spike 的 host.js 是最小实现，且已暴露 activate 中途抛错的泄漏缺陷）。

---

## 附：复现清单

```powershell
# 0) 一次性准备（已做）
robocopy _scratch\core\ts spike\plugin-runtime\work\ts /E /XD node_modules dist .git
cmd /c mklink /J spike\plugin-runtime\work\ts\node_modules _scratch\core\ts\node_modules
# vite.config.ts 改为 port 5182 / host 127.0.0.1 / open false（只改工作副本）

# 1) dev server
cd spike\plugin-runtime\work\ts ; node_modules\.bin\vite --port 5182 --host 127.0.0.1
# 2) 证据
cd spike\plugin-runtime\scripts ; node probe-api.mjs ; node plugin-host.mjs
# 3) 夹具（全量 373，约 6 s）
cd spike\plugin-runtime\scripts ; node corpus.mjs
```

---

## 8. 收尾验证：用引擎自己的 nodeList 独立对拍 codec 的 nets

背景：codec 的 nets 完全由几何推导（`inferNets`），此前只有自洽证据。本节用**真实浏览器引擎**的 `SimulationManager.nodeList` 当独立 oracle 测了一遍。
脚本 `spike/plugin-runtime/scripts/nets-oracle.mjs`，结果 `spike/plugin-runtime/evidence/nets-oracle.json`（37 KB，含逐例 firstDiff + 4 条 findings）。

### 8.1 方法（避免踩两个坑）

- 引擎侧：`importCircuit(text,false)` → `app.analyzeFlag=true; sim.analyzeCircuit()` → **`sim.preStampCircuit(false)`**。
  ⚠️ 坑 1：`analyzeCircuit()` **只**同步 elmList/busWidths/postDrawList，**nodeList 是在 `preStampCircuit()` 里建的**（`SimulationManager.ts:932`）；只调前者会读到上一个电路的 nodeList（一开始就是这么错的：335 例全部 `engineNets=0`）。
  ⚠️ 坑 2：`link.num >= elm.getPostCount()` 的是**内部节点**（`makeNodeList` 里 `internal=true`），必须剔除；同时 `cn.internal` 的节点整类丢掉。
- 引擎侧不需要额外 union 线：`calculateWireClosure()`（`SimulationManager.ts:263` 起）已在 `makeNodeList` **之前**把导线/标签组并成同一个 `NodeMapEntry`，所以 `nodeList` 本身就是网表划分。
- 规范化：每类引脚按 `"elm:post"` 排序、类按字符串排序，两侧用**同一个** `canon()`；比较前先校验元件数一致。

### 8.2 结果（335 例可对拍，373 例中 38 例元件数不一致被排除）

| 桶 | 例数 | 划分完全一致 | 命中率 |
|---|---|---|---|
| **clean**（codec `degradedPins === 0`，引脚全部定位成功） | 96 | **54** | **56.25 %** |
| **degraded**（codec 自己标记「有引脚定位不了」） | 239 | 0 | **0 %** |
| 合计 | 335 | 54 | 16.12 % |

耗时 2.9 s（真 Chromium，单例 ~9 ms）。另有 **38 例元件数不一致**（`adder4-sc` 163 vs 110、`brentkung` 343 vs 324、`conv-buck` 17 vs 15…）——codec 把某些行计成元件而引擎不计，这些例无法逐引脚对齐，已排除。codec 侧 0 个解析异常。

### 8.3 四条结论

1. **F1（系统性，最重要）：引擎把所有 ground 引脚并成同一个 `CircuitNode.ground`；codec 只把 net 命名成 `GND`，没有跨坐标 union ground 引脚。** 于是 codec **过度切分**：`besselbutter` 引擎 12 类 vs codec 23 类，引擎那条 GND net 一气连了 24 个引脚（`0:1,4:0,10:1,12:0,13:1,15:0,…`），codec 把它切成了一堆两两成对的碎片；`bandnoise` 更直观——codec 多出一个只有 `10:1`（一个接地脚）的孤立 net，引擎里它属于主 GND。**修法只需在 `inferNets` 里把 `traits.isGroundElm` 的 key 统一 union 到一个虚拟 ground key。**
2. **F2（系统性）：多掷开关（txt 类型 `S`，末位参数是极数）的引脚数 codec 给 2、引擎给 4。** `3way.txt` 引擎有 `{4:1,7:2,8:0,8:1}` 和 `{4:2,7:1,9:0,9:1}`，codec 只有 `{8:0,8:1}`/`{9:0,9:1}`，`pinDelta = -4`（2 个开关 × 2 脚）；`4way.txt` 是 `-8`。属 `postCountOf` / registry 表错，不是几何问题。
3. **F3（by design 但阻塞）：codec 自己标 degraded 的 239/335 例，划分命中率 0 %**，且 `pinDelta` 恒为负（`3-cgand` 少 24 个引脚 = 它的 `degradedPins: 24`）。也就是说**对 71 % 的语料，nets 缺失引脚、天然不可能与引擎一致**——这不是新 bug（codec 报告里已声明 `fullyInferable=false`），但意味着 nets 在这 71 % 上**不能当 ground truth 用，只能当部分视图**。
4. **clean 桶的 42 例不匹配中，能归因到 F1/F2 之外的很少**：多数是同一类被 F1 拆开后的连锁（`avr8js-strobe` 引擎一条 14 引脚长链 vs codec 三对）；未见「引擎粗于 codec」的系统性合并（`classCountDelta > 0` 占绝大多数）。

一句话给 codec：**nets 的方向是对的（导线闭包、标签合并都过），主要偏差是「ground 不跨坐标合并」+「多掷开关引脚数」两条表级/规则级缺陷；把这两条修掉后，clean 桶的命中率预期从 56 % 显著上升。** 另外不建议在 239 个 degraded 例上做 nets 的等价性断言。
