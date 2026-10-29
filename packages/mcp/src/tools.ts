// @ext/mcp — 工具集（D03，Stage 5，attach 模式）
//
// 角色：MCP 工具层。每个工具 = { name, description, inputSchema, handler }，
// attach 模式下 handler 经 D02 的 McpBridgeClient（bridge-client.ts）把请求转发到
// 页面内桥（cover/ts/ExtMcpBridge.ts）——真实引擎语义（载入/步进/测量/截图）全部
// 落在浏览器内，Node 侧只做参数校验、会话持有与结构化返回（spike C 结论：
// 会话式 RPC，绝不每次调用重建电路）。
//
// 结构化返回纪律（与 D01 session.ts 同约定，绝不向外抛异常）：
//   - 成功：{ ok:true, … }
//   - RPC 层失败：透传页面桥 payload（{ ok:false, error:{code,message} } 或
//     load 内容失败的 { ok:false, unsupported:[…] }，不用 error 包装）
//   - 传输层失败（页面未连/超时/断开）：{ ok:false, error:{code:"bridge_unavailable"} }
//   - 工具层失败：unknown_tool / invalid_args（本文件校验产生）
//
// sim.read_scope：返回 minValues/maxValues 成对缓冲。默认在页面桥侧降采样到
// maxPoints=240（分桶保峰谷——尖峰/过冲不丢），maxPoints=0 取全量。
// 降采样是为了控制 token：500px 示波器的原始缓冲是 500 对数字，读几条就爆上下文。

import type { McpBridgeClient } from "./bridge-client";
import { BridgeTransportError } from "./bridge-client";

// ── 工具声明 ────────────────────────────────────────────────────────────────

export type McpToolName =
    | "circuit.get_netlist"
    | "circuit.load_netlist"
    | "circuit.list_components"
    | "circuit.set_param"
    | "sim.run"
    | "sim.stop"
    | "sim.step"
    | "sim.reset"
    | "sim.read_measurements"
    | "sim.read_scope"
    | "schematic.screenshot";

export interface McpToolSpec {
    name: McpToolName;
    description: string;
    /** JSON Schema（MCP tools/list 形状） */
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export const MCP_TOOLS: McpToolSpec[] = [
    {
        name: "circuit.get_netlist",
        description:
            "读取当前电路的网表。format=netlist（默认）返回命名 JSON（会话内稳定 id e1..eN，layout:true 时附带坐标）；" +
            "format=compact 返回紧凑投影（自描述：带 t 类型图例，约 0.41× XML、约为命名 JSON 的 1/6）——" +
            "它**没有坐标、没有导线行**，是只读视图，不能喂回 load_netlist",
        inputSchema: {
            type: "object",
            properties: {
                layout: { type: "boolean", description: "是否输出 x1 y1 x2 y2 坐标（仅 format=netlist，默认 false）" },
                format: {
                    type: "string",
                    enum: ["netlist", "compact"],
                    description: "netlist = 命名 JSON（默认）；compact = 紧凑投影（自描述、无坐标）",
                },
                legend: {
                    type: "boolean",
                    description: "format=compact 时是否带类型图例 t（默认 true；关掉更小，但要自己拿 registry 翻译）",
                },
            },
        },
    },
    {
        name: "circuit.load_netlist",
        description:
            "载入电路：三选一的字符串 —— core 电路文本 / XML / 网表 JSON。" +
            "网表 JSON 会经编译器重建坐标与导线（C07）：带 layout 的网表坐标照搬，" +
            "无 layout 时自动布局（只支持 2 端元件，多端元件会返回 needs_layout）。" +
            "编译后按节点身份校验拓扑，不一致就回滚并返回 unsupported（电路不变）；" +
            "成功返回 {ok:true, stats, losses}，时间轴归零。" +
            "注意紧凑格式（C05）**不能**直接载入：它是只读投影、没有坐标，先用解码器转成命名网表",
        inputSchema: {
            type: "object",
            properties: { text: { type: "string", description: "电路文本（core 文本 / XML）或网表 JSON" } },
            required: ["text"],
        },
    },
    {
        name: "circuit.list_components",
        description: "元件清单：稳定 id + 类型 + tag + 参数（AI 编辑的前置）",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "circuit.set_param",
        description: "按稳定 id（或旧 cN）修改元件参数；成功后自动重分析，后续仿真按新参数步进",
        inputSchema: {
            type: "object",
            properties: {
                target: { type: "string", description: "元件稳定 id（e1..eN）或旧 cN 下标" },
                prop: { type: "string", description: "参数字段名（如 resistance/capacitance）" },
                value: { type: ["number", "string", "boolean"], description: "新值" },
            },
            required: ["target", "prop", "value"],
        },
    },
    {
        name: "sim.run",
        description: "恢复宿主实时步进（墙钟驱动；与显式 step 并存但确定性不保证）",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "sim.stop",
        description: "暂停宿主实时步进，时间轴回到会话显式 step 独占",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "sim.step",
        // 确定性入口：页面桥内部冻结 Date.now，按 G2 配方手动驱动
        // analyzeCircuit → preStampAndStampCircuit → runCircuit 帧循环，同一电路同一
        // 步数必得同一电压。sim.run 走墙钟，外部调用方无法用它对拍。
        description:
            "确定性推进仿真：steps（整数步数）与 seconds（按固定假步长折算）二选一；" +
            "返回 {t, timeStepCount}。与 sim.run 的墙钟步进互斥使用",
        inputSchema: {
            type: "object",
            properties: {
                steps: { type: "integer", description: "推进的引擎步数（正整数）" },
                seconds: { type: "number", description: "按仿真时间推进（秒，正数）" },
            },
        },
    },
    {
        name: "sim.reset",
        description: "复位：t=0、元件状态复位、scope 清空；保持会话接管（paused）",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "sim.read_measurements",
        description: "读瞬时测量值：net 电压 / 元件电流 / 功率；nets 与 components 二选一",
        inputSchema: {
            type: "object",
            properties: {
                nets: { type: "array", items: { type: "string" }, description: "要读电压的网络 id" },
                components: { type: "array", items: { type: "string" }, description: "要读电流/功率的元件 id" },
                quantity: { type: "string", enum: ["voltage", "current", "power"] },
            },
        },
    },
    {
        name: "sim.read_scope",
        description:
            "读 scope 波形缓冲（minValues/maxValues 成对；pointCount 为容量、ptr 为写指针）。" +
            "默认降采样到 maxPoints=240 点（分桶保峰谷，尖峰不丢）；maxPoints=0 取全量。" +
            "返回含 fullPointCount 与 downsampled，便于判断保真度。index 可选只读一个 scope",
        inputSchema: {
            type: "object",
            properties: {
                index: { type: "integer", description: "scope 下标（默认全部）" },
                maxPoints: {
                    type: "integer",
                    description: "每个波形最多返回多少点（默认 240；0 = 全量不降采样）",
                },
            },
        },
    },
    {
        name: "schematic.screenshot",
        description: "当前画布截图：png（dataURL）或 svg（文本）；视觉兜底",
        inputSchema: {
            type: "object",
            properties: { format: { type: "string", enum: ["png", "svg"], description: "默认 png" } },
        },
    },
];

// ── 返回形状 ────────────────────────────────────────────────────────────────

/** 工具层错误码（页面桥错误码原样透传，见文件头） */
export type ToolErrorCode =
    | "unknown_tool"
    | "invalid_args"
    | "bridge_unavailable"
    | "internal_error";

export interface ToolFailure {
    ok: false;
    error: { code: string; message: string };
}

export type ToolResult = { ok: true } & Record<string, unknown> | ToolFailure;

function fail(code: ToolErrorCode, message: string): ToolFailure {
    return { ok: false, error: { code, message } };
}

/** RPC 层 payload 是否成功（页面桥约定 payload.ok === true） */
function isPayloadOk(p: any): boolean {
    return p != null && typeof p === "object" && p.ok === true;
}

/** 把传输层异常转成结构化失败（绝不向外抛） */
function transportFailure(e: unknown): ToolFailure {
    if (e instanceof BridgeTransportError) return fail("bridge_unavailable", e.message);
    const msg = e instanceof Error ? e.message : String(e);
    return fail("internal_error", msg);
}

// ── 参数校验（薄：类型/形状；语义校验权在页面桥）───────────────────────────

function validate(spec: McpToolSpec, args: any): ToolFailure | null {
    if (args == null) args = {};
    if (typeof args !== "object" || Array.isArray(args)) {
        return fail("invalid_args", `${spec.name} 的参数必须是 object，收到 ${typeof args}`);
    }
    const schema = spec.inputSchema;
    for (const key of schema.required ?? []) {
        if (args[key] === undefined) return fail("invalid_args", `${spec.name} 缺少必填参数 "${key}"`);
    }
    for (const [key, defAny] of Object.entries(schema.properties)) {
        const def = defAny as any;
        const v = args[key];
        if (v === undefined) continue;
        const type = def?.type;
        const types = Array.isArray(type) ? type : type != null ? [type] : [];
        if (types.length === 0) continue;
        const actual = Array.isArray(v) ? "array" : typeof v;
        const ok = types.some((t) =>
            t === "integer" ? typeof v === "number" && Number.isInteger(v) : t === actual,
        );
        if (!ok) {
            return fail("invalid_args", `${spec.name} 的参数 "${key}" 应为 ${types.join("|")}，收到 ${actual}`);
        }
        if (Array.isArray(def?.enum) && !def.enum.includes(v)) {
            return fail("invalid_args", `${spec.name} 的参数 "${key}" 必须是 ${def.enum.join("|")}，收到 ${JSON.stringify(v)}`);
        }
    }
    return null;
}

// ── attach 模式工具集 ───────────────────────────────────────────────────────

export interface AttachToolsetOptions {
    /** 单个桥请求的默认超时（ms），默认 30000（截图/步进可能慢于 bridge 默认 15s） */
    timeoutMs?: number;
}

/**
 * attach 模式工具集：持有一个页面桥会话（懒打开），工具调用全部落在同一
 * 活电路上——时间轴与 scope 状态跨调用保持（会话式而非无状态）。
 */
export class AttachToolset {
    private readonly bridge: McpBridgeClient;
    private readonly timeoutMs: number;
    private sessionId: string | null = null;

    constructor(bridge: McpBridgeClient, opts: AttachToolsetOptions = {}) {
        this.bridge = bridge;
        this.timeoutMs = opts.timeoutMs ?? 30_000;
    }

    /** 当前会话 id（尚未懒打开时为 null） */
    get id(): string | null {
        return this.sessionId;
    }

    /** 工具声明（MCP tools/list 形状） */
    listTools(): McpToolSpec[] {
        return MCP_TOOLS;
    }

    /** 显式打开会话（不传 call() 也会懒打开）；重复打开会丢弃旧 sessionId */
    async openSession(): Promise<ToolResult> {
        try {
            const r = await this.bridge.request("open", { timeoutMs: this.timeoutMs });
            if (!isPayloadOk(r)) {
                return r != null && typeof r === "object" && r.ok === false && r.error != null
                    ? r as ToolFailure
                    : fail("internal_error", `open 返回了意外形状: ${JSON.stringify(r)}`);
            }
            this.sessionId = r.sessionId;
            return { ok: true, sessionId: r.sessionId };
        } catch (e) {
            return transportFailure(e);
        }
    }

    /** 关闭当前会话（工具集之后可继续 call，会懒打开新会话） */
    async closeSession(): Promise<ToolResult> {
        const sid = this.sessionId;
        if (sid == null) return { ok: true, sessionId: null };
        this.sessionId = null;
        try {
            const r = await this.bridge.request("close", { sessionId: sid, timeoutMs: this.timeoutMs });
            return isPayloadOk(r) ? { ok: true, sessionId: sid } : (r as ToolFailure);
        } catch (e) {
            return transportFailure(e);
        }
    }

    /**
     * 调用一个工具。结构化返回，绝不抛异常：
     *   - unknown_tool / invalid_args：本层校验
     *   - bridge_unavailable / internal_error：传输层与兜底
     *   - 其余 ok:false 原样透传页面桥 payload（含 load 的 unsupported 形状）
     */
    async call(name: string, args?: any): Promise<ToolResult> {
        const spec = MCP_TOOLS.find((t) => t.name === name);
        if (spec == null) {
            return fail("unknown_tool", `unknown tool ${JSON.stringify(name)}；可用: ${MCP_TOOLS.map((t) => t.name).join(", ")}`);
        }
        const bad = validate(spec, args);
        if (bad != null) return bad;
        try {
            if (this.sessionId == null) {
                const opened = await this.openSession();
                if (!opened.ok) return opened;
            }
            return await this.dispatch(spec.name, args ?? {});
        } catch (e) {
            return transportFailure(e);
        }
    }

    // ── 工具 → 页面桥方法映射 ────────────────────────────────────────────────

    private async dispatch(name: McpToolName, args: any): Promise<ToolResult> {
        const sid = this.sessionId!;
        const req = (method: string, params?: any, timeoutMs?: number) =>
            this.bridge.request(method, { sessionId: sid, params, timeoutMs: timeoutMs ?? this.timeoutMs });
        switch (name) {
            case "circuit.get_netlist": {
                const format = args.format === "compact" ? "compact" : "netlist";
                const r = await req("export", {
                    format,
                    layout: args.layout === true,
                    // 图例默认开：位置化的 props 不带字段名就是一串数字，
                    // 消费方要么读不懂、要么得自带 255 个类型的 registry
                    legend: args.legend !== false,
                });
                if (!isPayloadOk(r)) return r as ToolResult;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(r.payload);
                } catch (e) {
                    return fail("internal_error", `${format} payload 不是合法 JSON: ${(e as Error).message}`);
                }
                return format === "compact"
                    ? { ok: true, format, compact: parsed, bytes: r.bytes }
                    : { ok: true, format, netlist: parsed, bytes: r.bytes };
            }
            case "circuit.load_netlist": {
                // 内容失败 {ok:false,unsupported[]} 原样透传（loader 形状，不走 error）
                return (await req("load", { text: args.text })) as ToolResult;
            }
            case "circuit.list_components":
                return (await req("list_components")) as ToolResult;
            case "circuit.set_param":
                return (await req("set_param", { target: args.target, prop: args.prop, value: args.value })) as ToolResult;
            case "sim.run":
                return (await req("sim_run")) as ToolResult;
            case "sim.stop":
                return (await req("sim_stop")) as ToolResult;
            case "sim.step": {
                // 二选一在工具层先挡（页面桥也会判，但这里给出更早、更明确的 invalid_args）
                const hasSteps = args.steps !== undefined;
                const hasSeconds = args.seconds !== undefined;
                if (hasSteps === hasSeconds) {
                    return fail("invalid_args", "sim.step 需要 steps 或 seconds 之一（且只能一个）");
                }
                const params: any = {};
                if (hasSteps) params.steps = args.steps;
                if (hasSeconds) params.seconds = args.seconds;
                return (await req("step", params)) as ToolResult;
            }
            case "sim.reset":
                return (await req("sim_reset")) as ToolResult;
            case "sim.read_measurements": {
                const params: any = {};
                if (args.nets !== undefined) params.nets = args.nets;
                if (args.components !== undefined) params.components = args.components;
                if (args.quantity !== undefined) params.quantity = args.quantity;
                return (await req("measure", params)) as ToolResult;
            }
            case "sim.read_scope": {
                // minValues/maxValues 成对返回；默认在桥侧降采样到 240 点（分桶保峰谷）
                const params: any = {};
                if (args.index !== undefined) params.index = args.index;
                if (args.maxPoints !== undefined) params.maxPoints = args.maxPoints;
                return (await req("read_scope", params)) as ToolResult;
            }
            case "schematic.screenshot": {
                const params: any = {};
                if (args.format !== undefined) params.format = args.format;
                return (await req("screenshot", params)) as ToolResult;
            }
        }
    }
}

/** 便捷工厂：attach 模式工具集 */
export function createAttachToolset(bridge: McpBridgeClient, opts?: AttachToolsetOptions): AttachToolset {
    return new AttachToolset(bridge, opts);
}
