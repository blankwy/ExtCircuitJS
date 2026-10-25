# Stage 1 handoff（2026-10-25）

- 做了什么：A01 基线三连全绿（doctor/build/boot.browser）；A02 cover 状态干净（status/scan 退出 0，local-only=6 无冲突）；A05 cover/public 静态覆盖验证（ext-cover.css CSS 变量，dev 命中 + dist 存在）；A07 ElementFactory 契约测试三条断言全绿 + ts-resolve 测试基座。
- 证据：见下方各卡证据段（doctor 全 PASS / build ok / browser `ok:true, components:7, ops.applied:1`；cover `local-only=6, conflicts:0`；`GET /ext-cover.css → 200` 且页面计算值 `--ext-accent:#4a7dbe`；`dist/circuitjs/ext-cover.css` 存在、`cover-overlay.json` 记录 `ext-cover.css`；`node --test` 3 pass 0 fail）。
- 卡在哪：无阻塞。两个非阻塞观察（见 observations）：① coverOverlay 的 dev URL 与 dist 产物路径相差一个 assetsDir 层级（放置约定按 dist 侧对齐，已记录）；② dev server 为上次会话遗留进程（配置一致，已复用）。
- 下一步：Stage 2（网表读写闭环，C01 → … → G2），用 dynamic workflow 派 F/G 卡；Stage 3 的 Node 单测直接复用 tests/contract/helpers/ts-resolve.mjs。
- 消耗：Lead（GLM-5.3）直做，估算 <10 万 token；F/G worker 未动用。

## A01 基线三连（只读验证，无代码改动）

环境：Windows / node v24.18.0 / core.lock e952e788a413（5.0.3ts）。dev server 复用上次会话遗留进程（PID 38636，`vite --config cover/vite.cover.config.ts --port 5174`，配置与 `ext dev` 完全一致）。

```
$ node tools/ext.mjs doctor          → EXIT=0
  PASS  node >= 22  24.18.0
  PASS  core/ts/package.json
  PASS  core/ts/node_modules
  PASS  core.lock.json  e952e788a413
  PASS  core version matches lock  src=5.0.3ts lock=5.0.3ts
  PASS  cover manifest (6 entries)   overrides=2 adds=4 core=5.0.3ts
  PASS  plugins manifest (1)
  PASS  contract corpus  373 xml
  all checks passed

$ node tools/ext.mjs build           → EXIT=0
  ✓ 272 modules transformed
  dist/circuitjs.html                        0.66 kB
  dist/circuitjs/circuitjs--wuhdAF1.css      6.75 kB
  dist/circuitjs/circuitjs-DDGkSwQY.js   1,335.42 kB
  [ext] build ok -> <repo>/dist

$ node tests/contract/boot.browser.mjs   → EXIT=0   (base http://127.0.0.1:5174)
  "ok": true,  "version": "5.0.3ts",
  netlist: { "components": 7, "nets": 5, "schema": "netlist/0.1", "unsupported": 0 },
  ops:     { "ok": true, "applied": 1 },        // set c0.resistance=2200
  lifecycle: reload/deactivate/reactivate 全部 ready→0→ready，errors=[]，consoleErrors=[]
```

期望全部满足：doctor 全 PASS；build ok；browser `ok:true`、`components=7>0`、`ops.applied=1`。

## A02 cover 状态（只读验证，manifest 未动）

```
$ node tools/ext.mjs cover status      → EXIT=0
  local-only  overridden  ts/main.ts            cover/ts/main.ts            3/3  core
  local-only  overridden  ts/ElementFactory.ts  cover/ts/ElementFactory.ts  2/2  plugin
  local-only  added       ts/ExtBoot.ts / ExtApi.ts / ExtPluginHost.ts / ExtEvents.ts
  summary: local-only=6    conflicts: 0  anchorWarnings: 0

$ node tools/ext.mjs cover scan --json build/cover-scan.json   → EXIT=0
  counts: { "local-only": 6 },  conflicts: 0,  anchorWarnings: 0
  两条 override 的 anchors 全部 ok:true（main.ts 3/3，ElementFactory.ts 2/2）
  无 upstream-changed / orphan / both-changed / anchor-broken
```

状态干净：upstream 未接入（`upstream: null`，本阶段按 local-only 基线判），manifest 无需调整。

## A05 cover/public 覆盖验证（新增 `cover/public/ext-cover.css`）

文件：`cover/public/ext-cover.css`（`:root { --ext-accent: #4a7dbe; }` 一条 CSS 变量覆盖；core 的 style.css 未使用 CSS 自定义属性，扩展主题变量由本层引入）。

放置约定（踩坑记录）：coverOverlay 的约定是 `cover/public/<rel>` 按 rel 影子覆盖——dev 由中间件在 `/<rel>` 优先返回、build 拷入 `dist/circuitjs/<rel>`（与 core public 资产同命名空间）。最初放在 `cover/public/circuitjs/` 子目录导致 dist 出现双层 `circuitjs/circuitjs/`，已移回根下。

```
dev 命中（文件仅存在于 cover/public，命中即证明走 overlay 中间件）：
$ curl -s -i http://127.0.0.1:5174/ext-cover.css
  HTTP/1.1 200 OK / Content-Type: text/css; charset=utf-8
  :root { --ext-accent: #4a7dbe; ... }
$ curl http://127.0.0.1:5174/circuitjs/ext-cover.css   → 404（旧嵌套路径已消失，中间件按精确路径服务）

页面级验证（circuitjs.html 内动态挂载后读回计算值，真实 Chromium）：
  { "href": "http://127.0.0.1:5174/ext-cover.css", "loaded": true, "rules": 1, "extAccent": "#4a7dbe" }

dist 存在（重建后）：
  dist/circuitjs/ext-cover.css        （与源文件逐字节一致）
  dist/cover-overlay.json             "publicOverlay": [ "ext-cover.css" ]
```

注：dev URL 是 `/ext-cover.css`，而 dist 以根目录静态服务时同一文件在 `/circuitjs/ext-cover.css`——两者相差一个 assetsDir 层级，是 coverOverlay 原型（spike B）既有设计，本阶段不改 tools/（超出写作用域），已记入 observations.md。

## A07 ElementFactory 契约测试（新增 `tests/contract/element-factory.test.mjs` + `tests/contract/helpers/ts-resolve.mjs`）

三条断言（对应 task-board A07）：注销后 `create` 返回 null（注销前可创建、卸载隔离性）；跨 owner 注销抛错且无副作用；`listClasses` 含核心类（owner=core 注册可见）。`node --test tests/contract/element-factory.test.mjs`：

```
✔ 注销后 create 返回 null（deregister → create=null，注销前可创建）
✔ 跨 owner 注销抛错（plugin-b 不能注销 plugin-a 注册的类型）
✔ listClasses 含核心类（owner=core 注册后可见且有序）
ℹ tests 3  pass 3  fail 0        EXIT=0
```

测试基座范式（Stage 3 fiber/events 单测复用）：仓库 tsc 均 noEmit、无独立编译产物，Node 侧加载 cover TS 用 `tests/contract/helpers/ts-resolve.mjs`（`node:module` resolve hook：补 `.ts` 扩展名 + cover→core 镜像回落，只在默认解析失败时介入）；Node ≥23.6 原生剥离类型，测试内动态 `import("../../cover/ts/X.ts")` 即可。"核心类"用 `registerClass` 默认 owner="core" 的规范类名代表——registerElements.ts 依赖全部元件模块（DOM 环境），Node 侧不导入。

## 收尾复核（全部验收命令在最终状态重跑）

```
doctor 退出 0（全 PASS）｜cover status 退出 0｜node --test element-factory 退出 0（3 pass）
boot.browser：ok=true, components=7, ops.applied=1, EXIT=0
```

提交：A01 cd9f175 / A02 8ce13f8 / A05 97e577c / A07 6b491c5 / 收尾（本文件 + observations）见 git log。


