# ExtCircuitJS 交接文档（v0.1.0 → 下一任执行者）

> 交接对象：DeepSeek harness（付费强模型）或 CodeBuddy（免费额度、能力有限）。
> 交接日期：2026-10-26。交接人：Lead（GLM-5.3 goal 会话，Stage 1–6 执行完毕）。
> 配套阅读：`zcode-goal_step.md`（阶段手册，含全部纪律）、`docs/development-plan.md`（总计划）、`docs/task-board.md`（任务卡原文）、各阶段 handoff（`docs/handoffs/stage1..6.md`）、计划外观察（`docs/handoffs/observations.md`）。

## 1. 项目当前状态（一句话：六个阶段全部完成，门禁全绿，待发布动作）

| 阶段 | 内容 | 状态 | 证据入口 |
|---|---|---|---|
| 1 | 基线三连 + cover 状态 + 测试基座 | ✅ | handoffs/stage1.md |
| 2 | 网表读写闭环（registry/对拍/ops/roundtrip/紧凑编码/稳定 id）+ G2 门禁 | ✅ | handoffs/stage2.md |
| 3 | 插件宿主（fiber/事件/命令/面板/lint/三示例/热重载） | ✅ | handoffs/stage3.md |
| 4 | C04 增量放置（设计先行 + place.ts 自校验回滚）+ G3 门禁 | ✅ | handoffs/stage4.md、stage4-design.md |
| 5 | MCP 全链路（会话 RPC/WS 桥/10 工具/ai-loop demo/文档）+ G4 门禁 | ✅ | handoffs/stage5.md |
| 6 | CI / sync-drill / 菜单插槽 / REL v0.1.0 | ✅ | handoffs/stage6.md |
| 7 | 插件自定义元件（`ctx.element`：类/存档类型/菜单/卸载一条链）+ 静态部署/站点配置/MCP stdio | ✅ | CHANGELOG v0.1.2 |
| 8 | 打开/保存钩子（`ctx.hook`）+ 元件交互事件（`select`/`elemclick`） | ✅ | CHANGELOG v0.1.3 |
| 9 | 插件能力权限（运行期强制 + lint 同口径 + 站点策略） | ✅ | CHANGELOG v0.1.4 |
| 10 | 元件拖动事件 + 元件增删事件（`elemdrag` / `elementschange`，含载入后同步） | ✅ | CHANGELOG v0.1.5 |
| 11 | 紧凑网表**解码**（`decodeCompact` + 幂等律/内容对拍，372 例语料） | ✅ | CHANGELOG v0.1.6 |

全量门禁（2026-10-26 最后一轮亲跑，v0.1.6）：**全绿**——doctor、build、plugin lint、cover status、cover scan、
`ext netlist bench`（372 例，体积 0.258× XML + 解码对拍 372/372）、
Node 契约 **127 例**（`node --test --test-concurrency=1 tests/contract/*.test.mjs`，含 hooks.test.mjs 10 例、
element-events.test.mjs 10 例、permissions.test.mjs 12 例、netlist-compact.test.mjs 9 例）、
浏览器/产物脚本 6 个（boot/menu/netlist-g2/reload/mcp-stdio/dist-site，
其中 dist-site 双形态：根路径 + `/<repo>/`，且两形态都要跑通 `jsinterface.html` 那条老接口）。

## 2. 环境与常用命令

- Node ≥ 22（本机 24.18）；Windows + Git Bash；git 仓库根 = `ExtCircuitJS/`（注意外层 `V:\Vibe\circuitjs1` 还有 _scratch/spike 等，不在仓库内）。
- dev server：`node tools/ext.mjs dev --port 5174`（浏览器测试的前置；探活 `curl http://127.0.0.1:5174/circuitjs.html`）。
- 构建：`node tools/ext.mjs build`；自检：`node tools/ext.mjs doctor`；cover：`node tools/ext.mjs cover status|scan`；插件：`node tools/ext.mjs plugin lint`；registry/bench：`node tools/ext.mjs netlist registry|bench`；假上游演练：`node tools/ext.mjs core sync-drill`；MCP 服务器：`node tools/ext.mjs mcp`（宿主拉起用，stdout 是协议通道）。
- 浏览器契约测试 env：`EXT_PW_CORE`（playwright-core index.mjs 绝对路径）、`EXT_CHROME`（chrome.exe）、`EXC_BASE`（默认 http://127.0.0.1:5174）。新机器需先 `npm install --prefix core/ts`。
- Node 侧加载 cover/packages 的 TS：`tests/contract/helpers/ts-resolve.mjs`（register 后动态 import `.ts` 路径；JSON 已由 load hook 兜住），参照 `tests/contract/ops.test.mjs`。

## 3. 架构速览（读代码前必看）

- **四层**：`core/`（上游只读，pinned e952e78/5.0.3ts）→ `cover/`（影子覆盖 + 新增文件，构建期 coverOverlay 解析）→ `plugins/`（运行期动态 import）→ `packages/`（netlist/plugin-api/mcp）。
- **覆盖纪律**：只有 `ts/main.ts`、`ts/ElementFactory.ts` 是整文件覆盖；新增文件一律加进 `cover/cover.manifest.json`（kind:added）。**cover/ts 下不要建与 core 同名的文件**（会影子掉 core，除非完整 re-export）。
- **网表三通道**：官方 XML（存档）／语义 JSON `netlist/0.1`（读，引擎 nodeList 权威）／ops 补丁（写，不碰坐标）。紧凑编码 0.26× XML（AI 批量读）。
- **稳定 id**：`packages/netlist/src/ids.ts`（e1..eN，WeakMap，全新电路重置）；applyOps 双轨 target（稳定 id 优先 + cN 兼容）。
- **增量放置**：`packages/netlist/src/place.ts`——split 导线 + 有界正交路线 + **放置后自校验（net 数不变 + 引脚落网正确）失败即机械回滚**。
- **MCP**：会话式 RPC（勿改无状态）→ `cover/ts/ExtMcpBridge.ts`（页面内，`/@fs/` 装载挂 window.ExtCircuitJS.mcp）→ Node 侧 `McpBridgeClient`/`AttachToolset`。仅环回。

## 4. 高危坑位（前任踩过的，勿重踩）

1. **引擎确定性步进序列**：`analyzeCircuit() → preStampAndStampCircuit() → runCircuit()`（配合冻结 Date.now）。只调 preStampCircuit 会在 runCircuit 的 NaN 检查崩（analyze 只建矩阵壳不分配行）。参照 `tests/contract/netlist-g2.browser.mjs`。
2. **Mimosa 安全 hook**：本地 `git commit` 前全项目扫描，**仓库外 `spike/` 旧产物（33 高危/21 中危）会硬拦任何提交**。处置：不 --no-verify；根治 = 销账/豁免 spike/（见 §6 待办 3）。它对 `.exec(`/`eval(` 字面量也有误报（改措辞规避）。
3. **生成物不可覆盖**：`core/ts/registerElements.ts` 等生成物禁止改动（铁律 4）。菜单扩展走 `cover/ts/ExtMenus.ts` 插槽。
4. **coverOverlay 解析**：根相对 URL（`/xxx.ts`）只解析 core 存在的文件；cover-only 文件页面内用 `/@fs/<绝对路径>` 装载。
5. **右键弹出菜单 UL 游离于 DOM 外**（右键时才挂载）——菜单断言用元素级 querySelector。
6. **registry 统计以现存为准**：255 类 / txtType 124 / slots 86；重生成必须 diff 为空（`ext netlist registry` 跑两次对比）。
7. **worker 额度/并发**：GLM 免费额度已耗尽（Start Plan code 1005）；同一 provider 并发派发会撞 "model concurrency limit"（失败≠未执行，先查 git status 与工作区）。
8. **`cover/node_modules` 是隐式前置**（CI 首绿时踩过）：仓库根没有 node_modules，依赖只装在 `core/ts`；vite 加载 `cover/vite.cover.config.ts` 时要能从 `cover/` 解析到 `vitest`/`vite`，靠 `tools/ext.mjs` 的 `ensureCoverDeps()` 建 junction（已被 dev/build 自动调用、doctor 有 WARN 行）。该链接被 .gitignore 忽略——**手工建它不会进版本库**，不要靠手工兜底；若再次出现 `ERR_MODULE_NOT_FOUND: vitest`，先看这行有没有被跳过。
9. **模块 id 必须是正斜杠**（Pages 部署时踩过，v0.1.0 的 dist 因此是坏的）：`tools/coverOverlay.mjs` 是 `enforce: 'pre'` 的解析器，交还的 id 直接决定模块身份。Windows 上 `path.join` 的反斜杠与 Vite 的正斜杠会被当成两个模块 → `dist` 里同一份源码出现两份实例（实测两个 `CirSim` 类，`registerElements` 的 `CirSim.theApp` 属于另一份，启动即 `TypeError ... reading 'register'`）。新增解析分支一律 `toId()`。**dev 全绿≠dist 能用**：产物必须真当站点打开一次（把 `dist/` 挂到带前缀的静态服务，用 Chrome 断言 `window.ExtCircuitJS` + 站内 0 个 404）。
10. **`dist/` 出问题先看是不是上游部署脚本的活**：`index.html`、`service-worker.js` 上游都由 `dist.sh` 生成，不在源码里；我们改由 `cover/vite.cover.config.ts` 的 `finalizeForHosting()` 统一产出（含绝对路径转相对），别再手工往 dist 里塞文件。
11. **cover 层的东西不要手写进 core 的 HTML**：`core/ts/circuitjs.html` 是上游文件，同步时会被整份覆盖。A05 的 `cover/public/ext-cover.css` 就是这样失效的——Stage 1 验收时页面里确实注入了 `<link>`、能读到 `--ext-accent`，但那个 link 是手写进 core 的，上游一同步就没了，之后文件一直躺在 `dist/` 里却没有任何页面引用它。凡是「要出现在页面里的 cover 资产或配置」，一律走 `extSiteConfig()` 插件注入（dev 中间件 + build 收尾同一份逻辑），不改 core 的 html。
12. **`coverRoot` ≠ `cover` 目录**：`cover/vite.cover.config.ts` 里的 `coverRoot` 是 `cover/ts`（TS 源码根），而 `cover/site.config.json` 在 `cover/` 下（变量名 `coverDir = here`）。配置读错目录不会报错，只会静默生效成默认值——改完配置先 `curl` 一下入口 HTML 看 `data-ext-site-title` 有没有变。
13. **MCP stdio 的 stdout 就是协议通道**：一行非 JSON-RPC 就会让宿主断连（症状是「服务器启动失败」而不是报错文本）。日志/调试一律 stderr；`ext mcp` 用 `spawnSync(..., {stdio:"inherit"})` 且自身不打印任何东西——在 `tools/ext.mjs` 的 mcp 分支里加 `console.log` 会立刻把它弄坏。同理，`StdioMcpServer` 的 `log` 默认写 `process.stderr`。
14. **`path.resolve(fileURLToPath(import.meta.url), "../..")` 少算一级**：那是把**文件**当目录算。正确写法 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")`。`packages/mcp/src/{backend,dev-server}.ts` 的 repoRoot 两次踩到，报错表现为「找不到 `.../packages/tools/ext.mjs`」——看着像仓库结构坏了，其实是路径基准错了。
15. **浏览器驱动是可选依赖（刻意如此）**：`playwright-core` 不进 `package.json`（只跑 Node 契约的人不该被装浏览器驱动）。运行时按 `EXT_PW_CORE` → 仓库根 `node_modules/playwright-core` → `core/ts/node_modules/playwright-core` 依次找；都找不到时**不要**改成硬依赖，把提示写清即可。Chrome 同理：`EXT_CHROME` → 各平台默认安装路径（Chrome → Edge → Chromium）。
16. **同一个 cover 模块在浏览器里可能有"两份实例"**（v0.1.2 踩到）：Vite 下应用内部导入拿到的是
    `@fs/V:/…/cover/ts/ElementFactory.ts`，而页面里 `import("/ElementFactory.ts")` 走的是另一个模块 URL，
    于是**两份 classMap**——在后者注册的元件，`app.constructElement` 依然找不到；dev server 跨多次改动
    不重启时，HMR 的 `?t=` 还会让同一路径再分叉（症状：`commands.length` 两边都是 0）。
    对策：① 运行期一律用 `window.ExtCircuitJS.elements.factory`（与 app 同一实例）；
    ② 跑浏览器契约前**重启 dev server**；③ 断言优先走 app 上的入口（`constructElement`），
    别用 `import()` 做模块身份断言。
17. **`cover/ts/ExtElements.ts` 不许静态 import `CirSim`/`ExtMenus`/`MouseManager`**：`ExtPluginHost` 会被
    `tests/contract/fiber.test.mjs` 以 Node strip-only 模式直接加载，而 core 的 `CirSim` 图里有不可擦除语法
    （`CommandPaletteRegistry` 的参数属性）会当场炸。所以：dumpType/xmlType 两张表从 `app.constructor` 上取，
    `MODE_SELECT` 从 `ui.mouse.constructor` 上取，菜单实现由 `ExtBoot` 用 `configureMenuSlot()` 注入。
18. **插件的 `getDumpType()` 不覆盖会与核心撞类型**：继承 `ResistorElm` 就返回 `'r'`，`CirSim.register`
    会把 `'r'` 判给插件类并打 "dump type conflict"。`registerExtElement` 因此把 `def.dumpType`/`def.xmlType`
    钉在插件类自己的原型上（只影响该类），插件作者不必记得覆盖。

19. **`dumpCircuit` / `readCircuit` 不只是"保存/打开"**（v0.1.3 踩到）：撤销快照、崩溃恢复、
    粘贴、`isModified()` 的文本比较、子电路进出全走这两个方法。所以 `ctx.hook` 的每次回调都带
    `meta.source`（document/undo/recovery/paste/internal），由宿主包 `undoManager.*`、`isModified`、
    `popContext`、`commands.doPaste` 打标；**插件必须在 `save` 侧按 source 过滤**，否则每按一个键
    都要给撤销快照改写一遍。
20. **`load` 侧不能按 source 过滤**（与 19 是配套的，别抄反了）：恢复用的文本恰恰是**本插件 save 侧写过的东西**，
    过滤掉就把它读成一堆看不懂的字符。正确写法：只要文本里有自己的标记就无条件还原
    （`plugins/ext-hook/index.js` 就是这么写的）。另：改写必须**幂等**（先删标记再追加），
    否则"保存→打开→保存"会越改越多。
21. **`MouseManager.MODE_ADD_ELM = 0`，`MODE_SELECT = 6`**：`app.setMouseMode(0)` 是把界面切到"放置元件"，
    不是"选择"。测试里想点选元件不要调它（默认就是 SELECT），否则下一次点击会去 create 元件。
22. **浏览器契约的两个环境坑（都会表现为"我明明点了/加载了"）**：
    ① 启动电路（演示电路）是**异步**装载的，`window.ExtCircuitJS` 早于它出现 —— 先等 `plugins` 全 ready、
    再 `app.clearCircuit()`，否则基准电路里混进 7 个演示元件；
    ② 电路载入后会重绘并重新居中，**格点→像素的坐标要等两帧再算**，且空白点按画布比例取
    （按格点算容易跑到画布外，点到侧栏上等于什么都没发生）。
23. **别把插件数量/集合写死在测试里**：`reload.browser.mjs` 曾硬编码"4 个插件""卸载后只剩 hello"，
    加一个示例插件就红而它并不是断言目标。改为一律从 `plugins/plugins.manifest.json` 派生
    （数量、集合、卸载后剩余），以后加插件不用再动测试。


24. **`permissions` 不是沙箱，别把它当安全感**（v0.1.4）：插件是同源 ESM，`window` 照样摸得到。
    这套东西的真实价值是三件事——能力显式化、漏声明在「激活现场 / 构建期」就报错、站点能收紧某一面。
    写文档或对外介绍时说清这一点，比多写十个权限名重要。
25. **声明与实现是两套东西，必须双向对齐**：v0.1.4 一上手就发现三个示例插件早就"用了没声明"
    （`hello` 用 `ctx.on`/`ctx.api`、`ext-event` 用 `ctx.on`、`ext-hook` 用 `ctx.api`），
    而此前没人知道，因为**没有任何代码读 `permissions`**。加能力时先写权限表 + 让 lint 报错，
    再谈"插件写起来方不方便"——否则约束会一直停留在注释里。
26. **手写一份插件 entry 的测试，会在插件加权限后立刻过期**：`plugin-element.browser.test.mjs`
    与 `boot.browser.mjs` 都用 `activate({ id, entry, rev })` 手搓过 entry，加权限后当场红。
    一律改为 `fetch("/plugins/plugins.manifest.json")` 取真身再 spread（与坑位 23 同一个道理：
    **测试里不该有第二份 manifest**）。
27. **`removeEventListener` 的 capture 标志必须与 `addEventListener` 一致**（v0.1.5）：监听器注册时传
    `true`、移除时漏了它，浏览器不会报错，监听器就静默留在 `document` 上 —— 每次启动多一份、每次卸载漏一份，
    表现为"事件发了两遍""插件停了还在收事件"。测试里的假 `EventTarget` 必须按 `type|capture` 记账，
    否则这类 bug 永远测不出来（`element-events.test.mjs` 的 `makeTarget` 就是这么写的）。
28. **文本电路格式每行都要 5 个字段**（`x1 y1 x2 y2 flags`，元件再加值）：导线写成 `w 300 100 400 100`
    会在 `CircuitLoader.readCircuitText` 里抛异常→被 `catch` 吞掉→**元件静默消失**（不报错、不提示）。
    这是"我明明写了 2 个元件却只有 1 个"的标准原因，写测试电路时先数一眼字段。
29. **撤销 = 重解析 = 全新对象**：`ctx.on("elementschange")` 按对象身份判定，所以撤销/载入会如实报成
    "一删一加"（旧对象没了、新对象来了）。这不是 bug，别试图在插件里按 id 把两者配对 —— core 没有稳定 id，
    `c<index>` 只是当下标用。要"跨撤销记住某个元件"只能自己存特征（类型 + 坐标 + 值）。
30. **rAF 在无头浏览器里会停摆**：所有"合并到下一帧"的逻辑都必须配一个 `setTimeout` 兜底
    （本仓库统一 100ms），否则事件要等到下一次真正绘制才发出来；反过来，**结构判定不要用 rAF 合并**——
    兜底定时器会把别的动作（键盘删除）的结果算到上一个动作（鼠标松开）的 source 上，v0.1.5 踩过。
31. **`document` 上的捕获监听器看不到目标元素的处理器**：菜单动作跑在菜单项的 `click` 里，捕获阶段收到
    `click` 时动作还没执行。要观察"菜单点了之后电路变了什么"，得把比对排到事件派发结束之后（0ms 定时器），
    或者改在冒泡阶段。混用两种阶段时，`onCanvas(e.target)` 这类判断要写清楚，否则画布上的动作会被记成 `ui`。

32. **manifest 里的"装饰性字段"必须删掉，不是留着解释**（v0.1.5）：`inject: ["api"]` 在 6 个插件里躺了
    三个阶段，没有任何代码读它 —— 它看起来像"声明依赖"，实际连 lint 都不看。这类字段最坏的不是浪费字节，
    而是**让人以为它在生效**（谁也没去 grep 引用点）。处置：字段表落成
    `packages/plugin-api/manifest-fields.json`（运行期警告 + lint 报错 + 测试自检三处共用），
    把 `inject` 送进 `retired` 并给出迁移提示；`mode` 因为被 lint 校验取值所以留着。
    判断标准只有一条：**谁读它？读不到就删。**

33. **有损编码的正确性要两条腿：幂等律 + 内容对拍**（v0.1.6）：只测 `encode(decode(encode(nl))) ≡ encode(nl)`
    会放过"解码器把 props 全丢掉"这种退化（它丢掉的东西再编码也是空的，律照样成立）；只测内容对拍又会
    在编码端偷偷改语义时说不清是谁的错。两条一起跑才知道"没引入新损失"且"没丢该留的东西"。
    另外对拍要**报出比对了多少元件/net** —— 空跑（0 个元件）也能全绿，这种测试比没有更危险。
34. **紧凑格式的属性位置依赖 registry 顺序**：`xmlAttrs` 一改（重新生成 registry、上游加属性），
    历史紧凑数据就整体错位，而且**不会报错**——只会读到错的值。所以解码器把"位置越出属性表"单独计数
    （`losses.orphanProps`），bench 里一旦非零就是编解码两端版本不一致的信号。紧凑数据要长期存盘，
    必须连 registry 版本一起存。
## 5. 测试地图（改哪里跑什么）

**全量本地跑法（唯一推荐命令）**：`node --test --test-concurrency=1 tests/contract/*.test.mjs`
—— 14 个浏览器契约共用同一个 dev server，并行跑会互相挤（`plugins-smoke` 偶发 `commands`/`listeners`
增量断言为 0）。串行约 50s（116 例），并行会假失败。
另有一批老式脚本不进 glob，需单独跑：`boot/menu/netlist-g2/reload/mcp-stdio/dist-site` 的 `.browser.mjs`。

| 改动 | 必跑 |
|---|---|
| cover/ts/*（宿主/桥/菜单/boot） | `ext build` + 对应浏览器契约 + `boot.browser.mjs` 回归 |
| packages/netlist/* | `node --test ops/netlist-ids` + `netlist-export` + `netlist-roundtrip`（浏览器）+ `ext netlist registry`（若动 registry-gen） |
| packages/netlist/src/compact.ts（编码/解码） | `node --test tests/contract/netlist-compact.test.mjs`（纯 Node，边界语义）+ `ext netlist bench`（372 例：体积比 + 幂等律 + 内容对拍，任一失败退出码 1） |
| packages/mcp/* | `mcp-session` + `mcp-stdio`（纯 Node）+ `mcp-bridge` + `mcp-tools`（浏览器）+ `mcp-stdio.browser.mjs`（独立进程端到端）+ `examples/ai-loop.mjs` |
| packages/mcp/src/{stdio,server,backend,dev-server}.ts | 上面全部 + `node tools/ext.mjs mcp --help` + 手工 `initialize`/`tools/list` 各一条（stdout 必须是纯协议帧） |
| tools/ts-resolve.mjs（TS 加载钩子） | `node --test tests/contract/mcp-session.test.mjs`（shim 路径）+ `node tools/ext.mjs mcp --help` |
| plugins/* | `ext plugin lint` + `plugins-smoke.browser.test.mjs` + `plugin-element.browser.test.mjs`（改 `ctx.element` 时）+ `plugin-hooks.browser.test.mjs`（改 `ctx.hook` 时） |
| cover/ts/ExtHooks.ts（打开/保存钩子） | `node --test tests/contract/hooks.test.mjs` + `plugin-hooks.browser.test.mjs` + `dist-site.browser.mjs`（产物形态下钩子同样要跑通） |
| cover/ts/ExtElementEvents.ts（元件交互事件） | `node --test tests/contract/element-events.test.mjs`（纯 Node：身份比对/来源/卸载）+ `element-events.browser.test.mjs`（真鼠标拖动、Delete、Ctrl+Z、载入）+ `boot.browser.mjs`（启动期不得多发空选择） |
| cover/ts/ExtElementEvents.ts 里新增/删除 document 监听 | 同上 + `plugins-smoke`/`reload`（监听器计数必须精确回基线；**capture 标志漏写会泄漏**，见坑位 27） |
| cover/ts/ExtHooks.ts 的 `afterLoad`（载入后同步） | `node --test tests/contract/hooks.test.mjs` + `element-events.browser.test.mjs`（载入 → `elementschange(source=load)`）+ `dist-site.browser.mjs` |
| packages/plugin-api/permissions.json（能力目录） | `node --test tests/contract/permissions.test.mjs` + `ext plugin lint`（两边读同一份表，改一处必跑两处） |
| packages/plugin-api/manifest-fields.json（条目字段表） | 同上（三处共用：宿主警告 / lint 报错 / 测试自检；加字段先想清楚谁读它） |
| cover/ts/ExtPluginHost.ts 的权限闸门 | 同上 + `plugins-smoke.browser.test.mjs`（真 manifest 下六个插件仍要全 ready） |
| cover/ts/ExtElements.ts（插件自定义元件） | `plugin-element.browser.test.mjs` + `menu.browser.mjs` + `ext build` + `fiber.test.mjs`（Node 侧加载约束，见坑位 17） |
| tools/ext.mjs | doctor + 受影响子命令的手工验证 |
| tools/coverOverlay.mjs | `ext build` + 上表浏览器契约（dev 走同一解析器）+ `dist-site.browser.mjs`（§4 坑位 9） |
| cover/vite.cover.config.ts（产物收尾） | `ext build` + `node tests/contract/dist-site.browser.mjs`（把 dist 挂在 `/<prefix>/` 下真开一次：`window.ExtCircuitJS` 就绪、插件全 ready、站内 0 个 404、V(n1) 与 G2 基线一致；再开 `jsinterface.html` 验证旧版 `window.CircuitJS1` 接口与 `startCircuit` 名字解析） |
| core/ts 里的静态页（`jsinterface.html`、`circuits/*.txt` 路径） | `dist-site.browser.mjs`（dev 下这两个页面由 Vite 直接服务，看不出部署后的路径问题） |
| cover/site.config.json（站点配置） | `node --test tests/contract/site-config.test.mjs`（默认值零改动 / 注入幂等 / 许可段落保留 / 转义）+ dev 下改配置刷新一次看标签页标题与「关于」 |

## 6. 待办（按优先级，接手即做）

1. ~~**发布动作（人工，10 分钟）**~~ ✅ 已完成（2026-10-26）：`git push origin main` → CI 首绿（run 40274976842，Windows+Ubuntu 双 success；首跑失败的是 `ensureCoverDeps` 未接线，已修，见 §4 坑位 8）→ tag `v0.1.0` 移到修复提交 `bd7996e` 并推送 → Release 已发（https://github.com/blankwy/ExtCircuitJS/releases/tag/v0.1.0 ，正文取 CHANGELOG v0.1.0 段）。
2. ~~**外部 MCP 客户端验证（G4 补强）**~~ ✅ 已完成（2026-10-26）：查证后发现缺的不是「验证」而是**服务器本身**——`packages/mcp/src/index.ts` 只是骨架，`createAttachTransport` 直接抛 "not implemented yet"，任何标准 MCP 宿主都接不上（此前所有覆盖都是同进程 import `package/mcp`，摸得到 bridge 对象、绕过了协议）。现补：`node tools/ext.mjs mcp` = 零依赖 stdio 服务器（`stdio.ts` 协议层 + `backend.ts` 懒启动后端 + `dev-server.ts` 守护）；工具面补 `sim.step`（否则外部只能墙钟 `sim.run`，读数不可复现）。证据：`mcp-stdio.test.mjs` 11 例（纯 Node，进 CI）、`mcp-stdio.browser.mjs` 独立进程走纯协议跑通读→改→步进→测量→截图（V(n1)=4.80356 基线，改 2.2k 后 9.53785，退出码 0 且端口释放）。宿主配置见 `docs/mcp.md` §6。
3. **spike/ 销账（人工裁决）**：`V:\Vibe\circuitjs1\spike\` 是 spike 期产物（在 git 仓库外），Mimosa 对它的历史发现（SSRF/代码注入/路径穿越，均为 spike 原型的 dist 产物与 Expr.ts）与本仓库无关——建议整目录归档移走或加入扫描豁免，否则本地每次 commit 都可能被拦。
4. **CI 浏览器测试上云（可选）**：CI 现只跑 Node 侧；若要上浏览器测试，需在 CI 装 Chrome + playwright-core 并设 EXT_PW_CORE/EXT_CHROME。
5. **可选功能债**：B08 Worker 沙箱插件（任务板标注可选）、C05 的 decodeCompact（spike 无对应解码器，未做）、probe op 的 ScopeElm 映射（v0.2）。
6. **上游同步（当 pfalstad/circuitjs1 有新 commit 时）**：流程见 `ext core sync` 输出的三步（clone → cover scan --core → rebase cover/ + 更新 core.lock/manifest）；演练工具 `ext core sync-drill` 已验证 scan 判定。
7. ~~**静态部署**~~ ✅ 已完成（2026-10-26）：`dist/` 已是可挂任意前缀的静态站（构建期相对化 + `index.html` + `.nojekyll` + `service-worker.js`），`.github/workflows/pages.yml` 在 main 上自动部署。首次启用需 Settings → Pages → Source = GitHub Actions（已用 API 设好 `build_type=workflow`）。
   **域名不进仓库**：站点域名只在 Pages 设置 / 反向代理侧配置，产物不含 `CNAME`、构建脚本不读任何站点地址（演示站与程序解耦）。`tests/contract/dist-site.browser.mjs` 默认对根路径与 `/<repo>/` 两种形态各断言一次。

### 下一步（v0.2 候选，按「插件还差什么」排序）

1. ~~**加载/保存钩子**~~ ✅ 已完成（v0.1.3）：`ctx.hook("load"|"save")`，包 `loader.readCircuit` 与
   `app.dumpCircuit`，带 `meta.source`（见坑位 19/20），示例 `plugins/ext-hook`。
2. ~~**元件交互事件**~~ ✅ 已完成（v0.1.3 / v0.1.5）：`select` / `elemclick` / `elemdrag` / `elementschange`
   （`cover/ts/ExtElementEvents.ts`）。拖动与增删都不靠轮询、也不包 core 任何私有方法：
   拖动 = 按下时几何快照 + 移动时比对；增删 = 元件表对象身份比对，触发点覆盖画布、键盘、菜单/工具栏、
   以及载入完成（`ExtHooks.afterLoad`）。剩下的已知边界写在文件头注释里（自动恢复的定时落盘不算用户动作）。
3. ~~**钩子权限化**~~ ✅ 已完成（v0.1.4）：`ctx.hook` 需要 `document.hook`；`claims.hooks`
   与实现不一致会记 warning（`strictClaims` 下失败）。
4. ~~**`permissions` 落地**~~ ✅ 已完成（v0.1.4）：七个 ctx 面全部按权限裁剪、`ctx.api` 读属性即校验、
   `ExtPermissionError.denial` 区分漏声明/策略拦截/拼错；lint 与运行期读同一份
   `packages/plugin-api/permissions.json`，源码用了没声明的面直接报错（带行号）。
   ~~`inject: ["api"]`~~ ✅ 已删（v0.1.5，见坑位 32：字段表落成 `manifest-fields.json`，写它会被 lint 报错）。
   剩下没做的：配置驱动加载（`"enabled"` 已有，但没有"按站点覆盖某个插件的 permissions"的细粒度开关）。
5. ~~**两个上游辅助页**~~ ✅ 已完成（v0.1.5）：`dist-site.browser.mjs` 现在会开 `jsinterface.html`，
   验证 iframe + `window.CircuitJS1` + `oncircuitjsloaded/onanalyze/onupdate` + `getElements/getTime`
   整条老链路（两种挂载形态都跑）。`iframe.html` 经查是**上游空壳（0 字节）**，没有内容可测。
6. 可选功能债：B08 Worker 沙箱、probe op 的 ScopeElm 映射。
   ~~`decodeCompact`~~ ✅ 已完成（v0.1.6）：`{ netlist, losses }`，幂等律 + 372 例内容对拍。
   **下一步（把格式真正用起来）**：MCP `circuit.get_netlist` 加 `format: "compact"`、
   `circuit.load_netlist` 接受紧凑 JSON（解码器已就位，长度约 0.26×），否则 C05 只是"能编码"而没有消费方。
7. CI 跑浏览器测试（装 Chrome + playwright-core）。

## 7. 纪律（沿用 goal 手册，对任何执行者有效）

1. `core/` 只读；改 core 才能继续的诉求 → 上报，不许动手。
2. 验收命令是唯一裁判：每个"完成"必须附命令退出码/输出，不许模型自证。
3. 测试断言不许弱化换绿；测试本身错了 → 记录上报。
4. 禁止顺手重构；计划外发现记 `docs/handoffs/observations.md`。
5. 每卡独立 commit（`卡号: 一句话`），不混无关文件（`.mimosa/` 永不提交）。
6. 同一失败连续 2 次 → 换模型/换人重试 1 次 → 仍败写阻塞报告（复现命令 + 完整日志）。
