# Stage 4 设计文档 — C04：`add between nets` 导线分裂增量放置

> 卡片：C04（模型 G，15 万，先设计后实现）｜写作用域：`packages/netlist/src/place.ts`（新建）、`tests/contract/place.test.mjs`（新建）、`docs/handoffs/`
> 输入材料：`docs/format-strategy.md` §5（ops API 草案）；`core/ts/WireElm.ts:240`（split）；`core/ts/WireElm.ts:270`（draggingDone）
> 本文只做设计，不含实现。所有引擎行为断言均带源码行号；lrc.txt 的网表形状来自实测探针（见 §1.3）。

---

## 0. 结论先行

- **不需要改 core**，也不需要整电路自动布局。放置 = 复用 core 已有的三个原语：
  `WireElm.split()`（WireElm.ts:240-245）、`app.constructElement()`（CirSim.ts:667,731）+ `drag()`、`app.needAnalyze()`。
- **正确性核心是"放置后自校验 + 回滚"**：放置完成立即强制重分析 → 重导出网表 → 断言
  ①net 数不变 ②新元件两个引脚恰好落在 between 指定的两个网上。任一不满足 → 机械回滚 → `ok:false`。
  这把阻塞条件担心的"静默开路/静默串线"变成显式失败，而不是靠测试碰运气发现。
- **一个必须 Lead 裁决的决策项**：实现 add 后，`tests/contract/ops.test.mjs` 的"add 未实现"断言
  （ops.test.mjs:63-74）会过时转红。全局纪律 3 禁止 worker 改测试断言 → 见 §7，不自行处理。

---

## 1. 引擎语义（设计依据，全部已核对源码/实测）

### 1.1 连接的唯一语义：post 点重合 + 导线闭包

- 节点表构建 `makeNodeList()`（core/ts/SimulationManager.ts:606-698）：每个元件 post 按**坐标**
  查 `nodeMap`，同点 → 同一个 `CircuitNode`（:622-655）。
- 导线把两端点并入同一网：`calculateWireClosureForList()`（SimulationManager.ts:274-329）对
  `isRemovableWire()` 元件做端点合并（NodeMapEntry 级并查）。
- **post 落在导线内部 ≠ 连接**：nodeMap 的键只有 post 点（导线只注册两个端点）。
  这就是 split() 存在的原因——要"接入"一段导线必须先把它断成两段，接入点变成两段的端点。
  人工路径同款：`MouseManager.splitWireAt()`（core/ts/MouseManager.ts:615-631）。

### 1.2 split() 的确切契约（WireElm.ts:240-245）

```ts
split(px, py): WireElm   // this 变为 (p1→p_split)，返回的新导线是 (p_split→p2)
```

- **返回的新导线不会被自动 push 进 elmList**——调用方负责（MouseManager.ts:626 同款）。
- 分裂点必须是**轴对齐线段的严格内点**：`pointOnWireInterior()`（WireElm.ts:220-238）基于
  `pointOnSegmentInterior()`（CircuitElm.ts:361-372，只认水平/垂直）。斜线段没有可分裂点。
- 分裂不改变网数：两半经闭包仍同网（§1.1）；随后新元件 post 落在分裂点上 → 并入该网。

### 1.3 draggingDone() 的语义（WireElm.ts:263-321）——v1 **借用其判定、不直接调用**

- 它是"新画导线穿过了已有 postDrawList 点 → 就地分裂接上；若子段与既有二元件完全共线则丢弃"
  的补全钩子。**问题**：丢弃逻辑 `hasDirectConnection()`（WireElm.ts:250-261）会把"与元件本体
  完全重合的线段"替换成"经该元件导通"——这在电学上是**另一条拓扑**（如 1k 变成 1k+100Ω 串联），
  且 net 数不变、四条验收全绿，属于**静默改拓扑**。
- 因此 v1 的路线选择以"**不穿过任何外来 post 内点**"为硬约束（§4.2 C 步），从源头避免需要
  draggingDone 补救的场景；新加的跳线也不调用 draggingDone。设计上把它记录为 v2 的兜底工具。

### 1.4 接地网与 net id（实测，非推测）

实测命令（设计期探针 `node _scratch/c04a-probe.mjs`，dev server 5174，输出已留存）：
lrc.txt 载入 → analyzeCircuit → preStampAndStampCircuit → `ext.api.dumpNetlist({layout:true})`：

- **7 元件、5 个网**（导线把 (176,80) 与 (176,352) 合并成一个网 `n1`——不是按几何点数 6 个）。
- **没有 "GND" 网**：lrc.txt 无 GroundElm；引擎把电压源 post0 (448,352) 指为地
  （`setGroundNode()`，SimulationManager.ts:556-603，nodeList[0] 恒为地，:564-567），
  但 `exportNetlist` 只对显式 GroundElm 打 GND 标（packages/netlist/src/index.ts:107-110,124-125），
  于是地网被命名为普通 **`n0`**（导出按 nodeList 顺序编号，地网必为首网）。
- 各网可分裂性：`n1` 是唯一含导线的网（`w 176 80 176 352`）；n0/n2/n3/n4 只有元件 post。
- **推论**：验收原文 `between ["GND","n1"]` 的 "GND" 必须作为**别名**解析到引擎地网
  （显式 GroundElm 网优先，否则 nodeList[0] 对应的网），不能只查导出 id。

### 1.5 网格与最小尺寸

- 网格 16px：`gridSize=16, snapGrid(x)=(x+7)&~15`（CirSim.ts:152-154, 581-582）。
- 卡片要求元件端点 ≥32px（= 2 格）。分裂点与两跳线端点必须格点对齐（分裂点还须严格内点，§1.2）。

### 1.6 构造与撤销

- 程序化造件：`app.constructElement(name, x, y)` → `elm.drag(x2, y2)`（CirSim.ts:667 起，含
  VoltageElm→DCVoltageElm 等别名；与 MouseManager 画线同款 MouseManager.ts:648-650）。
  place.ts 走鸭子类型（包内不 import core，沿用 index.ts 的纪律）。
- UndoManager：`pushUndo()` 是全电路 dump 快照（UndoManager.ts:57-71）；命令层惯例是
  `this.app.undoManager?.pushUndo()`（CommandManager.ts:64）。place 在**改动前**可选调用
  `app.undoManager?.pushUndo?.()`——假 app 无此属性时不影响（与现有 applyOps 相容）。
  卡片禁令"绕过 UndoManager"由此满足；place 自身的失败回滚不依赖 UndoManager（§5）。

---

## 2. 模块边界与数据结构（`packages/netlist/src/place.ts`）

```
placeElement(app, op: {type, between:[A,B], props?, place?}): PlaceResult
PlaceResult =
  | { ok:true;  elementId; splits: {wireId; at:[x,y]}[]; wires: {id; p1; p2}[] }
  | { ok:false; reason: string }        // 结构化失败，绝不抛出（对齐 C03 语义）
```

- `index.ts` 的 `add` 分支改为委托 `placeElement`：成功 → `applied++`、`created[type#序号]=elementId`、
  `atoms.push({add:{id,type}, splits, wires})`；失败 → `unsupported.push({op, reason})`、`result.ok=false`。
  返回形状对齐 format-strategy §5 的 `created`/`atoms`（§5 里的 `w3`/`c17` 是示意名，
  实际统一用稳定 id `eN`，由校验步的导出分配，ids.ts:22-50）。
- `place.mode`（§5 草案字段）：v1 只有 auto，存在则忽略，不报错。
- v1 明确不支持（→ `ok:false` + reason，进 `unsupported`）：非 2 端元件（`getPostCount()!==2`）、
  `between` 两个 id 相同、RoutedWireElm/总线（busWidth>1）、LabeledNodeElm 跨网。
- 错误语义表（与 C03 同风格，不抛断）：

| 场景 | reason 片段 | 副作用 |
|---|---|---|
| `between` id 解析不到 | `unknown net "X"` | 无 |
| 两 id 同网 | `nets identical` | 无 |
| `constructElement` 返回 null / registry 无此类 | `unknown element type` | 无 |
| 非 2 端 | `only 2-post elements supported` | 无 |
| 无碰撞-free 放置方案 | `no collision-free placement` | 无 |
| 校验失败（net 数变了 / 引脚没落在目标网） | `verification failed: ...` | 已机械回滚 |
| 假 app（无 sim/constructElement） | `app has no sim` 等 | 无 |

---

## 3. 伪代码

```text
placeElement(app, op):
  # ── 0) 前置 ─────────────────────────────────────────────────────
  A, B = op.between
  if A == B:            fail("nets identical")
  if not app?.constructElement: fail("app.constructElement unavailable")
  elm0 = app.constructElement(op.type, 0, 0)          # 试造一件，探能力
  if elm0 == null:      fail("unknown element type")
  if elm0.getPostCount() != 2: fail("only 2-post elements supported")
  elm0.delete()  # 探测件即刻丢弃（不进 elmList，不影响 id 计数）

  # ── 1) 拿到"新鲜"节点表 ─────────────────────────────────────────
  ensureFreshAnalysis(app):
      app.needAnalyze()            # 置 analyzeFlag
      app.sim.analyzeCircuit()     # 只同步 elmList/postDrawList
      app.analyzeFlag = false
      app.sim.preStampCircuit(false)   # 建 nodeList（不 stamp）
  # 与 netlist-g2.browser.mjs:85-90 的顺序一致；exportNetlist 内部同款兜底 index.ts:64-73

  # ── 2) 收集网（与 exportNetlist 完全同序的命名）─────────────────
  nets = collectNets(app)
  #   遍历 app.sim.nodeList（跳过 pins 为空的 cn），保活引用：
  #   { cn, name, pins:[{elm, post, point}] }
  #   命名规则逐行复刻 index.ts:106-125：
  #   groundNode = elmList 里 isGroundElm()?.nodes[0] ?? null
  #   isGround = cn === groundNode → 名 "GND"；否则 "n{递增}"
  # 解析 between：
  #   netA = byName[A] ?? (A=="GND" ? groundNet(app, nets) : null)
  #   groundNet: 显式 GND 网优先；否则 name==n0 且其 cn === app.sim.nodeList[0]
  #             （nodeList[0] 恒为引擎地网，SimulationManager.ts:564-567 + §1.4 实测）
  if netA == null or netB == null: fail(`unknown net`)
  netsBefore = count(nets)

  # ── 3) 枚举接入点（tap）─────────────────────────────────────────
  foreignPosts = 所有 elmList 元件的全部 post 坐标集合（用于碰撞硬约束）
  taps(net) =
      [ pin.point for pin in net.pins ]                        # 既有 post：零改动的接入点
    + [ 内点格点 for wire-w in net 的引脚中 getClassName()=="WireElm" 且 busWidth==1
        的每条轴对齐线段，按格距取样 ≤8 个，须 pointOnWireInterior 且不与 foreignPosts 重合 ]
  # 注意：post 型 tap 天然合法（点重合即同网，§1.1）；
  #       导线内点型 tap 只在执行期才真正 split。
  tapsA = taps(netA) 有限截断（≤12，按离对网质心近排序）; tapsB = taps(netB) 同理

  # ── 4) 选方案（局部、有界；不是整电路布局）──────────────────────
  occupiedSegs = elmList 各元件的 (post1,post2) 几何线段集合   # 软约束：本体重叠
  plan = null
  for (a in tapsA) for (b in tapsB):               # 双重有界循环
     for cand in candidateRoutes(a, b):            # 见 §4
        if cand 无 foreign post 内点穿越  and  分裂点不压 foreign post:
            score = 本体重叠数*100 + 跳线总长 + 转角数
            keep min; (首方案即可用则早停)
  if plan == null: fail("no collision-free placement")

  # ── 5) 执行（全程记 journal 供回滚）────────────────────────────
  app.undoManager?.pushUndo?.()                    # 改动前快照（可选链，CommandManager.ts:64 同款）
  journal = []
  for s in plan.splits:                            # 顺序：先分裂，后放件
      half = s.wire.split(s.x, s.y)                # WireElm.ts:240
      app.elmList.push(half)                       # 调用方负责 push（MouseManager.ts:626 同款）
      journal.push({undoSplit: s.wire, half, ox2: s.wire 原 x2, oy2: 原 y2})
  elm = app.constructElement(op.type, plan.ax, plan.ay)
  elm.drag(plan.bx, plan.by)                       # |ax-bx|+|ay-by| 恰 ≥32 且轴对齐（§4）
  applyProps(elm, op.props)                        # registry xmlAttrs 的 attr→field 映射（同 index.ts fieldOf + 数字字符串强转）
  app.elmList.push(elm);  journal.push({remove: elm})
  for seg in plan.wires:                           # 正交跳线（必要时，§4）
      w = app.constructElement("WireElm", seg.x1, seg.y1); w.drag(seg.x2, seg.y2)
      app.elmList.push(w); journal.push({remove: w})

  # ── 6) 自校验（正确性核心）──────────────────────────────────────
  ensureFreshAnalysis(app)
  nl = exportNetlist(app)                          # 顺带为新增元件分配稳定 id（ids.ts）
  okNets  = nl.meta.counts.nets == netsBefore
  pinNets = { elm.pins["0"], elm.pins["1"] } 经 nl 映射回名字
  okPins  = pinNets == { netA.name, netB.name }    # 恰好两脚分别落在两目标网
  if not (okNets and okPins):
      rollback(journal)                            # §5；逆序撤
      app.needAnalyze()
      fail(f"verification failed: nets {netsBefore}->.., pins {pinNets}")

  # ── 7) 收尾 ─────────────────────────────────────────────────────
  app.needAnalyze()                                # applyOps 末尾对 applied>0 也会调（index.ts:237）；幂等无害
  return { ok:true, elementId: idOf(elm), splits: [...], wires: [...] }

rollback(journal):   # 逆序、纯机械
  for j in reverse(journal):
      if j.undoSplit: app.elmList.remove(j.half); j.wire.drag(j.ox2, j.oy2)  # split 的精确逆操作
      if j.remove:    app.elmList.remove(j.elm)
```

要点：**步骤 6 是硬闸**。任何"分裂点选错导致开路"（新元件脚悬空 → 网数 +1）或
"跳线误穿 post 被并网"（网数 −1）或"引脚落错网"都会被抓住并整体回滚，返回结构化失败——
直接回应阻塞条件"两种分裂点方案都导致静默开路"：不静默。

---

## 4. 路线候选（§3 第 4 步的展开）

设 tapA=(ax,ay)、tapB=(bx,by)，格距 g=16，最小元件长 L=32：

- **R0 直接**：ax==bx 或 ay==by 且 |Δ|≥L → 元件 (ax,ay)→(bx,by)，无跳线。
- **R1 L 形**：元件贴着 tapA 放：主方向取 |bx-ax|≥|by-ay| ? 水平 : 垂直；
  post2 = tapA + L·unit(主方向)；跳线 post2→corner→tapB，corner ∈ {(bx,ay),(ax,by)} 两种取优。
  （若 tapA 主方向上 L 内有 foreign post/本体 → 换次方向或换 tap。）
- **R2 单折让（3 段）**：R1 的 corner 阻塞时，把拐角外推一档：corner' = corner ± g·垂直偏移
  （±16/±32 共 4 档），绕开占用列/行后回到 tapB。lrc.txt 验收场景实测需要的就是这一档：
  从地网 post (448,352) 出发，向下 32px 放元件 (448,352)→(448,384)，跳线
  (448,384)→(160,384)→(160,192)→tapB=(176,192)（在 n1 导线内点分裂）。
  x=160 是元件包围盒左缘外一格，实测全程无 post 穿越、无本体重叠。
- 超出 R2 的复杂绕行 **不做**（那是自动布线的滑坡）→ `no collision-free placement` 显式失败。

**硬约束**（任一违反即弃该候选）：跳线/元件线段不得穿过 foreignPosts 的**内点**
（穿越而不分裂=视觉谎报；调用 draggingDone 补分裂=并网改拓扑，§1.3）；分裂点不得压 foreign post
（会把该 post 并入目标网）；所有新增端点格点对齐；元件长 ≥L；分裂点为轴对齐严格内点。
**软约束**（打分）：与既有元件本体重叠数、跳线总长、段数。

---

## 5. 回滚可行性论证

split 是可精确逆的：`split(px,py)` 只做了 `this.drag(px,py)` + 造新段（WireElm.ts:241-244）；
逆操作 = `this.drag(ox2,oy2)` + 删新段。新增元件/跳线只被 `push` 进 elmList，未触碰
`nodes[]`/矩阵（分析会在下次 `preStampCircuit` 重建全部 nodeList，SimulationManager.ts:934-940），
所以删除即回滚。稳定 id 侧：回滚元件曾领的 eN 由 `assignStableIds` 的存活集清理
（ids.ts:45-48），counter 不回退、不复用——无泄漏。未动 `elm.nodes[]`、失败不依赖
UndoManager 重建——满足卡片"禁止绕过 UndoManager/直接改 nodes"。

---

## 6. 测试用例清单（`tests/contract/place.test.mjs`，新建）

形态：`node:test` 包真实浏览器（模板 `plugins-smoke.browser.test.mjs`：EXT_PW_CORE/EXT_CHROME/
EXC_BASE、dialog 自动 dismiss、console/pageerror 采集）；错误语义子测试用 ops.test.mjs 的
最小假 app（Node 侧即可）。步进配方照抄 netlist-g2.browser.mjs:57-90（冻结 Date.now +
analyzeCircuit → preStampAndStampCircuit → runCircuit）。

**T1 主验收（四条断言，对应 goal Stage 4 步骤 3）**
lrc.txt → between `["GND","n1"]` add `ResistorElm` props `{resistance:1000}`：
  1. `components: 7 → 8`（+1）；
  2. `nets: 5 → 5`（不变；这是静默开路/误并网的探测器）；
  3. sim 跑 10 步：`sim.timeStepCount ≥ 10` 且 `t` 前进、无 `stopMessage`；
  4. 无 console error / pageerror。
  附加强断言（设计的核心不变式，比验收原文更严）：
  5. 新元件 `pins == {"0":"n0","1":"n1"}`（GND 别名解析到 n0 的地网，§1.4）；
  6. 返回的 `splits` 恰 1 条（n1 的导线被分裂一次），`wires` ≥1（正交跳线存在），
     `created`/`atoms` 里 id 与重导出的稳定 id 一致。

**T2 net id 双轨**：between `["n0","n1"]`（显式导出 id）与 `["GND","n1"]` 结果等价
（同元件数/同网数/引脚同落点）——证明别名解析与导出命名一致性。

**T3 重复放置**：同一 between 连续 add 两次 → 第二次也 ok；`nets` 仍 5、`components` 9
（证明放置不独占接入点，分裂点可再分裂）。

**T4 写读闭环**：T1 后对返回的 elementId 做 `set resistance=2200` → 导出确认 2200
（add 产出的 id 可被既有 set 消费，双轨 target 生效）。

**T5 序列化往返**：T1 后 `dumpCircuit()` 文本 → 重新载入 → 再导出：components/nets 计数一致
（新增元件+跳线可被引擎自己的读写路径还原；防止构造参数缺漏）。

**T6 错误语义（假 app / Node 侧）**：
  - unknown net：`between:["n99","n1"]` → ok:false、reason 含 `unknown net`、elmList 长度不变；
  - 两 id 相同 → `nets identical`；
  - unknown type：`"NopeElm"` → `unknown element type`；
  - 非 2 端（如 3 端的 `NTransistorElm`）→ `only 2-post elements supported`；
  - 假 app 缺 `sim` → 结构化失败不抛异常（对齐 ops.test.mjs:32-49 风格）。

**T7（可选，若实现期难以构造则记录跳过）**：校验失败回滚路径——用真引擎构造一个
"仅有一个 post 且被完全包围"的网使放置必然失败 → 断言 elmList/netlist 与放置前逐项一致。

**既有回归**：`node --test tests/contract/ops.test.mjs`、`tests/contract/netlist-export.test.mjs`、
`boot.browser.mjs` 保持绿（实现卡的验收前置）。

---

## 7. 实现卡注意事项 / 决策项（不改 core 的论证 + 遗留）

1. **ops.test.mjs:63-74 会转红**：其断言 add → `"not implemented"` 是 C03 时代的占位（该文件注释
   自述"增量布局留待 v0.2"）。add 落地后该断言过时。全局纪律 3 禁止 worker 改测试断言 →
   **需 Lead 批准**：把该子测试改为"add 在假 app 上结构化失败（reason 任意）不抛异常 + 不创建元件"，
   真正的 add 正向断言全部放 place.test.mjs。本设计不预先改它。
2. Stage 4 写作用域未含 `ops.test.mjs` 与 `index.ts`——但 add 分支必须在 `index.ts` 接线。
   `index.ts` 的 add-case 一行委托属于 C04 实现的最小必要改动，提交时单独说明；若 Lead 认为
   越界，则以 place.ts 导出 + place.test.mjs 直接调用 placeElement 验收，接线留给下一卡。
3. 不改 core 论证：分裂用 `WireElm.split`（只读调用方语义）、构造走 `app.constructElement`、
   重分析走公开序列（analyzeCircuit/preStampCircuit）、撤销走 `undoManager?.pushUndo?.()`。
   唯一"必须改 core 才能继续"的潜在点是 wanting draggingDone 兜底复杂穿越——本设计已用
   硬约束绕开（§1.3、§4），不触发。
4. 阻塞条件自查：`两种分裂点方案都导致静默开路` → 不成立：自校验+回滚把一切静默失败显式化（§3 步骤 6）。
5. v2 展望（不进本卡）：draggingDone 作为穿越兜底、多端元件、RoutedWireElm、总线位宽、`place.mode` 其它值。

## 8. 证据索引（设计期已跑）

- 探针脚本：`_scratch/c04a-probe.mjs`（仓库外，不入提交）；输出要点见 §1.4
  （7 元件 / 5 网 / 无 GND 网名 / 仅 n1 含导线）。
- 源码核对：WireElm.ts:220-245, 250-321；SimulationManager.ts:266-329, 556-603, 606-698, 915-951；
  MouseManager.ts:604-654；CirSim.ts:152-154, 581-582, 667-731；UndoManager.ts:57-71；
  CircuitElm.ts:361-372；index.ts:60-153, 194-239；ids.ts:22-50；format-strategy.md §5-§7。

## 9. Lead 裁决（2026-10-26，随设计一并提交，实现卡必读）

1. **ops.test.mjs 的 add 占位断言**（§7.1）：批准在实现卡把它更新为「add 在假 app 上结构化失败
   （ok:false、不抛异常、不创建元件）」，add 的正向断言全部放 place.test.mjs。理由：该断言的
   意图是 C03 的错误语义契约，「not implemented」只是占位文案；更新保持契约意图不变，不算弱化。
2. **index.ts add 分支接线**（§7.2）：批准实现卡做最小改动（add-case 委托 placeElement），
   提交信息里单独说明这处越界补充。理由：G3 门禁要求 ops 闭环，不接线 add 永远 unsupported；
   packages/netlist/src/ 本就是 C 轨写作用域的家园，Stage 4 清单未预见该集成点属清单滞后。
3. **Mimosa commit 硬拦处置**：本设计文档的提交由 Lead 完成（worker 被仓库外 spike/ 旧产物的
   既有扫描发现硬拦，正确地拒绝 --no-verify 绕行）。后续卡若同样被硬拦：保持文件 staged、
   立即经 blocked/summary 上报等待 Lead 提交，不重试、不绕行。
