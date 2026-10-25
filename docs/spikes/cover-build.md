# Spike B：Cover 覆盖层（Vite 影子解析 + 上游更新三方冲突扫描）

**结论：可行。** 上游 `ts/` 全量 TS + Vite(rolldown) 工程里，"按路径镜像覆盖"可以做到**零改动上游源码树**：
一个 `resolveId` 钩子把 `ts/<rel>` 影子解析到 `cover/<rel>`，dev/生产构建/HMR/类型检查四件事全部成立，
`keepNames` 与 `ElementFactory` 的"类名字符串 → 类"链路未被打断。代价是三处必须自己补的胶水：
覆盖文件的相对导入要指回上游、`public/` 静态资源要单独一条中间件+拷贝、`tsc` 需要 `rootDirs` 或物化后才能检查覆盖层。

- 工作副本与原型：`spike/cover-build/`（cover 层、工具、脚本、证据日志）
- 上游参考：`_scratch/core` @ `e952e78`（= master = dev-ts，5.0.3），只读
- 复现：`pwsh -File spike/cover-build/scripts/run-all.ps1`（三个脚本可单独跑）
- 证据日志：`spike/cover-build/evidence/*.log`、`dist/cover-overlay.json`、`build/cover-report.json`

---

## 1. 实测数字（本机 Windows，Node 24.18.0 / npm 11.16.0 / Vite 8.0.14(rolldown) / TS 6.0.3）

| 项目 | 基线（上游原样） | 加 coverOverlay 后 |
|---|---|---|
| `tsc`（noEmit，全工程） | 5.8–6.4 s | 5.8 s（同一份 tsconfig） |
| `vite build` | 0.31–3.1 s（首次含编译缓存差异） | 0.91–1.06 s |
| `tsc && vite build` 合计 | 6.4 s | 8.0–9.6 s |
| 参与打包的模块数 | 261 | 268（+7：cover 的 ResistorElm/ext 模块与重新解析链） |
| 产物 JS | 1184.16 kB（gzip 276.68） | 1187.64 kB（gzip 279.64；+3.5 kB / +2.9 kB gzip） |
| 产物 CSS | 6.75 kB（gzip 2.02） | 6.62–6.77 kB（gzip 2.03，覆盖后的 `style.css` 进包） |
| `dist/` 文件数 / 体积 | 410 个 / 2.62 MB | 412 个 / 2.65 MB（+`cover-public-marker.txt`、+`cover-overlay.json`） |
| `npm test`（vitest，7 文件 68 test） | 3.2 s 墙钟（内部 1.84 s） | 3.2–4.6 s（含 npx 启动开销），全绿；cover 专属测试另跑 1.3 s |
| `tsc -p tsconfig.cover.json`（cover 就地检查） | — | 4.7–6.9 s |
| `tools/cover.mjs status`（5 条 manifest） | — | 0.9 s |
| `tools/cover.mjs apply`（materialize 686+5 文件） | — | 1.1 s（`build/src` 691 文件） |
| dev server 冷启动（5181） | 1.17 s | 1.17 s |

产物结构（上游语义，未变）：`dist/circuitjs.html` + `dist/circuitjs/circuitjs-<hash>.js|css` + `dist/circuitjs/{circuits,locale,images,font,setuplist.txt}`；
覆盖层额外写 `dist/cover-overlay.json`（本次影子命中清单 + public 覆盖清单，CI 可直接断言）。

---

## 2. 必做验证：命令与结果

### 2.1 基线（`scripts/01-baseline.ps1`）

```powershell
# work/ts = _scratch/core/ts 的副本（排除 node_modules）；node_modules 用 junction 指回上游已装依赖
cmd /c mklink /J spike\cover-build\work\ts\node_modules _scratch\core\ts\node_modules
cd spike\cover-build\work\ts
npx tsc          # EXIT 0，5.8–6.4 s
npx vite build   # EXIT 0，0.31–3.1 s，261 modules，dist 2.62 MB / 410 files
npx vitest run   # EXIT 0，7 files / 68 tests，3.2 s
npx vite --port 5181   # dev 起在 5181（本 spike 用 5181，避开队友的 5182/上游默认 5173）
```

> **npm 11 allow-scripts 门控**：本次没有重新 `npm install`。用 junction 复用上游已装好的 `node_modules`（含
> `@esbuild/win32-x64`）绕开 `esbuild@0.28` postinstall 被 allow-scripts 拦掉的风险；这是可复现脚本的选择，
> 也是"机器上有上游克隆"时最省事的做法。全新机器上应 `npm ci && npm approve-scripts esbuild` 后再构建。
> 证据：`evidence/baseline.log`。

### 2.2 coverOverlay()（`scripts/02-verify-overlay.ps1`）

插件接口（原型，`spike/cover-build/tools/coverOverlay.mjs`）：

```ts
coverOverlay({
  coreRoot?: string,        // 上游源码根（默认 process.cwd()）
  coverRoot?: string,       // 覆盖层根（默认 <coreRoot>/../cover）
  coverPublicDir?: string,  // 覆盖层 public（默认 <coverRoot>/public）
  assetsDir?: string,       // 上游 build.assetsDir（默认 'circuitjs'）
  coreAlias?: string,       // 指回上游原文件的别名前缀（默认 '@upstream/'，供薄影子用）
  debug?: boolean           // 打印每次影子命中
}): Plugin
```

解析规则（`resolveId`，`enforce:'pre'`）：

| 请求 | 条件 | 结果 |
|---|---|---|
| `/main.ts`、`/style.css`（root-relative，含 dev 直接 curl 模块） | `ts/<rel>` 存在 | 有 `cover/<rel>` → 返回 cover 绝对路径 |
| `./X`（importer 在上游树内） | `ts/<dir>/X(.ext)` 存在 | 有 `cover/<dir>/X` → 返回 cover 文件 |
| `./X`（importer 在 cover 内） | 先查 `cover/<dir>/X`（新增文件） | 否则查上游；**若上游存在而 cover 不存在 → 必须返回上游绝对路径**（见 6.1 坑） |
| `./X`（上游没有） | `cover/<dir>/X` 存在 | 返回 cover 文件（新增文件被上游代码 import） |
| `@upstream/X` | — | 强制返回上游文件（薄影子基类） |
| `public/<rel>` | `cover/public/<rel>` 存在 | dev：`configureServer` 中间件直出；build：`closeBundle` 拷进 `dist/<assetsDir>/<rel>` |

结果（全绿，证据 `evidence/verify-overlay.log`、`evidence/dev-5181-round1-failed-resolve.log`）：

- **(a) dev 返回覆盖内容**：`curl /ResistorElm.ts` 返回的模块含 `COVER-B` 标记、`coverTag`、`getCoverTag`；
  `curl /registerElements.ts` 里 `./ResistorElm` 已被改写成 `cover/ResistorElm.ts`；`curl /style.css` 命中 cover 副本；
  `curl /cover-public-marker.txt` 由插件中间件直出。dev 日志逐条打印影子命中（`[cover-overlay] ./ResistorElm ... -> ...cover/ResistorElm.ts`）。
- **(b) 生产构建包含覆盖代码**：`dist/circuitjs/circuitjs-*.js` 里 `COVER_MARKER_B` ×1、`coverTag` ×4、`getCoverTag` ×1，
  且 `ResistorElm=class extends` ×1（keepNames 把类名绑定留在产物里）；CSS 产物含 `--cover-marker-b`（注释被压缩器删掉，属正常）；
  `dist/circuitjs/cover-public-marker.txt` 存在；`dist/cover-overlay.json` 记录 `shadowed:["ExtCoverFeatures","ResistorElm.ts","style.css"]`。
- **(c) cover 文件被 tsc 检查**：`npx tsc -p tsconfig.cover.json`（`rootDirs: [".", "../../cover"]`）EXIT 0；
  负例（往 `cover/ExtCoverFeatures.ts` 塞 `const BREAK_ME: number = 'x'`）立刻报
  `../../cover/ExtCoverFeatures.ts(14,14): error TS2322` 且 EXIT 2，恢复后 EXIT 0。
- **(d) HMR**：改 `cover/ResistorElm.ts` 后 dev 日志出现 `[cover-overlay] HMR cover change: ResistorElm.ts modules=1`
  与 `[vite] page reload ...cover/ResistorElm.ts`，重新请求同一 URL 立刻拿到新内容（含 `HMR_PROBE`），恢复后消失。
  改的是 cover 里的真实文件（id 就是该文件），所以走的是 Vite 标准 HMR 图；无 `import.meta.hot.accept` → 整页 reload。
  想更快可以给覆盖模块加 `accept`，但不是必须。

> 应用能启动的**浏览器证据**：dev(5181) 打开 `circuitjs.html` 后 7 个 canvas、7 个菜单项、`window.LZString` 就位、
> 标题变成 `LRC电路 - Circuit Simulator`（已加载示例电路），见 `evidence/dev-5181-app-boot.png`。

### 2.3 keepNames / 类身份安全（`work/ts/cover-overlay.cover-test.ts`）

```powershell
cd spike\cover-build\work\ts
npx vitest run --config vite.cover.config.ts   # 4 tests, EXIT 0
```

断言（全部通过）：`COVER_BUILD_ID === "COVER_MARKER_B"`；`elm.coverTag` 来自覆盖层；`ResistorElm.name === "ResistorElm"`；
`getClassName() === "ResistorElm"`；`ElementFactory.registerClass("ResistorElm", ResistorElm)` 后
`ElementFactory.create("ResistorElm",100,100)` 得到**覆盖后**的实例；`dumpXml` 输出 `r=470` **且** `coverTag=COVER_MARKER_B`
（`x` 等上游属性仍在）。thin 变体另有一份 `cover-thin.cover-test.ts`（3 tests，`vite.cover-thin.config.ts`）。

**为什么没被打断**：`keepNames.mangle` 保留的是类名绑定；本工程产物里是 `ResistorElm=class extends Q{...}`
（见 2.2(b) 的 grep），`this.constructor.name` 仍是 `"ResistorElm"`；`ElementFactory` 的 key 是显式字符串，
与 `getClassName()`/`getDumpType()` 不耦合于压缩后的局部名。覆盖层只要**不改类名、不把类包成箭头函数/匿名类**就安全。

---

## 3. 上游更新三方冲突扫描（`tools/cover.mjs`）

```powershell
node tools/cover.mjs status [--core <克隆根|ts目录>] [--cover <cover根>] [--strict-anchors] [--json out.json]
node tools/cover.mjs scan   --json evidence/scan.json
node tools/cover.mjs apply  --core work\ts [--out build] [--dry-run]
node tools/cover.mjs bless            # 接受一轮 rebase 后，把当前上游/本地重新记为 base
node tools/cover.mjs verify-hashes    # 自校验：Node 的 sha1 与 git hash-object 是否一致
```

退出码：`0` 干净，`1` 有冲突（`both-changed` / `orphan` / added 碰撞 / `--strict-anchors` 下 anchor 缺失），`2` 用法错误。

### 3.1 manifest schema（`cover/cover.manifest.json`）

```jsonc
{
  "version": 1,
  "upstream": { "repo": "pfalstad/circuitjs1", "branch": "dev-ts", "tag": "5.0.3", "commit": "e952e78", "root": "ts" },
  "entries": [{
    "upstreamPath": "ts/ResistorElm.ts",      // 必填，永远以 ts/ 开头（覆盖范围内）
    "localPath": "cover/ResistorElm.ts",      // 必填，cover 根的父目录为基准
    "kind": "overridden",                     // overridden | added
    "owner": "cover-build",                   // 必填（责任到人/模块）
    "reason": "新增字段 + dumpXml 属性",       // 必填（为什么覆盖，评审要看）
    "forkPointBlob": "de5da3e3…",             // bless 写入：fork 时上游 blob
    "localBaseBlob": "de5da3e3…",             // overridden 默认 = forkPointBlob；added 为 null
    "blessedLocalBlob": "9c1f…",              // bless 写入：当次本地快照（审计用，不参与判定）
    "anchors": ["dumpXml(doc: Document, elem: Element): void", "getDumpType(): number"]  // 可选：语义锚点
  }]
}
```

### 3.2 判定表（`base`=fork 点，`ours`=cover 现内容，`theirs`=上游现内容）

| 上表条件 | 状态 | 含义 / 动作 |
|---|---|---|
| theirs 缺文件（overridden） | `orphan` | 上游删/改名 → 人工 |
| theirs≠base，ours==base | `upstream-changed` | 可机械 rebase（`bless` 前先看 anchor） |
| theirs==base，ours≠base | `local-only` | 正常，覆盖层自己的改动 |
| theirs≠base，ours≠base | `both-changed` | 人工三方合并 |
| added 且上游出现同路径 | `both-changed`（collision） | 人工：迁移到新路径或改注册 |
| 全等 | `clean` | 无需动作 |

### 3.3 blob hash 与 anchor

- hash 用 **git blob 语义**（`sha1("blob <len>\0"+content)`），文本先做 **CRLF→LF 归一化**（本仓库 `.gitattributes` 有
  `* text=auto`，否则 Windows 检出的上游文件与 cover 里新写的 LF 文件会互相判成"都改过"）。
  自校验：`node tools/cover.mjs verify-hashes` → Node 计算与 `git -C _scratch/core hash-object` **逐一相同**（2/2；3 个 added 条目上游不存在→ `null`）。
- **anchors（语义锚点，本 spike 增补）**：每条是"上游必须仍然存在的签名文本"，scan 对上游文件做**空白归一化后的子串匹配**，
  不做 AST。当前 5 条覆盖项共 7 个 anchor，全部命中。它的价值是区分两种"上游变了"：
  - 实现变了、签名没变（如 `dumpXml` 里多画一笔）→ `upstream-changed` + anchors 全绿 → 可机械 rebase；
  - 签名变了（`dumpXml` → `dumpXmlEx`、参数表变化、方法被删）→ `upstream-changed`/`both-changed` **且** anchor 缺失，
    status 直接打印 `! ts/ResistorElm.ts: anchor missing -> dumpXml(doc: Document, elem: Element): void`。
  误报率估计：锚点写成**完整 TS 签名**时，格式化/缩进/换行/参数换行都能容忍；会误报的只有"上游重排参数顺序、
  改类型别名、把方法搬进基类"，以及"锚点写得过短（如只写 `dumpXml`）"——后者会把 rename 也判成命中，是漏报而非误报。
  实测：改实现不改签名 → 0 误报；rename `dumpXml`→`dumpXmlEx` → 1/1 命中（`evidence/conflict-scan.log` C 段）。
  **不建议**把 anchor 当唯一判据（它不懂语义），定位是"rebase 时的定位器 + 签名破坏的快速报警"。

### 3.4 模拟上游变更（`scripts/03-conflict-scan.ps1`，把 `work/ts` 复制成 `work/upstream-sim` 再改）

| 场景 | 结果（`evidence/conflict-scan.log`） |
|---|---|
| A 基线 | 5×`local-only`，conflicts 0，EXIT 0 |
| B 上游改被覆盖文件的实现（签名不动） | `upstream-changed`（ResistorElm），其余 local-only，EXIT 0 |
| C 上游把 `dumpXml(...)` 改名 | 仍 `upstream-changed`，anchors 4/5，打印缺失锚点；`--strict-anchors` 时 EXIT 1 |
| D 上游+本地都改 | `both-changed`，conflicts 1，EXIT 1 |
| E 上游删掉 `ts/style.css` | `orphan`（style.css），EXIT 1 |
| F 上游新增 `ts/ExtCoverFeatures.ts`（与 added 撞名） | added 条目 `both-changed`（collision），EXIT 1 |
| G 恢复 | 回到 5×`local-only`，EXIT 0 |
| H/I `apply --dry-run` / `apply` | `files=691 cover=5 conflicts=0`；`build/src/ResistorElm.ts` 是覆盖版（`COVER-B` 命中），`build/src/ExtCoverFeatures.ts` 存在，`build/cover-report.json` 落盘 |

物化后的**权威类型检查**：`build/src`（686 上游 + 5 覆盖，junction 借用 node_modules）跑 `npx tsc` → EXIT 0（6.9 s）。
这是"覆盖后的类与全部上游调用点是否仍然相容"的唯一可信门禁。

---

## 4. 覆盖层写法决策：整文件复制 vs 薄影子（有实验）

**结论：默认整文件复制；薄影子只留给"很小的行为补丁"，并且必须用 `@upstream/` 别名取基类。**

| 维度 | 整文件复制（`cover/ResistorElm.ts` 全量） | 薄影子（`class ResistorElm extends Upstream`） |
|---|---|---|
| 实现 | 复制上游文件 + 就地改 | `@upstream/ResistorElm` 取基类，`extends` + 只写增量 |
| 实验 | vitest 4 tests 通过；`dist` 里 `ResistorElm=class extends` ×1、`COVER_MARKER_B` ×1 | vitest 3 tests 通过；`dist-thin` 里 `ResistorElm=class extends ResistorElm$1{coverTag=…;dumpXml(){super.dumpXml(...)}}` |
| 类身份/keepNames | 安全（类名未变） | 安全（子类仍叫 `ResistorElm`，上游基类被压成 `ResistorElm$1`） |
| 上游更新成本 | 每次上游改这个文件都要看 diff（anchor 帮你定位） | **自动跟随**上游实现，只有增量部分要维护 |
| 覆盖构造逻辑 | 可以直接改构造函数重载/字段初始化顺序 | 不能重写字段初始化顺序；构造重载要靠 `extends` 继承 + `super(...)` 转发，多参重载容易写错 |
| 双类身份风险 | 无 | 有：任何绕过影子（`@upstream/`、动态 `import()` 绝对路径）的模块会拿到**另一份**类，`instanceof` 失效 |
| 适用 | 改动多、要改构造/字段、要整段替换 | 加方法/加 XML 属性/小钩子（≤ 20 行增量） |

建议：**默认整文件复制**（简单、可读、无 `instanceof` 陷阱，配合 anchor + 三方扫描把 rebase 成本压到"看一条 anchor 报警"）；
薄影子作为"小补丁 + 明确的评审规则"的例外。两者都实测不破坏 `ElementFactory` 与 `keepNames`。

---

## 5. 推荐工作流（含 CI 门禁）

1. **日常开发**：`ts/` 永远是只读上游（钉 commit），改功能只改 `cover/`（新增文件或覆盖文件）。
   dev/build 用 App 层派生配置（`vite.cover.config.ts` = 上游配置 + `coverOverlay()`），不复制第二份配置。
2. **上游跟进**（例如每月一次）：`git -C _scratch/core fetch && git checkout <new>`（或换新克隆）→
   `node tools/cover.mjs status --core <新克隆>`：
   - `upstream-changed`：看 anchor 是否全绿；全绿 → 把上游文件重新复制进 cover，重放自己的 diff，`bless` 记账；
   - `both-changed` / `orphan`：人工三方合并（`apply --core <新克隆>` 物化到 `build/src` 后直接 git diff 对比）；
   - 处理完 → `bless` → `status` 必须 EXIT 0。
3. **CI 门禁**（建议按此顺序，任一失败阻断）：
   ```
   npm ci && npm approve-scripts esbuild      # 需要在全新机器交代 esbuild
   node tools/cover.mjs status --strict-anchors   # 0 = 与钉住的上游一致（含语义锚点）
   npx tsc                                    # 上游 gate（cover 专属测试已 exclude）
   npx tsc -p tsconfig.cover.json             # cover gate（就地检查覆盖文件）
   npx vitest run --config vite.cover.config.ts   # cover 类身份/keepNames 回归
   npx vitest run                             # 上游 68 tests
   npx vite build --config vite.cover.config.ts   # 产物里 grep cover-overlay.json 的影子清单
   node tools/cover.mjs apply --core work/ts && (cd build/src && npx tsc)  # 权威合并类型检查（可选，重）
   ```
4. **发布**：上游 `dist.sh`/`dist-offline.sh` 仍然可用（输出 `site/`），只要构建命令换成 cover 配置。
   `dist/cover-overlay.json` 建议一并归档——出问题时可以立刻回答"这个版本覆盖了哪些文件"。

---

## 6. 风险与已知坑（按实测严重度排序）

1. **覆盖文件的相对导入必须由插件显式指回上游**（已修，但这是最大的隐藏坑）。
   第一版只对"上游文件 import 覆盖文件"做了重定向，覆盖文件里的 `./CircuitElm` 交回 Vite 默认解析 →
   Vite 按覆盖文件**物理位置**去 `cover/CircuitElm.ts` 找 → `Internal server error: Failed to resolve import "./CircuitElm"`。
   证据：`evidence/dev-5181-round1-failed-resolve.log`。任何"影子目录"方案都会踩，别指望 Vite 帮你做虚拟目录合并。
2. **rolldown 对 `resolveId` 返回值的处理差异**：本 spike 返回的是**绝对文件路径**（cover 里的真实文件），
   dev/build 均正常；不要返回虚拟 id + `load` 读取（那样会丢 HMR 文件监听与 sourcemap 的相对路径），
   也不要在 `closeBundle` 里 `emitFile`（bundle 已关闭；本 spike 改成直接写 `dist/cover-overlay.json`）。
   rolldown 的 `resolveId` 在依赖预打包（optimizer）阶段也会被调用，日志里能看到它对 `registerElements.ts` 的扫描请求。
3. **`public/` 与静态资源是两套机制**：`copyPublicAssets()` 在 `closeBundle` 手工把 `public/*` 拷进 `dist/circuitjs/`，
   所以覆盖层也必须自己拷（插件按同映射写）。`base:'./'` + `assetsDir:'circuitjs'` 下，**覆盖 CSS 里的相对 `url(images/…)`
   会相对 `cover/` 解析**，dev 会有 `images/hborder.png doesn't resolve` 警告（上游本来也有）；如果覆盖的 CSS 新增了
   相对资源，必须把资源也镜像进 `cover/public/`（或改绝对路径），否则构建产物里 404。
4. **service worker 缓存**：`main.ts` 只在 `import.meta.env.PROD` 注册 SW，`dist.sh` 生成 `service-worker.js` 且
   `base:'./'`。覆盖层换了 bundle hash 不会自动失效旧 SW 缓存的 `circuitjs.html`；发布新版本时要沿用上游的
   版本化目录（`circuitjs81/` 之类）或 bump SW 版本，否则用户会看到"覆盖没生效"的假象。
5. **类名压缩**：`keepNames` 依赖上游 `vite.config.ts` 的 `rolldownOptions.output.minify.mangle.keepNames`；
   **覆盖层绝不能把它关掉**，也不要把类包成匿名类/箭头函数工厂（`const Foo = class extends ...` 不带名字会丢 `name`）。
   建议 CI 加一条断言：`dist/circuitjs/*.js` 里 `ResistorElm=class extends` 至少 1 处（本 spike 已做成脚本检查）。
6. **生成物 `registerElements.ts` 不能覆盖**：它是 `ts/scripts/generateRegistrations.mjs` 的产物，脚本**只 `readdir(ts)`
   根目录、非递归、只收 `*Elm.ts`**，看不到 `cover/`。所以覆盖层新增元件必须：
   ① 在 `cover/registerExtElements.ts` 里手写 `ElementFactory.registerClass("XxxElm", XxxElm)` + `CirSim.theApp.register(...)`；
   ② 在 boot 处调用一次（`CirSim.init()` 里 `registerElements()` 之后；最省事的落点是覆盖一个很小的 `main.ts`，
      在 `await app.init()` 之后调用——`register()` 只写 `dumpTypeMap/xmlDumpTypeMap`，不重建菜单）；
   ③ 想让元件出现在 "Add ..." 菜单里**还要改 `Menus.ts`**：那是硬编码的 `["Add Resistor","ResistorElm", ...]` 列表
      （`Menus.ts:490` 起），不是从注册表生成的。→ 动态插件系统要新增元件，这条路必须给 `Menus` 一个插件式入口
      （覆盖 `Menus.ts` 风险大：文件大且改版频繁；更稳的是给 ElementFactory + 菜单注入留一个 hook）。
      或者干脆走 `apply` 物化后再跑生成器（合并后的树里生成器能扫到新增 `*Elm.ts`），代价是"每次构建都物化"。
7. **`tsc` 的两种覆盖检查各有盲区**：`rootDirs` 方案快（就地、不动源码树），但只证明"覆盖文件自身类型合法"，
   不证明"上游调用点仍与覆盖后的类相容"；后者只有物化后整体 `tsc` 能保证（本 spike 两者都跑了）。
   `tsconfig.cover.json` 还需要 `types: ["vite/client"]`（上游靠 `main.ts` 顶部的 reference 提供 `import.meta.env`，
   而 cover 程序不含 `main.ts`）。另外 cover 专属测试要 `tsconfig.json exclude` + 各自 `test.include` 隔开，
   否则上游 `npm run build`（`tsc`）会因为 `import "./ExtCoverFeatures"` 在 ts 树里找不到而失败。
8. **manifest 的 added 条目与上游新增冲突**只能靠 `both-changed`(collision) 报警；上游**改名**（`FooElm.ts`→`FooElement.ts`）
   会表现为 `orphan`，需要人工把 `upstreamPath` 改掉并 `bless`。目录级移动同理。
9. **Windows 换行**：hash 必须 CRLF→LF 归一化，否则任何 Windows 检出都会让 `both-changed` 假阳性；这一点已用
   `verify-hashes` 与 `git hash-object` 对齐。二进制资源按原字节 hash。

---

## 7. 交付物索引

```
spike/cover-build/
  work/ts/                       上游工作副本（git 无关；node_modules 为 junction）
  cover/                         覆盖层样本（manifest + 2 overridden + 3 added + public 覆盖）
    cover.manifest.json          三方扫描清单（含 anchors）
    ResistorElm.ts               整文件复制覆盖（COVER-B 标记）
    ExtCoverFeatures.ts          新增文件（插件接口落点）
    style.css                    CSS 覆盖样本
    registerExtElements.ts       覆盖层元件注册入口（不碰生成物）
    public/cover-public-marker.txt
  cover-thin/                    薄影子变体（extends @upstream/ResistorElm）
  tools/coverOverlay.mjs         Vite 插件原型（+ .d.mts 类型）
  tools/cover.mjs                scan/status/apply/bless/verify-hashes
  work/ts/vite.cover.config.ts   App 层派生配置（上游配置 + 插件，端口 5181）
  work/ts/vite.cover-thin.config.ts
  work/ts/tsconfig.cover.json    rootDirs 方案的 cover 类型检查
  work/ts/cover-overlay.cover-test.ts / cover-thin.cover-test.ts
  scripts/{00-bootstrap-cover,01-baseline,02-verify-overlay,03-conflict-scan,run-all}
  evidence/*.log                 实测日志（基线/覆盖验证/冲突扫描/失败的第一次解析）
  evidence/dev-5181-app-boot.png 浏览器启动证据
  build/src + build/cover-report.json   apply 物化结果
```
