# ExtCircuitJS 架构评估（基于上游实测，2026-10-25）

> 评估对象：`pfalstad/circuitjs1` 二次开发，Core / Cover / Plugin / App 四层，含 JSON 拓扑格式与 AI 接口。
> 方法：拉取真实上游源码（`_scratch/core`，commit `e952e78`）逐文件核实，并用三个 spike 做可证伪验证（见 `docs/spikes/`）。
> 结论口径：**可行 / 有条件可行 / 不可行**，每条都带证据位置（`file:line`）或实测命令。

---

## 0. TL;DR

**方案总体成立，而且比你预想的容易——但你方案里对上游的三个前提已经过期了。** 按修正后的形态，这是一条 6~8 周可以做出可用 v1 的路。

五条关键修正（按重要性排序）：

| # | 原设想 | 实测事实 | 修正 |
|---|---|---|---|
| C1 | 覆盖 `.java` 源码、加载时替换 | 上游已**全量迁移到 TypeScript + Vite**（无 `.java`），master == dev-ts，版本 5.0.3 | 覆盖是**构建期**概念（Vite `resolveId/load` 影子解析）；插件是**运行期**概念。两者别混在同一个"加载"叙事里 |
| C2 | "对应目录对应文件"整文件覆盖 | 上游 260 个 `.ts`，元件**一文件一件**，但 `CirSim.ts`/`UIManager.ts`/`CircuitElm.ts` 是 60KB 级热点；实测薄影子有 `instanceof` 双份类陷阱 | 覆盖**分级**：能加不改（L0）> 用钩子（L1）> 整文件覆盖（L3，默认写法）；薄影子（L2）只留给 ≤20 行小补丁 |
| C3 | 每个特性各自覆盖核心文件 | 上游已有 `HookRegistry`（12 个中性钩子）、`ElementFactory`、`CommandPaletteRegistry`、`window.CircuitJS1`；且事件回调走实例方法（`CirSim.ts:315/355`） | 先一次性建**最小 seam（poke 面）**并版本化成契约。实测只需 **1 个整文件覆盖（`main.ts`，58 行，+2 行）**，`CirSim/UIManager/CircuitLoader` 一个都不用覆盖——见 `docs/seams.md`。否则覆盖面会随特性线性膨胀，跟进上游必然失败 |
| C4 | JSON 相对"官方 txt" | 官方现行保存格式是 **XML**（`<r x="200 100 300 100" f="0" r="1000"/>`），txt 只是**遗留导入**路径 | JSON 的对照基准是 XML（再加上 373 个遗留 txt 语料的兼容适配器）；导出**不要自己复刻几何并查**，直接读引擎 `nodeList` |
| C5 | 插件注入 js、动态生命周期 | 核心有大量**进程级静态单例**（`SimulationManager.theSim`、`CircuitElm.app`、`CircuitNode.ground`、各注册表 static） | 插件卸载 = 释放自己的 effect，不是回滚核心；必须定 dispose 契约 + 静态粗扫描 + 可选 Worker 隔离 |
| C6 | JSON 读写都当"文本格式"处理 | 官方 XML 的语义只存在于 158 个类的 `dumpXml/undumpXml` 里（95.6% 属性名 ≤2 字符、30.4% 打包值、`f` 位标志、`x` 语义随上下文变） | **读写分离**：XML 存（不动）／语义 JSON 读／**ops 补丁写**（引擎生成坐标与 XML）。详见 [format-strategy.md](format-strategy.md) |

**第二轮补充（针对"二开定位"与"两周排期"）**：

- 如果 core 与 cover 是**同一个产品**（不是启动器），风险模型要改：区分**自有文件**（插件宿主/codec/API facade——随便改，不参与三方合并）与**跟随文件**（`main.ts`/`ElementFactory`/`HookRegistry` 这些只做接线的）。实测跟随面只有 **1 个 58 行 + 2 个微型文件**，所以"覆盖面失控"降级为次要风险；真正的风险变成**自有代码与上游 API 的耦合点**（静态单例、`elmList`/`nodes[]` 结构、`getPost` 几何），用契约测试兜。
- 排期同理：串行全量 5–7 周的口径包含自动布局/无头求解器/Worker 沙箱；**砍掉这三项 + 多 agent 并行 = 14 天**（`development-plan.md` §5.2 有逐日轨道表）。2 周不是乐观，是**范围问题**，不是难度问题。

一句话判断：**架构方向对；把"覆盖"从"复制文件"降级为"末选手段"，把"seam + 契约测试"升为首要工程投入，这个项目就从"能跑"变成"能长期跟进上游"。**

---

## 1. 事实基线（已核实，勿再猜）

### 1.1 上游形态

| 项 | 实测值 | 证据 |
|---|---|---|
| 仓库 HEAD | `e952e788a4135a693bfd4cee7883f9b3314e3e76`，`master` == `dev-ts`，版本串 `5.0.3`，日期 2026-10-24 | `git ls-remote --symref`、`git log` |
| 语言/构建 | **纯 TypeScript + Vite**（`rolldownOptions`），无 `.java`、无 Maven/GWT | `ts/package.json`、`ts/vite.config.ts` |
| 源码规模 | `ts/` 根 260 个 `.ts`（递归 265），一元件一文件 | `Get-ChildItem -Filter *.ts` |
| 构建/测试 | `npm run build` = `tsc && vite build`；`npm test` = `vitest run`（7 个 `*.test.ts`） | `ts/package.json:6-10` |
| 语料 | `ts/public/circuits/*.txt` **373 个**遗留 txt；`tests/*.txt` 一批回归电路 | 目录计数 |
| 发布 | `dist.sh` / `dist-offline.sh` → `site/`；CI 在 `dev-ts` 上 `npm ci && build && test` | `.github/workflows/*.yml` |
| 标签 | **没有 tag** | `git ls-remote --tags` 空 |
| 许可证 | `COPYING.txt` = **GPL v2**；但 `ts/package.json` 写 `"license": "ISC"`（不一致） | `COPYING.txt:1`、`ts/package.json:14` |
| 桌面 | `app/`（Electron 壳）、`cxx/`（C++ 移植分支） | 目录 |

**推论**：上游处于活跃期（今天还在提交），且**没有 semver tag**。跟进策略必须按 commit 钉版 + 自建标签 + 契约回归，不能指望版本号。

### 1.2 上游已经给了你什么（这是最大的可行性红利）

| 能力 | 位置 | 对 ExtCircuitJS 的价值 |
|---|---|---|
| 浏览器 JS API `window.CircuitJS1` | `ts/JSInterface.ts:21-105` | 现成的对外 API 基座：`exportCircuit/importCircuit/dumpCircuit/getElements/getLabeledNodeVoltage/setExtVoltage/setSimRunning/getTime/setTimeStep`，回调 `onupdate/ontimestep/onanalyze/onsvgrendered` |
| 中性钩子表（无 import，防循环依赖） | `ts/HookRegistry.ts` | 12 个钩子：`createJSInterface`、`createSubcircuitElm`、`getLabeledNode`、`resetGroundNodeList`…——**这就是"官方预留的插槽"，Cover 的第一优先手段** |
| 元件工厂（可运行时注册） | `ts/ElementFactory.ts:24-40` `registerClass/hasClass/create` | 插件加自定义元件的入口；缺 `deregister`（需 Cover 补，见 C5） |
| 命令面板注册表 | `ts/CommandPaletteRegistry.ts` `addCommand/add/addToggle/clear` | 插件贡献命令的现成通道（带 fuzzy 检索、历史） |
| XML 序列化 / 反序列化 | `ts/CircuitXMLSerializer.ts:97`、`ts/CircuitXMLDeserializer.ts` | 网表 JSON 的**权威序列化基座**；每元件 `dumpXml/undumpXml` 就是属性 schema |
| 加载器双通道 | `ts/CircuitLoader.ts` `readCircuit`：`<` 开头走 XML，否则走遗留 txt | JSON 导入只要在 `readCircuit` 前插一层 codec |
| 管理器分层 | `CirSim` 委托 `SimulationManager/UIManager/ScopeManager/CommandManager/UndoManager/MouseManager/Toolbar/Menus` | 插件宿主可以按 manager 划边界，不必改造 `CirSim` 内部 |
| 模块基址解析 | `ts/ModuleBase.ts` | 插件目录/资源基址可复用 |

### 1.3 三个必须尊重的硬约束

1. **连接性是几何推导的，不是网表驱动的。** `SimulationManager.calculateWireClosure()`（`SimulationManager.ts:266`）先把导线/标签/地并成等价类，`setGroundNode()`（`:566`）定地，`makeNodeList()`（`:606`）再把每个元件的 `getPost(j)`（`CircuitElm.ts:875`）坐标落到 `CircuNode` 上。**没有坐标就没有连接**——这直接决定了"JSON 去掉坐标"必须配套"布局合成器"，否则只能仿真不能还原。
2. **类名是运行时契约。** `ElementFactory` 按类名造对象，`CircuitElm.getClassName()` 用 `this.constructor.name`，因此 `vite.config.ts` 里专门开了 `minify.mangle.keepNames.class/function`。**任何覆盖都不能改类名**，否则静默失效。
3. **核心是单例密集的。** `CirSim.theApp`（`CirSim.ts:54`）、`CircuitElm.app/sim`（`CircuitElm.ts:149-151`）、`SimulationManager.theSim`、`CircuitNode.ground`、`HookRegistry`、`ElementFactory.classMap`、`CommandPaletteRegistry` 全是静态/模块级。⇒ 一个页面只有一个 `CirSim`；插件只能"附着"，不能"再起一个仿真"。

---

## 2. 逐层评估

### 2.1 Core 层（上游钉版）

**判定：可行，但要换钉法。**

- 上游无 tag ⇒ 用 **commit SHA 钉版**，并在自己的镜像仓打 `up/core/5.0.3-e952e78` 之类的标签。
- 推荐 `vendor/circuitjs-core/`（submodule 或 subtree）+ `core.lock.json`（commit、版本串、文件清单 hash），供 Cover 的冲突扫描做基线。
- 不要保留 `_scratch/core` 里的 `.git`（浅克隆无法做三方 diff）；正式仓库里应是**完整克隆**，冲突扫描才有 blob 历史可查。
- 维护成本现实预估：上游是单人主导的高频仓库（今天就有提交），**每月至少 1~2 次同步**；契约测试是唯一能让你敢同步的东西。

### 2.2 Cover 层（覆盖 + 插件宿主）

**判定：可行（构建期影子解析 + tsc + HMR + 类身份五条链全绿）；但"覆盖"应是末选手段，且**默认写法是整文件复制**（薄影子只用于 ≤20 行小补丁，实测有 `instanceof` 双份类陷阱）。**

分级策略（建议写进 ADR，作为团队纪律）：

| 级别 | 手段 | 适用 | 成本 | 优先级 |
|---|---|---|---|---|
| **L0 新增** | 新文件/新模块（插件宿主、netlist codec、API facade、UI 插槽） | 绝大多数新功能 | 0 覆盖 | ★★★★★ |
| **L1 钩子** | 用 `HookRegistry` / 事件 / 注册表（`ElementFactory`、`CommandPaletteRegistry`） | 能在既有插槽上挂的行为 | 极低 | ★★★★★ |
| **L2 薄影子** | `export * from '@core/X'; class Y extends X { override m() {} }` | **只用于 ≤20 行小补丁**（字段初始化顺序、多参构造、`instanceof` 陷阱） | 低 | ★★ |
| **L3 整文件覆盖** | `cover/ts/X.ts` 整份复制 + 锚点 + 契约测试 | **一旦决定覆盖，默认用这个**（结构性改动、需完整控制） | 中高（每次上游改动都要 rebase） | ★★★ |

**实测结果（spike B，全链路，详见 `docs/spikes/cover-build.md`）**：

| 链路 | 结果 |
|---|---|
| dev 影子解析 | ✅ `curl /ResistorElm.ts` 返回 cover 版；cover 内 `./CircuitElm` 被插件改写回上游；`/registerElements.ts` 的 `./ResistorElm` 指向 cover；`style.css` 与 public 标记文件都命中；dev 启动 1.17 s |
| 生产构建 | ✅ 261→268 modules；1,184.16→1,187.64 kB JS（gzip +3 kB）；产物含 `COVER_MARKER`、`coverTag`、`ResistorElm=class extends`（keepNames 生效）、`dist/cover-overlay.json` |
| 类型检查 | ✅ `tsc -p tsconfig.cover.json`（rootDirs 就地检查）4.7–6.9 s；故意塞类型错误 → TS2322 / EXIT 2 |
| 类身份 | ✅ vitest 4 断言：`ResistorElm.name`、`ElementFactory.create('ResistorElm')` 得到覆盖版、`dumpXml` 含新属性 |
| HMR | ✅ 改 cover 文件 → `HMR cover change modules=1` + 整页 reload，约 3 s 后新内容可见 |
| 冲突扫描 | ✅ 5 态 + `collision`/`orphan` + anchor 校验；模拟"改实现/改签名/双边改/删文件/新增同名"全部判对，EXIT 0/1 正确；Node sha1 与 `git hash-object` 逐条一致 |
| 物化构建树 | ✅ `cover.mjs apply` 1.1 s 产出 691 文件（含 5 个覆盖文件），供 CI diff 与复现 |

两个**必须自补的胶水**（不补就是"看起来生效、实际没生效"）：
1. **覆盖文件里的相对导入必须由插件显式指回上游**。Vite 按覆盖文件物理位置解析 `./CircuitElm`，第一版直接 `Failed to resolve import`（日志已留证）。任何"影子目录"方案都会踩，且只在"覆盖文件 import 上游未覆盖文件"时暴露。
2. **public/ 静态资源是另一套机制**：上游 `copyPublicAssets` 在 `closeBundle` 手工拷贝，覆盖层要按同映射自己拷；CSS 里的 `url(images/…)` 会相对 `cover/` 解析而 404；`base:'./'` + 生产 service worker 会让旧缓存伪装成"覆盖没生效"。

**整文件 vs 薄影子（实测结论）**：两者都不破坏 `ElementFactory`/`keepNames`（产物里是 `ResistorElm=class extends ResistorElm$1`）。但薄影子有坑：字段初始化顺序不能重写、多参构造重载要靠 `super` 转发、**任何绕过影子的模块会拿到第二份类导致 `instanceof` 失效**。⇒ **默认整文件复制；薄影子只用于 ≤20 行的小补丁，并写进评审规则**（与我最初的"薄影子优先"判断相反，以实测为准）。

**新增元件的硬边界（影响插件设计）**：`scripts/generateRegistrations.mjs` 只 `readdir(ts 根)`、**非递归**、只收 `*Elm.ts`，且没接进 `package.json`；`Menus.ts:490` 起是**硬编码**的 "Add Resistor" 列表，不是注册表生成。⇒ 插件要加自定义元件，必须：`ElementFactory.registerClass` + `CirSim.theApp.register` + **给 Menus 留注入点**（否则元件存在但用户点不出来）。这条决定 P2 必须做"菜单插槽"。

**关键工程点（这三个决定了 Cover 是否可持续）：**

1. **seam 先行**：与其让 10 个特性各自去改 `CirSim.ts`，不如一次性把"poke 面"做成一份最小补丁集，版本化 + 契约测试。实测结论（详见 `docs/seams.md`）：
   - **S1（必需，L3）**：覆盖 `ts/main.ts`（58 行），末尾加 `await ExtBoot(app)` —— 唯一差异两行；
   - **S2（必需，L0）**：在 `ExtBoot` 里对 `app.jsInterface.call*Hook` 做**实例级链式包装**，拿到 update/analyze/timestep/svg 四类事件；包装 `app.importCircuitFromText` + `app.loader.readCircuit` 拿到全部导入入口；
   - **S3（推荐，L3 40 行）**：`ElementFactory` 补 `deregisterClass/listClasses`（否则插件"卸载"是假的）；
   - **S4（L0）**：命令注册表字段是 public static，宿主自己记账即可，无需覆盖；
   - **S5（暂缓）**：`HookRegistry` 追加结构性钩子，等真有需求再加。
   ⇒ 覆盖面从"每个特性改几个热点文件"降到"1 个 58 行文件 + 2 个微型文件"。**这是本方案成败的分水岭。**
2. **锚点 + 契约测试**：只比对 blob hash 会把"上游语义漂移但 hash 变了/没变"判错。每个覆盖文件记录 anchors（它依赖的上游签名，例如 `dumpXml(doc, elem)`、`getXmlDumpType()`、`getPost(n)`），同步时校验锚点；再加**电气指纹回归**（373 个语料的节点电压/元件电流）兜底。
3. **生成物不覆盖**：`registerElements.ts` 是 `ts/scripts/generateRegistrations.mjs` 的产物。覆盖生成物 = 每次上游重新生成就冲掉。正确做法是新增第二个注册模块，在 boot 后追加注册。

冲突扫描的判定空间（`tools/cover.mjs scan`，退出码即 CI 门禁）：

```
clean            上游未变、本地有覆盖        → OK
local-only       上游未变、本地新增           → OK（正常演进）
upstream-changed 上游变了、本地没动覆盖副本  → 自动 rebase（需人 review）
both-changed     双边都变                    → 冲突，阻断合并
orphan           上游文件被删/改名           → 覆盖失效，必须处理
anchor-broken    blob 级 clean 但锚点没了    → 语义漂移，必须处理
```

### 2.3 Plugin 层（动态插件 / cordis 语义）

**判定：可行，但"沙箱"这一层必须先想清楚，否则插件生态会失控。**

上行事实：
- 动态 `import('/plugins/<id>/index.js?rev=N')` 天然支持热重载（query 串破缓存）；`activate/deactivate` + `ctx.disposables` 足以实现"可卸载"。
- 已有 `CommandPaletteRegistry`、`ElementFactory`、`HookRegistry`，插件加命令/元件/钩子不需要改核心。
- 已有 `Locale`，插件文案可复用 i18n。

必须正视的三件事：
1. **没有真沙箱**：同源 ESM 就是全权限。`window`、`document`、`fetch`、核心单例它都能碰。
   ⇒ 设计两档执行模式：**in-page（可信，直接 ctx）+ worker（不可信/AI 生成，`postMessage` 只走数据面 API）**。你的 API 是数据型的（网表 JSON + 测量值），非常适合切到 worker。
2. **静态粗扫描**（你原话"冲突粗扫描"）要落成可执行门禁：插件入口 + manifest 做 AST/正则扫描，禁止 `document`、`window.CircuitJS1`、`eval`、`new Function`、直接 `import '../core/...'`（类型导入白名单除外）、读写 `localStorage` 裸用；manifest 声明 `permissions: ["storage","network","ui","elements"]`，不声明就注入受限 ctx。**扫描不是安全边界，是"粗扫描 + 责任归属"**，报告里要这么写，别把它当沙箱。
3. **卸载语义**：核心静态状态不可回滚。契约写成"**卸载 = 释放本插件注册的一切（监听器、命令、DOM、定时器、注册表项）**"，而不是"还原核心状态"。`ElementFactory` 目前**没有 deregister** ⇒ 必须由 Cover 补（这是 seam 清单里的一条）。

**实测结果（spike C，真 Chromium，未改 Core）**：

| 能力 | 结果 | 证据 |
|---|---|---|
| 动态 import + `activate` | ✅ 插件挂上 3 个钩子、注册 1 条命令（207→208）、7 个 disposable | `spike/plugin-runtime/evidence/plugin-host.json` |
| `deactivate` 清理 | ✅ 钩子槽位回 `null`、命令回 207、计数冻结（无残留） | 同上 |
| 热重载 | ✅ `?v=N` 穿透 ESM 缓存，v1→v2 生效；同 URL 复用同一实例 | 同上 |
| 失败隔离 | ✅ activate 抛错不拖垮宿主与 app（仍可导入电路） | 同上 |
| **失败路径泄漏** | ⚠️ activate 中途抛错会留下已注册的监听（实测 `onanalyze=1` 未释放） | 契约必须"激活失败无条件 LIFO 回滚" |
| 钩子单槽 | ⚠️ `CircuitJS1.onanalyze` 是覆盖式单槽；**N>1 插件会互相踩** | 宿主必须做多路复用（自己维护订阅表） |
| 命令撤销 / 元素注销 | ⚠️ Core 无 `remove` / `deregister` | 命令可由宿主记账（字段是 public static）；元素必须 Cover 补 |



**cordis 对齐**：你的目标模型（ctx / service / fiber / effect / inject / dispose / 配置驱动加载）是 Koishi 的 cordis 那一套，语义成熟（npm 上的 cordis 描述就是"显式依赖注入 + 作用域服务 + 生命周期托管清理 + `inject` 声明依赖 + fiber 释放时自动移除 effect/监听/服务"）。建议**自研 ~300 行轻量 ctx 与 cordis 语义对齐**，而不要把 cordis 运行时直接塞进浏览器包（多一层依赖与打包风险），但保留以后替换的接口形状：`ctx.plugin()`, `ctx.inject(deps, cb)`, `ctx.effect(fn)`, `ctx.on('dispose')`, `ctx.get(name)`, `ctx.provide(name, impl)`。

状态机（建议直接实现）：

```
discovered → resolved(依赖拓扑) → loaded(import) → activated → running
                                              ↘ failed(隔离，不拖垮其他插件)
running → deactivating → unloaded（effect 逆序释放）
             ↑ 热重载：unloaded → loaded（保留 ctx.storage 命名空间）
```

### 2.4 App 层（组装）

**判定：可行，且应该是"一个 CLI + 一个 Vite 插件 + 一个 boot 模块"，不要做成第四个运行时框架。**

职责重述（把"加载"拆清楚）：

| 阶段 | 谁做 | 做什么 |
|---|---|---|
| 构建期 | `ext build/dev`（Node CLI + Vite 插件） | 校验 `core.lock`/`cover.manifest`/`plugins.manifest` → 影子解析 → 类型检查（独立 `tsconfig.cover.json`）→ 冲突扫描 → 打包 |
| 启动期 | `boot.ts`（Cover 的 L0 新文件） | 挂 `ExtBridge`（暴露 app/API）→ 初始化插件宿主 → 按依赖顺序 activate → 注册冲突报告面板 |
| 运行期 | 插件宿主 | 生命周期、事件、命令、UI 插槽、热重载、错误隔离 |

**"App 层加载核心"要么是构建期静态解析（正解），要么是运行时动态 import 已构建产物（会丢掉类型/摇树）。别指望浏览器里替换任意核心文件**——这是 C1 的落地含义。

### 2.5 JSON 拓扑格式 + AI API + MCP

**判定：格式可行（高置信）；但"JSON 省 token"的通俗叙事是错的——省的是导线 + 坐标，不是 JSON 语法。导入可行但有硬前置（布局合成）。**

**实测（373 例全量，`docs/spikes/netlist-codec.md`）**：

| 表示 | 体积（÷官方 XML = 1.00） | 说明 |
|---|---|---|
| 官方 XML | 1.00（560,374 B） | 现行保存格式 |
| legacy txt | 0.685 | 已无导出路径 |
| **命名键 JSON** | **2.29** | 比 XML **还大**，朴素 schema 是负优化 |
| 紧凑 JSON（短键/数组） | **0.32** | |
| 网表文本（一行一件、无坐标） | **0.19** | 最省 |

消融（逐步删减）：去 XML 语法 −47.6% → **删导线 −32.3%** → **删坐标 −49.3%** → 删默认值 −5.2%。语料里 **4,909 根导线 = 元件总数的 46.5%**。
⇒ JSON 的价值是**结构与可编程性**（nets、语义类型、稳定引用、schema 校验），不是字节数。要省 token 必须用紧凑编码/netlist 文本，**对外必须讲清楚**，否则会被自己的基准打脸。

- **导出**：不要自己从坐标反推连接。正解是驱动真实引擎：正确序列是 `importCircuit → analyzeFlag=true → sim.analyzeCircuit() → sim.preStampCircuit(false)`，然后读 `sim.nodeList` + 每个 `CircuitNode.links`（`CircuitNodeLink{num, elm}`）——这就是权威网表；JSON 只是它的序列化。
  - 实测保真（codec 独立解析）：txt 路径 **335/335 = 100%**；元件数对拍引擎 **372/372**；脚位数 93.84%；回写后再解析 335/335，**引脚划分不变 335/335**。
  - **独立 oracle 对拍（关键负证据）**：拿引擎 `nodeList` 当参照，codec 自算 nets 只在 **clean 桶 96 例里 54 例一致（56.25%）**，degraded 桶 239 例 **0%**，总体 **54/335 = 16%**。两条系统性缺陷：① 引擎把所有接地脚并进同一个 `CircuitNode.ground`，codec 没做跨坐标 union（过度切分，例：`besselbutter` 引擎 12 类 vs codec 23 类）；② 多掷开关 `S` 的引脚数错（引擎 4 脚 vs codec 2 脚，`4way` 差 −8）。
  - ⇒ **结论：nets 必须由引擎算，codec 只做"序列化 + 属性映射 + 紧凑编码"**。自研并查只在"没有引擎的离线批量转换"时用，且必须标注可信度（clean/degraded 桶）。
- **导入**：分两级。
  - `layout: "keep"`（保留量化坐标）→ 1:1 还原，**必做**。
  - `layout: "auto"` → 布局合成器（按 net 摆件 + 正交布线 + 结点合并）。硬证据：**无坐标可完整推断仅 105/373 = 28.2%**，2,930 个引脚卡在多脚元件的内部几何（`setPoints/calcLeads/getPost` 重载）。这是"画图问题"，不是"格式问题"；v1 允许 `requires_layout` 报错，别假装能自动布局。
- **元件表自动化**：255 类 → **158 真元件 / 97 UI 类**；143 有 txtType（90.5%，含继承）；105 有 XML 属性三元组；**85 个 type 里 31 个参数个数随 flag 变长**（`RailElm` 6/4/0、`TransistorElm` 5/4/3）⇒ 生产实现必须**按 type 生成小解析器**，扁平表天然不成立。XML tag 走双路映射（`getXmlDumpType()` 优先、否则类名），注意 `GateElm.ts:144` 用 `getClassName().replace("GateElm","")` 算出 `And/Nand/…`（12 例失败，修法约 5 行 + `Scope` tag 冲突白名单 + `n`→Noise 别名）。
- **AI API**：读（网表、节点电压、元件电流、scope 数据、`getInfo` 文本）、写（改参数、增删元件、设外部电压、run/stop/timestep）、解释（元件 info 串）。**写通道用 ops 补丁，不让 AI 手写 XML/坐标**（理由与算法见 [format-strategy.md](format-strategy.md)）。**稳定 ID 是最大设计点**：索引会随编辑漂移。建议 API 层用 `WeakMap<elm, id>` 管会话内 ID，导出 JSON 时写 `id`；跨会话就落 JSON，不污染官方 XML。
  - 实测约束：`window.CircuitJS1` 只有 13 个成员，元素代理只有 **6 个只读方法**（`getType/getInfo/getVoltageDiff/getVoltage/getCurrent/getPostCount`），没有 setter；`getElements()` 急切构建且 **6/373 电路整体抛错**（`alu74181`、`td4*`）⇒ 一律按元件逐个读 `app.elmList`。
  - 钩子语义：`ontimestep` 每仿真步（1.2 s 内 2031 次）、`onupdate` UI 节流（75 次）、`onanalyze` **只在重分析时 1 次**（`SimulationManager.ts:1034`），别把 `onanalyze` 当帧钩子。
- **MCP**：两条路
  - **浏览器附着**（先用）：页面内 WebSocket 桥到 Node MCP server。spike C 的结论是：Node 侧适合做网表编解码/diff，**载入 + 仿真 + 指纹必须在浏览器内**，所以用 session 式 RPC（`open/load/step/measure/close`）而不是无状态工具调用。
  - **无头求解器**（后做，价值极高）：实测 `SimulationManager.ts` 里 `document/window` 引用数为 **0**，元件在 Node 下可构造（post 坐标、dump 类型都能打印），DOM 绑定点在 `CirSim`。但 `registerElements()` 会构造 `AudioOutputElm`（要 DOM）与 `LDRElm`（要 2D canvas），需 canvas/DOM 桩。⇒ 实现 ~200 行 `HeadlessApp` shim（约 17 个成员）+ canvas 桩，**AI 就能不开浏览器做仿真**；未端到端验证，列为可选路线。

---

## 3. 可行性判定表

| 子项 | 判定 | 证据强度 | 备注 |
|---|---|---|---|
| 按路径镜像覆盖 TS 源码（构建期） | **可行** | 强（Vite `resolveId/load` 原生能力 + spike B） | 注意 `keepNames`、`public/` 资源、`base:'./'` |
| 覆盖"新增文件 + 薄影子" | **可行** | 强（TS 语言特性） | 禁止改类名 |
| 整文件覆盖热点文件长期可维护 | **有条件可行** | 中 | 依赖 anchor + 契约测试；冲突率高时改 fork-merge |
| 运行时插件 activate/deactivate/热重载 | **可行** | 强（真 Chromium 实测：钩子归零、命令回滚、`?v=` 热重载、失败隔离） | 卸载只回滚自身；失败路径需强制回滚 |
| 插件沙箱 | **不可行（同源）/ 可降级（Worker）** | 强 | 只能"粗扫描 + 权限声明 + Worker 隔离" |
| JSON 拓扑导出（去坐标） | **可行** | 强（引擎 `nodeList` 权威 + 335/335 解析、372/372 元件数对拍） | token 收益见 §2.5：**紧凑 0.32×、网表 0.19× XML；命名键 JSON 反而 2.29×** |
| JSON 导入（保布局） | **可行** | 强（回写后引脚划分不变 335/335） | 1:1 还原 |
| JSON 导入（自动布局） | **有条件可行** | 强（负证据：无坐标仅 28.2% 可推断） | 独立工程问题，分期；v1 明确报 `requires_layout` |
| 无浏览器仿真（Node 求解器） | **有条件可行（未端到端验证）** | 中（静态 + 元件构造已验） | `HeadlessApp` shim 待做 |
| 跟随上游更新 | **可行** | 中 | 靠 seam + 锚点 + 电气指纹；无 tag 需自建 |
| 商业闭源分发 | **受限** | 强 | GPLv2（`COPYING.txt`）；`package.json` 的 ISC 是错的，以 GPLv2 为准 |

---

## 4. 风险清单（按优先级）

| # | 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | 自有代码与上游 API 的耦合点被上游重构 | 上游改静态单例/`elmList`/`getPost` 几何/管理器拆分 | 升级时编译或行为断裂 | 二开模式下不致命：跟随面只有 1+2 个文件；用 seam + 契约测试（语料指纹）兜住，耦合点集中在 `ExtBridge`/`ExtBoot` 一层 |
| R2 | 覆盖副本漂移：上游改了语义、我们的副本还"看起来对" | 上游重构同名方法 | 静默错误 | anchors + 373 语料电气指纹回归 + 每次同步跑 |
| R3 | 类名/注册表契约被破坏 | 覆盖时改类名、覆盖 `registerElements.ts` | 元件造不出来、静默功能缺失 | 禁止改类名；生成物不覆盖；注册表快照测试 |
| R4 | 插件冲突与泄漏 | 多插件抢同一 hook/命令 ID、卸载不清监听 | 状态错乱、内存涨 | 声明式 claim + 单例规则、dispose 契约、泄漏测试（监听器计数归零） |
| R5 | JSON 导入的自动布局工作量被低估 | 以为"去坐标"免费 | 排期爆掉 | v1 只做 `layout:keep`；自动布局单独立项（实测无坐标仅 28.2% 可完整推断） |
| R9 | 自研拓扑推断不可信 | 以为"坐标重合 = 连接"就够 | 网表错误、AI 被喂错数据 | **nets 一律由引擎 `nodeList` 产出**；自研并查仅用于离线批量且标注可信度（oracle 实测 16%） |
| R6 | 构建链脆弱（rolldown-vite 较新、`keepNames` 耦合） | 上游升级 Vite | 覆盖失效/构建挂 | 锁 Vite 版本、CI 跑 `build+test`、覆盖冒烟用例 |
| R7 | 上游高频变动 | 无 tag、主线即 dev-ts | 契约频繁失败 | 自建标签、按月同步窗口、把可上游化的补丁 PR 回去 |
| R8 | 许可证 | 分发/商业化 | GPLv2 传染性；`package.json` 标签误导 | 明确以 GPLv2 为准；插件若需闭源走 Worker/独立进程边界并做法务确认；或与上游谈授权 |

---

## 5. 替代架构对比（为什么选"修正版分层"）

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 修正版分层**（推荐） | Core 钉版 + Cover 分级 + seam + 插件宿主 | 跟进上游可控、可多套定制、插件生态 | 需要工具链与纪律 | ✅ 选它 |
| B. fork + 定期 merge | 直接改自己的 fork，周期性 merge upstream | 工具链零成本、IDE 友好 | 冲突集中爆发、无法多特性开关、插件仍需宿主 | 单人单产品可选；与插件目标冲突 |
| C. 纯运行时 monkey-patch | 只在 `window`/原型上包一层 | 零构建改动 | 改不了私有逻辑、丢类型、加不了元素/菜单 | 只适合小补丁 |
| D. 尽量上游化 | 把改动做成 PR 回上游 | 长期成本最低 | 上游接受度不可控、独家特性暴露 | **与 A 并用**（能上游的就上游） |
| E. 走 `cxx/` 原生 | 用 C++ 端口自建 UI | 性能/桌面 | 等于重写产品 | ❌ |

---

## 6. 实测验证汇总（三个 spike，均可复现）

| # | 验证项 | 方法 | 结果 | 对方案的含义 |
|---|---|---|---|---|
| V1 | Cover 影子解析（dev） | Vite 插件 `resolveId/load` + 中间件 | ✅ `/ResistorElm.ts` 返回 cover 版；cover 内 `./CircuitElm` 被改指上游；public 资源命中；**HMR ≈3 s** | 构建期覆盖可行 |
| V2 | Cover 影子解析（build） | `vite build` | ✅ 261→268 modules；375 ms→984 ms；1,184→1,216 kB（+2.7%） | 构建成本可接受 |
| V3 | 覆盖层类型检查 | `tsc -p tsconfig.cover.json`（rootDirs 就地检查） | ✅ 4.9 s；故意塞类型错误 → TS2322 退出码 2 | 覆盖代码不会绕过类型系统 |
| V4 | 三方冲突扫描 | `tools/cover.mjs scan` + 模拟上游改/改签名/双边改/删文件 | ✅ 5 态 + anchor；`both-changed`/`anchor-broken` 正确触发，退出码 0/1 | "跟进上游"可自动化 |
| V5 | 插件生命周期（真 Chromium） | 页面内 ESM 宿主 + `?v=` 热重载 | ✅ activate 207→208 命令、3 钩子、7 disposables；deactivate 全归零；热重载 v1→v2 生效；失败隔离存活 | 插件系统可行 |
| V6 | 插件失败路径 | `activate()` 中途抛错 | ⚠️ 宿主存活但残留 1 个订阅 | 契约必须强制 LIFO 回滚 |
| V7 | 语料 + 电气指纹 | 373 个 txt 逐个载入、400 步确定性运行 | ✅ 372/373（唯一失败是空电路），5.49 s，10,555 元件 | 契约回归基座就位 |
| V8 | 网表解析/回写 | codec 双路解析 + 回写 | ✅ txt 335/335；元件数对拍 372/372；引脚数 93.84%；回写后引脚划分 335/335 不变 | 格式可行 |
| V9 | 网表 nets 独立 oracle | 浏览器 `sim.nodeList` vs codec 并查 | ❌ clean 桶 96 例仅 **54 例一致（56.25%）**；degraded 239 例 0% | **nets 必须由引擎算，codec 只做序列化** |
| V10 | 体积消融 | 373 例逐格式统计 | ✅ 命名 JSON **2.29×** XML；紧凑 0.32×；网表文本 0.19×；删导线 −32.3%、删坐标 −49.3% | 省的是结构不是语法 |

**三个"被证伪的直觉"**（比成功更重要）：

1. ❌ "JSON 一定比 XML 省 token" → 命名键 JSON **大 2.3 倍**；只有紧凑编码/网表文本才省，且省在导线与坐标。
2. ❌ "自己按坐标推连接就行" → 与引擎对拍仅 16%（clean 桶 56%），ground 合并与多掷开关引脚数两处系统性偏差。
3. ❌ "要改 CirSim.ts 才能暴露 app" → 实际只需 `main.ts` 一个 58 行文件的 2 行改动（或 `HookRegistry.createJSInterface` 包装）。

---

## 7. 结论

1. **架构成立**，而且上游的 TS 化把它从"高难"降到"中等"：影子覆盖、插件、API 都有现成支点。
2. **最大的技术风险不在 JSON，也不在插件**，而在"**覆盖面治理**"：能不能把改动压进一个小而稳定的 seam 里，并用契约测试守住。R1/R2 不解决，别的都白搭。
3. **最大的产品差异点**是"AI 可读写的活电路"：网表 JSON + 测量 API + 无头求解器三者组合，市面上（SPICE 类 MCP：`spicelib-mcp`、`spicebridge`）都是批处理网表，没有"边画边仿边改"的活对象模型。
4. **许可证要早决策**：GPLv2 是硬约束，别等要分发时才看。

下一步见 `docs/development-plan.md`；三项验证细节见 `docs/spikes/`。
