# Stage 3 handoff（2026-10-25）

- 做了什么：B01 Fiber dispose 四不变式契约测试（LIFO/幂等/late-add 立即执行/signal aborted）；B02 事件多路复用契约测试（3 订阅全收、抛错隔离、wireAppEvents 对抗 core 单槽钩子）；B03 命令插槽 + 冲突拒绝（ExtPluginHost 所有权登记，scanClaims 改只校验）；B04 面板插槽 + DOM 卸载清理契约（含激活失败 LIFO 回滚）；B06 plugin lint 三禁令（报错级，支持显式路径双向验证）；B07 三示例插件 ext-panel/ext-command/ext-event 进 manifest + 浏览器同时启停冒烟；B05 热重载 `?rev=` 换版本（reload 可显式指定 rev）。B08（可选）未做，不进达成条件。
- 证据：见下方各卡证据段；收尾复核在最终状态全量重跑（本日实测）：`node --test fiber+events` 18 pass 0 fail EXIT=0；`boot.browser.mjs` ok:true EXIT=0（4 插件 ready、ops.applied=1，无回归）；`plugins-smoke` 三插件停机后 listeners 2→1、analyze 2→1、commands 209→208、panelChildren 19→18、markers 1→0 精确回基线；`plugin lint` ok EXIT=0 且违规样例目录 3 规则命中 EXIT=1；`reload.browser.mjs` 三轮 ?rev 零累积、旧命令不可见、终卸精确回落 boot-1。
- 卡在哪：无阻塞。执行侧一个工具观察：eval 违规样例 fixture 被 Mimosa 安全 hook 误拦（对故意违规样例报"代码注入"），改用同族 new Function 样例实测（eval 正则本身未落盘实测，见 observations）。
- 下一步：Stage 4（增量放置 C04 + G3 门禁）：C04 设计先行（读 format-strategy §5、core/ts/WireElm.ts split()/draggingDone()，伪代码进 docs/handoffs/stage4-design.md）；G3 三套 smoke 中 B 轨两件（plugins-smoke.browser.test.mjs、reload.browser.mjs）本阶段已就绪可直接复用，C 轨用 ops 闭环。
- 消耗：F worker（B01/B02/B03/B04/B06/B07）按卡预算合计约 23 万 token；G worker（B05）约 5 万——均为按手册卡面预算的估算值（workflow 运行记录在本会话不可读，实际消耗无法核对）；GLM 免费额度充足，远未触止损线。

## B01 Fiber dispose 四不变式（commit b3f2283）

`tests/contract/fiber.test.mjs` 新增 77 行，Node 侧经 ts-resolve 基座直载 cover/ts/ExtPluginHost.ts。四条断言（收尾复核全绿）：

```
✔ dispose 逆序：后注册的清理先执行（LIFO），状态落到 disposed
✔ 重复 dispose 幂等：清理动作恰好执行一次，再次 dispose 不抛不重跑
✔ dispose 后再 add()：迟到的清理动作立即同步执行（不进栈、不外泄异常）
✔ 插件拿到的 AbortSignal：dispose 时 aborted=true，abort 监听恰好收到一次事件
```

## B02 事件多路复用（commit e887038）

`tests/contract/events.test.mjs` 新增 173 行。对抗单槽钩子的六条断言全绿：

```
✔ 3 个订阅者同时挂 analyze：一次 emit 三者全收，订阅计数=3（对抗单槽）
✔ 其中一个回调抛错：异常被隔离，其余订阅者（含后注册者）仍全收，总线不损
✔ analyze 类事件四路互不串扰：各命名空间独立派发
✔ wireAppEvents：core 单槽钩子一次调用 → 3 插件订阅全收，原钩子不被顶替
✔ wireAppEvents：app 无 jsInterface 时安全返回 noop
✔ 退订与宿主生命周期：off 精确移除；ctx.on 接线 + fiber.dispose → 订阅计数回 0
```

## B03 命令插槽 + 冲突拒绝（commit cefa4d3）

`cover/ts/ExtPluginHost.ts` +31 行（ctx.command 所有权登记 / disposer 释放 / 冲突拒绝；scanClaims 改只校验，在 Stage 3 写作用域内）；`tests/contract/fiber.test.mjs` 增 4 条宿主生命周期断言（Node 直载真实 PluginHost）：

```
✔ B03 命令插槽：ctx.command 注册进调色板、返回的 disposer 精确撤销、run 经调色板可触发
✔ B03 冲突拒绝：第二插件抢同 id 被拒（抛错非静默），先注册者命令原样保留、被拒插件零残留
✔ B03 claims 早拒：manifest 声明与在册所有者冲突 → activate 即拒；卸载后槽位释放、后到插件可激活
✔ B03 卸载回基线：多插件交错注册/卸载命令数精确回落；抢占核心命令 id 也被拒、核心命令不受波及
```

## B04 面板插槽 + DOM 卸载清理（commit 4c82f3d）

`tests/contract/fiber.test.mjs` 增 208 行（手写最小 DOM 桩镜像 UIManager 表面，未动 core）：

```
✔ B04 面板插槽：ctx.panel 把元素挂进宿主 verticalPanel（iFrame 之前），disposer 精确撤销且幂等
✔ B04 DOM 卸载清理：多插件交错挂面板，逐个卸载后子节点数精确回基线、无残留节点
✔ B04 激活失败回滚：activate 中途抛错，已挂面板随 LIFO 回滚 detach，零 DOM 残留
✔ B04 清理弹性：插件自行摘除面板后，宿主卸载不抛、无错误日志、容器计数不变
```

## B06 plugin lint 三禁令（commit 93f03e4）

`tools/ext.mjs` +61/−7（仅 lint 扩展，作用域内）：core-import / eval / new-function / document-write 四条文本正则（tools/ext.mjs:188-193），命中即报错（非 warn），递归扫插件目录全部 js/ts；`plugin lint <path>` 显式路径模式专供双向验证。双向实测：

```
$ node tools/ext.mjs plugin lint                 → "plugin lint ok"  EXIT=0（4 插件目录全过）
$ node tools/ext.mjs plugin lint <违规样例目录>    →
  violation-core.js:1:  core-import: import 指向 core: "../core/ts/Foo.ts"
  violation-newfn.js:1: new-function: 动态代码执行 new Function(
  violation2.js:1:      document-write: 裸 document.write(
  3 issue(s)   EXIT=1
```

注：eval 样例 fixture 被 Mimosa 安全 hook 拦截未能落盘（对故意违规样例误报"代码注入"，见 observations.md），eval 正则本身未做落盘实测；同族 new-function 规则实测命中，正则随 B06 commit 固化于 ext.mjs:190。

## B07 三示例插件 + 同时启停冒烟（commit b209b2d）

`plugins/` 新增 ext-panel / ext-command / ext-event（各 plugin.json + index.js），`node tools/ext.mjs plugin list` 四插件全 OK；`tests/contract/plugins-smoke.browser.test.mjs`（279 行）真实 Chromium：

```
withPlugins:  listeners 2 / analyze 2 / commands 209 / byId 575 / panelChildren 19 / markers 1
baseline:     listeners 1 / analyze 1 / commands 208 / byId 574 / panelChildren 18 / markers 0
afterStop:    listeners 1 / analyze 1 / commands 208 / byId 574 / panelChildren 18 / markers 0（与 baseline 逐项相等）
checks:       panelOk=true / cmdVisible=true / cmdRan=1 / eventCount=1
✔ B07 plugins-smoke：三示例插件同时启停无泄漏 (2433.9ms) — tests 1 pass 1 fail 0  EXIT=0
```

## B05 热重载 ?rev=（commit 51ac0fc）

`cover/ts/ExtPluginHost.ts` +12 行：reload 支持显式指定 rev（模块 URL 加 `?import&rev=<rev>` 绕 ESM 缓存）；`tests/contract/reload.browser.mjs`（330 行）真实 Chromium 三轮 reload：

```
revs: b05-1 / b05-2 / b05-3
counts.boot == afterReloadR1 == afterReloadR2R3（listeners 2 / analyze 2 / commands 209 / byId 575 / panelChildren 19 恒等，零累积）
afterReloadR1: oldCmdStillById=false / oldCmdInArray=false（旧命令对象不可见）
afterFinalDeactivate: listeners 1 / analyze 1 / commands 208 / byId 574 / panelChildren 18 / markers 0（精确回落 boot-1）
ok:true  EXIT=0
```

## 收尾复核（全部验收命令在最终状态重跑，2026-10-25）

```
node --test tests/contract/fiber.test.mjs tests/contract/events.test.mjs → tests 18 pass 18 fail 0  EXIT=0
node tests/contract/boot.browser.mjs     → ok:true / 4 插件 ready / netlist.components=7 / ops.applied=1 / errors=[] / consoleErrors=[]  EXIT=0
node tests/contract/plugins-smoke.browser.test.mjs → 1 pass 0 fail  EXIT=0（计数回基线见 B07 段）
node tools/ext.mjs plugin lint           → plugin lint ok  EXIT=0（双向验证见 B06 段）
node tests/contract/reload.browser.mjs   → ok:true  EXIT=0（零累积见 B05 段）
```

B01–B07 七卡 commit：b3f2283 / e887038 / cefa4d3 / 4c82f3d / 93f03e4 / b209b2d / 51ac0fc；写作用域全部落在 Stage 3 清单（cover/ts/ExtPluginHost.ts、tests/contract/fiber|events|plugins-smoke|reload、plugins/、tools/ext.mjs 仅 lint），core/ 未动。
