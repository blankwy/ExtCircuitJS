# ExtCircuitJS

基于 [pfalstad/circuitjs1](https://github.com/pfalstad/circuitjs1) 的**二开**：在保留上游电路仿真与绘图能力的前提下，加三层可维护的扩展结构，并给 AI 提供可读写的电路对象模型。

> 上游基线：`e952e78` / `5.0.3ts` / 全 TypeScript + Vite（无 Java/GWT）。
> 许可证：GPL-2.0-or-later（见 `core/COPYING.txt`；上游 `ts/package.json` 的 ISC 标注不作数）。

**在线体验**：<https://blog.binarydev.top/ExtCircuitJS/>（GitHub Pages，跟随账户的 Pages 自定义域；
`blankwy.github.io/ExtCircuitJS/` 会 301 到同一地址）

## 四层结构

```
core/    上游源码（只读、pinned commit；任何人改都进 cover/）
cover/   覆盖层：按路径镜像覆盖 + 新增文件 + 插件宿主（构建期影子解析）
plugins/ 运行期插件（动态 import，带 manifest/权限/生命周期）
packages/ 可复用库：plugin-api（fiber/ctx）、netlist（JSON 投影 + ops）、mcp
tools/   App 层 CLI：ext doctor/dev/build/test/cover/plugin/core
```

关键设计：
- **覆盖是最小面**：只有 `ts/main.ts`（58 行，+2 行）和 `ts/ElementFactory.ts`（40 行）是整文件覆盖，其余都是新增文件与实例级包装。见 [docs/seams.md](docs/seams.md)。
- **读写分离**：官方 XML 存，语义 JSON 读，**ops 补丁写**（AI 不碰坐标）。见 [docs/format-strategy.md](docs/format-strategy.md)。
- **插件无沙箱**：同源 ESM 全权限 ⇒ 契约 + 权限声明 + 静态粗扫描；"卸载 = 释放自身注册的一切"。见 [docs/development-plan.md](docs/development-plan.md) §3.3。

## 快速开始

要求：Node ≥ 22（Windows / Linux 均可）。

```bash
# 1) 安装上游依赖（core/ts 自带 package.json）
node tools/ext.mjs core install

# 2) 自检
node tools/ext.mjs doctor

# 3) 开发（http://localhost:5174/circuitjs.html）
node tools/ext.mjs dev

# 4) 生产构建 -> dist/
node tools/ext.mjs build

# 5) 契约测试（真实 Chromium，需要本机 Chrome + playwright-core）
node tests/contract/boot.browser.mjs
node tests/contract/dist-site.browser.mjs   # 把 dist/ 当子路径站点真开一次（生产构建的验收）
```

`doctor` 会检查：Node 版本、core.lock 与源码版本一致、cover manifest 文件齐全、插件 manifest、373 个语料 fixture。

## 静态部署（GitHub Pages 等）

`node tools/ext.mjs build` 的 `dist/` 就是一个**可以直接挂在任意子路径**下的静态站，不需要改 `base`：

- 构建收尾（`cover/vite.cover.config.ts` 的 `finalizeForHosting`）会把 HTML 里的绝对 `href/src`、`circuit/manifest.json` 的 `start_url`/图标全改成相对路径，并补上 `index.html`（站点根直接进仿真器）、`favicon` 引用、`.nojekyll`；
- 插件根不是 bundle 同级目录，`cover/ts/ExtPluginHost.ts` 用 `document.baseURI` 推 `plugins/`，所以在 `/<repo>/plugins/` 下也能加载；
- `service-worker.js` 由构建从上游 `core/ts/service-worker.template.js` 生成（上游这一步在 `dist.sh` 里），首访会预缓存约 425 个文件 / 3.3 MB，之后可离线打开。

GitHub Pages 由 `.github/workflows/pages.yml` 负责：`main` 每次推送都构建并 deploy（首次使用需在仓库 **Settings → Pages → Source** 选 “GitHub Actions”）。`ci.yml` 也会把两平台的 `dist/` 作为 artifact 保留 7 天，方便直接下载静态包。

## 现在能跑什么（v0.1.0）

| 能力 | 状态 | 入口 |
|---|---|---|
| 覆盖层构建/热更新/类型检查 | ✅ | `cover/vite.cover.config.ts` |
| Boot 暴露 window.ExtCircuitJS | ✅ | `cover/ts/ExtBoot.ts` |
| API：读网表 / 列元件 / 测量 / 改参数 / 载入电路 | ✅ | `cover/ts/ExtApi.ts` |
| 插件：activate / deactivate / 热重载 / 失败回滚 / 命令 / 面板 | ✅ | `cover/ts/ExtPluginHost.ts、packages/plugin-api` |
| 网表导出（引擎 nodeList 权威）+ 稳定 id + set/delete ops | ✅ | `packages/netlist` |
| 紧凑编码（聚合 0.26× XML）+ registry 再生成 CLI | ✅ | `packages/netlist/src/compact.ts；ext netlist registry/bench` |
| add between nets（导线分裂增量放置，自校验回滚） | ✅ | `packages/netlist/src/place.ts` |
| 菜单插槽（自定义元件进 Draw/右键菜单） | ✅ | `cover/ts/ExtMenus.ts` |
| MCP：会话 RPC + WebSocket 桥 + 10 工具 + ai-loop demo | ✅ | `packages/mcp`、[docs/mcp.md](docs/mcp.md) |
| CI（Windows+Ubuntu：doctor/build/lint/scan + Node 契约） | ✅ 本地自证 | `.github/workflows/ci.yml` |
| 无头求解器 / Worker 沙箱 / 自动布局 | ⬜ 非 v1 目标 | [docs/development-plan.md](docs/development-plan.md) §5.2 |

浏览器里试：

```js
const ext = window.ExtCircuitJS;
ext.api.dumpNetlist({ layout: false });        // 语义网表
ext.api.listComponents();                       // 元件 + 稳定 id
ext.api.applyOps([{ op: "set", target: "c0", prop: "resistance", value: 2200 }]);
ext.api.getMeasurements();                      // 节点电压 + 元件电流
await ext.plugins.reload("hello");              // 插件热重载
```

## 目录

```
core/           上游 ts/ + war/（只读）+ core.lock.json
cover/          manifest、Vite 派生配置、tsconfig.cover、ts/（覆盖与新增）
plugins/        plugins.manifest.json + hello/
packages/       plugin-api / netlist / mcp
tools/          ext.mjs（CLI）、cover.mjs（scan/status/apply/bless）、coverOverlay.mjs
tests/          fixtures/corpus-xml（373 例 + fingerprints）、contract/
docs/           评估 / 计划 / 格式策略 / seam / 协作与任务板 / spike 报告
dist/           构建产物（gitignore）
```

## 文档

- [架构评估](docs/architecture-review.md) — 逐层判定、五条修正、实测数据、风险
- [开发计划](docs/development-plan.md) — 契约、P0–P5、14 天冲刺轨道表、CI 门禁
- [格式策略](docs/format-strategy.md) — 官方 XML 的 AI 友好度审计、读/写通道、ops 设计
- [最小 seam](docs/seams.md) — S1–S5 的具体改法
- [模型协作与并行](docs/collaboration-plan.md) — DeepSeek/GLM 分工、预算、worktree、门禁
- [任务板](docs/task-board.md) — D1–D7 可拆分的任务卡
- [交付索引](docs/README.md) · [spike 报告](docs/spikes/)

## 开发纪律（摘要，详见 CONTRIBUTING）

1. `core/` 永远保持上游原样；只允许 `ext core sync` 的机械更新。
2. 覆盖分级：能加不改 > 钩子 > 整文件覆盖；薄影子只用于 ≤20 行补丁。
3. 不改类名、不覆盖生成物（`registerElements.ts`）。
4. 测试只允许 Lead 修改；worker 不许"修测试让它变绿"。
5. 一次任务一个写作用域，用 worktree 隔离。
