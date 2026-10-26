# ExtCircuitJS

基于 [pfalstad/circuitjs1](https://github.com/pfalstad/circuitjs1) 的**二开**：在保留上游电路仿真与绘图能力的前提下，加三层可维护的扩展结构，并给 AI 提供可读写的电路对象模型。

> 上游基线：`e952e78` / `5.0.3ts` / 全 TypeScript + Vite（无 Java/GWT）。
> 许可证：GPL-2.0-or-later（见 `core/COPYING.txt`；上游 `ts/package.json` 的 ISC 标注不作数）。

**在线演示**：由 `.github/workflows/pages.yml` 部署到 GitHub Pages，具体域名在仓库的
Pages 设置里配置——仓库与产物都不绑定域名（`dist/` 里不含 CNAME，构建脚本不读任何站点地址）。
挂在子路径（`/<repo>/`）或自定义域根路径下都能跑，见下方「静态部署」。

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

# 6) 接 AI 助手：MCP stdio 服务器（宿主拉起，自己管 dev server + 浏览器）
node tools/ext.mjs mcp --help
```

`doctor` 会检查：Node 版本、core.lock 与源码版本一致、cover manifest 文件齐全、插件 manifest、373 个语料 fixture。

## 静态部署（GitHub Pages 等）

`node tools/ext.mjs build` 的 `dist/` 就是一个**可以直接挂在任意子路径**下的静态站，不需要改 `base`：

- 构建收尾（`cover/vite.cover.config.ts` 的 `finalizeForHosting`）会把 HTML 里的绝对 `href/src`、`circuit/manifest.json` 的 `start_url`/图标全改成相对路径，并补上 `index.html`（站点根直接进仿真器）、`favicon` 引用、`.nojekyll`；
- 插件根不是 bundle 同级目录，`cover/ts/ExtPluginHost.ts` 用 `document.baseURI` 推 `plugins/`，所以在 `/<repo>/plugins/` 下也能加载；
- `service-worker.js` 由构建从上游 `core/ts/service-worker.template.js` 生成（上游这一步在 `dist.sh` 里），首访会预缓存约 425 个文件 / 3.3 MB，之后可离线打开。

GitHub Pages 由 `.github/workflows/pages.yml` 负责：`main` 每次推送都构建并 deploy（首次使用需在仓库 **Settings → Pages → Source** 选 “GitHub Actions”）。`ci.yml` 也会把两平台的 `dist/` 作为 artifact 保留 7 天，方便直接下载静态包。

## 站点配置（标题 / 关于页 / 描述）

改 `cover/site.config.json` 一个文件即可，`dev` 和 `build` 走同一套逻辑，**dev 下改完刷新页面就生效**（不用重启）：

| 字段 | 作用 | 缺省值（= 上游原样） |
|---|---|---|
| `title` | 运行时标题基名，标签页显示 `<电路名> - <title>` | `Circuit Simulator` |
| `htmlTitle` | 静态 `<title>`（首屏、SEO、分享卡片） | `CircuitJS` |
| `description` | `<meta name="description">`，留空则不注入 | `""` |
| `homeurl` | 关于页底部的「返回主页」链接，留空则不显示 | `""` |
| `about.heading` | 关于页自定义内容的小标题 | `""` |
| `about.html` | 关于页自定义内容（原样插入的 HTML） | `""` |

几条规则：

- **关于页的自定义内容插在正文最前面**，上游的 GPL 与第三方许可声明原样保留在下面——那是许可证要求，不能被自定义内容顶掉。
- 全部留空时，产物与上游**逐字一致**（入口 HTML 只多一个 `data-ext-site-title` 属性），所以这个文件同时是「什么都不配就照旧」的开关。
- `title`/`htmlTitle`/`description`/`homeurl`/`about.heading` 都做 HTML 转义；`about.html` 不转义（它就是给你写 HTML 的）。
- **这里不写域名。** 站点挂在哪个域名、用不用 CDN，属于部署侧的事，程序与产物都不应该知道。

实现上是一个 cover 层插件（`extSiteConfig`）：dev 用中间件拦入口 HTML 与 `circuitjs/about.html`，build 在 `finalizeForHosting` 里落到 `dist/`。同一处还负责补回 `cover/public/ext-cover.css` 的 `<link>`——那个文件是 A05 的影子覆盖样例，原先手写进 core 的 HTML，上游一同步就丢，现在每次由插件补。


## 接 AI 助手（MCP）

`node tools/ext.mjs mcp` 是一个标准 **MCP stdio 服务器**（换行分隔 JSON-RPC），任何 MCP 宿主
（Claude Desktop / Codebuddy / Cursor…）配一段命令即可：

```json
{
  "mcpServers": {
    "ext-circuitjs": {
      "command": "node",
      "args": ["<仓库绝对路径>/tools/ext.mjs", "mcp"]
    }
  }
}
```

宿主拉起后它**自己管后端**：探活 dev server（不可达就拉起，退出时回收进程树）→ headless Chrome 打开页面
→ 注入页面桥 → 工具调用落在同一活电路上。握手阶段不起浏览器；找不到浏览器时错误以工具结果返回，不会让
服务器启动失败。工具面 11 个：读网表 / 载入 / 列元件 / 改参数 / `sim.step`（确定性推进）/ run / stop / reset /
读测量 / 读 scope / 截图。

细节、宿主配置的可选项与排障见 [docs/mcp.md](docs/mcp.md) §6。

## 现在能跑什么（v0.1.4）

| 能力 | 状态 | 入口 |
|---|---|---|
| 覆盖层构建/热更新/类型检查 | ✅ | `cover/vite.cover.config.ts` |
| Boot 暴露 window.ExtCircuitJS | ✅ | `cover/ts/ExtBoot.ts` |
| API：读网表 / 列元件 / 测量 / 改参数 / 载入电路 | ✅ | `cover/ts/ExtApi.ts` |
| 插件：activate / deactivate / 热重载 / 失败回滚 / 命令 / 面板 | ✅ | `cover/ts/ExtPluginHost.ts、packages/plugin-api` |
| 插件自定义元件（类 + 存档类型 + 菜单 + 卸载，`ctx.element`） | ✅ | `cover/ts/ExtElements.ts`、`plugins/ext-element` |
| 插件打开/保存钩子（可改写存档文本，带来源标记，`ctx.hook`） | ✅ | `cover/ts/ExtHooks.ts`、`plugins/ext-hook` |
| 元件交互事件（`select` / `elemclick`，`ctx.on`） | ✅ | `cover/ts/ExtElementEvents.ts` |
| 插件能力权限（声明 → 运行期强制 → lint 同口径 + 站点策略） | ✅ | `packages/plugin-api/permissions.json`、`cover/ts/ExtPluginHost.ts` |
| 网表导出（引擎 nodeList 权威）+ 稳定 id + set/delete ops | ✅ | `packages/netlist` |
| 紧凑编码（聚合 0.26× XML）+ registry 再生成 CLI | ✅ | `packages/netlist/src/compact.ts；ext netlist registry/bench` |
| add between nets（导线分裂增量放置，自校验回滚） | ✅ | `packages/netlist/src/place.ts` |
| 菜单插槽（把自定义元件挂进 Draw/右键菜单） | ✅ | `cover/ts/ExtMenus.ts` |
| MCP：stdio 服务器 + 会话 RPC + WebSocket 桥 + 11 工具 | ✅ | `node tools/ext.mjs mcp`、[docs/mcp.md](docs/mcp.md) §6 |
| 静态部署（任意前缀）+ 站点配置（标题/关于页） | ✅ | `dist/`、`cover/site.config.json` |
| CI（Windows+Ubuntu：doctor/build/lint/scan + Node 契约） | ✅ | `.github/workflows/ci.yml` |
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

写一个「能用的」自定义元件不需要碰 core，一个 `ctx.element.register` 就把
类、存档类型（文本 + XML）、Draw/右键菜单一起登记好，卸载时四样一起撤：

```js
// plugins/my-plugin/index.js
export async function activate(ctx) {
    const Base = ctx.element.base("ResistorElm");        // 插件不能 import core，基类从这里拿
    const dumpType = ctx.element.freeDumpType();          // 190 起的空号
    class ShuntElm extends Base {
        constructor(xa, ya, xb, yb, f, st) {
            super(xa, ya, xb, yb, f, st);
            if (xb === undefined) this.resistance = 0.5;   // 放置时用 0.5Ω，存档读入时保留文件值
        }
    }
    ctx.element.register({ className: "ShuntElm", ctor: ShuntElm, dumpType, label: "Add Shunt (0.5Ω)" });
}
```

「打开 / 保存」也有出口了：`ctx.hook` 包住 `loader.readCircuit` 与 `app.dumpCircuit`，
能看见并改写存档文本（格式扩展、旧档迁移、注释持久化都靠它）。两个纪律写进了类型注释，
示例插件 `plugins/ext-hook` 完整演示：

```js
const MARK = "<!-- ext:1 -->";
ctx.hook("load", (text) => text.includes(MARK) ? text.replace(MARK, "").trimEnd() : text);  // 自己写的格式，无条件认得
ctx.hook("save", (text, meta) => {
    if (meta.source !== "document") return text;   // 撤销/恢复/比较的内部序列化：别插手
    return text.replace(MARK, "").trimEnd() + "\n" + MARK + "\n";   // 幂等：先删再加
});
```

元件交互同样有事件：`ctx.on("select", ({ count, elms, ids }) => …)`、
`ctx.on("elemclick", ({ elm, index, type, grid }) => …)`——"选中元件显示扩展信息"这类需求
不必再轮询 `listComponents()`。

### 权限（permissions）

插件用到哪一面，就得在 `plugins.manifest.json` 的 `permissions` 里声明。运行期强制、
`ext plugin lint` 也查同一份表（`packages/plugin-api/permissions.json`）：

| 权限 | 对应的 ctx 面 | 说明 |
|---|---|---|
| `sim.observe` | `ctx.on(...)` | 订阅 analyze / update / timestep / svgren / select / elemclick |
| `sim.control` | `ctx.api` | 读写网表与元件、改参数、载入电路、控制仿真 |
| `ui.command` | `ctx.command(...)` | 命令面板条目 |
| `ui.panel` | `ctx.panel(el)` | 右侧栏面板节点 |
| `ui.menu` | `ctx.element.register({ menu: true })` | Draw / 右键菜单条目（`menu: false` 不需要） |
| `element.register` | `ctx.element.*` | 元件类与存档类型 |
| `document.hook` | `ctx.hook("load"\|"save", ...)` | 打开 / 保存时改写存档文本 |

```js
// plugins/my-plugin/index.js
export async function activate(ctx) {
    if (!ctx.permits("document.hook")) return;   // 站点可能按策略关掉了这一面：降级而不是崩
    ctx.hook("save", (text, meta) => (meta.source === "document" ? migrate(text) : text));
}
```

没声明就调用会**当场抛** `ExtPermissionError`（`code: "ext/eperm"`），`denial` 区分
`undeclared`（作者漏写）/ `denied-by-policy`（站点拦的）/ `unknown`（名字拼错）；
`plugins.list()` 里能看到每个插件实际拿到的 `permissions`、被拒的 `denied` 与 `warnings`。
部署侧想关掉某一面，在 manifest 顶层写 `"policy": { "denyPermissions": ["document.hook"] }`
——策略只能做减法，不能凭空授予。

⚠ **这不是沙箱**：插件仍是同源 ESM，拿得到 `window`。permissions 管的是"经由 `ctx` 用到哪一面"，
作用是把能力显式化、让漏声明在激活现场或构建期就报错、让站点能收紧。真隔离要等 B08（Worker/iframe）。

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
