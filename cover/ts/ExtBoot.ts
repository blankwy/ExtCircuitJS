// Cover 层新增：启动编排（唯一入口，由 cover/ts/main.ts 在 app.init() 之后调用）
// 职责：事件桥 -> API facade -> 插件宿主 -> window.ExtCircuitJS

import { ExtApi } from "./ExtApi";
import { ExtEvents, wireAppEvents } from "./ExtEvents";
import { PluginHost } from "./ExtPluginHost";
import { applySiteConfig } from "./SiteConfig";
import { installMenuSlot, registerMenuElement, unregisterMenuElement } from "./ExtMenus";
import { configureMenuSlot } from "./ExtElements";
import { ElementFactory } from "./ElementFactory";
import { ExtHooks, wireAppHooks } from "./ExtHooks";
import { wireElementEvents } from "./ExtElementEvents";
import type { ElementEventWiring } from "./ExtElementEvents";

export interface ExtRuntime {
    api: ExtApi;
    plugins: PluginHost;
    events: ExtEvents;
    /** 文档钩子总线（load/save） */
    hooks: ExtHooks;
    /** 元件交互事件的接线句柄（refresh / dispose） */
    elementEvents: ElementEventWiring;
    dispose(): void;
}

let runtime: ExtRuntime | null = null;

export function getExtRuntime(): ExtRuntime | null {
    return runtime;
}

export async function ExtBoot(app: any): Promise<ExtRuntime> {
    if (runtime) return runtime;

    // 站点配置：把 cover/site.config.json 的 title 落成运行时标题基名（在插件装载之前，
    // 让任何插件看到的就是最终标题）
    applySiteConfig(app);

    const events = new ExtEvents();
    const unwire = wireAppEvents(app, events);
    // 文档钩子：必须早于插件装载（插件在 activate 里注册 hook，装载完立刻就能用）
    const hooks = new ExtHooks();
    const unwireHooks = wireAppHooks(app, hooks);
    // 元件交互事件：旁观画布，不包 core 任何私有方法
    const elementEvents = wireElementEvents(app, events);
    // 载入完成后再同步一次：readCircuit 返回时 elmList 已整体重建，但没有任何 DOM 事件可言
    // （载入一个电路=可能"删掉全部旧的、新增 7 个"，插件必须能看到）
    const offAfterLoad = hooks.afterLoad((meta) => {
        elementEvents.refresh(meta.source === "document" ? "load" : meta.source);
    });
    const api = new ExtApi(app, events);
    const plugins = new PluginHost(app, api, hooks);

    const rt: ExtRuntime = {
        api,
        plugins,
        events,
        hooks,
        elementEvents,
        dispose() {
            unwire();
            unwireHooks();
            offAfterLoad();
            elementEvents.dispose();
            void plugins.dispose();
            events.clear();
            hooks.clear();
            runtime = null;
        },
    };
    runtime = rt;

    // 对外句柄：window.ExtCircuitJS（插件、MCP 桥、控制台都用它）
    (window as any).ExtCircuitJS = {
        version: api.version,
        app,
        sim: app.sim,
        api,
        events,
        plugins,
        hooks,
        // 就绪信号：插件宿主装载完（成功或被吞掉的失败）才置 true。注意 window.ExtCircuitJS
        // 本体在这之前就已挂出，外部（MCP backend、契约测试）不能拿它当就绪标志，等这里。
        ready: false,
        // 选中集合 / 元件表的手动同步（插件自己改完电路或选择、或外部脚本直接改完后调用）
        refreshSelection: () => elementEvents.refresh("manual"),
        refreshElements: () => elementEvents.refresh("manual"),
        // 元件工厂的**同一实例**（不是同名模块再 import 一份）。
        // dev 下 `/ElementFactory.ts` 与 `@fs/...` 是两个模块 URL、两份 classMap，
        // 外部代码（控制台/契约测试/未来的 MCP 工具）一律从这里拿，否则注册了却放置不了。
        elements: {
            factory: ElementFactory,
            list: () => ElementFactory.listClasses(),
            has: (name: string) => ElementFactory.hasClass(name),
            ownerOf: (name: string) => ElementFactory.ownerOf(name),
        },
        /**
         * 按需加载 MCP 桥（供 MCP 客户端驱动本页）。
         * 静态产物（dist/、GitHub Pages）没有 Vite 的 /@fs/ 转译路径，桥必须随 bundle 走，
         * 所以这里用相对动态 import —— Vite 会切成独立 chunk，只有真正调用时才下载。
         * 返回 bridge 实例；加载失败/环境不支持返回 null（调用方自行降级）。
         */
        loadMcpBridge: async (): Promise<any> => {
            const w = window as any;
            if (w.ExtCircuitJS?.mcp != null) return w.ExtCircuitJS.mcp;   // 已加载
            try {
                const mod = await import("./ExtMcpBridge");
                const bridge = mod.getMcpBridge?.() ?? mod.attachMcpBridge?.(w.ExtCircuitJS) ?? null;
                return bridge;
            } catch (e) {
                console.error("[ExtCircuitJS] loadMcpBridge failed:", e);
                return null;
            }
        },
        dispose: rt.dispose,
    };

    // 菜单插槽：一次装好 —— 既覆盖"之后重建菜单"的场景（composeMainMenu 包装），
    // 也把此刻已登记的项挂到已构建的 Draw/右键菜单上。插件自定义元件依赖它才有入口。
    // 菜单实现以注入方式交给 ExtElements：后者要能被 Node 契约测试直接加载（不能拖进 core 图）。
    configureMenuSlot({ register: registerMenuElement, unregister: unregisterMenuElement });
    try {
        const slot = installMenuSlot();
        if (!slot.ok) console.warn("[ExtCircuitJS] menu slot unavailable:", slot.reason);
    } catch (e) {
        console.error("[ExtCircuitJS] menu slot install failed:", e);
    }

    // 插件装载失败不阻断主程序
    try {
        await plugins.load();
    } catch (e) {
        console.error("[ExtCircuitJS] plugin load failed:", e);
    }
    (window as any).ExtCircuitJS.ready = true;

    console.log(`[ExtCircuitJS] booted (core ${api.version}); api on window.ExtCircuitJS`);
    return rt;
}
