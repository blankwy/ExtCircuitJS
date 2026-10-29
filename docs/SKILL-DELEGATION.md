# Skill 委托文档：ExtCircuitJS 电路助教

> 交接对象：新会话（负责做 skill 并推广）。
> 交接日期：2026-10-29。前置工作已完成，见"已就绪能力"。
> 相关文档：[Wiki 首页](https://github.com/blankwy/ExtCircuitJS/wiki) · [插件开发](https://github.com/blankwy/ExtCircuitJS/wiki/插件开发)

---

## 1. 要做什么

做一个 skill，让 AI 助手能**用真实电路仿真回答电路问题**：读网表 → 改参数 → 跑仿真 → 读数值 → 出图。

**核心价值**（别丢掉）：AI 不是"画一个像电路的图"，而是**在真引擎上跑出真数值**。
555 定时器的占空比、滤波器的截止频率、运放的增益——这些能算出来、能验证，不是编的。

**明确不做**：
- ❌ 回复里的可交互 canvas（对话界面撑不住，AI 侧收不到交互结果，做了也是断链）
- ❌ 把 Chrome/playwright 打进 skill（体积大、多数宿主不让起子进程）

**产出形态**：文字解释 + SVG 波形图（AI 自己画）+ 关键数值 + **（首选）一个能点开就仿真的分享链接**。

---

## 1.5 ⭐ 分享链接：AI 交付的**最轻路径**（优先用它）

用户不满足于"一张图"时，**别急着塞文件、别要求装环境**——给一个 URL 就够：

```
https://blankwy.github.io/ExtCircuitJS/circuitjs.html?ctz=<压缩电路>
```

点开即见电路、可点 RUN 仿真、可拖滑块调参。**零安装、零文件传输、不需要 Node。**

### AI 侧怎么生成（纯命令行，不需要浏览器）

```bash
# 内置语料
node tools/ext.mjs share --circuit lrc

# 任意电路文本（AI 现造或从网表编译得到的）
node tools/ext.mjs share --text "r 100 100 300 100 0 1000\nw 100 100 100 300"

# 电路文件
node tools/ext.mjs share --file my.txt

# 顺便出分享页（1-2KB html）
node tools/ext.mjs share --circuit lrc --out build/share.html
```

- **stdout 只有一行 URL**（诊断走 stderr），便于脚本抓取：`URL=$(node tools/ext.mjs share --circuit lrc 2>/dev/null)`
- 脚本**内置自检**：解压必须与原文逐字节相同，否则报错（防止给用户一个空电路链接）
- 实测：lrc（441 字节）→ URL 404 字符，打开后自动载入 7 元件并开始仿真

### 长度预算（要主动判断，别给出会失效的链接）

| URL 长度 | 判断 |
|---|---|
| < 2000 | 安全，任何渠道都能传 |
| 2000–8000 | 部分 IM/邮件会截断，**建议改用 `--out` 出分享页** |
| > 8000 | 脚本会警告；改用分享页或单文件 HTML |

### 完整链路（AI 全自动）

```
① 造/改电路 → 拿到电路文本
     · 内置语料：直接 --circuit <名字>
     · 从网表编译：MCP 的 circuit.load_netlist（带拓扑硬闸）→ dumpCircuit 取文本
     · 手写/微调：--text "<电路文本>"
② node tools/ext.mjs share --text "<文本>"     → 得到 URL
③ 把 URL 给用户（"点开就能跑，可以拖滑块调参数"）
```

> **分享链接只含电路本身**，不含仿真状态、不含主题设置——对方打开是 t=0 初始态，这通常正是想要的。

### 决策顺序（写进 SKILL.md）

| 用户想要 | 给什么 |
|---|---|
| 一句话能答的概念问题 | 文字，别折腾 |
| 看波形/要真实数值 | MCP 仿真 + SVG 波形 + 数值 |
| **自己动手试、调参数** | **分享链接**（首选，最轻） |
| 离线/内网/存档/发文件 | 单文件 HTML（`bundle-single`，1.4MB） |
| 链接太长发不出去 | 分享页（`--out`，1-2KB，仍依赖原站） |

---

## 2. 已就绪能力（不用重做）

| 能力 | 状态 | 位置 |
|---|---|---|
| **静态产物可被 MCP 驱动** | ✅ 已改造（`0adbe2d`） | `ExtBoot` 暴露 `loadMcpBridge()`，backend 优先用之 |
| `read_scope` 降采样（防爆 token） | ✅ 默认 240 点、保峰谷 | `ExtMcpBridge.ts` / `tools.ts` |
| 标准回合示例 | ✅ 可运行 | `examples/circuit-tutor.mjs` |
| MCP 服务器（stdio） | ✅ | `node tools/ext.mjs mcp` |
| 11 个工具 | ✅ | 见下表 |
| 网表读写 + 稳定 id + ops 补丁 | ✅ | `packages/netlist` |
| 网表→电路编译器（拓扑硬闸） | ✅ | `compile.ts` / `geom.ts` |
| 373 电路语料 | ✅ | `core/ts/public/circuits/*.txt` |

**实测过的完整回合**（`node examples/circuit-tutor.mjs`）：

```
[1] 网表: 7 元件 / 5 网
[2] 改参: e1.resistance 10Ω → 30Ω (applied=1)
[3] 步进: t=0.010005s, 2001 engine steps
[4] 测量: V(n1) = -10.4774 V, V(n2) = -10.3258 V, V(n3) = 5 V ...
[5] 波形渲染: 6 个 SVG → build/tutor
```

### MCP 工具一览

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `circuit.get_netlist` | 读网表（元件/稳定id/连接） | `format=compact` 省 token，`layout` 带坐标 |
| `circuit.load_netlist` | 载入电路文本/XML/网表 JSON | `text` |
| `circuit.list_components` | 元件清单 | — |
| `circuit.set_param` | 改元件参数 | `target`(e1..), `prop`, `value` |
| `sim.step` | **确定性步进**（读数可复现） | `seconds` |
| `sim.run` / `sim.stop` | 实时步进（不确定性，教学别用） | — |
| `sim.reset` | 复位 | — |
| `sim.read_measurements` | 读电压/电流 | `nets` / `components` |
| `sim.read_scope` | 读波形 | `maxPoints`（默认 240，0=全量） |
| `schematic.screenshot` | 电路截图 | `format: png\|svg` |

---

## 3. 双线策略（你定的，已具备条件）

**目标**：绕开 GitHub Pages 在部分网络环境不可达/极慢的问题。

```
① 先试 GitHub Pages（零安装，最轻）
     https://blankwy.github.io/ExtCircuitJS/
     └─ 可达 → 直接连它（MCP backend 的 baseUrl 指过去）
② 不可达 → 用本地仓库的 dist/
     node tools/ext.mjs build && node tools/ext.mjs serve --port 8080
     └─ 已实测：静态产物被 MCP 完整驱动（via builtin）
③ 都没有 → 起 dev server（最重，仅开发态）
     node tools/ext.mjs dev --port 5174
```

**技术支撑**：`backend.ts` 的 `baseUrl` 参数 + `devServer: "off" | "reuse" | "auto"`。
线 ① 和 ② 都走 `devServer: "off"`（不需要 dev server，静态服务即可）。

**建议的探测逻辑**（写进 skill 的辅助脚本）：

```js
// 依次试，第一个通的就用
const candidates = [
  { base: "https://blankwy.github.io/ExtCircuitJS", label: "GitHub Pages", devServer: "off" },
  { base: `http://127.0.0.1:${port}`, label: "本地 dist", devServer: "off" },  // 先确保 serve 起了
  { base: "http://127.0.0.1:5174", label: "dev server", devServer: "reuse" },
];
```

> ⚠️ 注意：Pages 站点是 **`/ExtCircuitJS/` 子路径**部署，`baseUrl` 要带前缀。
> 静态站点已支持子路径（`dist-site.browser.mjs` 两种形态都测过）。

---

## 3.5 给用户的**单文件**产物（不走 MCP，纯人看）

如果用户只想「拿到一个电路，打开就能看/点仿真」，**不需要 MCP、不需要 Node 常驻**：

```bash
node tools/ext.mjs build
node tools/ext.mjs bundle-single --out build/circuitjs-single.html
```

产出**约 1.37 MB 单个 .html**，双击即开（`file://` 可运行），界面完整、可拖元件、可点 RUN 仿真、可导入/导出电路。

**已实测**（真实 Chromium + `file://` 协议）：`window.ExtCircuitJS` 注入成功、版本 `5.0.3ts`、画布渲染正常、无致命错误。

**实现要点**（想改就改这个脚本：`tools/ext-bundle-single.mjs`）：
- bundle 包成 `async () => { ... }` IIFE —— 顶层 await 在函数体内合法，且不再是 module，`file://` 才能执行
- `import.meta.url` 注入伪对象（指向 `document.baseURI`）—— 否则非 module 环境直接抛错
- 字体 woff2 内联成 base64、CSS 内联 —— 单文件自洽
- **坑**：bundle 源码里含 `` $` `` 字面量，`String.replace` 会把替换串里的 `$\`` 展开成"匹配前的内容"，必须用**函数式替换** `replace(a, () => b)`

**已知限制**（脚本文件头也写了，别对外承诺超出范围）：
| 限制 | 原因 | 影响 |
|---|---|---|
| 内置电路列表为空 | 需 fetch `setuplist.txt` + `circuits/`，`file://` 被 CORS 禁 | 用户可手动粘贴电路文本 |
| 语言包不加载 | 同上（fetch `locale/*.txt`） | 界面显示英文默认文案 |
| Service Worker 不注册 | `file://` 不支持 | 无离线缓存（单文件本身已离线） |
| MCP 不可用 | 单文件无 http 服务，WS 桥连不上 | 要 AI 驱动仍须走 ①/②/③ |

> 结论：**单文件 = 给"人"看/玩的产物；MCP = 给"AI"驱动的通道**。两者互补，不是替代。

---

## 3.6 能不能把整套塞进 skill 内置运行？

**可以，但要分清两件事**：

| 想要 | 可行性 | 做法 |
|---|---|---|
| 单文件 HTML 内置于 skill | ✅ 完全可以 | 1.37MB 直接打进 skill 的 `assets/`，AI 生成电路文本 → 写入 HTML 的 `#circuit` 或直接给用户文件 |
| MCP 后端内置运行 | ⚠️ 有条件 | 需要 Node + 本机 Chrome；**不能**把 Chrome 打包进去（体积/许可证/沙箱限制），只能依赖用户已装 |

**推荐组合**：
1. skill 内置 `circuitjs-single.html`（1.37MB，离线可用，不受墙影响）
2. 需要 AI 真驱动仿真时，检测用户是否有 Node + Chrome —— 有则用本地仓库的 MCP，没有则退化为「生成电路文本 + 给单文件让用户自己点」

这样「墙 + 延迟 + 没装环境」三种情况都有对应降级路径，不会全盘失败。

---

## 4. Skill 该包含什么

```
ext-circuit-tutor/
├── SKILL.md                 触发条件 + 使用说明（见下）
├── scripts/
│   ├── probe.mjs            双线探测：Pages → 本地 dist → dev server
│   ├── tutor.mjs            标准回合（照抄 examples/circuit-tutor.mjs）
│   └── scope-svg.mjs        SVG 渲染（照抄 examples/circuit-tutor.mjs 里的 scopeToSvg）
└── reference/
    ├── tools.md             11 个工具速查（可裁剪自本文 §2）
    └── circuits.md          内置语料清单（373 个电路名 + 一句话）
```

### SKILL.md 要写的关键内容

**触发条件**（写给模型看，要具体）：
> 用户问电路/电子相关问题，且需要**真实数值或波形**（不只是概念解释）：
> "这个 RC 滤波器截止频率多少" / "555 占空比怎么调" / "帮我看看这个电路为什么振荡" /
> "改一下这个电阻会怎样" / "画出输出波形"。

**不该触发的**：纯概念问答（"什么是欧姆定律"）、纯电路图绘制需求（用 SVG 手画即可）。

**工作流**（模型必须照做的顺序）：
1. `probe.mjs` 确认有可用后端（Pages / 本地 dist / dev）
2. 若是常见电路（RC/RL/555/运放…），先看 `reference/circuits.md` 有没有现成语料；没有就 `load_netlist` 生成
3. `get_netlist` 看清元件与网络
4. 用 `set_param` / ops 改参数（**绝不手写坐标**）
5. `sim.step` 推进（**必须用 step，不能用 run** —— run 是墙钟驱动，数值不可复现）
6. `read_measurements` 读数 + `read_scope` 取波形
7. 用 `scope-svg.mjs` 渲染 SVG 嵌进回复
8. 结论里给**具体数值 + 单位 + 条件**（t=2ms 时 Vout=3.2V），不要只说"会变大"

**硬性纪律**（写进 SKILL.md，防止模型走歪）：
- 数值必须来自 `read_measurements`/`read_scope`，**不许估算或编造**
- 步进一律用 `sim.step`（确定性），不用 `sim.run`
- 波形点数用默认 240（够画图），不要 `maxPoints=0` 拉全量（会爆 token）
- 电路改动走 ops/`set_param`，不手写坐标（坐标错 1px = 静默断线）

---

## 5. 推广时该讲的（和不该讲的）

**该讲**（真实优势）：
- 数值可验证：不是"看起来像"，是真引擎跑出来的
- 373 个内置电路可直接用（RC/RL/LRC/555/运放/滤波器/数字电路…）
- AI 改电路是改参数不是画图，出错率低
- 离线可用（本地 dist 那条线）

**不该讲**：
- ❌ "在对话里交互式玩电路" —— 做不到
- ❌ "零安装" —— MCP 那条线要 Node + Chrome（Pages 那条线是人看，不是 AI 驱动）

**要如实说的门槛**：需要 Node ≥22 + 本机 Chrome；`npm install --prefix core/ts`。

---

## 6. 现有仓库位置与命令

```bash
git clone https://github.com/blankwy/ExtCircuitJS.git
cd ExtCircuitJS
npm install --prefix core/ts

# 本地产物（线 ②）
node tools/ext.mjs build
node tools/ext.mjs serve --port 8080

# MCP 服务器（给 AI 宿主）
node tools/ext.mjs mcp

# 分享链接（不需要浏览器/不需要 build）
node tools/ext.mjs share --circuit lrc

# 单文件离线 HTML
node tools/ext.mjs bundle-single --out build/circuitjs-single.html

# 标准回合验证（做完 skill 先跑这个）
node examples/circuit-tutor.mjs
```

**环境变量**：`EXC_BASE`（后端地址）、`EXT_PW_CORE`（playwright-core）、`EXT_CHROME`（浏览器）。

---

## 7. 已知坑（踩过的，别重踩）

| 坑 | 说明 |
|---|---|
| **`sim.run` 不可复现** | 墙钟驱动，同一电路两次跑数值不同。一律用 `sim.step` |
| **`read_scope` 全量会断连** | 3 scope × 512 点会撑爆 WS 消息。用默认 240，或看 `cappedFromAll` 标记 |
| **确定性步进的引擎序列** | `analyzeCircuit → preStampAndStampCircuit → runCircuit`，只调 `preStampCircuit` 会在 NaN 检查崩（MCP 内部已封装，自己写时注意） |
| **坐标陷阱** | 手写 XML 坐标差 1px = 静默开路（不报错、仿真出全 0V）。所以走 ops 不碰坐标 |
| **Pages 是子路径** | `baseUrl` 要带 `/ExtCircuitJS` 前缀 |
| **静态产物必须有桥** | 已在 `0adbe2d` 解决（桥打进 bundle）；更早的版本只能 dev 驱动 |

---

## 8. 验收标准（skill 做完了怎么算成）

1. `node scripts/probe.mjs` → 三条线各能正确识别可用/不可用
2. 问"RC 低通滤波器截止频率是多少" → 模型能建电路、跑出 -3dB 点、出 SVG 幅频曲线
3. 问"555 定时器改 R2 会怎样" → 模型能改参、给出前后对比数值 + 波形
4. **问"能让我自己试试吗" → 模型能生成分享链接，且链接打开后电路正确**
5. 所有数值都能在 `read_measurements` 输出里找到对应项（抽查 3 个）
6. 回复里嵌的 SVG 能正常显示

---

## 9. 可选增强（优先级低）

- **网表 JSON → 电路图**：`compile.ts` 能生成坐标与导线，配合 `schematic.screenshot` 出图
- **常见电路模板库**：把 373 语料按教学主题分类（滤波器/振荡器/数字/电源…），写进 `reference/circuits.md`
- **参数扫描**：循环 `set_param + step + measure` 画参数曲线（如 R 从 10Ω 到 1kΩ 的增益变化）
- **多通道对比**：同一电路改参前后两条曲线叠在一张 SVG
