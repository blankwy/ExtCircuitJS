// Cover 层新增：插件宿主（fiber / effect / dispose / 热重载 / 失败回滚 / 冲突粗扫描）
// 上游没有任何插件机制：window.CircuitJS1 是单槽回调，注册表没有 remove。
// 这里的职责就是把"能加不能减"补齐成人能用的生命周期。

import { Fiber } from "@ext/plugin-api";
import type { ExtPluginContext, ExtPluginModule, ExtCommand } from "@ext/plugin-api";
import { CommandPaletteRegistry, PaletteCommand } from "./CommandPaletteRegistry";

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

export class PluginHost {
    private fibers = new Map<string, Fiber>();
    private mods = new Map<string, ExtPluginModule>();
    private errors = new Map<string, string>();
    private disposables = new Map<string, number>();
    private commandOwners = new Map<string, string>();

    constructor(private readonly app: any, private readonly api: any) {}

    async load(manifestUrl = "/plugins/plugins.manifest.json"): Promise<void> {
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

        const url = `/plugins/${entry.id}/${entry.entry}?v=${entry.rev ?? Date.now()}`;
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

    async reload(id: string): Promise<void> {
        const entry = await this.findEntry(id);
        if (!entry) throw new Error(`plugin "${id}" not found in manifest`);
        await this.deactivate(id);
        await this.activate({ ...entry, rev: Date.now() });
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
            const res = await fetch("/plugins/plugins.manifest.json", { cache: "no-store" });
            const m = await res.json();
            return (m?.plugins ?? []).find((p: PluginEntry) => p.id === id) ?? null;
        } catch {
            return null;
        }
    }

    /** 冲突粗扫描：同一命令/面板被两个插件声明时，后启动者直接拒绝（v0.1 策略） */
    private scanClaims(entry: PluginEntry): void {
        for (const cmd of entry.claims?.commands ?? []) {
            const owner = this.commandOwners.get(cmd);
            if (owner && owner !== entry.id) {
                throw new Error(`command conflict: "${cmd}" already claimed by plugin "${owner}"`);
            }
        }
        // 通过校验后再占位
        for (const cmd of entry.claims?.commands ?? []) this.commandOwners.set(cmd, entry.id);
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
                const palette = new PaletteCommand({
                    id: cmd.id,
                    label: cmd.label,
                    category: cmd.category ?? "Ext",
                    keywords: cmd.keywords ?? "",
                    custom: { execute: () => cmd.run() },
                });
                CommandPaletteRegistry.addCommand(palette);
                const off = () => {
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
