// Cover 层新增：启动编排（唯一入口，由 cover/ts/main.ts 在 app.init() 之后调用）
// 职责：事件桥 -> API facade -> 插件宿主 -> window.ExtCircuitJS

import { ExtApi } from "./ExtApi";
import { ExtEvents, wireAppEvents } from "./ExtEvents";
import { PluginHost } from "./ExtPluginHost";
import { applySiteConfig } from "./SiteConfig";

export interface ExtRuntime {
    api: ExtApi;
    plugins: PluginHost;
    events: ExtEvents;
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
    const api = new ExtApi(app, events);
    const plugins = new PluginHost(app, api);

    const rt: ExtRuntime = {
        api,
        plugins,
        events,
        dispose() {
            unwire();
            void plugins.dispose();
            events.clear();
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
        dispose: rt.dispose,
    };

    // 插件装载失败不阻断主程序
    try {
        await plugins.load();
    } catch (e) {
        console.error("[ExtCircuitJS] plugin load failed:", e);
    }

    console.log(`[ExtCircuitJS] booted (core ${api.version}); api on window.ExtCircuitJS`);
    return rt;
}
