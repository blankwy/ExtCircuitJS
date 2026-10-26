#!/usr/bin/env node
// @ext/mcp — 进程入口（MCP 宿主的 command）
//
//   node packages/mcp/src/cli.mjs        # 或 node tools/ext.mjs mcp（等价）
//
// 两件事，顺序不能反：
//   1. 先注册 TS 加载钩子（tools/ts-resolve.mjs）——packages 的 TS 用无扩展名相对导入，
//      Node ESM 原生不认；钩子必须在 import 到那些模块**之前**生效。
//   2. 再动态 import 真正的服务器（src/server.ts）。
// 本文件刻意保持 .mjs：它不能被 tsc 的类型检查牵连，也不该有副作用。

import { register } from "node:module";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stderr.write([
        "ext-circuitjs MCP server (stdio)",
        "",
        "  由 MCP 宿主拉起，不是给人手动运行的交互程序；协议帧走 stdout，日志走 stderr。",
        "",
        "环境变量：",
        "  EXT_PW_CORE   playwright-core index.* 绝对路径（未设则从仓库 node_modules 找）",
        "  EXT_CHROME    Chrome/Edge 可执行文件绝对路径（未设则用各平台默认安装位置）",
        "  EXC_BASE      页面地址，默认 http://127.0.0.1:5174",
        "  EXT_DEV_PORT  需要自动拉起 dev server 时用的端口（默认取 EXC_BASE 的端口）",
        "",
        "宿主配置示例见 docs/mcp.md §6。",
        "",
    ].join("\n"));
    process.exit(0);
}

register(new URL("../../../tools/ts-resolve.mjs", import.meta.url));

const { runStdioServer } = await import("./server.ts");
process.exitCode = await runStdioServer();
