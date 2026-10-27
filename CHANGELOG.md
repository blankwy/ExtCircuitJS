# Changelog

## v0.2.0（2026-10-27）

**v0.2 收尾：任务板最后一张卡（B08）落地，编译器上语料回归网，CI 接上浏览器契约。**

### B08 · Worker 模式插件（任务板收官）
- 不可信插件跑在 Web Worker 隔离线程：拿不到 DOM/引擎对象，只能经 postMessage RPC 向宿主取数据。
- 宿主 mode:worker 分支：创建 Worker + WorkerRpcClient 双向协议（宿主 serve getNetlist/getMeasurements/step/report，按 sim.observe 裁剪，引擎对象不外传）；deactivate 时通知并 terminate。
- 示例插件 plugins/ext-worker（enabled:false 按需加载）+ 浏览器契约（activate→ready、取网表元件数>0、deactivate 清理）。
- manifest-fields 补 workerType/name/apiVersion/description；lint 同步放行 worker 模式。

### probe op 落地（v0.2 功能债）
- probe op 从占位 unsupported 变为真实：映射引擎停靠 scope（viewInScope 同路免坐标），幂等、unknown target 结构化失败（C03 语义），elmList 零污染。

### C07 编译器 · 373 语料回归网
- 新建 compiler-corpus.browser.test.mjs：layout 路由 345/345 全过（含坐标/导线照搬的无损往返）；重建路由测出实际地板 R，全部失败例逐例归因（浮空脚/示波器/FLAG_SMALL 等语料特性，非编译器缺陷）。

### CI 浏览器契约上云
- ci.yml 新增 browser job（双平台）：装 playwright-core（EXT_PW_CORE 指向 repo 内路径）+ build（dist-site 依赖产物）+ dev server 后台探活 + 串行跑全部 17 个浏览器契约，逐条 PASS/FAIL 汇总。
## v0.1.8（随 v0.2.0 一并发布）


**网表终于能载入了。** 上一版 `load_netlist` 只会对 JSON 说"不"，理由成立但把路堵死了：
引擎只认电路文本/XML，紧凑格式又刻意丢了坐标，于是"A I 读网表 → 改 → 写回电路"这条闭环
缺了最后一环。这一版补的是**编译器**——拓扑是输入，坐标和导线是输出。

### 两条路径，一个判据

- **带 layout 的网表**（`exportNetlist({layout:true})`）：坐标照搬，**自带导线也照搬**
  （`WireElm` 本来就在 `components` 里，再重新布一遍等于把同一段连接画两次）。
  这是真正的无损往返。
- **不带 layout 的网表**（AI 手写、`get_netlist` 默认输出、紧凑格式解码后）：
  无坐标导线被剔除（导线是"连接"不是"元件"），元件按**连接序 BFS** 摆进网格
  （行间留 64px 通道），再用 **A\* 网格搜索**重建导线。A\* 的障碍有三类：元件本体、
  别人家的 post、**别的网已经布过的格子** —— 最后一条保证不会把两个网短接。

判据只有一个，而且是硬闸：重建后强制重分析，按 `elm.nodes[i]` 的**对象身份**比对引脚
划分（不看 net 名字，重编号合法），不一致就用快照回滚、返回
`{ok:false, unsupported:[{code:"topology_mismatch"}]}`。接线是电气问题，不能"差不多就行"。

### 行为变化

- `circuit.load_netlist` 接受三种输入：core 文本 / XML / **网表 JSON**（命名或紧凑）。
  紧凑格式会在 load 内部解码再编译，`netlist_json_not_loadable` 这个码随之退休。
- 成功返回 `{ok:true, format:"netlist", stats:{components,wires,explicitWires,nets}, losses}`；
  `losses` 如实报：坐标是照搬还是生成、哪些字段被丢弃、哪几段导线躲不开障碍（`conflicts`）、
  哪几个元件的实际位置与网表有偏差（`positionDrift`）。
- `apply:false` 时编译完会回滚，只交电路文本（给"先看看长什么样"的场景）。
- 子电路实例明确拒绝：`subcircuit_not_supported`（网表不带子电路库，默默构造只会得到
  1 脚的假元件）。

### 撞出来的坑（都写进 HANDOVER 了）

- 一端元件构造后**必须调一次 drag/setPoints**：`point1/point2` 只在 `setPoints()` 里赋值，
  漏了 `getPost()` 返回 (0,0)，所有地和电源轨都掉到原点；
- ChipElm 系列的 `pins[]` 由 `setupPins()` 建，而脚数取决于 `inputMode`/`dataBusWidth`/`bits`
  这些属性 —— `applyProps` 之后必须补 `setupPins()`，否则 `setPoints` 读到 `undefined`；
- `RoutedWireElm.setPoints()` 会启动全局 router 扫全图，构造期调用必崩（用 `setPoints(false)`）；
- 总线宽度（`busWidth`/`bits`）没进 registry，但引脚数是它的整数倍 → 按引脚数反推；
- "元件被自身短路""元件没有引脚"在真实语料里很常见，不是错误。

### 验收

| 命令 | 覆盖 |
|---|---|
| `node --test tests/contract/compile.test.mjs` | 16 例：几何算法（连接序 / 格点 / 绕障 / 异网不共格 / 围死记冲突）+ 迷你引擎上的编译事务（预校验、属性、确定性、回滚） |
| `node tests/contract/netlist-compile.browser.mjs` | 真引擎：5 个语料 `export → compile → export` 引脚划分逐字相同；子电路负例按码拒绝；合成环（6 元件 / 5 网）自动布局出 18 段导线、0 冲突、拓扑一致 |
| `node --test --test-concurrency=1 tests/contract/*.test.mjs` | 全量 151 例（原 135 + 新增 16） |

## v0.1.7

紧凑格式终于有了**消费方**：`circuit.get_netlist` 加了 `format: "compact"`。接的时候撞上一个
设计问题——位置化的 props（`[1,1000,5,0,0,0.5,0,0.001]`）没有字段名就是一串数字，而喂整份
registry（255 个类型）比数据本身还大。于是格式改成**自描述**：自己带一份"本电路用到的类型 +
属性名前缀"的图例。

### 类型图例 `t`（自描述，默认开）

- 输出新增 `t: { "<typeIdx>": ["VoltageElm", ["waveform","frequency","maxVoltage"]] }`，
  只含本电路**用到的**类型，字段名只报**实际用到的槽位前缀**（同类型元件里最长的那个决定深度）
- 键按**数字**索引升序（字典序会把 `"17"` 排到 `"9"` 前），同一电路编两次字节相同
- `encodeCompact(nl, { legend: false })` 仍可拿到纯投影形态（更小，但要自己拿 registry 翻译）
- 解码**优先按图例**还原字段名：图例就是编码端的 registry 快照，于是 registry 重新生成、
  属性顺序变动之后历史数据仍解得对。两端不一致时记 `losses.legendDrift`（类名或字段前缀不符）
- 图例形状不对直接抛：坏图例会让**每个**字段名错位，静默忽略等于把数据解成错的字段名

体积代价（372 例语料实测，`ext netlist bench` 现在同时报两个口径）：

| 形态 | 聚合 | 中位 | 说明 |
|---|---|---|---|
| 纯投影（`legend:false`） | 0.258× XML | 0.257× | C05 原验收线 ≤0.35×，不变 |
| **自描述（默认，MCP 实际输出）** | **0.415× XML** | 0.497× | 新验收线 ≤0.50×；图例占 37.7% |
| 命名 JSON（get_netlist 现状） | 2.513× XML | — | 自描述紧凑是它的 **0.165**（省 83%） |

图例是**每电路固定成本**（40–560 字节）：大电路约占 19%，小电路 30–60%，1/372 例的极小电路
上它甚至比 XML 还大——这些数字不藏，bench 里逐例报 `legendBytes` 并把"比 XML 还大"的例点名。

### MCP

- `circuit.get_netlist`：新增 `format: "netlist" | "compact"`（默认 netlist）与 `legend`（默认 true）；
  返回 `{ok:true, format, compact|netlist, bytes}` —— 用字段名区分形态，不让调用方猜 payload 是什么
- `circuit.load_netlist`：**修正描述里的谎**。它一直写着"网表 JSON / XML 由 loader 区分"，
  但 `CircuitLoader.readCircuit` 只认 `<`（XML）与文本，网表 JSON 从来没有导入器 —— 传进去会被
  当电路文本逐行解析、静默丢掉全部内容，报出来的是 `empty circuit`。现在见到 `{` 开头的内容直接
  返回 `{ok:false, unsupported:[{code:"netlist_json_not_loadable", reason:"…"}]}`，
  **且发生在动电路之前**（不会把当前电路清空）。理由里给出可行方向（改参用 `set_param`，换电路用 XML）
- 页面桥 `export` 支持 `format:"compact"`；`ExtApi.dumpCompact()` 作为薄转发

### 测试

- `netlist-compact.test.mjs` 9 → 15 例：图例只含用到的类型 / 只报已用前缀 / 解码按图例还原且记
  `legendDrift` / registry 不认识的类型也能解 / 纯投影与自描述解出同一份网表 / 图例形状非法逐项抛
- `mcp-tools.browser.test.mjs` +2 例（真实引擎）：`format=compact` 的**每个已用槽位都有名字**、
  本地 `decodeCompact` 解出的元件类型/props/连通性与命名网表逐项相等、体积更小；
  紧凑与命名 JSON 两种 `load_netlist` 都被明确拒绝且电路元件数不变
- bench 的 `checkRoundtrip` 现在两种形态都过幂等律，并要求二者解出**同一份网表**

## v0.1.6（未发布）

紧凑网表补上**解码器**，并且用 373 例真实语料把它钉住。此前 C05 只有编码：格式小到 0.26× XML，
但没有任何东西能证明"编出去的东西还认得回来"——`docs/development-plan.md` 里写的
"三档互相可转"实际上靠人工核对。

### `decodeCompact`（紧凑 JSON → 网表投影）
- 返回 `{ netlist, losses }`：`netlist` 与 `encodeCompact` 的输入同形（`schema` / `components` /
  `nets` / `unsupported`），可以直接再编码，也可以当作"网表 JSON"喂给写入入口
- 类型索引 → 类名、`props` 位置 → 字段名（`null` 占位跳过、dump-only 属性不占位）、
  `pins` 下标 → `{ post: netId }`（中间 `-1` 保留为空洞）、net 下标 → `GND` / `n0..` id
  （与 `exportNetlist` 同一命名规则）、`n` 命名表 / `g` 接地 / `u` 不支持项原样还原
- 解不回来的三件如实记账（`losses`）：`geometry`（坐标）、`wires: "unknown"`（导线行，
  数量不可知 → 元件 id 会有缺口）、`unresolved`（类型索引解析不出的元件数）。
  另有 `orphanProps`（属性位置越出 registry = 编解码两端版本漂移）与 `unreferencedNets`
- 形状不对直接抛 `decodeCompact: …`：紧凑格式是机器产出的，静默返回半个电路比报错更贵

### 正确性判据：幂等律 + 内容对拍
有损格式不可能"解回原样"，所以判据不能是深比较原网表：
- **幂等律** `encode(decode(encode(nl))) ≡ encode(nl)`：解码不引入**新的**损失。
  逐字段的成立理由写在 `compact.ts` 文件头（类型表双向、pins 的 maxPost/空洞一致、
  props 的 null 占位与尾部省略一致、flags/unsupported 原样）
- **内容对拍**：摘掉"刻意丢掉的"导线行/坐标后，元件类型、`f`、`props`、引脚连通性
  逐字段相等。只证明幂等律是不够的 —— 一个"把属性全丢掉"的解码器同样满足它

### 语料级验证（372 例，`node tools/ext.mjs netlist bench`）
- 幂等律 **372/372**、内容 **372/372**，比较了 **5646 个元件 / 3655 个 net**；
  未解析元件 0、属性越位 0、空 net 0（= 真实电路里导线剔除后没有 net 变成孤儿）
- 聚合体积 **0.258× XML**（中位 0.257×，验收线 0.35×）——bench 报告里新增 `roundtrip` 段，
  对拍失败同样以退出码 1 结束（"体积达标但解不回来"不该算通过）
- 报告里记了"对比了多少元件/net"：防止对拍写成空转（0 个元件也能全绿）

### 测试
- 新增 `tests/contract/netlist-compact.test.mjs`（9 例，纯 Node，**进 CI**）：基本往返 /
  导线剔除与 id 缺口 / 属性前导 null 与尾部省略、dump-only 不占位 / 引脚中间空洞与尾部裁剪 /
  类型索引越界与未知类型 / net 下标反推（ground 在末位、命名、无人引用） / 非法输入逐项抛错 /
  两轮解码不动点 / registry 漂移的 `orphanProps`

## v0.1.5（未发布）

元件交互事件补齐成完整一面：**拖动**有了高频事件，**元件增删**有了结构事件。
此前插件只能知道"选中了什么、点了谁"，用户拖走一个元件、删掉一个元件、载入另一份电路，
对插件完全不可见（只能自己轮询 `listComponents()` 比对）。

### `elemdrag`（拖动中）
- 按下时给整张元件表打几何快照（`x,y,x2,y2`），移动时比对，**只报真的动过的元件**
- `phase` = `start` / `move` / `end`，payload 带 `{ elms, indices, ids, grid, delta }`
  （`grid` 是指针当前格点，`delta` 是相对按下的格点位移）
- 一帧最多一条（rAF 合并，100ms 兜底）：`mousemove` 的频次由浏览器决定，插件不该被它控制节奏
- 判定不看 `tempMouseMode`，只看几何是否变化 —— 上游改拖动实现（reroute / post 拖动 / 整选拖动）
  都不用改这里；新建元件的预览实例不在 `elmList` 里，所以不会被误报成拖动
- 松手在画布外也收得到 `end`（document 冒泡阶段收尾，此时 core 的 `draggingDone` 已经跑完）

### `elementschange`（增删）
- 按**对象身份**比对整张元件表（不按下标：删掉中间一个元件会让后面全体下标 -1，
  按下标比对会把"删一个"报成"全删全加"）。纯换序不算变化
- payload：`{ added: [{index,id,type,elm}], removed: [...], count, source }`；
  `removed` 的 `index/id` 是移除前最后已知值
- `source` 与 `ctx.hook` 的 `meta.source` 同一套词汇（`document` → `load`），外加三类用户动作：
  `pointer`（画布）/ `ui`（菜单、工具栏、对话框）/ `keyboard`；另有 `undo` / `paste` /
  `recovery` / `internal` / `manual`。**插件必须按 source 过滤**：撤销和载入也走这条路
- 结构比对是**同步**的，且调用点都选在"上游已经改完"之后（画布 mouseup/click、document keyup、
  菜单动作之后的 0ms 定时器、载入完成回调）——这样 source 才不会张冠李戴
- 载入电路时 `elmList` 被整体重建，但那是普通方法调用、没有任何 DOM 事件：
  新增 `ExtHooks.afterLoad()`（宿主内部旁观者，不进 ctx）在 `readCircuit` 返回后同步一次，
  嵌套/子电路载入只在最外层结束时通知

### 修的坑
- `document.removeEventListener` 的 capture 标志必须与 `addEventListener` 一致，
  否则监听器静默留在 document 上（Node 契约的假 EventTarget 现在按 `type|capture` 记账，写错就红）
- 文本格式每行要 5 个字段（`x1 y1 x2 y2 flags`）：导线少写 `flags` 会被上游**静默丢掉**
  （浏览器契约里踩到，已把该电路改成合法写法）
- `plugins-smoke` / `reload` 里的监听器增量断言原本写死 1，改为 `EVENT_SUBS`
  （示例插件现在订阅 3 个事件；断言仍要精确，不能放宽成 `>=1`，否则漏监听器查不出来）

### manifest 字段表：清掉 `inject`
- 新增 `packages/plugin-api/manifest-fields.json`（唯一权威表）：`entryFields` / `allowedMode` /
  `retired`。运行期（`ExtPluginHost`）、构建期（`ext plugin lint`）、测试（`permissions.test.mjs`）
  读同一份，不再各抄一遍
- `inject: ["api"]` 从 6 个插件里删掉：它从没被任何代码读过（"声明依赖"是幻觉），
  现在写它会被 lint 报错并给出迁移提示（`注入语义已由 permissions 取代`）
- 运行期遇到未知字段 → 记 warning（`plugins.list()[i].warnings` 可见）+ console.warn，
  但**不阻断激活**：手里有旧 manifest 的部署不会因为一个装饰键就起不来
- `mode` 保留但被真正校验（只允许 `in-page`）——"被检查的字段"和"装饰性字段"是两回事

### 产物契约补一条老接口
- `dist-site.browser.mjs` 现在会真开一次 `jsinterface.html`（外部站点 iframe 嵌入的老路）：
  iframe 起得来、`window.CircuitJS1` 在位、`oncircuitjsloaded` → `onanalyze`/`onupdate` 回调真的跑
  （`#info` 出现 `V(vsense)` 与计数器）、`getElements()` 有 78 个元件、`getTime() > 0`。
  它同时验证三件平时各坏各的事：`startCircuit=jsinterface.txt` 在部署后的 `circuits/` 里能找到、
  iframe 与父页同源、老 API 的名字一个没改（`getElements/getNodeVoltage/setExtVoltage/exportCircuit/…`）
- 顺带确认 `iframe.html` 是上游的空壳（0 字节，`war/` 里写着 "Insert title here"），没有内容可测，
  不为它编造断言

### 测试
- 新增 `tests/contract/element-events.test.mjs`（10 例，纯 Node，进 CI）：身份比对 / 纯换序 /
  替换 / 几何快照 / 无 canvas 时 no-op / refresh 双同步 / 拖动三相位 / 拖动中的新建不算拖动 /
  keyup 来源 / ui 来源 / dispose 后零监听零事件
- 扩 `element-events.browser.test.mjs`（真实鼠标键盘）：拖 48px → `start…move…end` 且
  `delta` 与画布缩放一致；Delete 删元件 → `source=keyboard`；Ctrl+Z → `source=undo`；
  载入另一份电路 → `source=load` 且 `count` 正确；并验证示例插件经 `ctx.on` 的正式通道确实收到
- 扩 `hooks.test.mjs`（10 例）：`afterLoad` 只在最外层载入结束后触发、来源正确、旁观者抛错不影响载入
- 扩 `permissions.test.mjs`（12 例）：manifest 字段表与运行期导出双向一致、仓库 manifest 零未知字段、
  宿主对未知字段只警告不阻断（`inject` 与随机键各一条，带迁移提示）

## v0.1.4（未发布）

`permissions` 从"装饰性字段"变成真的闸门：**运行期强制 + 构建期 lint + 站点策略**三处同口径。
此前 manifest 里写着 `permissions` 和 `claims`，但没有任何代码读它——安全模型是摆设。

### 权限目录（唯一权威表）
- 新增 `packages/plugin-api/permissions.json`：7 项能力（`sim.observe` / `sim.control` /
  `ui.command` / `ui.panel` / `ui.menu` / `element.register` / `document.hook`），
  每项带 `label` / `surface` / `summary` 与 lint 用的源码特征 `check`
- 新增 `packages/plugin-api/src/permissions.ts`：`ExtPermission` 联合类型、
  `resolveDeclaredPermissions`（名字拼错直接抛，不静默忽略）、`applyPermissionPolicy`
- 同一份 JSON 被运行期（`ExtPluginHost`）与 `tools/ext.mjs plugin lint` 共同读取，避免"文档一套、检查一套"

### 运行期强制
- `ctx` 每个面调用前校验：`ctx.on`→`sim.observe`、`ctx.api`→`sim.control`、`ctx.command`→`ui.command`、
  `ctx.panel`→`ui.panel`、`ctx.hook`→`document.hook`、`ctx.element.*`→`element.register`，
  带菜单注册额外要 `ui.menu`（`register({ menu: false })` 不需要）
- 未授予即抛 `ExtPermissionError`（`code: "ext/eperm"`），`denial` 区分
  `undeclared`（作者漏写）/ `denied-by-policy`（站点拦）/ `unknown`（拼错并列出可用项）
- `ctx.api` 写成 getter：**读属性就校验**，不给"存在但一用就炸"的对象
- 新增 `ctx.permits(perm)` 与 `ctx.permissions`：缺权限时能体面降级，而不必靠 try/catch 探
- 权限解析发生在 `import(url)` **之前**：拼错权限名的插件连代码都不会被加载
- `plugins.list()` 新增 `permissions` / `denied` / `warnings`；`claims` 与实现不一致时记 warning
  （`policy.strictClaims` 下升级为激活失败）

### 站点策略
- `plugins.manifest.json` 顶层可写 `"policy": { "denyPermissions": [...], "strictClaims": false }`
  —— 部署侧能整体关掉某一面（如演示站禁 `document.hook`，别改访客的存档）；策略只能做减法
- 传 `policy` 也可由宿主构造参数给（`new PluginHost(app, api, hooks, policy)`），两者取并集

### 构建期检查（`ext plugin lint`）
- 未知权限、`claims` 有内容却没申请对应权限、**源码用了某面却没声明** 全部报错（带文件行号）
- 扫描前先抹掉注释与字符串（`maskNonCode`），注释里写一句 `ctx.panel` 不会误报
- 声明了却没用到 → 只提示不失败（动态取用 `ctx[name]` 看不出来）
- 单个插件目录带 `plugin.json` 时也能 lint（`ext plugin lint plugins/x`），不必先进 manifest

### 修
- 示例插件的权限声明补齐（`hello` 缺 `sim.observe`/`sim.control`、`ext-event` 缺 `sim.observe`、
  `ext-hook` 缺 `sim.control`）——这三个缺口正是新模型要抓的东西
- `tests/contract/plugin-element.browser.test.mjs` 与 `boot.browser.mjs` 里手写的插件 entry
  改为从 manifest 派生（手写副本会在插件加权限后立刻过期）

### 测试
- 新增 `tests/contract/permissions.test.mjs`（9 例，纯 Node，进 CI）：目录自洽 / 七个面各自抛 /
  未捕获时激活失败零残留 / 声明了就通 / 拼错时插件代码不被加载 / 策略 deny 降级 /
  claims 不一致 / `ui.menu` 独立 / lint 与运行期同口径（含"注释不算使用"的对照组）

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
