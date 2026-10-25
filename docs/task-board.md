# 任务板（D1–D7，可直接拆给 agent）

> 规则：一张卡 = 一个写作用域 = 一次 smoke 验收。**没有验收命令的卡不许开工。**
> 模型：`F` = GLM-5.3-Flash（免费 2 亿）、`G` = GLM-5.3（免费 3 亿）、`D` = DeepSeek-V4.1-Flash（自费，只用于门禁/仲裁）。
> 预算单位：万 token（估算，D2 后按实际校准）。

## 总览

| ID | 轨道 | 任务 | 写作用域 | 模型 | 依赖 | 验收 | 预算 |
|---|---|---|---|---|---|---|---|
| A01 | A | 基线三连（doctor/build/browser）跑通并留证据 | — | F | — | `node tools/ext.mjs doctor && node tools/ext.mjs build && node tests/contract/boot.browser.mjs` | 2 |
| A02 | A | `ext cover status/scan` 跑通；manifest 的 forkPointBlob 与 core 一致 | `tools/`、`cover/cover.manifest.json` | F | — | `node tools/ext.mjs cover status` 退出 0 | 3 |
| A03 | A | `core sync` 自动化：clone 到 `build/upstream` + 调 scan | `tools/ext.mjs` | G | A02 | 用假上游（改一个文件）跑出 `upstream-changed` | 6 |
| A04 | A | CI（GitHub Actions）：build + plugin lint + cover scan | `.github/` | F | A02 | 首绿 | 4 |
| A05 | A | cover/public 覆盖验证（新增静态文件 + CSS 变量） | `cover/public/` | F | — | dev 命中 + dist 存在（`cover-overlay.json`） | 3 |
| A06 | A | 菜单插槽：`Menus.ts` 注入点（不改生成物） | `cover/ts/Menus.ts`、`cover.manifest.json` | G | A02 | 自定义元件出现在 Add 菜单（浏览器断言） | 8 |
| A07 | A | ElementFactory 注册/注销/冲突契约测试 | `tests/contract/element-factory.test.mjs` | F | — | 三条断言：注销后 create=null；跨 owner 抛错；listClasses 含核心类 | 4 |
| B01 | B | Fiber 单测：LIFO、幂等、late dispose 立即执行 | `tests/contract/fiber.test.mjs` | F | — | `node --test` 全绿 | 3 |
| B02 | B | 事件多路复用：3 插件同时挂 analyze 都收到 | `tests/contract/events.test.mjs` | F | — | 计数 3；抛错插件不影响其余 | 4 |
| B03 | B | 命令插槽 + 冲突拒绝 | `cover/ts/ExtPluginHost.ts` | F | B02 | 第二插件抢同 id 被拒；卸载后命令回基线 | 4 |
| B04 | B | 面板插槽 + DOM 卸载清理 | `cover/ts/ExtPluginHost.ts` | F | — | 卸载后 `verticalPanel` 子节点数回基线 | 3 |
| B05 | B | 热重载：`?rev=` 换版本、旧 fiber 全释放 | `cover/ts/ExtPluginHost.ts` | G | B03 | reload 后 state=ready、旧 command 不可见 | 5 |
| B06 | B | lint 扩展：禁 `import "../core`、`eval`、裸 `document.write` | `tools/ext.mjs` | F | — | 对样例插件报错、对 hello 放行 | 4 |
| B07 | B | 示例插件 ×3（panel/command/event 各一） | `plugins/` | F | B03/B04 | 三插件同时启停，`plugin lint` 通过 | 5 |
| B08 | B | （可选）Worker 模式：不可信插件走 postMessage | `cover/ts/ExtPluginWorker.ts` | G | B07 | 一个 Worker 插件能读网表/回传测量 | 10 |
| C01 | C | registry 生成接 CLI：`ext netlist registry` | `tools/`、`packages/netlist/` | F | — | 重生成后 diff 为空；255 类/143 txtType | 5 |
| C02 | C | 导出保真：373 语料逐例对拍元件数/引脚数 | `tests/contract/netlist-export.*` | G | C01 | 元件数 100%、引脚数 ≥93.8%（基线） | 8 |
| C03 | C | ops：set/delete 行为 + 错误语义 | `packages/netlist/src/index.ts` | F | — | 未知 target/prop 返回结构化错误，不抛断 | 3 |
| C04 | C | ops：add between nets（增量放置） | `packages/netlist/src/place.ts` | G | C03 | 在两个网络间加电阻后：引脚数 +2、net 数不变、可仿真 | 15 |
| C05 | C | 紧凑编码 + token 基准脚本 | `packages/netlist/src/compact.ts` | F | C02 | 紧凑 ≤0.35× XML；输出基准 JSON | 5 |
| C06 | C | 稳定 id（WeakMap）设计 + 导出携带 | `packages/netlist/src/ids.ts` | G | C02 | 编辑后未受影响元件 id 不变 | 5 |
| C07 | C | 幂等契约：export → load XML → export 差异为空 | `tests/contract/netlist-roundtrip.*` | F | C02 | 逐例 diff = 0 | 5 |
| D01 | D | MCP 会话 RPC 接口 + 假实现 | `packages/mcp/src/` | F | — | 单测：open/load/step/measure/close 顺序 | 4 |
| D02 | D | WebSocket 桥（页面内）+ Node 客户端 | `cover/ts/ExtMcpBridge.ts`、`packages/mcp/` | G | D01 | 浏览器内 echo 通；会话存活 | 10 |
| D03 | D | 工具集（attach 模式） | `packages/mcp/src/tools.ts` | F | D02 | 5 个工具可调用并返回结构化 JSON | 8 |
| D04 | D | 闭环 demo：读 → 改电阻 → 跑 2ms → 读电压 | `examples/ai-loop.mjs` | F | D03 | 一条命令输出前后电压对比 | 4 |
| D05 | D | MCP 文档 + 教程 | `docs/mcp.md` | F | D03 | 新人 30 分钟跑通 | 3 |
| G1 | 门禁 | D3：seam + ExtBoot 全绿 | — | D | A01 | build + browser test 通过 | 5 |
| G2 | 门禁 | D5：ops 闭环 | — | D | C03 | set→run→measure 数值变化合理 | 4 |
| G3 | 门禁 | D7：三轨汇合（cover/plugin/netlist） | — | D | B07/C04 | 三套 smoke 全绿、无 console error | 6 |
| G4 | 门禁 | D10：MCP 全链路 | — | D | D04 | 外部 MCP 客户端跑通 demo | 5 |

## D1–D2 的六张详细卡（照抄即可）

### A01 基线三连
```md
- 模型：F ｜ 预算：2 万 ｜ 写作用域：无（只跑命令，禁止改文件）
- 目标：确认当前仓库可构建、可启动、契约测试通过
- 步骤：
  1) node tools/ext.mjs doctor
  2) node tools/ext.mjs build
  3) node tools/ext.mjs dev --port 5174（后台）
  4) node tests/contract/boot.browser.mjs
- 验收：doctor 全 PASS；build ok；browser 输出 "ok": true、netlist.components>0、ops.applied=1
- 如果失败：只贴日志 + 复现命令，不改代码
```

### A02 cover 状态与 manifest 一致性
```md
- 模型：F ｜ 预算：3 万 ｜ 写作用域：cover/cover.manifest.json（仅 forkPointBlob/anchors）
- 目标：manifest 与 core 现状一致，scan 退出 0
- 验收：node tools/ext.mjs cover status ; echo exit=$?
        node tools/ext.mjs cover scan --json build/cover-scan.json
- 禁止：改 core/；改 scan 判定逻辑
```

### B01 Fiber 单测
```md
- 模型：F ｜ 预算：3 万 ｜ 写作用域：tests/contract/fiber.test.mjs
- 用例：dispose 逆序；重复 dispose 幂等；dispose 后 add() 立即执行；signal.aborted=true
- 验收：node --test tests/contract/fiber.test.mjs
```

### C03 ops 错误语义
```md
- 模型：F ｜ 预算：3 万 ｜ 写作用域：packages/netlist/src/index.ts
- 目标：unknown target / unknown prop / add(not implemented) 都返回 {ok:false, unsupported[]}，不抛断
- 验收：node --test tests/contract/ops.test.mjs（测试由本卡一并写）
```

### C04 add between nets（最难的一张，先设计后实现）
```md
- 模型：G ｜ 预算：15 万 ｜ 写作用域：packages/netlist/src/place.ts
- 输入：docs/format-strategy.md §5；core/ts/WireElm.ts:240 split()；:263 draggingDone()
- 目标：在 net A/B 上各找一个可分裂点，split 导线，放置元件（端点 ≥32px、网格对齐），必要时补正交导线
- 验收：lrc.txt 上 between ["GND","n1"] 加 1k 电阻后：
        components +1、nets 数不变、sim 能跑 10 步、无 console error
- 禁止：整电路自动布局；改 core
```

### D01 MCP 会话 RPC 接口
```md
- 模型：F ｜ 预算：4 万 ｜ 写作用域：packages/mcp/src/index.ts
- 目标：定义 Session/Transport 接口 + InMemory 假实现；单测覆盖顺序与错误
- 验收：node --test tests/contract/mcp-session.test.mjs
- 注意：真正的浏览器桥是 D02，不要在本卡里连浏览器
```

## 卡外事项（Lead 自己处理，不派给 worker）

- 接口变更（manifest schema / ctx / netlist schema / MCP 工具名）：`D`
- 覆盖层同步上游：`D`（跑 `core sync` + `cover scan` + 契约回归）
- 测试断言修改：`D`（worker 不许改测试）
- 发布 / 版本号 / README 的战略段落：`D`
