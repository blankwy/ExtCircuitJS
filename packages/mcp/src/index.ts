// @ext/mcp — MCP server（骨架）
//
// 传输：stdio（本地）+ 可选 http。后端两种模式：
//   attach  : 连到浏览器里的 ExtCircuitJS（WebSocket 桥，v0.1 目标）
//   headless: 在 Node 里跑求解器（v0.2；需要 HeadlessApp shim + canvas 桩）
//
// 协议形态是**会话式 RPC**（见 docs/development-plan.md §3.5）：
//   open -> load -> step -> measure -> export -> close
// 因为"载入/仿真/指纹"必须在浏览器内完成，无状态工具调用会反复重建电路。

export interface McpSession {
    id: string;
    load(text: string): Promise<{ ok: boolean; unsupported?: any[] }>;
    step(args: { steps?: number; seconds?: number }): Promise<{ t: number; stepCount: number }>;
    measure(args: { nets?: string[]; components?: string[] }): Promise<any>;
    export(args: { format: "netlist" | "xml"; layout?: boolean }): Promise<any>;
    close(): Promise<void>;
}

export interface McpTransport {
    open(): Promise<string>;
    send(sessionId: string, method: string, params: any): Promise<any>;
    close(sessionId: string): Promise<void>;
}

/** v0.1 待实现：WebSocket 桥（页面内 window.ExtCircuitJS 暴露的会话端点） */
export async function createAttachTransport(_url = "ws://127.0.0.1:5182/ext-mcp"): Promise<McpTransport> {
    throw new Error("attach transport not implemented yet — see docs/development-plan.md P4");
}

export const TOOLS = [
    "circuit.get_netlist",
    "circuit.load_netlist",
    "circuit.list_components",
    "circuit.set_param",
    "circuit.apply_ops",
    "sim.run",
    "sim.stop",
    "sim.reset",
    "sim.read_measurements",
    "sim.read_scope",
    "schematic.screenshot",
] as const;
