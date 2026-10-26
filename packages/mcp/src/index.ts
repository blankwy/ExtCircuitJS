// @ext/mcp — 包入口（真实现，不是骨架）
//
// 传输：stdio（标准 MCP 宿主可直接拉起，见 src/cli.mjs）+ 可选的浏览器内嵌会话。
// 后端：attach —— 真实引擎在浏览器里跑（dev server 页面），Node 侧只做协议、
// 参数校验、会话持有。无头求解器是 v0.2 的另一条路（需要 HeadlessApp shim）。
//
// 模块地图：
//   session.ts       会话式 RPC 的接口与内存实现（open → load → step → measure → export → close）
//   bridge-client.ts 环回 WebSocket 服务端（零依赖 RFC 6455 子集），页面桥连进来
//   tools.ts         MCP 工具面（MCP_TOOLS + AttachToolset），结构化返回、绝不抛
//   stdio.ts         MCP stdio 协议层（JSON-RPC over NDJSON），与后端解耦、纯 Node 可测
//   backend.ts       attach 后端生命周期（dev server 探活/拉起 → 浏览器页面 → 桥）
//   server.ts        组装：stdio + 懒启动后端
//   cli.mjs          进程入口（bin: ext-circuitjs-mcp）
//
// 协议形态是**会话式 RPC**（见 docs/development-plan.md §3.5）：
//   open -> load -> step -> measure -> export -> close
// 因为"载入/仿真/指纹"必须在浏览器内完成，无状态工具调用会反复重建电路。

export * from "./session";
export * from "./bridge-client";
export * from "./tools";
export * from "./stdio";
