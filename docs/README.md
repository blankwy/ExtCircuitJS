# ExtCircuitJS · 设计评估与开发计划（交付索引）

> 评估基准：`pfalstad/circuitjs1` @ `e952e78`（`master` = `dev-ts`，版本 5.0.3，2026-10-24）。上游已**全量 TypeScript + Vite**，无 Java/GWT。
> 所有数字都来自本机实测，可复现命令见各文档。

## 一句话结论

**方案成立，但需要三处修正**：① 覆盖是构建期概念、插件是运行期概念，别混；② 覆盖要分级，且先把"poke 面"压到最小（实测只需 1 个 58 行文件的 2 行改动）；③ JSON 的价值是结构与可编程性，**省 token 靠去导线/去坐标/紧凑编码，不靠 JSON 语法**（命名键 JSON 反而比 XML 大 2.3 倍）。

## 文档地图

| 文档 | 内容 | 适合谁读 |
|---|---|---|
| [architecture-review.md](architecture-review.md) | 逐层评估（Core/Cover/Plugin/App/JSON+API+MCP）、五条关键修正、可行性判定表、风险清单、替代方案对比、实测评测汇总 | 决策者 / 架构评审 |
| [format-strategy.md](format-strategy.md) | **官方 XML 对 AI 友好吗**（量化审计）、读写通道怎么切、ops 补丁 API、与体积的真实关系 | 格式/API 设计者 |
| [collaboration-plan.md](collaboration-plan.md) | DeepSeek / GLM 的分工与预算、worktree 并行、门禁与升级链 | 项目负责人 |
| [task-board.md](task-board.md) | D1–D7 可拆分的任务卡（写作用域 / 验收命令 / 预算） | 派活的 Lead |
| [development-plan.md](development-plan.md) | 目录结构、接口契约（manifest/ctx/netlist/ops/MCP）、P0–P5 阶段计划、**14 天冲刺轨道表**、质量门禁、测试策略、工作量 | 执行者 |
| [seams.md](seams.md) | 最小 poke 面 S1–S5 的具体改法与代码、反面清单、同步检查顺序 | 写代码的人先看这个 |
| [spikes/cover-build.md](spikes/cover-build.md) | 覆盖层全链路实测（dev/build/HMR/tsc/类身份/冲突扫描）、插件接口草案、9 条风险 | Cover 实现者 |
| [spikes/plugin-runtime.md](spikes/plugin-runtime.md) | JS API 面（13 成员）、插件生命周期实测、C1–C9 Cover 缺口、plugin-api 契约、MCP 边界、§8 nets oracle | 插件/MCP 实现者 |
| [spikes/netlist-codec.md](spikes/netlist-codec.md) | 网表解析/回写数字、体积消融、元件描述表、`netlist/0.1` schema、失败分类 F1–F8 | 网表/格式实现者 |

## 关键数字（一句话版）

- 上游规模：`ts/` 根 **260** 个 `.ts`；示例电路 **373** 个；构建 `tsc && vite build` ≈ **6.4 s**，产物 JS **1.18 MB**（gzip 277 kB）。
- 覆盖层代价：+7 模块、+3.5 kB（gzip +3 kB）、构建 8.0–9.6 s、HMR ≈3 s。
- 语料回归：**372/373** 电路可确定性复跑（仅空电路失败），总耗时 **5.49 s**，10,555 元件。
- 网表：txt 解析 **335/335**；元件数对拍 **372/372**；引脚数 93.84%；回写后引脚划分 **335/335** 不变。
- 体积（÷官方 XML）：命名 JSON **2.29×**、紧凑 JSON **0.32×**、网表文本 **0.19×**；删导线 −32.3%、删坐标 −49.3%。
- 拓扑可信度（引擎 oracle 对拍）：clean 桶 **54/96 = 56.25%**，degraded 桶 0% ⇒ **nets 必须由引擎 `nodeList` 产出**。
- 插件：activate 后命令 207→208、钩子 {1,1,1}；deactivate 全归零；`?v=` 热重载生效；失败路径会漏 1 个订阅（契约需强制回滚）。

## 证据与可复现产物

| 路径 | 说明 |
|---|---|
| `spike/cover-build/` | 覆盖层工作副本、`tools/coverOverlay.mjs`、`tools/cover.mjs`（scan/status/apply/bless）、`evidence/*.log`、`scripts/run-all.ps1` |
| `spike/plugin-runtime/` | 浏览器夹具（playwright-core + 本机 Chrome）、`evidence/plugin-host.json`、`evidence/nets-oracle.json`、`scripts/*.mjs` |
| `spike/netlist-codec/` | `src/registry-gen.mjs` → `registry.json`、`src/codec.mjs`、`out/metrics.json`、`out/variants.json` |
| `_scratch/corpus-xml/` | **373 个 XML 快照 + fingerprints.json（1.9 MB）+ FAILURES.md**，后续所有契约测试的基座 |
| `_scratch/headless/probe.ts` | 无头证据：元件模型在 Node 下可构造、post 几何与 dump 类型可读 |
| `_scratch/core/` | 上游浅克隆（只读参考，勿改） |

## 复现（示例）

```powershell
# 覆盖层：基线 → 覆盖验证 → 冲突扫描
cd V:\Vibe\circuitjs1\spike\cover-build; .\scripts\run-all.ps1

# 网表：全量指标与体积消融
cd V:\Vibe\circuitjs1\spike\netlist-codec; node .\src\measure.mjs; node .\src\variants.mjs

# 插件 + oracle（需先起 dev server :5182）
cd V:\Vibe\circuitjs1\spike\plugin-runtime; node .\scripts\plugin-host.mjs; node .\scripts\nets-oracle.mjs
```

## 注意

- `spike/` 与 `_scratch/` 是**验证用一次性产物**，不是最终仓库结构；最终结构见 `development-plan.md` §2。
- `core/` 永远保持上游原样；任何人工改动进 `cover/`。
- 许可证以 `COPYING.txt` 的 **GPLv2** 为准（`ts/package.json` 写的 ISC 是错的）。
