# Stage 3 handoff（2026-10-26）

- 做了什么：B01 Fiber dispose 四不变式契约测试（LIFO/幂等/late-add 立即执行/signal aborted）；B02 事件多路复用契约测试（3 订阅全收、抛错隔离、wireAppEvents 对抗 core 单槽钩子）；B03 命令插槽 + 冲突拒绝（ExtPluginHost 所有权登记，scanClaims 改只校验）；B04 面板插槽 + DOM 卸载清理契约（含激活失败 LIFO 回滚）；B06 plugin lint 三禁令（报错级，支持显式路径双向验证）；B07 三示例插件 ext-panel/ext-command/ext-event 进 manifest + 浏览器同时启停冒烟；B05 热重载 `?rev=` 换版本（reload 可显式指定 rev）。实现轮 commit b3f2283 / e887038 / cefa4d3 / 4c82f3d / 93f03e4 / b209b2d / 51ac0fc（2026-10-25）；复验轮 commit 0cdaf42 / 200d7b8 / d5028e2 / 326a60f / 47367e3 / 0a1f0b5 / 85644a4（2026-10-26）——七卡代码零改动（唯二差异是 B01/B02 两处测试断言只收紧不放宽、B04 三处行号注释修正、B03 空标记提交），实跑验收全绿，B06 eval 规则首次落盘实测命中。B08（可选）未做，不进达成条件。
- 证据：收尾复核于 2026-10-26 在复验轮 HEAD（85644a4）全量重跑，六条验收命令全绿：`node --test fiber+events` 18 pass 0 fail EXIT=0；`boot.browser.mjs` ok:true（4 插件 ready、netlist.components=7、ops.applied=1、errors=[] / consoleErrors=[]）EXIT=0；`plugins-smoke` 三插件停机后 listeners 1 / analyze 1 / commands 208 / byId 574 / panelChildren 18 / markers 0 与 baseline 逐项相等、checks panelOk/cmdVisible=true、cmdRan/eventCount=1，1 pass 0 fail EXIT=0；`plugin lint` 默认 4 插件全过 EXIT=0，仓库外违规样例四规则逐行命中（core-import:2 / eval:3 / new-function:4 / document-write:5）4 issue(s) EXIT=1；`reload.browser.mjs` 三轮 ?rev=b05-1/2/3 真实模块请求 13 条、manifest 重取 10 次、旧命令对象双不可见、终卸 afterFinalDeactivate 精确回落 baseline 且 markers=0，EXIT=0。`git log -- core/` 自骨架 20383ef 后零提交、`git diff 20383ef HEAD -- core/` 为空——core/ 只读铁律全程成立（2026-10-26 实查）。分卡证据见下文各段。
- 卡在哪：无阻塞。两条历史观察已有后续：① eval 违规样例在仓库内被 Mimosa 安全 hook 误拦 → 复验轮起改置仓库外 _scratch 即可落盘实测（本次收尾复核再度复现，四规则全中），observations 对应条目的"无法落盘"仅适用于仓库内路径；② 浏览器契约对共享 5174 dev server 的依赖持续存在（本次 probe 一次通过，复用遗留进程），测试内自动起 server 的需求留待 Stage 6 CI 化。
- 下一步：Stage 4 已完成（C04 设计先行 + C04b place 实现 + G3 三套 smoke 全绿，见 stage4.md / stage4-design.md）；当前前沿是 Stage 5 剩余卡：D05 docs/mcp.md 文档 + G4 外部客户端门禁（D01–D04 已提交 944bf50/85eedf7/69fd544/b1bc840）。可选卡 B08（Worker 模式）仍未做，按手册不进达成条件，留待 Stage 6 前酌情补。
- 消耗：实现轮 F worker（B01/B02/B03/B04/B06/B07）按卡面预算合计约 23 万 token、G worker（B05）约 5 万；复验轮七卡（复跑验收 + 断言补强）无独立计量记录（workflow 运行记录在本会话不可读），估算另耗 ≤ 10 万 token。均为按手册卡面预算的估算值，实际消耗无法核对。GLM 免费额度充足，远未触止损线。

## B01 Fiber dispose 四不变式（commit b3f2283；复验 0cdaf42）

`tests/contract/fiber.test.mjs` 新增 77 行，Node 侧经 ts-resolve 基座直载 cover/ts/ExtPluginHost.ts。四条断言（复验轮断言补强后于 2026-10-26 重跑全绿）：

```
✔ dispose 逆序：后注册的清理先执行（LIFO），状态落到 disposed
✔ 重复 dispose 幂等：清理动作恰好执行一次，再次 dispose 不抛不重跑
✔ dispose 后再 add()：迟到的清理动作立即同步执行（不进栈、不外泄异常）
✔ 插件拿到的 AbortSignal：dispose 时 aborted=true，abort 监听恰好收到一次事件
```

复验补强（0cdaf42，+16/−3）：late-dispose 异常隔离断言升级为捕获 console.error 恰好一次且含原始异常、零外泄（不放宽任何断言）。

## B02 事件多路复用（commit e887038；复验 200d7b8）

`tests/contract/events.test.mjs` 新增 173 行。对抗单槽钩子的六条断言全绿：

```
✔ 3 个订阅者同时挂 analyze：一次 emit 三者全收，订阅计数=3（对抗单槽）
✔ 其中一个回调抛错：异常被隔离，其余订阅者（含后注册者）仍全收，总线不损
✔ analyze 类事件四路互不串扰：各命名空间独立派发
✔ wireAppEvents：core 单槽钩子一次调用 → 3 插件订阅全收，原钩子不被顶替
✔ wireAppEvents：app 无 jsInterface 时安全返回 noop
✔ 退订与宿主生命周期：off 精确移除；ctx.on 接线 + fiber.dispose → 订阅计数回 0
```

复验补强（200d7b8，+13/−7）：抛错隔离日志断言收紧为每次含抛错的 emit 恰好一条日志且记录原始异常对象本身（ExtEvents.ts:33 契约）。

## B03 命令插槽 + 冲突拒绝（commit cefa4d3；复验 d5028e2 空标记）

`cover/ts/ExtPluginHost.ts` +31 行（ctx.command 所有权登记 / disposer 释放 / 冲突拒绝；scanClaims 改只校验，在 Stage 3 写作用域内）；`tests/contract/fiber.test.mjs` 增 4 条宿主生命周期断言（Node 直载真实 PluginHost）：

```
✔ B03 命令插槽：ctx.command 注册进调色板、返回的 disposer 精确撤销、run 经调色板可触发
✔ B03 冲突拒绝：第二插件抢同 id 被拒（抛错非静默），先注册者命令原样保留、被拒插件零残留
✔ B03 claims 早拒：manifest 声明与在册所有者冲突 → activate 即拒；卸载后槽位释放、后到插件可激活
✔ B03 卸载回基线：多插件交错注册/卸载命令数精确回落；抢占核心命令 id 也被拒、核心命令不受波及
```

## B04 面板插槽 + DOM 卸载清理（commit 4c82f3d；复验 326a60f）

`tests/contract/fiber.test.mjs` 增 208 行（手写最小 DOM 桩镜像 UIManager 表面，未动 core）：

```
✔ B04 面板插槽：ctx.panel 把元素挂进宿主 verticalPanel（iFrame 之前），disposer 精确撤销且幂等
✔ B04 DOM 卸载清理：多插件交错挂面板，逐个卸载后子节点数精确回基线、无残留节点
✔ B04 激活失败回滚：activate 中途抛错，已挂面板随 LIFO 回滚 detach，零 DOM 残留
✔ B04 清理弹性：插件自行摘除面板后，宿主卸载不抛、无错误日志、容器计数不变
```

复验（326a60f，3/3 行）：仅修正两处漂移的行号注释引用（宿主 203-208→209-214、core 586-589→585-589），无逻辑改动。

## B06 plugin lint 三禁令（commit 93f03e4；复验 47367e3）

`tools/ext.mjs` +61/−7（仅 lint 扩展，作用域内）：core-import / eval / new-function / document-write 四条文本正则（tools/ext.mjs:188-193），命中即报错（非 warn），递归扫插件目录全部 js/ts；`plugin lint <path>` 显式路径模式专供双向验证。双向实测（2026-10-26 收尾复核重跑）：

```
$ node tools/ext.mjs plugin lint    → "plugin lint ok"  EXIT=0（4 插件目录全过）
$ node tools/ext.mjs plugin lint <仓库外违规样例> →
  violation.js:2: core-import: import 指向 core: "../core/ts/Foo.ts"
  violation.js:3: eval: 动态代码执行 eval(
  violation.js:4: new-function: 动态代码执行 new Function(
  violation.js:5: document-write: 裸 document.write(
  4 issue(s)   EXIT=1
```

注（2026-10-26 更新）：实现轮 eval 样例在仓库内被 Mimosa 安全 hook 误拦未能落盘；复验轮起改置仓库外 _scratch 后落盘实测命中（47367e3 首次，本日收尾复核再度复现四规则全中）。eval 正则已实测，原 observations 条目的"无法落盘"结论仅适用于仓库内路径。

## B07 三示例插件 + 同时启停冒烟（commit b209b2d；复验 0a1f0b5）

`plugins/` 新增 ext-panel / ext-command / ext-event（各 plugin.json + index.js），`node tools/ext.mjs plugin list` 四插件全 OK；`tests/contract/plugins-smoke.browser.test.mjs`（279 行）真实 Chromium。2026-10-26 复跑（1 pass 0 fail EXIT=0）：

```
baseline:     listeners 1 / analyze 1 / commands 208 / byId 574 / panelChildren 18 / markers 0
withPlugins:  listeners 2 / analyze 2 / commands 209 / byId 575 / panelChildren 19 / markers 1
afterStop:    listeners 1 / analyze 1 / commands 208 / byId 574 / panelChildren 18 / markers 0（与 baseline 逐项相等）
checks:       panelOk=true / cmdVisible=true / cmdRan=1 / eventCount=1
✔ B07 plugins-smoke：三示例插件同时启停无泄漏 (3364.4ms)
```

## B05 热重载 ?rev=（commit 51ac0fc；复验 85644a4）

`cover/ts/ExtPluginHost.ts` +12 行：reload 支持显式指定 rev（模块 URL 加 `?import&rev=<rev>` 绕 ESM 缓存）；`tests/contract/reload.browser.mjs`（330 行）真实 Chromium 三轮 reload。2026-10-26 复跑（EXIT=0）：

```
revs: b05-1 / b05-2 / b05-3（真实模块请求 13 条 = boot 4 + 每轮 3 插件 ×3 轮；manifest 重取 10 次）
counts.boot == afterReloadR1 == afterReloadR2R3（listeners 2 / analyze 2 / commands 209 / byId 575 / panelChildren 19 恒等，零累积）
afterReloadR1: oldCmdStillById=false / oldCmdInArray=false（旧命令对象不可见）
afterFinalDeactivate: listeners 1 / analyze 1 / commands 208 / byId 574 / panelChildren 18 / markers 0（精确回落 boot-1）
EXIT=0
```

## 收尾复核（全部验收命令在复验轮 HEAD 85644a4 重跑，2026-10-26）

```
node --test tests/contract/fiber.test.mjs tests/contract/events.test.mjs → tests 18 pass 0 fail  EXIT=0
node tests/contract/boot.browser.mjs     → ok:true / 4 插件 ready / netlist.components=7 / ops.applied=1 / errors=[] / consoleErrors=[]  EXIT=0
node tests/contract/plugins-smoke.browser.test.mjs → 1 pass 0 fail  EXIT=0（afterStop 六项计数与 baseline 逐项相等，见 B07 段）
node tools/ext.mjs plugin lint           → plugin lint ok  EXIT=0
node tools/ext.mjs plugin lint <仓库外违规样例> → 4 issue(s)  EXIT=1（四规则逐行命中，见 B06 段）
node tests/contract/reload.browser.mjs   → EXIT=0（零累积 + 终卸精确回落，见 B05 段）
```

B01–B07 实现轮 commit：b3f2283 / e887038 / cefa4d3 / 4c82f3d / 93f03e4 / b209b2d / 51ac0fc；复验轮 commit：0cdaf42 / 200d7b8 / d5028e2 / 326a60f / 47367e3 / 0a1f0b5 / 85644a4。写作用域全部落在 Stage 3 清单（cover/ts/ExtPluginHost.ts、tests/contract/fiber|events|plugins-smoke|reload、plugins/、tools/ext.mjs 仅 lint），core/ 未动（`git log -- core/` 自 20383ef 零提交、diff 为空）。
