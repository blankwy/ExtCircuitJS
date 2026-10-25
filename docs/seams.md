# 最小 seam（poke 面）清单 v1

> 目的：把"要改上游"的地方压到最小、可审计、可同步。
> 结论先说：**只需要 1 个整文件覆盖（`main.ts`，58 行）+ 2 个极小影文件（可选）+ 若干实例级包装**。`CirSim.ts` / `UIManager.ts` / `CircuitLoader.ts` 这些热点文件**一个都不用覆盖**。
> 所有行号基于上游 `e952e78`（5.0.3）。

---

## 0. 总览

| 编号 | 手段 | 目标 | 改动量 | 是否必需 | 上游同步成本 |
|---|---|---|---|---|---|
| **S1** | 整文件覆盖（L3） | `ts/main.ts` | +2 行（`await ExtBoot(app)`） | ✅ 必需 | 极低（58 行、极少变） |
| **S2** | 实例级包装（L0） | `app.jsInterface.call*Hook`、`app.importCircuitFromText`、`app.loader.readCircuit` | 0 覆盖 | ✅ 必需 | 零 |
| **S3** | 微影（L3，40 行） | `ts/ElementFactory.ts` 加 `deregisterClass/listClasses/hasConflict` | +15 行 | 推荐 | 极低 |
| **S4** | 无覆盖（L0） | `CommandPaletteRegistry` 的卸载/归属记账 | 0 覆盖 | 可选 | 零 |
| **S5** | 微影（L3，30 行） | `ts/HookRegistry.ts` 追加结构性钩子 | +N 行 | 暂不加 | 极低 |

**核心洞察**：上游把 `CirSim` 拆成了 manager 组合（`SimulationManager/UIManager/CommandManager/...`），且事件回调走 **实例方法** `this.jsInterface?.callAnalyzeHook()`（`CirSim.ts:315-316`、`:355`）。⇒ 只要拿到 `app`，就能在**实例上**链式包装事件与导入路径，完全不需要改 `CirSim.ts`。

---

## S1 · `ts/main.ts` 覆盖（唯一必需）

上游（`ts/main.ts:1-58`，节选）：

```ts
HookRegistry.createJSInterface = (app: any) => new JSInterface(app);   // :20
await Locale.load();                                                    // :23
…
const app = new CirSim();                                               // :57
await app.init();                                                       // :58
```

覆盖版（唯一差异在末尾）：

```ts
// cover/ts/main.ts —— 与上游逐行一致，只在最后加两行
const app = new CirSim();
await app.init();
await ExtBoot(app);        // ← 唯一差异
```

`ExtBoot(app)` 做四件事（全部在 `cover/ts/ExtBoot.ts`，新文件）：

1. 暴露：`(window as any).ExtCircuitJS = { app, sim: app.sim, version, plugins }`。
2. 事件桥：包装 `app.jsInterface` 的 `callUpdateHook / callAnalyzeHook / callTimeStepHook / callSVGRenderedHook`（见 S2）。
3. 启动插件宿主：读 `plugins/plugins.manifest.json` → 拓扑排序 → `activate`。
4. 装 API facade：`ExtCircuitJS.api`（网表读写、测量、仿真控制，见 `docs/development-plan.md` §3.5）。

**为什么不覆盖 `CirSim.ts`**：28KB 热点文件、上游活跃修改、且 `CirSim` 内部就是 manager 组合，我们真正需要的只是"启动后拿到实例"，`main.ts` 是唯一的组装点，天然适合。

**备选（不推荐）**：
- 影子 `JSInterface.ts`（117 行）在构造函数里存 app —— 文件更大、且 JSInterface 是 API 增长最快的文件。
- 在 `circuitjs.html` 里插一个 `<script>` 用 `Object.defineProperty` 拦截 `HookRegistry.createJSInterface` 赋值 —— 零覆盖但极脆弱，不建议。

**同步护栏**：`cover/ts/main.ts` 记录 anchor `const app = new CirSim();` + `await app.init();`；上游若改启动流程，`ext cover scan` 直接报 `anchor-broken`。

---

## S2 · 实例级包装（零文件覆盖）

上游调用点（已核实）：

| 事件 | 上游调用 | 位置 |
|---|---|---|
| 每帧 | `this.jsInterface?.callUpdateHook()` | `CirSim.ts`（`updateCircuit`/`repaint` 路径） |
| 分析后 | `this.jsInterface?.callAnalyzeHook()` | `CirSim.ts:315` 附近 |
| 每步 | `this.jsInterface?.callTimeStepHook()` | `CirSim.ts:355` |
| SVG 导出后 | `this.jsInterface?.callSVGRenderedHook(svg)` | `JSInterface.ts:102` |

`ExtBoot` 里的包装（示意）：

```ts
function chainEvent(app: any, method: string, fn: () => void) {
  const ji = app.jsInterface;
  if (!ji || typeof ji[method] !== 'function') return () => {};
  const orig = ji[method].bind(ji);
  ji[method] = () => { safe(fn); orig(); };          // 插件先、宿主后
  return () => { ji[method] = orig; };               // 返回 disposer，保证可卸载
}
```

要点：
- **只包装实例，不动原型**（否则污染同类实例）。
- 插件回调必须 `try/catch` 隔离，一个插件抛错不能让宿主回调与仿真停摆。
- 返回 disposer，宿主卸载时还原 —— 这就是"可卸载"的物理基础。

导入拦截（同一套路）：

```ts
const origImport = app.importCircuitFromText.bind(app);
app.importCircuitFromText = (text: string, subs: boolean) => {
  const converted = ExtNetlist.maybeConvert(text);   // JSON → XML；非 JSON 原样返回
  return origImport(converted, subs);
};
const origRead = app.loader.readCircuit.bind(app.loader);
app.loader.readCircuit = (text: string, flags?: number) => origRead(ExtNetlist.maybeConvert(text), flags);
```

覆盖到的入口（已核实）：
- `ImportFromTextDialog.ts:68` → `app.importCircuitFromText`
- `UIManager.ts:795` → `app.importCircuitFromText`
- `JSInterface.ts:55/77` → `app.importCircuitFromText`
- URL/startCircuit 路径 → `loader.readCircuit`（`CircuitLoader.ts:loadCircuitFromUrl`）

⇒ **JSON 导入不需要覆盖 `CircuitLoader.ts`**（12KB 热点）。

---

## S3 · `ElementFactory` 微影（40 行）

上游事实：只有 `registerClass/create/hasClass`，`classMap` 是 `private static`，**无卸载、无枚举、无冲突检测**。

覆盖版只追加：

```ts
export class ElementFactory {
  private static classMap: Map<string, ElmCtor> = new Map();
  private static owners: Map<string, string> = new Map();   // 新增：插件归属

  static registerClass(name: string, ctor: ElmCtor, owner = 'core'): void {
    if (ElementFactory.classMap.has(name) && ElementFactory.owners.get(name) !== owner)
      throw new Error(`element type conflict: ${name} (owned by ${ElementFactory.owners.get(name)})`);
    ElementFactory.classMap.set(name, ctor); ElementFactory.owners.set(name, owner);
  }
  static deregisterClass(name: string, owner?: string): void { /* 校验 owner 后删除 */ }
  static listClasses(): string[] { return [...ElementFactory.classMap.keys()]; }
  static hasConflict(name: string): boolean { return ElementFactory.classMap.has(name); }
}
```

**为什么值得覆盖这 40 行**：插件加自定义元件是核心卖点；没有 `deregister` 就没有"卸载"，插件系统就是假的。备选（零覆盖）是 `(ElementFactory as any).classMap` 直接操作 —— 能跑，但拿不到冲突语义，且依赖私有名。

---

## S4 · 命令卸载（零覆盖）

`CommandPaletteRegistry` 的 `commands / circuitCommands / byId` 都是 **public static**（`ts/CommandPaletteRegistry.ts`），且已有 `addCommand/add/addToggle/clear`。

⇒ 插件宿主自己记账即可，无需覆盖：

```ts
const before = new Set(CommandPaletteRegistry.byId.keys());
const disposer = ctx.effect(() => {
  CommandPaletteRegistry.addCommand(new PaletteCommand({ id, label, category, keywords, custom }));
  return () => {
    CommandPaletteRegistry.byId.delete(id);
    CommandPaletteRegistry.commands = CommandPaletteRegistry.commands.filter(c => c.id !== id);
  };
});
```

（如果上游以后把这些字段改成 private，再升级为微影。）

---

## S5 · `HookRegistry` 扩展（暂不加）

现有 12 个钩子都是"给上游内部用的接线柱"，不是给插件用的 API。v1 用 S1+S2 已足够；只有出现下面这类需求才追加：

- `readCircuitInterceptor`：让所有加载路径（含 URL/CORS）都支持 JSON —— 若 S2 的 `loader.readCircuit` 包装不够用。
- `registerExtraElements`：让 `registerElements.ts` 的生成物在启动后追加注册（不覆盖生成物）。
- `onPluginHostReady`：给插件提供"宿主已就绪"的确定时序。

每加一个钩子都要：写进本文件、加 anchor、加契约测试、`SEAMS.md` 版本 `+0.1`。

---

## 反面清单（写进 CONTRIBUTING）

1. ❌ 覆盖 `CirSim.ts` / `UIManager.ts` / `CircuitLoader.ts` / `CircuitElm.ts`（热点）。
2. ❌ 改类名（`ElementFactory` + `keepNames` 依赖 `this.constructor.name`）。
3. ❌ 覆盖生成物 `registerElements.ts`。
4. ❌ monkey-patch 原型（只 patch 实例）。
5. ❌ 用 `eval` / `new Function` 注入补丁。
6. ❌ 在插件里直接 `import '../core/...'` 内部模块（只允许 `@extcircuitjs/plugin-api` 的类型与 ctx）。

---

## 同步时的检查顺序

```
ext core sync --dry-run     # 拉取上游，生成分类报告（不改工作树）
ext cover scan              # clean / upstream-changed / both-changed / orphan / anchor-broken
ext build && ext test       # 类型检查 + 单测 + 契约（373 语料电气指纹）
ext plugin lint             # 插件静态扫描
```

S1 的 anchor 只有两条，S3 的 anchor 是 `registerClass(name, ctor)` 签名；两者都极其稳定，这是选择它们做主 seam 的原因。
