# 模型协作与长任务并行规划（DeepSeek-V4.1-Flash + GLM-5.3 / 5.3-Flash）

> 前提：14 天冲刺（`development-plan.md` §5.2），4 条轨道。
> 资源：**自费 DeepSeek-V4.1-Flash**（按量计费）+ **GLM-5.3 免费 3 亿** + **GLM-5.3-Flash 免费 2 亿**。
> 目标：**免费额度覆盖体量，付费额度只买"确定性"**；并发不是越多越好，写作用域必须互斥。

---

## 1. 一句话原则

**付费模型当"包工头 + 质检员"，免费模型当"施工队"；用测试和 CI 当裁判，不用模型自证正确。**

- 免费额度用于**读代码、写代码、写测试、写文档、跑命令、整理日志**（token 大头）。
- 付费 DeepSeek 用于**接口设计、集成、疑难 debug、最终验收、跨模型仲裁**（token 小头，但决定成败）。
- 任何"让模型判断自己写得对不对"的用法都是浪费钱；正确做法是让它跑 `ext build` / `tsc` / 契约测试。

---

## 2. 角色分配（模型 × 任务类型）

| 任务类型 | 首选 | 理由 | 典型 token/任务 |
|---|---|---|---|
| 读上游源码、定位符号、列清单 | **GLM-5.3-Flash** | 量大、可并行、错了代价低 | 2–6 万 |
| 机械改动 / 补类型 / 写样板 / 迁移路径 | **GLM-5.3-Flash** | 单价最低，适合"看得懂就会做" | 1–4 万 |
| 写单测 / 契约测试 / fixture 清洗 | **GLM-5.3-Flash** | 有明确验收命令 | 2–5 万 |
| 文档、README、注释、报告汇总 | **GLM-5.3-Flash** | 无运行时风险 | 1–3 万 |
| 新模块设计（ctx/ops/schema） | **GLM-5.3** | 需要长上下文 + 推理 | 5–12 万 |
| 疑难 debug（跨 3 个以上文件、时序/生命周期） | **GLM-5.3**，卡住升级 DeepSeek | 免费额度里最强的推理 | 8–20 万 |
| 代码评审（找别人的坑） | **GLM-5.3**（第一遍）+ **DeepSeek**（放行） | 双人复核，成本可控 | 3–8 万 |
| 接口冻结 / 集成 / 冲突裁决 | **DeepSeek-V4.1-Flash** | 一次错会让 4 条轨道返工，值得付费 | 3–10 万 |
| 最终验收 / 发布前冒烟 | **DeepSeek-V4.1-Flash** | 需要稳定复现与判断 | 2–6 万 |
| 长上下文整仓扫描 | GLM-5.3（若上下文够）否则 DeepSeek | 按可用上下文选 | 10–30 万 |

**升级链**（同一条任务最多 2 次免费尝试）：
`GLM-5.3-Flash → GLM-5.3 → DeepSeek-V4.1-Flash`。
升级时必须带**失败证据**（命令输出/报错/复现步骤），否则新模型会从零重来，钱白花。

---

## 3. 预算（先按 14 天估，D2 后用真实消耗重算）

| 轨道 | GLM-5.3 | GLM-5.3-Flash | DeepSeek（付费） | 说明 |
|---|---|---|---|---|
| A Cover/App | 40M | 30M | 15M | seam、构建胶水、冲突扫描 |
| B 插件 | 45M | 40M | 10M | 生命周期、命令/面板、lint |
| C 网表 | 50M | 45M | 10M | registry、导出、ops |
| D MCP/AI | 30M | 25M | 15M | 会话 RPC、工具集、文档 |
| 评审/集成/返工缓冲 | 35M | 20M | 20M | 每周 2 次门禁 + 20% buffer |
| **合计** | **200M** | **160M** | **70M** | 免费 360M（剩 140M 余量）+ 付费 70M |

> 校准方法：D2 结束时统计每条轨道实际消耗（各模型后台都有用量），按比例缩放上表；**免费额度低于 120M 时切换到"只做 P0/P1/P2"**，把 P3/P4 推到第二冲刺。

---

## 4. 并行结构：4 条轨道，最多 3 个写者

```
                    ┌──────────── Lead（DeepSeek，短会话）────────────┐
                    │ 接口冻结 / 门禁 / 冲突裁决 / 最终验收            │
                    └───────┬───────────────┬───────────────┬────────┘
        Track A (worktree-a)│  Track B (worktree-b)│ Track C (worktree-c)│ Track D（只读+脚本）
        Cover/App           │  Plugin              │  Netlist            │  MCP/AI
        GLM-5.3 + Flash     │  GLM-5.3 + Flash     │  GLM-5.3 + Flash    │  Flash（+DeepSeek 收尾）
```

- **写作用域**（互斥，写进每张任务卡）：
  - A：`cover/`、`tools/`、`core/`（只读，仅 `core.lock` 机械更新）
  - B：`cover/ts/ExtPluginHost.ts`、`packages/plugin-api/`、`plugins/`
  - C：`packages/netlist/`、`tests/fixtures/`、`tests/contract/netlist*`
  - D：`packages/mcp/`、`docs/`（除 spike 报告）、`tests/contract/mcp*`
- **共享只读**：`core/`、`tests/fixtures/corpus-xml/`、`docs/architecture-review.md` 等决策文档。
- **worktree**：`git worktree add ../wt-a -b track/a` 等；合并由 Lead 做，**worker 不 push 主分支**。
- **接口冻结（D2 结束）**：`cover.manifest.json` schema、`ExtPluginContext`、`netlist/0.1`、`ExtApi` 成员、MCP 工具名。冻结后修改要走"接口变更队列"，由 Lead 统一改并通知三条轨道。
- **门禁（Lead，DeepSeek）**：D3（seam 通）/ D5（ops 通）/ D7（三条轨道汇合）/ D10（MCP 闭环）。每次 30–60 分钟，只跑命令 + 看 diff，不做大改。

---

## 5. 任务卡规范（每个 agent 只拿一张卡）

```md
### T-B03 插件命令插槽 + 卸载
- 轨道/模型：B / GLM-5.3-Flash
- 写作用域：cover/ts/ExtPluginHost.ts
- 输入：docs/seams.md S4；core/ts/CommandPaletteRegistry.ts:40-90
- 目标：ctx.command() 注册/撤销；重复 id 冲突时抛错
- 验收：node tools/ext.mjs build && node tests/contract/boot.browser.mjs（lifecycle.afterDeactivate=0）
- 禁止：改 core/、改测试断言、改接口签名
- 预算：≤ 4 万 token；2 次失败即上交
```

**卡片必须自带**：文件锚点（file:line）、验收命令、禁止项、预算。没有验收命令的任务不允许开工。

---

## 6. 省钱/省时的 10 条硬规则

1. **先跑命令，再问模型**：`ext doctor/build` 的报错比模型猜测便宜 100 倍。
2. **给文件清单，不给整仓**：每张卡列 3–8 个文件 + 行号锚点，上下文控制在 30–40k。
3. **一次任务只碰一个关注点**：混着改 UI + 改协议的任务，返工率翻倍。
4. **测试先行由 Flash 写，逻辑由 5.3 写**；不要让 5.3 花 token 抄样板。
5. **禁止"顺手重构"**：worker 只做卡上写的；发现别的问题写进 `docs/handoffs/observations.md`，由 Lead 排期。
6. **失败两次就升级/换卡**，不许同一模型反复试同一错。
7. **长任务拆成 ≤20 次工具调用**的阶段；超过就拆卡（长任务不等于长会话）。
8. **缓存重活**：registry 生成、语料 XML、fingerprints 只跑一次，产物入库。
9. **模型不判对错**：正确性由 `tsc` + 契约测试 + 指纹回归判定。
10. **每日收工写 5 行 handoff**（做了什么/证据/卡在哪/下一步/消耗），第二天换模型也能接。

---

## 7. 每周节奏

| 时间 | 事 | 谁 |
|---|---|---|
| 每天开始 | Lead 发当日卡片（≤6 张），确认写作用域不冲突 | DeepSeek |
| 每天结束 | 各轨道 5 行 handoff + 跑一次 `ext build` | 各 worker |
| D3 / D5 / D7 / D10 | 门禁：跑验收命令、看 diff、决定是否放行 | DeepSeek |
| 每周一次 | 上游同步演练（`core sync --dry-run` + `cover scan`） | A 轨 + Lead |
| 每周一次 | 成本复盘：各模型消耗/剩余额度，重排下周预算 | Lead |

---

## 8. 主要风险与对策

| 风险 | 症状 | 对策 |
|---|---|---|
| 两个模型风格不一致 | diff 噪音大、review 难 | 统一 `prettier`/`eslint`（D1 加），接口冻结，只允许卡上改动 |
| 模型幻觉 API | 调不存在的方法 | `tsc` 必须过；契约测试必须跑；禁止 `any` 逃逸到新代码 |
| 免费额度烧在"读仓库" | 前几天就用掉 30% | 用 `rg` 先定位、给锚点；大范围阅读交给 Flash 并只回摘要 |
| 并发写冲突 | 同一文件被两人改 | worktree + 写作用域互斥 + Lead 合并；冲突即停 |
| 上下文丢失导致返工 | 新会话从零开始 | 任务卡 + handoff + 决策文档（本仓库 docs/） |
| 模型"修测试"而不是修代码 | 测试变绿但功能坏了 | 测试文件只允许 Lead 改；CI 里禁止 worker 提交 tests/ 变更 |

---

## 9. 第一天怎么开局（可直接照做）

1. **Lead（DeepSeek）**：跑 `node tools/ext.mjs doctor && node tools/ext.mjs build`，确认基线绿；把 `docs/task-board.md` 的 D1 卡片发下去。
2. **A 轨（GLM-5.3）**：读 `docs/seams.md`，把 S1 的 `main.ts` 覆盖与 `ExtBoot` 接线核对一遍（已经搭好，重点是确认 anchor 与同步脚本）；补 `tests/contract/boot.browser.mjs` 的失败分支。
3. **B 轨（GLM-5.3-Flash）**：把 `plugins/hello` 扩成 3 个示例（panel/command/event 各一），并跑 `node tools/ext.mjs plugin lint`。
4. **C 轨（GLM-5.3）**：把 `packages/netlist` 的 `applyOps.add` 设计成可实现的增量放置（读 `WireElm.split` + `postDrawList`），先写伪代码 + 测试用例，不动实现。
5. **D 轨（GLM-5.3-Flash）**：写 MCP 会话 RPC 的 TypeScript 接口与假实现（不连浏览器），让 Lead 评审协议。

> 记住：**并发的是"任务"，不是"上下文"**。四个 agent 各自 30k 上下文、互不依赖，比一个 agent 带着 200k 上下文串行快 3 倍、便宜 2 倍。
