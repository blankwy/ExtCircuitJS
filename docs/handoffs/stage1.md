# Stage 1 handoff（2026-10-25）

> 进行中：按卡逐步追加证据段；全部完成后补下方五行总结。

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

