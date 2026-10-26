# Stage 4 handoff（2026-10-26）

- 做了什么：C04-design（commit 0a9be00，设计先行——引擎语义核对 WireElm.split()/draggingDone()、GND 别名发现、R0/R1/R2 有界路线、放置后自校验+机械回滚方案、Lead 三项裁决，`docs/handoffs/stage4-design.md` 323 行）；C04b（commit b97dc4f——`packages/netlist/src/place.ts` 549 行实现 placeElement（tap 枚举→有界候选评分→执行→自校验失败回滚），`index.ts` add 分支委托 placeElement（Lead 裁决 §9.2 批准的最小接线），`ops.test.mjs` add 占位断言按 Lead 裁决 §9.1 更新为「假 app 结构化失败」（契约意图不变，非弱化），`tests/contract/place.test.mjs` 607 行浏览器契约 T1/T2/T3/T4/T5/T6+T-cage）。G3 门禁三套 smoke 收尾复核全绿（见证据段，本日实测）。G3 无独立 commit（无代码改动，验收即三套 smoke 跑绿）。
- 证据：见下方各段；关键行——place 测试 `tests 2 pass 0 fail` EXIT=0（T1：lrc between [GND,n1] components 7→10、nets 5→5 不变、pins {"0":"n0","1":"n1"}、sim 405 步无 stopMessage、consoleErrors=[]）；G3 三套 smoke：plugins-smoke 1 pass 0 fail、place 2 pass 0 fail、netlist-g2 `ok:true`（R1 10Ω V(n1)=4.7298V → set 2.2k V(n1)=8.5300V，Δ=3.80V），三者 errors/consoleErrors 均空，全 EXIT=0。
- 卡在哪：无阻塞。两条已在 observations.md 记录的注记（均不需新裁决）：①设计 §6 T1 字面预测（splits 恰 1、components 7→8）被实测修正——lrc [GND,n1] 胜选路线为 post tap 0 分裂 + 2 跳线（score 306），分裂机制改由 T-cage 手工语料确定性覆盖（splits 恰 1 @(64,128)）；②C04b 提交时 Mimosa 以 `scanner_enobufs` 兼容策略放行（同 Stage 3 记录的不稳定行为），不宣称项目安全。
- 下一步：Stage 5（MCP 全链路，D01→D02 串行、D03/D04/D05 并行、G4 门禁）：入口 D01 会话 RPC + InMemory 假实现（不连浏览器）。复用资产：确定性步进配方（`netlist-g2.browser.mjs`：冻结 Date.now + analyzeCircuit → preStampAndStampCircuit → runCircuit）、稳定 id 双轨 target（`packages/netlist/src/ids.ts`）、浏览器契约基座（EXT_PW_CORE/EXT_CHROME + BASE 127.0.0.1:5174 + dialog 自动 dismiss）。无遗留需 Lead 决策事项；Stage 5 写作用域新增 `cover/ts/ExtMcpBridge.ts`（新建）。
- 消耗：G worker（C04 设计+实现，卡面预算 15 万）估算约 15 万 token；F worker（本收尾卡）少量——均为按手册卡面预算的估算值（workflow 运行记录在本会话不可读，实际消耗无法核对）；GLM 免费额度充足，远未触止损线。

## 设计先行时间序（达成条件①，可查）

```
0a9be00 2026-10-26 00:33:57 +0800  C04-design: 导线分裂增量放置设计（…）  docs/handoffs/stage4-design.md 323 行
b97dc4f 2026-10-26 01:11:51 +0800  C04b: add between nets 导线分裂增量放置（…）  实现卡
```

设计 commit（00:33:57）早于实现 commit（01:12:41）约 39 分钟，时间顺序可查。

## C04b place 契约（commit b97dc4f）

`node --test tests/contract/place.test.mjs`（2026-10-26 收尾复核实测）→ `tests 2 pass 0 fail` EXIT=0，counts：

```
t1（主验收，lrc.txt between ["GND","n1"] add ResistorElm 1k）:
  before {components:7, nets:5} → after {components:10, nets:5}   # nets 不变 = 无静默开路/误并网
  pins {"0":"n0","1":"n1"}                                        # GND 别名解析到引擎地网 n0
  wires e9 (448,384)→(176,384) + e10 (176,384)→(176,352)          # 0 分裂 + 2 正交跳线，元件 32px 网格对齐
  step {frames:16, steps:405, dt:0.002025, stopped:null}          # sim 步进 ≥10 步，无 stopMessage
t2 双轨: byAlias(GND) 与 byExportedId(n0) 均 ok:true applied:1、components 10、nets 5、pins [n0,n1]
t3 重复放置: 7→13、nets 仍 5（接入点可复用）
t4 写读闭环: set resistance=2200 → applied:1、导出 2200（add 产出的 id 可被既有 set 消费）
t5 序列化往返: dump→reload→export 计数 {components:10, nets:5} 不变
tcage（分裂机制确定性覆盖）: {components:10,nets:18} → {components:12,nets:18}
  splits 恰 1 条 {wireId:"e1", at:[64,128]}，pins {"0":"n0","1":"n16"}
consoleErrors: []   # 全程无 console error / pageerror
```

注：t1 的 components 账目 = before + 1（电阻）+ 2（跳线）；总数精确账目（比裸 +1 更严）证明除申报放置物外无增删，见 observations.md 首条。

## ops 错误语义回归（C03 契约 + §9.1 更新）

`node --test tests/contract/ops.test.mjs` → `tests 4 pass 0 fail` EXIT=0：

```
✔ unknown target：set 指向不存在的 c99 → ok:false、applied:0、unsupported 含 unknown target、不抛异常
✔ unknown prop：set 指向 registry 没有的属性 → ok:false、unsupported 含 unknown prop
✔ add 假 app：结构化失败（ok:false、不抛异常、不创建元件）   ← 按 Lead 裁决 stage4-design §9.1 更新
✔ 正向对照：合法 set 生效 —— value 字符串数字转 number、needAnalyze 恰好调 1 次
```

## G3 门禁三套 smoke（2026-10-26 收尾复核实测，全 EXIT=0）

```
① B 轨  node tests/contract/plugins-smoke.browser.test.mjs → tests 1 pass 0 fail
        三插件同时启停无泄漏；checks: panelOk=true / cmdVisible=true / cmdRan=1 / eventCount=1
        卸载后 panelChildren 19→18 / markers 1→0 回基线
② C 轨  node --test tests/contract/place.test.mjs → tests 2 pass 0 fail（计数见上段）
③ ops 闭环  node tests/contract/netlist-g2.browser.mjs → ok:true EXIT=0
        baseline R1=10Ω  V(n1)=4.72979959 V（steps 405, stopped:null）
        changed  R1=2.2k V(n1)=8.52996127 V（setApplied:1）
        voltageDelta = 3.80016168 V；errors=[] consoleErrors=[]
```

无 console error（三套输出 consoleErrors/errors 字段均为空数组）。

## 回归（最终状态重跑）

`node tests/contract/boot.browser.mjs` → `ok:true` EXIT=0（4 插件 ready、netlist.components=7、ops ok:true）——index.ts add 接线与 place.ts 无 boot 回归。

## 写作用域自查

C04 两卡落盘文件：`docs/handoffs/stage4-design.md`、`packages/netlist/src/place.ts`（新建）、`tests/contract/place.test.mjs`（新建）、`packages/netlist/src/index.ts`（add 分支最小接线，Lead 裁决 §9.2 批准的越界补充）、`tests/contract/ops.test.mjs`（add 占位断言按 Lead 裁决 §9.1 更新）、`docs/handoffs/observations.md`。core/ 未动；无整电路自动布局；未直接改 `elm.nodes[]`、未绕过 UndoManager（place 走 `app.undoManager?.pushUndo?.()`，回滚为纯机械 journal 逆序撤销）。
