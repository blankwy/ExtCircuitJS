# Wiki 首页

**ExtCircuitJS** —— 基于 [CircuitJS1](https://github.com/pfalstad/circuitjs1) 的二开电路仿真器：
保留上游全部仿真与绘图能力，并加上**网表读写**、**网表→电路编译器**、**MCP 服务**（让 AI 直接操作电路）与**插件系统**。

> GPL-2.0-or-later · 上游基线 `e952e78` / `5.0.3ts` · 全 TypeScript + Vite

---

## 快速开始

```bash
git clone https://github.com/blankwy/ExtCircuitJS.git
cd ExtCircuitJS
npm install --prefix core/ts
node tools/ext.mjs build
node tools/ext.mjs serve      # 打开 http://127.0.0.1:8080/
```

> ⚠️ 不能双击 `dist/index.html` —— 产物是 ES module，浏览器禁止 `file://` 加载模块（CORS）。
> 用上面的 `ext serve`，或任何静态服务器。

---

## 文档

| 文档 | 内容 |
|---|---|
| **[使用指南](使用指南)** | 安装运行、界面、网表读写、MCP 接入、插件管理、外观主题、常见问题 |
| **[分享电路](分享电路)** | **链接分享（最轻）/ 分享页 / 单文件离线 HTML**；命令行与界面用法、长度限制、AI 自动化链路 |
| **[开发指南](开发指南)** | 架构、目录结构、构建调试、覆盖层机制、网表/MCP 子系统、测试体系、CI、上游同步 |
| **[插件开发](插件开发)** | 五分钟写插件、清单字段、ctx 能力全景、权限系统、生命周期、自定义元件、文档钩子、Worker 模式 |
| **[内置插件](内置插件)** | 10 个自带插件的功能详解（含主题、分享、Worker 示例） |

---

## 核心能力一览

| 能力 | 说明 |
|---|---|
| 电路仿真与绘图 | 完全沿用上游（子电路、示波器、DC 分析、导入导出…） |
| **网表读写** | 引擎对象 → 语义 JSON（`netlist/0.1`），三种格式分工：XML 存档 / 语义 JSON 读 / 紧凑 JSON 省 token（约 0.26× XML） |
| **稳定 id** | 元件 id `e1..eN`，编辑后未受影响的元件 id 不变 |
| **ops 补丁写** | `set` / `delete` / `probe` / `add`（增量放置：导线分裂 + 正交补线 + 自校验回滚） |
| **网表 → 电路编译器** | 无坐标也能重建电路：自动布局 + A* 绕障布线 + 拓扑硬闸（不一致即回滚） |
| **MCP 服务** | 会话式 RPC，11 个工具，AI 可直接读网表/改参数/步进/测量/截图 |
| **插件系统** | 热重载、fiber 生命周期、权限声明、Worker 隔离、自定义元件/菜单/面板/命令/钩子 |
| **主题** | 深色/浅色切换、新拟态风格（均以插件形式提供，不改 core） |

---

## 仓库结构

```
core/      上游 CircuitJS1（只读，pinned commit）
cover/     覆盖层：影子覆盖 + 新增文件 + 插件宿主
plugins/   运行期插件
packages/  netlist · plugin-api · mcp
tools/     ext CLI（doctor/dev/build/serve/cover/plugin/netlist/mcp）
tests/     契约测试（Node + 真实 Chromium）
```

详见[开发指南](开发指南)。

---

## 常用命令

```bash
node tools/ext.mjs doctor       # 环境自检
node tools/ext.mjs build        # 构建到 dist/
node tools/ext.mjs dev          # 开发服务器（热更新）
node tools/ext.mjs serve        # 静态服务 dist/
node tools/ext.mjs mcp          # MCP stdio 服务器（给 AI 宿主）
node tools/ext.mjs plugin lint  # 插件静态检查
node tools/ext.mjs cover status # 覆盖层状态
```
