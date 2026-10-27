// 测试辅助：显式激活站点配置默认禁用的示例插件，并等待 ready。
//
// 背景：site.config.json 的 plugins.disabled 默认禁用全部示例插件（部署侧语义，
// 用户要求示例只留作开发参考）。依赖示例插件的契约测试用本 helper 在页面里
// 显式 activate（带 manifest 的 permissions——activate 只吃显式传入的 entry），
// 与 plugins-smoke.browser.test.mjs 的内联版本同一模式。

export async function activatePlugins(page, ids, base) {
    await page.evaluate(async ({ ids, base }) => {
        // goto(waitUntil:"load") 时 ExtBoot 可能还没跑完：先等 window.ExtCircuitJS.plugins 挂上
        // （Vite 冷启动首帧可能好几秒，60s 上限对齐其他契约测试的 boot 等待）
        for (let i = 0; i < 600 && !window.ExtCircuitJS?.plugins; i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        const ext = window.ExtCircuitJS;
        if (!ext?.plugins) throw new Error("ExtCircuitJS.plugins 未就绪");
        const manifest = await fetch(`${base}/plugins/plugins.manifest.json`).then((r) => r.json());
        const byId = Object.fromEntries((manifest.plugins ?? []).map((p) => [p.id, p]));
        const missing = ids.filter((id) => !byId[id]);
        if (missing.length) throw new Error(`manifest 缺插件: ${missing.join(",")}`);
        const todo = ids.filter((id) => {
            const cur = ext.plugins.list().find((x) => x.id === id);
            return cur?.state !== "ready"; // 已 ready 的跳过（幂等：重复 activate 会换模块实例）
        });
        await Promise.all(todo.map((id) => {
            const m = byId[id];
            return ext.plugins.activate({
                id,
                entry: m.entry,
                version: m.version,
                permissions: m.permissions,
                claims: m.claims,
                rev: Date.now(),
            });
        }));
        for (let i = 0; i < 100; i++) {
            if (ids.every((id) => ext.plugins.list().find((x) => x.id === id)?.state === "ready")) return;
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`插件未能 ready: ${ids.join(",")}`);
    }, { ids, base });
}
