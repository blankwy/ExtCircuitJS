// Cover 层新增：插件宿主（fiber / effect / dispose / 热重载 / 失败回滚 / 冲突粗扫描）
// 上游没有任何插件机制：window.CircuitJS1 是单槽回调，注册表没有 remove。
// 这里的职责就是把"能加不能减"补齐成人能用的生命周期。

import { Fiber } from "@ext/plugin-api";
import type { ExtPluginContext, ExtPluginModule, ExtCommand, ExtElementDef } from "@ext/plugin-api";
import { CommandPaletteRegistry, PaletteCommand } from "./CommandPaletteRegistry";
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
    claims?: { commands?: string[]; panels?: string[]; hooks?: string[] };
    [k: string]: any;
}

export interface PluginStatus {
    id: string;
    state: string;
    version?: string;
    error?: string | null;
    disposables: number;
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

export class PluginHost {
    private fibers = new Map<string, Fiber>();
    private mods = new Map<string, ExtPluginModule>();
    private errors = new Map<string, string>();
    private disposables = new Map<string, number>();
    /** 命令 id → 实际注册者插件 id（B03）。ctx.command 注册时登记，disposer 撤销时释放。 */
    private commandOwners = new Map<string, string>();
    // 显式字段而非构造器参数属性：Node 契约测试（tests/contract/fiber.test.mjs）以
    // strip-only 模式加载本文件，参数属性属不可擦除语法会直接报错；语义与原写法完全一致。
    private readonly app: any;
    private readonly api: any;

    constructor(app: any, api: any) {
        this.app = app;
        this.api = api;
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
        const entries: PluginEntry[] = (manifest?.plugins ?? []).filter((p: PluginEntry) => p.enabled !== false);
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

        // ?rev= 是热重载的换版本键：不同 rev → 不同 URL → 浏览器必然拉新模块实例，
        // 不会命中 ESM 模块图里的旧条目（core 只读，宿主侧解决"能加不能减"）。
        const url = `${pluginsRoot()}${entry.id}/${entry.entry}?rev=${entry.rev ?? Date.now()}`;
        let mod: ExtPluginModule;
        try {
            mod = (await import(/* @vite-ignore */ url)) as ExtPluginModule;
        } catch (e: any) {
            fiber.state = "failed";
            this.errors.set(entry.id, String(e?.message ?? e));
            throw e;
        }

        const ctx = this.createContext(entry, fiber);
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
        fiber?.dispose();
        this.fibers.delete(id);
        this.mods.delete(id);
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

    private createContext(entry: PluginEntry, fiber: Fiber): ExtPluginContext {
        const self = this;
        const id = entry.id;
        return {
            id,
            version: entry.version ?? "0.0.0",
            get signal() { return fiber.signal; },
            get state() { return fiber.state; },
            effect: (fn) => fiber.effect(fn),
            on: (name, h) => {
                const off = self.api.on(name, h);
                fiber.add(off);
                return off;
            },
            command: (cmd: ExtCommand) => {
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
                self.app.addWidgetToVerticalPanel(el);
                const off = () => self.app.removeWidgetFromVerticalPanel(el);
                fiber.add(off);
                return off;
            },
            element: {
                register: (def: ExtElementDef) => {
                    const r = registerExtElement(self.app, id, def);
                    // 与 ctx.command 同口径：注册不成立就让 activate 失败并整体回滚，
                    // 绝不"看起来装上了其实没装上"。
                    if (!r.ok) throw new Error(`element "${def?.className}" rejected: ${r.reason}`);
                    const off = () => { unregisterExtElement(self.app, r.className!, id); };
                    fiber.add(off);
                    return off;
                },
                unregister: (className: string) => unregisterExtElement(self.app, className, id),
                list: () => listExtElements(id),
                base: (className: string) => baseElement(className),
                freeDumpType: (from?: number) => findFreeDumpType(self.app, from),
            },
            api: self.api,
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
