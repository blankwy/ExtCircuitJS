# Spike A — 电路网表 JSON 编解码可行性验证（netlist-codec）

- **任务**：task-1 / Spike A
- **上游**：`pfalstad/circuitjs1` HEAD `e952e78`（= master = dev-ts，版本 5.0.3，2026-10-24），只读引用 `_scratch/core`
- **语料**：`_scratch/core/ts/public/circuits/*.txt` 373 个（335 个 legacy txt + 38 个 XML），`_scratch/corpus-xml/*.xml` 373 个，`fingerprints.json`（引擎权威指纹）
- **原型**：`spike/netlist-codec/`（零运行时依赖，Node ≥ 20）
- **结论**：**有条件可行**。导出侧可行（拓扑能算、回写能跑、压缩能测）；导入侧必须带 layout 或走布局合成，因为 ≥3 脚元件的脚位坐标是**类内几何代码**算出来的，不能从拓扑反推。

---

## 1. 结论（一句话 + 三条支撑）

> **"AI 友好的 JSON 网表"作为*导出*格式成立，作为*唯一真源*不成立。**

1. **导出成立**：373/373 电路全部可解析（txt 335/335 = 100%），元件数 372/372 与引擎指纹一致，几何并查能推出 3,956 个 net，回写 txt 后 335/335 的引脚划分完全不变（等同一个图的同构校验）。
2. **导入不成立（纯拓扑）**：只有 105/373（28.2%）的电路能在"无坐标"下完整还原，其余 268 个含 ≥3 脚元件（晶体管/MOSFET/门/555/继电器…），共 2,930 个引脚的位置无法从网表反推 → 必须带 `layout` 或引入布局合成器。
3. **省 token 的前提不是 JSON，而是"去导线 + 去坐标"**：命名键 JSON 反而比官方 XML 大 2.29×；把形状改成位置数组后 0.32×，网表文本 0.19×。省下来的量几乎全部来自"删掉 4,909 根导线 + 每个元件 4 个坐标"，JSON 语法本身不省。

---

## 2. 怎么跑（可复现命令）

```powershell
# 工作目录：V:\Vibe\circuitjs1\spike\netlist-codec
node src/registry-gen.mjs     # 从上游 .ts 源码抽元件描述表 -> src/registry.json
node src/calibrate.mjs        # 用语料学每个 dump type 的实参个数 -> src/arity.json
node src/measure.mjs          # 全量 373：解析/几何/拓扑/回写 -> out/metrics.json
node src/variants.mjs         # 五种表示 + 消融阶梯 -> out/variants.json
node src/demo.mjs <file.txt>  # 单个电路打印 netlist JSON（--layout 带坐标）
```

`out/metrics.json`、`out/variants.json`、`out/samples-20.json` 是原始证据，报告里所有数字都来自这三个文件。

**20 个样例**：`node src/samples.mjs` 生成 `out/samples-20.json`（20 个电路，按体积等距抽样：`blank` 空电路 → `capac` 4 元件 → `dram` 72 元件），每个含完整 `netlist/0.1` JSON；其中 19 个成功推出 pins（`blank` 无元件）。

---

## 3. 数字（全部来自 `out/metrics.json` / `out/variants.json`）

### 3.1 语料与解析

| 指标 | 数值 |
|---|---|
| 语料文件 | 373（335 txt + 38 xml） |
| legacy txt 字节 / 官方 XML 字节 | 383,826 / 560,374 |
| 元件总数 / 其中导线 | 10,555 / 4,909（46.5%） |
| **解析成功** | **361/373 = 96.78%** |
| txt 路径解析成功 | **335/335 = 100%** |
| 失败原因 | 12 个全是 XML 输入里的派生 tag：`<And>`49 `<Xor>`21 `<Nor>`12 `<Nand>`7 `<Or>`1 `<n>`7（详见 §6 F2） |
| **元件数对拍（vs 引擎指纹）** | **372/372 = 100%** |
| **脚位数对拍（vs 引擎指纹）** | **93.84%**（txt-only 子集 97.03%） |
| 参数槽被命名（非 `pN`） | 7,677 / 10,865 = **70.66%** |

### 3.2 拓扑

| 指标 | 数值 |
|---|---|
| 推出 net 总数 | 3,956（每电路均值 10.6） |
| **可完整推断的电路** | **105/373 = 28.2%** |
| 部分推断（含 ≥3 脚元件） | 268/373 |
| 无法定位的引脚（degraded pins） | 2,930 |
| 检出"未切分 T 型接点" | 18 处 |

> 最后一行是个正面结论：**保存出来的文件基本都是已切分的**（导线端点在接点处断开），所以加载期不需要复刻 `WireElm.split()` 的中间落点逻辑；18 处是真·历史遗留，会在解析时被报出来而不是悄悄连错。

### 3.3 回写（round-trip）

| 检查 | 结果 |
|---|---|
| AST → txt，元件行逐字节相同 | 324/335（差 11 个是带 `!` 模型/自由文本行的文件，行序不同） |
| 回写后重新解析 | **335/335** |
| **回写后引脚划分不变（同构）** | **335/335 = 100%** |
| 纯拓扑回写（无坐标，自动布点） | **92/373 可写，92/92 划分不变** |
| 因含 >2 脚元件而放弃纯拓扑回写 | 243 |

### 3.4 体积（消融阶梯，单位 UTF-8 字节）

**ratio 定义：分子 = 本表示总字节，分母 = 官方 XML 总字节（560,374）；"median" 是逐电路 (本表示 ÷ XML) 比值的**中位数**。** 聚合比 = Σ本表示 ÷ ΣXML。

| 表示 | 总字节 | 聚合比 vs XML | 逐电路中位比 |
|---|---|---|---|
| 官方 XML `<cir>` | 560,374 | 1.00 | 1.00 |
| legacy txt | 383,826 | 0.685 | 1.68 →（见备注） |
| **as-designed JSON（命名键）** | **1,312,321** | **2.34** | **2.29** |
| JSON 带 layout | — | **2.75** | 2.75 |
| **紧凑 JSON（位置数组）** | **185,412** | **0.32** | 0.32 |
| **网表文本（一行一件）** | **105,965** | **0.19** | 0.18 |

> 备注：legacy txt 聚合比 0.685，但逐电路中位比 1.68——因为 38 个 XML 输入文件同时有 xml 与 txt 两份，而 txt 与 xml 是同一套坐标的两种写法，分布不均。**以逐电路中位比为准**。

**消融阶梯（每次只删一样东西，中位比 vs XML）**

| 步骤 | 中位比 | 相对上一步 |
|---|---|---|
| L0 网表文本 + 导线行 + 坐标 | 0.524 | 从 XML 0.524（删掉 XML 标签语法 −47.6%） |
| L1 删导线行（连通性由共享 net id 承载） | 0.355 | **−32.3%** |
| L2 再删坐标 | 0.180 | **−49.3%** |
| L3 再删等于众数默认值的属性 | 0.171 | −5.2% |

**结论：省的是"导线 + 坐标"，不是"JSON"。** 4,909 根导线占元件数 46.5%，删掉它们把体积砍掉三分之一；再删坐标又砍掉一半。JSON 的花括号/引号/键名让体积反而涨了 2.3 倍。

**token ≠ 字节**：JSON 的 `{ " : ,` 对 BPE 不友好，字节比会高估 JSON 优势（或低估劣势）。本环境未装 tokenizer，只能用 chars/4 粗估：XML 140,094 / JSON 328,080 / 紧凑 JSON 46,353 / 网表文本 26,491（**方法局限：未实测 BPE，不可当结论用**，建议后续装 `gpt-tokenizer` 实测）。

绝对例子（`3-f211.txt`，10 元件 / 4 导线 / 4 个 net，实测）：

| 表示 | 字节 | ÷ XML(667) |
|---|---|---|
| 官方 XML | 667 | 1.00 |
| legacy txt | 328 | 0.49 |
| 命名 JSON（不写 layout） | 1,327 | **1.99** |
| 命名 JSON（带 layout） | 1,597 | 2.39 |
| 紧凑 JSON / 网表文本 | 见总表（本电路落在 0.19–0.32 区间） | — |

这个例子最能说明问题：同一电路，**命名 JSON 比 XML 大 1.99 倍**，而 txt 只有 XML 的 0.49——JSON 的键名/括号开销盖过了"去掉坐标"的收益。

---

## 4. 元件描述表（自动化程度）

`registry-gen.mjs` 从 253 个 `.ts` 源码里静态抽取，**没有手写 200 条表**：

| 项 | 数值 |
|---|---|
| 扫描类 | 255 |
| 其中真元件（继承链回到 `CircuitElm`） | **158** |
| 非元件（Dialog/Scope*/Menus/Graphics/Model/Manager…） | **97** |
| 有 txtType（自身声明 124 + 继承 19） | **143 / 158 = 90.5%** |
| 有构造器参数槽（`st.nextToken()` 可识别） | 83 |
| **有 XML 属性表（属性名 → 字段 → 解码类型）** | **105 个元素有表，其中 86 个同时有 txtType** |
| txtType 冲突 | **0** |
| XML tag 冲突 | 1（`Scope`：ScopeElm 与 Scope 类同名，需白名单） |

抽取规则（全部有源码依据，见 §5）：

- R1 `getDumpType()`：`'c'.charCodeAt(0)` 或整数 → 124 个显式声明
- R2 `getXmlDumpType()`：字面量（`"ln"`/`"rw"`）+ 计算式（`GateElm.ts:144` 的 `getClassName().replace("GateElm","")`）+ 基类默认规则（`CircuitElm.ts:135-140`：dumpType 在 65..126 用单字符，否则类名去 `Elm`）
- R3 构造器 `st.nextToken()` 序列 → 参数槽 + 字段名 + 类型（`parseFloatStrict`→float / `parseIntStrict`→int / `'true'` 比较→bool / 其余 string）
- R4 `dumpXml` 的 `dumpAttr(elem,"r",this.resistance)` + `undumpXml` 的 `parseDoubleAttr("r",…)` → **属性名 → 字段 → 类型** 三元组
- R5 `getPostCount()` 返回表达式（含单继承解析：`GraphicElm` 返回 0、`GateElm` 返回 `inputCount+1`…）
- R6 `isGroundElm/isRailElm/isVoltageElm/isBatteryElm/isRemovableWire/isLabeledNodeElm` 布尔特质

**过滤规则（给 schema/schema-codegen 用）**

```
一个类算"元件" ⟺ 沿着 `extends` 链能到达 CircuitElm
排除：*Dialog, *Popup*, Menu*, Toolbar, Scrollbar, Scope*(数据/绘图), *Model,
      Graphics, Point, Polygon, Rectangle, StringTokenizer, CirSim, SimulationManager,
      CircuitMatrix, Expr*/ExprEngine, JSInterface, Locale, Color, Font, UndoManager
```
剩下 143/158 有 txtType；**15 个没有**（`ChipElm`、`CompositeElm`、`SubcircuitElm`、`CustomLogicElm`… 走各自独立序列化/需要模型），正好等于 §6 的 unsupported 集合。

**参数个数的真相（重要）**：85 个在语料里出现的 type，只有 29 个的实参个数是常数；31 个是**变长**（`RailElm` 6/4/0、`VoltageElm` 6/4/1、`TransistorElm` 5/4/3、`OpAmpElm` 6/5/2/3…），因为构造器按 flag 走不同分支。**结论：扁平"类型 → 参数个数"表在 .txt 上天然不成立，生产实现必须做"每个 type 一个小解析函数"的代码生成（从 `*Elm.ts` 构造器生成），而不是查表。** 本原型采取保守路线：参数原样保留为 token 向量（无损），能命名的命名（70.66%），命名不了就留 `pN`。

---

## 5. 关键代码位置（上游，file:line）

| 事实 | 位置 |
|---|---|
| 现行保存格式是 XML，根元素属性 `f/ts/ic/cb/pb/vr/mts/st` | `CircuitXMLSerializer.ts:97` `dumpCircuit()`，属性写入 `:111-120` |
| `dumpAttr` 会对属性名做冲突检查（别名不能重名） | `CircuitXMLSerializer.ts:146-160` |
| XML 标签规则（单字符 vs 类名） | `CircuitElm.ts:135-140` `getXmlDumpType()` |
| 元素专属属性 | 各 `*Elm.ts` 的 `dumpXml/undumpXml`，例 `ResistorElm.ts:49-57` |
| 旧 txt 读入、类型分派、`x1 y1 x2 y2 f` | `CircuitLoader.ts:160-250`（`readCircuitText`），特殊行 `o/h/$/!/%/?/B/34/32/38/46` 在 `:180-215` |
| 类型 → 类 的注册表（`dumpTypeMap`） | `CirSim.ts:616-651` `register()`；`CirSim.ts:656` `createCe()` |
| 连接关系的权威生成 | `SimulationManager.ts:270` `calculateWireClosure()` → `:274` `calculateWireClosureForList()`（只按导线两端点合并！） |
| ground 规则 | `SimulationManager.ts:556` `setGroundNode()`：有 GroundElm 用它；否则无 rail 时第一个 voltage/battery 的 post0 接地 |
| 并查落地为节点 | `SimulationManager.ts:606` `makeNodeList()`，`:622-656` 把 post 匹配到 `nodeMap` 里的同一个 `NodeMapEntry` |
| 命名连接 | `LabeledNodeElm.ts:96-120` `getConnectedPost()`（同名 label 互相连接）、`:137` `label:` 端点键 |
| 导线切断点（编辑期做，非加载期） | `MouseManager.ts:615` `splitWireAt()` / `WireElm.ts:240` `split()` |
| 预打点入口（一次跑完三步） | `SimulationManager.ts:931` `preStampCircuit(subcircuit)` |

---

## 6. 失败分类（不假装支持）

| 编号 | 类型 | 实例数 | 原因 | 处理 |
|---|---|---|---|---|
| F1 | **≥3 脚元件的脚位几何** | 2,930 脚位 / 268 文件 | 脚位坐标由类内 `setPoints()/calcLeads()` 与 `getPost(n)` 重载算出（晶体管 base 在 point2 反向延长线…），**拓扑 JSON 无法反推** | 标 `unsupported:"post geometry"`；导出可（只丢该元件引脚），导入需 layout |
| F2 | XML 派生 tag | 90 实例 | `<And>` 来自 `GateElm.ts:144` 的 `getClassName().replace("GateElm","")`，静态抽取拿不到"对子类做替换"这一步 | 已定位，修法=给 `xmlType` 记 `replace(from,to)` 模式并按子类名求值（原型未合入，见 §8 风险 3） |
| F3 | 老式 `<n>`/`n`（NoiseElm 别名） | 7 | `CirSim.createCe` 里对 `'n'` 有硬编码别名（`CirSim.ts:658`），注册表里没有 | 加 1 行别名表 |
| F4 | 模型/UI 节点混排 | `mm/ccm/diode/transistor/sub/o/adj/h` | XML 子节点里元件与模型混排（`<mm nm="old-mosfet-2">` 被 `<f mo="old-mosfet-2">` 引用） | 已分区到 `models[]/scopes[]/hints[]`，元件引用保留 `mo/nm` 原值，**未做 id 改写**（schema 草案 §7 给出做法） |
| F5 | 变长参数（flag 驱动） | 31 个 type | 见 §4 | 参数原样保留 + 70.66% 命名；生产走代码生成 |
| F6 | `!` 自定义逻辑模型的自由文本行 | 1 文件（`ledarray.txt`） | 模型规则是多行原文，不是 token 序列；**上游自己的加载器也会静默丢弃这些行** | 保留原文进 `models[]`，不影响元件解析 |
| F7 | `Adjustable`（UI 滑杆）/ `Scope`（示波器） | 11 + 638 行 | 不是电路元件，是 UI 状态 | 分别进 `ignored[]` / `probes[]` |
| F8 | Composite/Subcircuit/Chip/CustomLogic/Bus/传输线 | 15 个类无 txtType | 需要内嵌节点表/引脚表/子电路模型，序列化路径独立 | **显式 unsupported**，导入导出都跳过并在 `unsupported[]` 里点名 |

---

## 7. JSON schema 草案（`netlist/0.1`）

```json
{
  "schema": "netlist/0.1",
  "meta": {
    "core": "5.0.3",
    "source": { "format": "txt|xml", "bytes": 667 },
    "opts": ["1","5.0E-6","10.81","50","5.0","50"],
    "counts": { "components": 10, "nets": 4 }
  },
  "models": [
    { "id": "m0", "kind": "mosfet", "tag": "mm", "nm": "old-mosfet-2",
      "props": { "vt": -1.75, "be": 0.02, "sb": 0 } }
  ],
  "components": [
    {
      "id": "c0",
      "type": "ResistorElm",
      "tag": "r",
      "f": 0,
      "props": { "resistance": 1000 },
      "pins": { "0": "n1", "1": "GND" },
      "layout": [200, 100, 300, 100],
      "model": null
    }
  ],
  "nets": [
    { "id": "n1", "name": null, "pins": ["c0:0","c1:1"] },
    { "id": "GND", "ground": true, "pins": ["c0:1"] }
  ],
  "probes": [ { "kind": "scope", "inputs": ["n1","n2"] } ],
  "subcircuits": [
    { "id": "s0", "name": "adder4", "pins": ["a0","b0","s0"], "body": "netlist/0.1" }
  ],
  "unsupported": [ { "component": "c7", "reason": "post geometry" } ]
}
```

设计规则（每条都有上面的数字支撑）：

1. **`pins` 用 net id，不用坐标**；net id 短（`n0`,`n1`,…）以便紧凑。
2. **`layout` 可选且默认不写**：写了 = 可无损回写 txt/XML（2.75× XML）；不写 = 只能导出 + 需布局合成才能导入。
3. **导线不是元件**：`w` 行在导出时被吸收进 net（`w1:0` 与 `w1:1` 同 net 的证据见 §3.3），这是 −32% 的主要来源。若要保留视觉/`mustShowCurrent`，用 `nets[].via:["w1"]` 记录导线 id。
4. **`props` 用字段名**（`resistance` 而非 `p0`），值用数字；XML 属性名作为 `tagProps` 别名表放在 registry 里（86 个元素 × 105 属性已抽好）。
5. **默认值省略**：语料众数即默认（示例：`GroundElm.symbolType=0` 100%、`LogicOutputElm.threshold=2.5`…），省略约定写进 schema 而不是逐条硬编码。
6. **`unsupported` 必填**：宁可点名不可猜测（F1/F8）。
7. 上下文行（`$`/`h`/`o`/`!`/模型）**原样保留**在 `meta.opts / hints / probes / models`，不参与拓扑。

紧凑变体（体积 −86%，用于喂 LLM）：

```json
{"v":"n1","c":[["r",0,1,1000],["c",1,2,1e-5],["w",2,2]],"n":{"0":"GND"}}
```

一行一件的网表文本（最省，0.19× XML）：

```
#GND=0 #VCC=1
r 0 1 1000
c 1 2 1e-5
q 2 3 0 4
```

---

## 8. 挂载建议（Cover / HookRegistry / JSInterface）

1. **codec 放 Cover 层，不进 Core**：`cover/netlist/{registry.ts, reader.txt.ts, reader.xml.ts, topo.ts, emit.ts}`。理由：registry 是从上游源码生成的，上游一改就要重生成——它是"对上游结构的镜像"，正是 Cover 的职责。Core 侧零改动，升级上游只需重跑 `registry-gen` 并 diff。
2. **接入点选 `CircuitLoader` 之后、`preStampCircuit` 之前**：导出走 `Cover.exportNetlist()`，输入是 `app.elmList`（**逐元件读，不要用 `window.CircuitJS1.getElements()`**——它在 6 个电路上整体抛错，见 corpus-xml/FAILURES.md）。导入走"构造元素 → 注入 `app.elmList` → 让引擎自己 `preStampCircuit(false)` 算节点"，**绝不要**由 codec 直接写 `elm.nodes[]`。
3. **与 HookRegistry**：只需要两个钩子——
   - `hook.beforeExportNetlist(elmList) → elmList`（让插件改写/裁剪元件，比如把某个 Chip 记成黑盒）
   - `hook.resolvePostGeometry(elm)`：**这是 F1 的正解**。Cover 声明接口，有几何能力的插件（或未来从 `*Elm.ts` 生成的 `geometry.ts`）实现它；没实现就标 `unsupported`。不要在 codec 里内联 200 个元件的几何。
4. **与 JSInterface**：`getNetlist({layout:false}) / setNetlist(json)` 两个方法即可对外。`setNetlist` 必须返回 `{ok, unsupported[]}`，因为 F1/F8 会是常态。别把 netlist 塞进 `getElements()` 那种急切全量构建（会整体失败）。
5. **顺序建议**：`reader.txt` 先上（100% 覆盖、且是历史存档）→ `topo` + `emit` 导出 → `layout` 合成器 → `reader.xml` + 双路 tag。

---

## 9. 风险（按严重度）

1. **F1 脚位几何是真墙，不是实现缺陷**：2,930 个引脚/268 文件不可无坐标还原。要"JSON 即真源"，必须补 158 个元件的几何（或至少 40 个常用件的 `getPost`/`setPoints`），这是数天量级工作量，不是本 spike 的 bug。**对外不要说"JSON 完整替代官方格式"，应该说"JSON 是导出+编辑视图，官方格式仍是存储真源"。**
2. **上游一变，registry 就腐烂**：现在 90.5% 的 txtType 覆盖靠"源码正则 + 继承解析"，上游改个属性名/换个 helper 就会静默漏抽。缓解：`registry-gen` 生成的 `registry.json` 进 CI，diff 变化即告警；并保留 `measure.mjs` 的 elmCount/postCount 双对拍（现在 372/372、93.84%）作为回归门。
3. **XML tag 双路映射还没合入**：`GateElm.ts:144` 的计算式 tag 让 90 个 `<And>` 类元件解析失败（其余 283 个 txt 文件不受影响）。修法已定位（记下 `replace(from,to)` 模式，按子类名求值），属 5 行改动；**在修好前不要宣布支持 XML 输入**。另需处理 `Scope` tag 冲突白名单和 `n`→NoiseElm 别名。
4. **压缩比容易被误读**：命名键 JSON 是 2.29× XML（更大）。对外只能讲"紧凑/网表文本 0.19–0.32×"，且必须同时讲"省的是导线和坐标"。另外字节 ≠ token，BPE 实测还未做（chars/4 粗估：26.5k vs 140.1k）。
5. **flag 驱动变长参数**：31 个 type 参数个数随 flag 变，扁平表天然不成立；若生产走"查表"必然在 `RailElm/VoltageElm/TransistorElm` 上错位。必须代码生成 per-type 解析器。

---

## 10. 与另一条轨（引擎权威 nodeList）的关系

本 spike 的 `engine/probe.ts` 试图直接驱动 `SimulationManager.preStampCircuit(false)` 拿权威 `nodeList`，**被上游的 DOM 依赖挡住**：`registerElements()` 会构造每个元件，而 `AudioOutputElm` 构造期就 `document.createElement` / `app.addWidgetToVerticalPanel`，`LDRElm.createSlider` 还会 `getContext("2d").fillStyle`。已加最小 DOM/Proxy stub，仍卡在 `Scrollbar.draw`；继续打通需要 canvas 上下文桩 + 更多 app 成员，超出本时间盒，故**未完成**。

替代对拍（已做、可信）：`_scratch/corpus-xml/fingerprints.json` 提供每电路的 `elmCount` 与**每元件 `posts.length`**（引擎实测），本 spike 用它验证"解析 + 脚位数"两层：元件数 372/372、脚位数 93.84%。**它不含 node id**，所以 `nets` 这一层目前只有"回写后划分不变（335/335）"这一条自洽证据，**缺一条与引擎的独立对拍**——这是本 spike 最该补的一刀，建议交给能跑起引擎的轨道（或给 `preStampCircuit` 补 canvas 桩后 5 分钟即可完成）。
