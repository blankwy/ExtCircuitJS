// Cover 层新增：插件宿主（fiber / effect / dispose / 热重载 / 失败回滚 / 冲突粗扫描）
// 上游没有任何插件机制：window.CircuitJS1 是单槽回调，注册表没有 remove。
// 这里的职责就是把"能加不能减"补齐成人能用的生命周期。

import { Fiber } from "@ext/plugin-api";
import type {
    ExtPluginContext,
    ExtPluginModule,
    ExtCommand,
    ExtElementDef,
    ExtHookName,
    ExtHookHandler,
    ExtPermission,
} from "@ext/plugin-api";
import {
    ExtPermissionError,
    resolveDeclaredPermissions,
    applyPermissionPolicy,
    unknownEntryFields,
    RETIRED_ENTRY_FIELDS,
} from "@ext/plugin-api";
import { CommandPaletteRegistry, PaletteCommand } from "./CommandPaletteRegistry";
import { ExtHooks } from "./ExtHooks";
import { WorkerRpcClient, createPluginWorker } from "./ExtPluginWorker";
import {
    registerExtElement,
    unregisterExtElement,
    unregisterExtElements,
    listExtElements,
    baseElement,
    findFreeDumpType,
} from "./ExtElements";

export interface PluginEntry {
    id: string;
    entry: string;
    version?: string;
    enabled?: boolean;
    rev?: string | number;
    /** 申请的 ctx 能力；权威表见 packages/plugin-api/permissions.json */
    permissions?: string[];
    claims?: { commands?: string[]; panels?: string[]; hooks?: string[]; elements?: string[] };
    [k: string]: any;
}

/**
 * 站点级策略（由 plugins.manifest.json 的 policy 或宿主显式传入）。
 * 这里只做「减法」：插件自己声明的能力，站点可以整体否掉；站点不能凭空授予。
 */
export interface PluginPolicy {
    /** 无论 manifest 怎么声明，这些能力一律不授予（相关 ctx 面调用即抛 ExtPermissionError） */
    denyPermissions?: string[];
    /** claims 与 permissions 不一致时是否直接失败；缺省 false = 记 warning（可在 list() 里看到） */
    strictClaims?: boolean;
}

export interface PluginStatus {
    id: string;
    state: string;
    version?: string;
    error?: string | null;
    disposables: number;
    /** 实际授予的权限 */
    permissions: ExtPermission[];
    /** 声明了但被站点策略拒掉的权限 */
    denied: string[];
    /** 漏声明 / 策略拦截 / 声明与实现不一致等非致命提示 */
    warnings: string[];
}

const STORAGE_PREFIX = "ext.plugin.";

/** 插件根 URL。plugins/ 是**页面同级目录**（dist/plugins），不是 bundle 的同级目录：
 *  JS 产物在 dist/circuitjs/，插件在 dist/plugins/，所以不能用 import.meta.url 推导。
 *  以 document.baseURI 为基准，"plugins/" 在站点根（dev）就是 /plugins/，
 *  在子路径部署（GitHub Pages 的 /<repo>/）就是 /<repo>/plugins/，两种都成立。
 *  Node 侧（fiber.test.mjs 直接 import 本文件、没有 document）退回原来的 "/plugins/"，
 *  契约测试按该前缀拦截动态导入。 */
function pluginsRoot(): string {
    if (typeof document !== "undefined") return new URL("plugins/", document.baseURI).href;
    return "/plugins/";
}

/** 策略合并：只能做减法，所以 deny 取并集、strictClaims 取或。构造参数与 manifest 的 policy 都走这里。 */
function mergePolicy(...policies: (PluginPolicy | null | undefined)[]): PluginPolicy {
    const deny = new Set<string>();
    let strictClaims = false;
    for (const p of policies) {
        if (!p) continue;
        for (const d of Array.isArray(p.denyPermissions) ? p.denyPermissions : []) deny.add(String(d));
        if (p.strictClaims) strictClaims = true;
    }
    return { denyPermissions: Array.from(deny), strictClaims };
}

export class PluginHost {
    private fibers = new Map<string, Fiber>();
    private mods = new Map<string, ExtPluginModule>();
    /** Worker 模式插件（B08）：entry.id → WorkerRpcClient（terminate 时清理） */
    private workers = new Map<string, WorkerRpcClient>();
    private errors = new Map<string, string>();
    private disposables = new Map<string, number>();
    /** 命令 id → 实际注册者插件 id（B03）。ctx.command 注册时登记，disposer 撤销时释放。 */
    private commandOwners = new Map<string, string>();
    /** 每个插件的授予集 / 被策略拒掉的 / 非致命提示（list() 暴露出去） */
    private granted = new Map<string, ExtPermission[]>();
    private denied = new Map<string, string[]>();
    private warnings = new Map<string, string[]>();
    /** 构造时给的策略（不随 load 变化；与 manifest policy 取并集得到 effective policy） */
    private readonly basePolicy: PluginPolicy;
    /** 当前生效的策略 = basePolicy ∪ manifest.policy（只能做减法，见 mergePolicy） */
    private policy: PluginPolicy = {};
    // 显式字段而非构造器参数属性：Node 契约测试（tests/contract/fiber.test.mjs）以
    // strip-only 模式加载本文件，参数属性属不可擦除语法会直接报错；语义与原写法完全一致。
    private readonly app: any;
    private readonly api: any;
    private readonly hooks: ExtHooks;

    constructor(app: any, api: any, hooks?: ExtHooks, policy?: PluginPolicy) {
        this.app = app;
        this.api = api;
        // 缺省自建一条空总线：Node 契约测试直接 new PluginHost(app, api) 也不会炸，
        // ctx.hook 只是没人跑（真正的接线在 ExtBoot 里用 wireAppHooks 完成）
        this.hooks = hooks ?? new ExtHooks();
        this.basePolicy = mergePolicy(policy);
        this.policy = this.basePolicy;
    }

    async load(manifestUrl = pluginsRoot() + "plugins.manifest.json"): Promise<void> {
        let manifest: any;
        try {
            const res = await fetch(manifestUrl, { cache: "no-store" });
            if (!res.ok) throw new Error(`manifest ${res.status}`);
            manifest = await res.json();
        } catch (e) {
            // 没有插件不影响核心可用
            console.warn("[ExtCircuitJS] plugin manifest unavailable:", e);
            return;
        }
        // 站点策略随 manifest 走：这是"部署侧能不能关掉某一面"的唯一入口。
        // 每次都从 basePolicy 重新合并（而不是累加到上一轮），否则反复 load 会一直做减法、
        // 把 manifest 里已经去掉的 deny 永久留在内存里。
        this.policy = mergePolicy(this.basePolicy, manifest?.policy);
        // 启停控制（部署侧）：site.config.json 的 plugins.disabled 构建期烘焙进
        // <html data-ext-site-disabled="[...]">，这里读它过滤 load() 的自动加载——
        // 与 manifest 的 enabled 取交集（两者都放行才加载）；显式 activate 不受限制。
        const rawDisabled = typeof document !== "undefined"
            ? document.documentElement.dataset.extSiteDisabled
            : undefined;
        let siteDisabled: string[] = [];
        if (rawDisabled) {
            try { siteDisabled = JSON.parse(rawDisabled); } catch { /* 坏数据当空 */ }
        }
        const entries: PluginEntry[] = (manifest?.plugins ?? [])
            .filter((p: PluginEntry) => p.enabled !== false && !siteDisabled.includes(p.id));
        for (const entry of entries) {
            try {
                await this.activate(entry);
            } catch (e: any) {
                console.error(`[ExtCircuitJS] plugin "${entry.id}" failed to activate:`, e);
            }
        }
    }

    async activate(entry: PluginEntry): Promise<void> {
        if (this.fibers.has(entry.id)) await this.deactivate(entry.id);
        this.scanClaims(entry);

        const fiber = new Fiber();
        fiber.state = "loading";
        this.fibers.set(entry.id, fiber);
        const warnings: string[] = [];
        this.warnings.set(entry.id, warnings);

        // 权限先于 import 解析：名字拼错时连插件的代码都不加载。
        // 失败也要留在 fibers 里（state=failed）——否则 list() 里凭空少一个插件，
        // 排障的人只会看到"它没启动"，看不到"为什么"。
        let granted: ExtPermission[] = [];
        let denied: string[] = [];
        try {
            const declared = resolveDeclaredPermissions(entry.permissions, entry.id);
            const applied = applyPermissionPolicy(declared, this.policy.denyPermissions);
            granted = applied.granted;
            denied = applied.denied;
        } catch (e: any) {
            fiber.state = "failed";
            this.errors.set(entry.id, String(e?.message ?? e));
            throw e;
        }
        this.granted.set(entry.id, granted);
        this.denied.set(entry.id, denied);
        for (const p of denied) warnings.push(`权限 "${p}" 已被站点策略禁用，对应的 ctx 面不可用`);
        if (denied.length) console.warn(`[ExtCircuitJS] plugin "${entry.id}": denied by policy → ${denied.join(", ")}`);

        // 装饰性字段：manifest 里写了但契约不认的键一律警告（构建期 lint 也报同一份清单）。
        // 这条规则的由来：`inject: ["api"]` 曾是"声明依赖"，实际没有任何代码读它。
        for (const key of unknownEntryFields(entry)) {
            const hint = RETIRED_ENTRY_FIELDS[key] ? `（${RETIRED_ENTRY_FIELDS[key]}）` : "";
            const msg = `manifest 字段 "${key}" 未被契约识别${hint}`;
            warnings.push(msg);
            console.warn(`[ExtCircuitJS] plugin "${entry.id}": ${msg}`);
        }

        // ?rev= 是热重载的换版本键：不同 rev → 不同 URL → 浏览器必然拉新模块实例，
        // 不会命中 ESM 模块图里的旧条目（core 只读，宿主侧解决"能加不能减"）。
        const url = `${pluginsRoot()}${entry.id}/${entry.entry}?rev=${entry.rev ?? Date.now()}`;

        // ── Worker 模式（B08）：不可信插件跑在隔离线程，只经 postMessage RPC ──
        if (entry.mode === "worker") {
            let rpc: WorkerRpcClient | null = null;
            try {
                // Classic worker：插件入口是普通脚本（模块可再用 {type:"module"} 演进）。
                // 不支持 Worker 的宿主（如某些测试 jsdom 桩）直接失败，走 fiber 回滚。
                if (typeof Worker === "undefined")
                    throw new Error("Worker 不可用：宿主环境不支持（in-page 插件可用 mode:'in-page'）");
                const worker = createPluginWorker(url, entry.workerType ?? "classic");
                const grantedSet = new Set(granted);
                // 服务面：worker 主动来取的数据接口，按权限裁剪；绝不把引擎对象传给 worker。
                const serve = async (req: { method: string; params?: any }): Promise<any> => {
                    const { method, params } = req;
                    switch (method) {
                        case "getNetlist":
                            return this.api.dumpNetlist?.() ?? this.api.getNetlist?.() ?? null;
                        case "getMeasurements":
                            if (!grantedSet.has("sim.observe")) throw new Error(`permission "sim.observe" not granted`);
                            return this.api.getMeasurements?.(params ?? {}) ?? null;
                        case "step": {
                            if (!grantedSet.has("sim.observe")) throw new Error(`permission "sim.observe" not granted`);
                            if (typeof this.api.step === "function") return this.api.step(params);
                            const secs = Number(params?.seconds ?? 0.002);
                            return this.api.runThenMeasure?.(secs) ?? { ok: false, error: "host step unavailable" };
                        }
                        case "report":
                            if (params) console.log(`[worker:${entry.id}]`, ...(Array.isArray(params) ? params : [params]));
                            return { ok: true };
                        default:
                            throw new Error(`unknown worker method "${method}"`);
                    }
                };
                rpc = new WorkerRpcClient(worker, serve);
                this.workers.set(entry.id, rpc);
                await rpc.request("activate", { id: entry.id, version: entry.version ?? "0.0.0" }, 15000);
                fiber.state = "ready";
                this.errors.delete(entry.id);
                return; // 不走下方 in-page 的 import 路径
            } catch (e: any) {
                this.errors.set(entry.id, String(e?.message ?? e));
                fiber.dispose();
                fiber.state = "failed";
                this.fibers.delete(entry.id);
                if (rpc) rpc.dispose();
                throw e;
            } finally {
                this.disposables.set(entry.id, 0);
            }
        }

        let mod: ExtPluginModule;
        try {
            mod = (await import(/* @vite-ignore */ url)) as ExtPluginModule;
        } catch (e: any) {
            fiber.state = "failed";
            this.errors.set(entry.id, String(e?.message ?? e));
            throw e;
        }

        const ctx = this.createContext(entry, fiber, granted, denied, warnings);
        try {
            await mod.activate?.(ctx);
            fiber.state = "ready";
            this.mods.set(entry.id, mod);
            this.errors.delete(entry.id);
        } catch (e: any) {
            // 不变式 2：激活失败 -> 无条件 LIFO 回滚（否则会残留已注册监听）
            this.errors.set(entry.id, String(e?.message ?? e));
            fiber.dispose();
            fiber.state = "failed";
            this.fibers.delete(entry.id);
            throw e;
        } finally {
            this.disposables.set(entry.id, (fiber as any).disposers?.length ?? 0);
        }
    }

    async deactivate(id: string): Promise<void> {
        const fiber = this.fibers.get(id);
        const mod = this.mods.get(id);
        try { await mod?.deactivate?.(); } catch (e) { console.error(`[ExtCircuitJS] ${id}.deactivate failed:`, e); }
        // Worker 模式：通知 worker 卸载并 terminate（B08）
        const wrpc = this.workers.get(id);
        if (wrpc) {
            try { await wrpc.request("deactivate", {}, 3000); } catch { /* 已终止 */ }
            wrpc.dispose();
            this.workers.delete(id);
        }
        fiber?.dispose();
        this.fibers.delete(id);
        this.mods.delete(id);
        this.granted.delete(id);
        this.denied.delete(id);
        this.warnings.delete(id);
    }

    /** 热重载（B05）：重新 fetch manifest 拿最新 entry，deactivate 旧 fiber（全部
     *  disposer 逆序执行：命令/监听/面板/所有权释放），再以新 rev 的 URL 重新装载。
     *  rev 可显式指定（契约测试用它钉死 import 路径），缺省用当前时间戳保证换版本。
     *  同步点 = 返回的 Promise（deactivate/activate 均 await），无需轮询等待。 */
    async reload(id: string, rev?: string | number): Promise<void> {
        const entry = await this.findEntry(id);
        if (!entry) throw new Error(`plugin "${id}" not found in manifest`);
        await this.deactivate(id);
        await this.activate({ ...entry, rev: rev ?? Date.now() });
    }

    list(): PluginStatus[] {
        return Array.from(this.fibers.keys()).map((id) => {
            const fiber = this.fibers.get(id)!;
            return {
                id,
                state: fiber.state,
                version: (this.mods.get(id) as any)?.version,
                error: this.errors.get(id) ?? null,
                disposables: this.disposables.get(id) ?? 0,
                permissions: (this.granted.get(id) ?? []).slice(),
                denied: (this.denied.get(id) ?? []).slice(),
                warnings: (this.warnings.get(id) ?? []).slice(),
            };
        });
    }

    async dispose(): Promise<void> {
        for (const id of Array.from(this.fibers.keys())) await this.deactivate(id);
    }

    // ── internals ──────────────────────────────────────────────────────────

    private async findEntry(id: string): Promise<PluginEntry | null> {
        try {
            const res = await fetch(pluginsRoot() + "plugins.manifest.json", { cache: "no-store" });
            const m = await res.json();
            return (m?.plugins ?? []).find((p: PluginEntry) => p.id === id) ?? null;
        } catch {
            return null;
        }
    }

    /** 冲突粗扫描：manifest 声明的命令与在册所有者冲突时，后启动者直接拒绝（v0.1 策略）。
     *  只校验、不占位：所有权以 ctx.command 的实际注册为准（见 createContext.command），
     *  并随注册 disposer 在卸载/回滚时释放——否则声明过的 id 会在插件卸载后永久占坑。 */
    private scanClaims(entry: PluginEntry): void {
        for (const cmd of entry.claims?.commands ?? []) {
            const owner = this.commandOwners.get(cmd);
            if (owner && owner !== entry.id) {
                throw new Error(`command conflict: "${cmd}" already claimed by plugin "${owner}"`);
            }
        }
    }

    private createContext(
        entry: PluginEntry,
        fiber: Fiber,
        granted: ExtPermission[],
        denied: string[],
        warnings: string[],
    ): ExtPluginContext {
        const self = this;
        const id = entry.id;
        const grantedSet = new Set(granted);
        const deniedSet = new Set(denied);

        /** 能力闸门：没授予就抛。区分"没声明"与"被策略拦"——两者的处置完全不同。 */
        const require = (perm: ExtPermission, surface: string): void => {
            if (grantedSet.has(perm)) return;
            throw new ExtPermissionError(id, perm, deniedSet.has(perm) ? "denied-by-policy" : "undeclared", surface);
        };
        /** claims 与实现不一致：默认只是 warning（可在 plugins.list() 里看到），
         *  strictClaims 下升级为失败——claims 是冲突检测的依据，偷偷扩面会让它失准。 */
        const noteClaim = (what: string, declared: string[] | undefined, actual: string): void => {
            if (!declared?.length || declared.includes(actual)) return;
            const msg = `${what} "${actual}" 未在 manifest 的 claims 里声明`;
            if (self.policy.strictClaims) throw new Error(`plugin "${id}": ${msg}`);
            warnings.push(msg);
            console.warn(`[ExtCircuitJS] plugin "${id}": ${msg}`);
        };

        return {
            id,
            version: entry.version ?? "0.0.0",
            get signal() { return fiber.signal; },
            get state() { return fiber.state; },
            // 授予集不可变副本：插件改它不该影响宿主判定
            get permissions() { return Object.freeze(granted.slice()); },
            permits: (perm: ExtPermission) => grantedSet.has(perm),
            effect: (fn) => fiber.effect(fn),
            on: (name, h) => {
                require("sim.observe", "ctx.on");
                const off = self.api.on(name, h);
                fiber.add(off);
                return off;
            },
            hook: (name: ExtHookName, h: ExtHookHandler) => {
                require("document.hook", `ctx.hook("${name}")`);
                if (typeof h !== "function") throw new Error(`hook "${name}" needs a function`);
                noteClaim("钩子", entry.claims?.hooks, name);
                const off = self.hooks.on(name, h);
                fiber.add(off);
                return off;
            },
            command: (cmd: ExtCommand) => {
                require("ui.command", "ctx.command");
                noteClaim("命令", entry.claims?.commands, String(cmd?.id ?? ""));
                // B03 冲突拒绝：目标 id 已被其他插件实际注册 → 抛错，绝不静默。
                // core 的 addCommand 对重复 id 是静默忽略（core/ts/CommandPaletteRegistry.ts:84-89），
                // 若不先拒绝，第二插件看似注册成功，其撤销 disposer 反而会删掉第一插件的命令。
                const owner = self.commandOwners.get(cmd.id);
                if (owner && owner !== id) {
                    throw new Error(`command conflict: "${cmd.id}" already registered by plugin "${owner}"`);
                }
                // 与核心调色板撞 id 同样拒绝（保护核心命令不被插件抢占、撤销时误删）
                if (!owner && CommandPaletteRegistry.byId.has(cmd.id)) {
                    throw new Error(`command conflict: "${cmd.id}" already exists in the command palette`);
                }
                const palette = new PaletteCommand({
                    id: cmd.id,
                    label: cmd.label,
                    category: cmd.category ?? "Ext",
                    keywords: cmd.keywords ?? "",
                    custom: { execute: () => cmd.run() },
                });
                CommandPaletteRegistry.addCommand(palette);
                self.commandOwners.set(cmd.id, id);
                const off = () => {
                    if (self.commandOwners.get(cmd.id) === id) self.commandOwners.delete(cmd.id);
                    CommandPaletteRegistry.byId.delete(cmd.id);
                    CommandPaletteRegistry.commands = CommandPaletteRegistry.commands.filter((c) => c.id !== cmd.id);
                };
                fiber.add(off);
                return off;
            },
            panel: (el: HTMLElement) => {
                require("ui.panel", "ctx.panel");
                self.app.addWidgetToVerticalPanel(el);
                const off = () => self.app.removeWidgetFromVerticalPanel(el);
                fiber.add(off);
                return off;
            },
            element: {
                register: (def: ExtElementDef) => {
                    require("element.register", "ctx.element.register");
                    // 菜单是另一件事：注册了类不等于该出现在用户菜单里
                    if (def?.menu !== false) require("ui.menu", "ctx.element.register({ menu: true })");
                    noteClaim("元件", entry.claims?.elements, String(def?.className ?? ""));
                    const r = registerExtElement(self.app, id, def);
                    // 与 ctx.command 同口径：注册不成立就让 activate 失败并整体回滚，
                    // 绝不"看起来装上了其实没装上"。
                    if (!r.ok) throw new Error(`element "${def?.className}" rejected: ${r.reason}`);
                    const off = () => { unregisterExtElement(self.app, r.className!, id); };
                    fiber.add(off);
                    return off;
                },
                unregister: (className: string) => {
                    require("element.register", "ctx.element.unregister");
                    return unregisterExtElement(self.app, className, id);
                },
                list: () => {
                    require("element.register", "ctx.element.list");
                    return listExtElements(id);
                },
                base: (className: string) => {
                    require("element.register", "ctx.element.base");
                    return baseElement(className);
                },
                freeDumpType: (from?: number) => {
                    require("element.register", "ctx.element.freeDumpType");
                    return findFreeDumpType(self.app, from);
                },
            },
            // 取属性即校验：写成 getter 而不是先赋值，是为了"没权限时连读都不许"，
            // 而不是给一个"存在但一用就炸"的对象（后者更难发现）。
            get api() {
                require("sim.control", "ctx.api");
                return self.api;
            },
            storage: {
                get<T = any>(key: string): T | null {
                    try {
                        const raw = localStorage.getItem(STORAGE_PREFIX + id + "." + key);
                        return raw == null ? null : (JSON.parse(raw) as T);
                    } catch { return null; }
                },
                set(key: string, value: any): void {
                    try { localStorage.setItem(STORAGE_PREFIX + id + "." + key, JSON.stringify(value)); } catch { /* quota */ }
                },
            },
            log: (...args: any[]) => console.log(`[plugin:${id}]`, ...args),
        };
    }
}
