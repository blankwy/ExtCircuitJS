# 贡献指南（ExtCircuitJS）

## 0. 先读什么

| 你要做的事 | 先读 |
|---|---|
| 加一个功能 | `docs/architecture-review.md` §2（分层与修正） + `docs/seams.md`（能改哪里） |
| 改网表/格式/API | `docs/format-strategy.md` |
| 加插件 | `docs/development-plan.md` §3.3 + `plugins/hello` |
| 跟上游同步 | `docs/seams.md` 末尾「同步检查顺序」 + `docs/spikes/cover-build.md` |
| 接模型/并行开发 | `docs/collaboration-plan.md` + `docs/task-board.md` |

## 1. 铁律

1. **`core/` 是只读的**。任何人工改动都进 `cover/`；唯一例外是 `ext core sync` 的机械替换。
2. **覆盖分级**：优先新增文件（L0）→ 实例级包装/钩子（L1）→ 整文件覆盖（L3）。薄影子（L2）只用于 ≤20 行补丁。
3. **不改类名**：`ElementFactory` 与 `keepNames` 依赖 `this.constructor.name`。
4. **不覆盖生成物**：`registerElements.ts` 由脚本生成；新增元件走 `registerExtElements` + `ElementFactory.registerClass`。
5. **测试是裁判**：worker 不得修改测试断言；测试失败先查实现。
6. **一次任务一个写作用域**：见任务卡的 `写作用域`；跨作用域先找 Lead 拆卡。

## 2. 提交前自检

```bash
node tools/ext.mjs doctor
node tools/ext.mjs build        # tsc(core) + tsc(cover) + vite build
node tools/ext.mjs plugin lint
node tools/ext.mjs cover status # 覆盖层与上游是否漂移
node tests/contract/boot.browser.mjs
```

任何一步红了都不要提交；先贴日志定位（`docs/spikes/` 里有同类问题的处理记录）。

## 3. 覆盖文件怎么写

- 整文件覆盖：从 `core/ts/<path>` 复制到 `cover/ts/<path>`，只改必要处，并在 `cover/cover.manifest.json` 写：
  - `forkPointBlob`：上游文件的 git blob hash（`node tools/cover.mjs bless` 可生成/刷新）
  - `anchors`：你依赖的上游签名（上游一改就要报警）
  - `owner` / `reason` / `contracts`
- 新增文件：`kind: "add"`，`tier: "L0"`。
- 覆盖文件里**可以**用相对导入（`./CirSim`），overlay 插件会把它指回 core；但**不要**复制 core 的无关代码进来。

## 4. 插件怎么写

```ts
export async function activate(ctx) {
  ctx.panel(el);                                  // 自动绑定卸载
  const off = ctx.on("analyze", () => {});         // 自动绑定卸载
  ctx.command({ id: "my.plugin.do", label: "Do", run() {} });
  ctx.effect(() => cleanup());                     // 自定义清理
}
export async function deactivate() {}
```

- 只通过 `ctx` 与 `ctx.api`，**不要** `import` core 内部模块。
- 所有注册必须能卸载；`node tools/ext.mjs plugin lint` 会扫危险 API 与 claims 冲突。
- `activate` 抛错时宿主会 LIFO 回滚；不要在模块顶层做副作用。

## 5. 网表/API 改动

- 读：`exportNetlist(app)` 一律走引擎 `nodeList`，**不要**自己并查坐标（对拍仅 16% 一致）。
- 写：只加 `ops`，不要让 AI/插件手写 XML 或坐标（静默断连风险）。
- schema 变更要改 `docs/format-strategy.md` 并升 `netlist/0.x`；旧版本必须还能读。

## 6. 上游同步流程

```bash
node tools/ext.mjs core sync          # 看 remote HEAD 与 lock 的差异
# 按提示 clone 上游 -> build/upstream
node tools/ext.mjs cover scan --core build/upstream --json build/cover-scan.json
# 处理 both-changed / orphan / anchor-broken，然后：
node tools/ext.mjs cover bless
node tools/ext.mjs build && node tests/contract/boot.browser.mjs
```

同步 PR 必须附 `cover-scan.json` 与契约测试结果；`both-changed` 未处理不得合并。

## 7. 许可证

上游为 GPLv2；本仓库同样以 GPL-2.0-or-later 发布。新增文件保留 SPDX 头即可：

```ts
// SPDX-License-Identifier: GPL-2.0-or-later
```
