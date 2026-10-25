# Stage 2 handoff（2026-10-25）

- 做了什么：C01 registry 生成接 CLI（重生成字节级幂等）；C02 导出保真 373 语料对拍（元件 100% / 引脚 103.48%）；C03 ops 错误语义契约测试；C07 round-trip 幂等（372/372 diff=0）；C05 紧凑编码 compact.ts + 基准（聚合 0.2583× XML）；C06 稳定 id（WeakMap + 全新电路重置）；G2 门禁 set→run→measure 闭环。
- 证据：见下方各卡证据段。关键数字：registry 255 类/txtType 124；export 元件 372/372=100%、引脚 21840/21105=103.48%（相对引擎 ΣgetPostCount 零损失）；roundtrip 372/372 diff=0；compact 聚合 144725/560289=0.2583×；G2 V(n1) 4.7298V→8.5300V（Δ+3.80V）。
- 卡在哪：无阻塞。执行侧两个非常规情况已按升级链处理：① glm-strong-worker 槽位连续 3 次并发受限，C06 改 Lead 直做（同为 GLM-5.3=G 模型）；② C05 首次派发看似失败实际已落半成品文件，二次 worker 审查后采纳并验证。
- 下一步：Stage 3（插件宿主完备，B 轨）。Node 单测直接复用 tests/contract/helpers/ts-resolve.mjs（含 .json load hook）。
- 消耗：F worker（C01/C03/C05/C07）约 285 万 token；G worker（C02）约 34 万；Lead（含 C06 直做 + G2 + 复核）约 15 万。GLM 免费额度充足，远未触止损线。

## C01 registry 生成接 CLI（commit 3531fe5）

```
node tools/ext.mjs netlist registry
  {"filesScanned":253,"classesScanned":255,"elementsWithTxtType":124,
   "elementsWithSlots":86,"txtConflicts":0,"xmlConflicts":1}
提交后再生成 → git diff 为空（Lead 复核：重跑 + diff 退出 0 无输出）
```
要点：生成器移植自 spike/netlist-codec/src/registry-gen.mjs（spike 与包内 registry 逐字节相等、core 源树一致，均已勘察证实）；`generatedFrom` 规范化为 `"core/ts"`（绝对路径不可重现）。实际统计与卡面猜数不同处**以现存为准**：txtType=124（非 143）、slots=86。

## C02 导出保真（commit 690c31c）

```
node --test tests/contract/netlist-export.test.mjs
  例数: 372/373（跳过 1: blank.xml — fingerprint ok=false，FAILURES.md 坏例）
  元件数匹配: 372/372 = 100.00%
  引脚聚合比: 21840/21105 = 103.48%（验收线 ≥ 93.8%）
  引擎真值对比: export/engine = 21840/21840（相对引擎 Σ getPostCount() 损失 0 脚）
  unsupported 条目合计: 0
```
引脚比 >100% 归因：fingerprint 分母缺口（总线导线 WireElm 按位宽算脚而 fingerprint 记 2 脚，td4* 5 例 + alu74181；InstructionDisplayElm 生成期 getInfoJS 抛错记 null），非导出侧损失——fixtures 只读纪律未动。浏览器基准设施（env EXT_PW_CORE/EXT_CHROME、分批 evaluate、dialog dismiss、373 例 ~4s）由此卡建立，C05/C07/G2 复用。

## C03 ops 错误语义（commit 2854d40）

```
node --test tests/contract/ops.test.mjs    → 4 pass（unknown target / unknown prop / add 未实现 / 正向对照）
node --test tests/contract/element-factory.test.mjs → 3 pass（helper 扩展无回归）
```
实现已满足语义（错误内部捕获进 unsupported，不外抛），本卡以测试固化契约；index.ts 未改。测试基座扩展：helpers/ts-resolve.mjs 增加 .json load hook（`export default <json>`），解决 Node ESM 对无 import attribute 的 registry.json 的加载。

## C07 round-trip 幂等（commit 60bbd52）

```
node --test tests/contract/netlist-roundtrip.browser.test.mjs
  例数: 372/373（跳过 blank 同上）
  round-trip diff=0: 372/372 = 100.00%   （E1 → app.dumpCircuit() → reload → E2，canonical 全量深比较）
```

## C05 紧凑编码 + token 基准（commit 4a261bf）

```
node tools/ext.mjs build        → 通过（tsc 覆盖 packages/*/src）
node tools/ext.mjs netlist bench
  例数: 372/373；聚合: 144725/560289 = 0.2583× XML（验收线 ≤0.35×）；中位 0.2566×
  报告: build/netlist-bench.json（schema extcircuitjs/netlist-bench@1，逐例 + 聚合）
```
设计：类型→registry 字典序索引、组件数组化、props 位置化、**WireElm 剔除**（连通性由 nets 表达，format-strategy §6 的 −32.3% 主降来源，文件头声明有损设计）。最差例 grid2 0.523×（多脚数字元件语料，预期内）。

## C06 稳定 id（commit 473f643，Lead 直做）

```
node --test tests/contract/netlist-ids.test.mjs tests/contract/ops.test.mjs → 8 pass
node --test netlist-export + netlist-roundtrip → 全绿（稳定 id 与 round-trip 兼容）
node tests/contract/boot.browser.mjs → ok:true, ops.applied=1（cN 兼容路径存活）
node tools/ext.mjs build → 通过
```
设计（Lead 定）：`packages/netlist/src/ids.ts` WeakMap<elm,eN> 单调分配、被删 id 不复用；**全新电路重置规则**（导出时 elmList 无任何已知实例 → 清零重分，兼容 C07 的 reload 相等性）；exportNetlist 落稳定 id；applyOps 双轨 target（稳定 id 优先 + cN 旧格式兼容，boot.browser 不改仍绿）。

## G2 门禁（commit b799dbb，Lead 亲自）

```
node tests/contract/netlist-g2.browser.mjs   → EXIT=0
  baseline: R1=10Ω（e1）  V(n1)=4.72979959V @ t=0.002025s（405 步 / 16 帧 / 无 stop）
  changed:  set R1=2200（applied=1） V(n1)=8.52996127V @ t=0.002025s
  voltageDelta = +3.80016168V（随参数变化；源 40V 量级内合理）
```
确定性步进配方（复用 spike/plugin-runtime corpus.mjs 思路）：冻结 Date.now + 手动驱动 `sim.runCircuit()` 直到 `sim.t` 前进 2ms。**关键坑**：此引擎版本 `analyzeCircuit()` 只建矩阵壳不分配行，必须按 UIManager.updateCircuit() 真实顺序调 `sim.preStampAndStampCircuit()`，只调 preStampCircuit 会让 runCircuit 在 NaN 检查处崩（已记 observations）。

## 收尾复核

Stage 1 回归：boot.browser 在 C06 后重跑 ok:true（见上）。全部 7 卡 commit：3531fe5 / 690c31c / 2854d40 / 60bbd52 / 4a261bf / 473f643 / b799dbb。
