# 计划外观察（跨阶段累积；Lead 逐条裁决，不在当前卡展开）

- [2026-10-25 · Stage 1 / A05] coverOverlay 的 dev 与 dist 路径层级不一致：`cover/public/<rel>` 在 dev 服务于 `/<rel>`，在 build 落到 `dist/circuitjs/<rel>`，同一文件在 dev 与 dist（根目录静态服务）的 URL 相差一个 assetsDir 层级。影响：想要 dist URL 与 dev URL 完全一致的覆盖文件做不到；想要影子 core 既有资源（如 `circuitjs/font/fontello.css`，HTML 里被引用）时，dev 侧 `cover/public/circuitjs/font/...` 可命中，dist 侧却落到 `dist/circuitjs/circuitjs/font/...`，不覆盖目标。属 spike B 原型遗留；本阶段 tools/ 超出写作用域未动。后续若要做"覆盖 core 静态资源"类功能（非新增），需先在 coverOverlay closeBundle 里对 `circuitjs/` 前缀做与上游 copy-public-assets 相同的剥层。
- [2026-10-25 · Stage 1 / A01] dev server（端口 5174）为上次会话遗留的 vite 进程（配置与 `ext dev` 完全一致，PID 38636），已直接复用未重启。CI/新环境无此便利，`ext dev` 的后台化与就绪探测（等端口 listen）目前要手工做，Stage 6 CI 化时需要一个 `dev --background` 或测试内起 server 的方案。
