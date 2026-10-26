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

全量门禁（2026-10-26 Lead 亲跑）：**16/16 退出 0**——doctor、build、plugin lint、cover status、cover scan、core sync-drill、Node 契约 40 测试（element-factory/ops/netlist-ids/fiber/events/mcp-session）、浏览器契约 10 套（boot/menu/g2/place/plugins-smoke/reload/netlist-export/netlist-roundtrip/mcp-bridge/mcp-tools）。

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

15. **浏览器驱动是可选依赖（刻意如此）**：`playwright-core` 不进 `package.json`（只跑 Node 契约的人不该被装浏览器驱动）。运行时按 `EXT_PW_CORE` → 仓库根 `node_modules/playwright-core` → `core/ts/node_modules/playwright-core` 依次找；都找不到时**不要**改成硬依赖，把提示写清即可。Chrome 同理：`EXT_CHROME` → 各平台默认安装路径（Chrome → Edge → Chromium）。

## 5. 测试地图（改哪里跑什么）

| 改动 | 必跑 |
|---|---|
| cover/ts/*（宿主/桥/菜单/boot） | `ext build` + 对应浏览器契约 + `boot.browser.mjs` 回归 |
| packages/netlist/* | `node --test ops/netlist-ids` + `netlist-export` + `netlist-roundtrip`（浏览器）+ `ext netlist registry`（若动 registry-gen） |
| packages/mcp/* | `mcp-session` + `mcp-stdio`（纯 Node）+ `mcp-bridge` + `mcp-tools`（浏览器）+ `mcp-stdio.browser.mjs`（独立进程端到端）+ `examples/ai-loop.mjs` |
| packages/mcp/src/{stdio,server,backend,dev-server}.ts | 上面全部 + `node tools/ext.mjs mcp --help` + 手工 `initialize`/`tools/list` 各一条（stdout 必须是纯协议帧） |
| tools/ts-resolve.mjs（TS 加载钩子） | `node --test tests/contract/mcp-session.test.mjs`（shim 路径）+ `node tools/ext.mjs mcp --help` |
| plugins/* | `ext plugin lint` + `plugins-smoke.browser.test.mjs` + `plugin-element.browser.test.mjs`（改 `ctx.element` 时） |
| cover/ts/ExtElements.ts（插件自定义元件） | `plugin-element.browser.test.mjs` + `menu.browser.mjs` + `ext build` + `fiber.test.mjs`（Node 侧加载约束，见坑位 17） |
| tools/ext.mjs | doctor + 受影响子命令的手工验证 |
| tools/coverOverlay.mjs | `ext build` + 上表浏览器契约（dev 走同一解析器）+ `dist-site.browser.mjs`（§4 坑位 9） |
| cover/vite.cover.config.ts（产物收尾） | `ext build` + `node tests/contract/dist-site.browser.mjs`（把 dist 挂在 `/<prefix>/` 下真开一次：`window.ExtCircuitJS` 就绪、插件全 ready、站内 0 个 404、V(n1) 与 G2 基线一致） |
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

1. **加载/保存钩子**（缺得最明显）：现在插件只能在仿真事件（analyze/update/timestep/svgren）上挂钩子，
   用户"打开电路 / 保存电路"时插件无法介入。做法就是 S2 的老套路——包 `app.loader.readCircuit` 与
   `dumpCircuit`，暴露 `ctx.hook("load"|"save")`；`ext/hook` 的拦截要带"可改写文本"的返回值，
   否则插件只能看不能改。
2. **元件交互事件**：选中/点击/拖动元件目前对插件不可见（只能轮询 `listComponents()`），
   "选中元件显示扩展信息"这类最常见的插件需求做不了。候选事件 `select` / `elemclick`。
3. **`permissions` 落地**：manifest 里的 `permissions` 目前只声明、不校验（`plugin lint` 只查三条文本规则）。
   真正的收口是按 permission 裁剪 `ctx`（没有 `ui.menu` 就不给 `ctx.element` 的菜单入口），
   并让 lint 把"用了未声明的能力"报出来。
4. **两个上游辅助页**：`iframe.html` / `jsinterface.html` 已经进产物，但 `dist-site.browser.mjs` 只开主页面；
   这两个页面是外部站点嵌入的老接口，坏掉没人知道。
5. 可选功能债（不变）：B08 Worker 沙箱、`decodeCompact`（C05 只做了编码）、probe op 的 ScopeElm 映射。
6. CI 跑浏览器测试（装 Chrome + playwright-core）。

## 7. 纪律（沿用 goal 手册，对任何执行者有效）

1. `core/` 只读；改 core 才能继续的诉求 → 上报，不许动手。
2. 验收命令是唯一裁判：每个"完成"必须附命令退出码/输出，不许模型自证。
3. 测试断言不许弱化换绿；测试本身错了 → 记录上报。
4. 禁止顺手重构；计划外发现记 `docs/handoffs/observations.md`。
5. 每卡独立 commit（`卡号: 一句话`），不混无关文件（`.mimosa/` 永不提交）。
6. 同一失败连续 2 次 → 换模型/换人重试 1 次 → 仍败写阻塞报告（复现命令 + 完整日志）。
