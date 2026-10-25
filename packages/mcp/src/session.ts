// @ext/mcp — 会话式 RPC 层（docs/development-plan.md §3.5）
//
// spike C 结论（development-plan.md:219、architecture-review.md:222）：MCP 不能
// 做成无状态工具调用——载入 + 仿真 + 读指纹必须落在同一个活电路上，否则每次
// 调用重建电路会丢时间轴与 scope 状态。因此协议是会话式的：
//   open -> load -> step -> measure -> export -> close
//
// 本文件定义三样东西：
//   1. SessionRpc          会话 RPC 接口（open/load/step/measure/export/close/isAlive）
//   2. InMemorySessionRpc  纯 Node 假实现——不连浏览器、不跑真引擎，只建模
//                          「会话生命周期 + 调用顺序 + 错误语义」。给
//                          tests/contract/mcp-session.test.mjs（D01 契约测试）
//                          和 D02 WebSocket 桥实现之前的本地调试用。
//   3. handleSessionRequest 线协议分发器：{ method, sessionId, params } 报文 →
//                          SessionRpc 调用。D02 的 Node 客户端与页面内桥共用
//                          这一报文形状。
//
// 错误语义（结构化返回，绝不向外抛异常——与 packages/netlist 的 applyOps 同风格）：
//   - 会话/生命周期/参数层错误：{ ok:false, error:{ code, message } }
//       unknown_session : sessionId 从未 open 过（含非字符串/缺失）
//       session_closed  : 会话已 close 后再调用（存活校验失败）
//       no_circuit      : load 成功之前 step/measure/export
//       invalid_args    : 参数非法（steps/seconds 同时给或都不给、非法 format 等）
//       load_failed     : 载入内容失败（附加 unsupported）
//       unknown_method  : 仅线协议分发器产生（method 不在六个方法之内）
//   - load 的内容级错误沿用网表装载语义：{ ok:false, unsupported:[...] }（透传形状，
//     与 packages/netlist 的 loader/applyOps 一致），不用 error 包装。

export type SessionErrorCode =
    | "unknown_session"
    | "session_closed"
    | "no_circuit"
    | "invalid_args"
    | "load_failed"
    | "unknown_method";

export interface SessionErrorBody {
    code: SessionErrorCode;
    message: string;
}

/** 会话层失败：{ ok:false, error:{code,message} }，不抛异常 */
export interface SessionFailure {
    ok: false;
    error: SessionErrorBody;
}

export interface OpenResult {
    ok: true;
    sessionId: string;
}

/** load 成功：时间轴归零；unsupported 恒为数组（透传 loader 形状） */
export interface LoadResult {
    ok: true;
    t: number;
    timeStepCount: number;
    unsupported: any[];
}

/** load 内容失败：沿用 packages/netlist 的 { ok:false, unsupported[] } 语义 */
export interface LoadContentFailure {
    ok: false;
    unsupported: any[];
}

export interface StepResult {
    ok: true;
    t: number;
    timeStepCount: number;
}

export type MeasureQuantity = "voltage" | "current" | "power";

export interface MeasureArgs {
    nets?: string[];
    components?: string[];
    quantity?: MeasureQuantity;
}

export interface MeasureResult {
    ok: true;
    t: number;
    quantity: MeasureQuantity;
    values: Record<string, number>;
}

export interface ExportArgs {
    format: "netlist" | "xml";
    layout?: boolean;
}

export interface ExportResult {
    ok: true;
    format: "netlist" | "xml";
    payload: string;
    bytes: number;
}

export interface CloseResult {
    ok: true;
    sessionId: string;
}

export interface SessionStepArgs {
    steps?: number;
    seconds?: number;
}

/**
 * 会话式 RPC 接口（docs/development-plan.md §3.5 的六方法 + 存活校验）。
 * 全部方法返回结构化结果，绝不向外抛异常。
 * D02 的 WebSocket 桥（attach 模式）实现同一接口；InMemorySessionRpc 是其假实现。
 */
export interface SessionRpc {
    /** 打开新会话；每次调用得到独立的新 sessionId */
    open(): Promise<OpenResult>;
    /**
     * 载入网表文本（netlist JSON 文本或 XML 文本，由真实后端区分）。
     * 成功后时间轴归零（t=0、timeStepCount=0）；对同一会话重复 load 允许
     * （重新载入），但会重置时间轴——这正是「无状态重建会丢时间轴」的语义。
     */
    load(sessionId: string, text: string): Promise<LoadResult | LoadContentFailure | SessionFailure>;
    /**
     * 推进仿真。steps（整数步数）与 seconds（按固定假步长换算成步数）二选一；
     * 都给/都不给/非法值 → invalid_args。load 之前 → no_circuit。
     */
    step(sessionId: string, args?: SessionStepArgs): Promise<StepResult | SessionFailure>;
    /**
     * 读测量值。nets（电压）与 components（current/power）二选一过滤；
     * 都给 → invalid_args；quantity 与过滤种类不匹配 → invalid_args；
     * 都不给 → 默认探针。load 之前 → no_circuit。t=0（load 后未 step）时
     * 返回初始工作点值。未知的 net/component 名只是不在 values 里（宽松读取）。
     */
    measure(sessionId: string, args?: MeasureArgs): Promise<MeasureResult | SessionFailure>;
    /** 导出。format 必须是 "netlist" | "xml"，否则 invalid_args；load 之前 → no_circuit。 */
    export(sessionId: string, args: ExportArgs): Promise<ExportResult | SessionFailure>;
    /** 关闭会话；关闭后任何操作 → session_closed；再次 close → session_closed。 */
    close(sessionId: string): Promise<CloseResult | SessionFailure>;
    /** 会话存活校验（同步、不抛异常）：open 过且未 close 才为 true。 */
    isAlive(sessionId: string): boolean;
}

// ---------------------------------------------------------------------------
// InMemory 假实现
// ---------------------------------------------------------------------------

/** 假步长：与引擎默认一致（core/ts/CircuitLoader.ts:73 maxTimeStep = 5e-6） */
export const FAKE_TIME_STEP = 5e-6;
/** 假 τ：n1 电压按 5·exp(-t/τ) 衰减（确定性，测试可精确对拍） */
const FAKE_TAU = 2e-3;
/** 无过滤时 measure 的默认探针（假电路：5V 初值放电 + 单元件 c0） */
const DEFAULT_NETS = ["n1", "GND"] as const;
const DEFAULT_COMPONENTS = ["c0"] as const;
/** 假电路里"存在"的探针集合：过滤时不在集合里的名字不进 values */
const KNOWN_NETS: ReadonlySet<string> = new Set(DEFAULT_NETS);
const KNOWN_COMPONENTS: ReadonlySet<string> = new Set(DEFAULT_COMPONENTS);

interface InMemorySessionState {
    id: string;
    alive: boolean;
    /** 最近一次 load 是否成功（load 内容失败不算 loaded） */
    loaded: boolean;
    t: number;
    timeStepCount: number;
    loadCount: number;
    /** 最近一次成功 load 的网表文本（export netlist 回显用） */
    text: string | null;
}

function fail(code: SessionErrorCode, message: string): SessionFailure {
    return { ok: false, error: { code, message } };
}

function isFailure(r: any): r is SessionFailure {
    return r != null && typeof r === "object" && r.ok === false && r.error != null;
}

/** 假电压：确定性衰减曲线；GND 恒 0。只建模会话语义，不做真网表解析。 */
function fakeVoltage(net: string, t: number): number {
    return net === "GND" || net === "0" ? 0 : 5 * Math.exp(-t / FAKE_TAU);
}

/** 假电流：v/1k（与 5V 初值自洽：t=0 时 5mA） */
function fakeCurrent(t: number): number {
    return 5e-3 * Math.exp(-t / FAKE_TAU);
}

function fakePower(t: number): number {
    return fakeVoltage("n1", t) * fakeCurrent(t);
}

/**
 * InMemory 假实现：会话状态存内存 Map，按 sessionId 寻址。
 * 每个会话有独立时间轴（t/timeStepCount 跨调用累积）——这就是「会话式而非
 * 无状态工具调用」的可观察契约：同一会话内连续 step，时间轴只进不退。
 */
export class InMemorySessionRpc implements SessionRpc {
    private sessions = new Map<string, InMemorySessionState>();
    private nextId = 0;

    async open(): Promise<OpenResult> {
        const id = `s${++this.nextId}`;
        this.sessions.set(id, {
            id,
            alive: true,
            loaded: false,
            t: 0,
            timeStepCount: 0,
            loadCount: 0,
            text: null,
        });
        return { ok: true, sessionId: id };
    }

    isAlive(sessionId: string): boolean {
        return this.sessions.get(String(sessionId))?.alive === true;
    }

    /** 存活校验：未知 id → unknown_session；已 close → session_closed */
    private live(sessionId: string): InMemorySessionState | SessionFailure {
        const s = this.sessions.get(String(sessionId));
        if (s == null) return fail("unknown_session", `unknown session "${sessionId}"`);
        if (!s.alive) return fail("session_closed", `session "${sessionId}" is closed`);
        return s;
    }

    async load(sessionId: string, text: string): Promise<LoadResult | LoadContentFailure | SessionFailure> {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (typeof text !== "string") return fail("invalid_args", "load 需要 string 类型的 text 参数");
        if (text.trim() === "") {
            // 内容级失败沿用 loader 形状：ok:false + unsupported，不进 error 通道
            return { ok: false, unsupported: [{ reason: "empty netlist text" }] };
        }
        s.loaded = true;
        s.t = 0;
        s.timeStepCount = 0;
        s.loadCount++;
        s.text = text;
        return { ok: true, t: 0, timeStepCount: 0, unsupported: [] };
    }

    async step(sessionId: string, args?: SessionStepArgs): Promise<StepResult | SessionFailure> {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (!s.loaded) return fail("no_circuit", "load a netlist before step");

        const steps = args?.steps;
        const seconds = args?.seconds;
        const hasSteps = steps !== undefined;
        const hasSeconds = seconds !== undefined;
        if (hasSteps && hasSeconds) {
            return fail("invalid_args", "step 的 steps 与 seconds 只能二选一");
        }
        let n: number;
        if (hasSteps) {
            if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1) {
                return fail("invalid_args", `steps 必须是正整数，收到 ${JSON.stringify(steps)}`);
            }
            n = steps;
        } else if (hasSeconds) {
            if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
                return fail("invalid_args", `seconds 必须是正的有限数，收到 ${JSON.stringify(seconds)}`);
            }
            n = Math.max(1, Math.round(seconds / FAKE_TIME_STEP));
        } else {
            return fail("invalid_args", "step 需要 steps 或 seconds 之一");
        }
        s.t += n * FAKE_TIME_STEP;
        s.timeStepCount += n;
        return { ok: true, t: s.t, timeStepCount: s.timeStepCount };
    }

    async measure(sessionId: string, args?: MeasureArgs): Promise<MeasureResult | SessionFailure> {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (!s.loaded) return fail("no_circuit", "load a netlist before measure");

        const nets = args?.nets;
        const components = args?.components;
        const quantity = args?.quantity ?? "voltage";
        if (quantity !== "voltage" && quantity !== "current" && quantity !== "power") {
            return fail("invalid_args", `quantity 必须是 voltage|current|power，收到 ${JSON.stringify(quantity)}`);
        }
        if (nets != null && components != null) {
            return fail("invalid_args", "measure 的 nets 与 components 只能二选一");
        }
        if (nets != null && quantity !== "voltage") {
            return fail("invalid_args", `nets 过滤只能读 voltage，收到 quantity=${quantity}`);
        }
        if (components != null && quantity === "voltage") {
            return fail("invalid_args", `components 过滤只能读 current|power，收到 quantity=${quantity}`);
        }

        const values: Record<string, number> = {};
        if (components != null) {
            for (const c of components) {
                if (KNOWN_COMPONENTS.has(c)) {
                    values[c] = quantity === "current" ? fakeCurrent(s.t) : fakePower(s.t);
                }
            }
        } else {
            for (const n of nets ?? DEFAULT_NETS) {
                // 假电路里不存在的 net 不进 values（宽松读取语义，见 interface 注释）
                if (KNOWN_NETS.has(n)) {
                    values[n] = fakeVoltage(n, s.t);
                }
            }
        }
        return { ok: true, t: s.t, quantity, values };
    }

    async export(sessionId: string, args: ExportArgs): Promise<ExportResult | SessionFailure> {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (!s.loaded) return fail("no_circuit", "load a netlist before export");

        const format = args?.format;
        if (format !== "netlist" && format !== "xml") {
            return fail("invalid_args", `format 必须是 netlist|xml，收到 ${JSON.stringify(format)}`);
        }
        const payload =
            format === "netlist"
                ? s.text ?? ""
                : `<?xml version="1.0" encoding="UTF-8"?>\n<!-- InMemorySessionRpc fake export; chars=${s.text?.length ?? 0}; t=${s.t} -->\n<circuit/>`;
        return { ok: true, format, payload, bytes: new TextEncoder().encode(payload).length };
    }

    async close(sessionId: string): Promise<CloseResult | SessionFailure> {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        s.alive = false;
        return { ok: true, sessionId: String(sessionId) };
    }
}

// ---------------------------------------------------------------------------
// 线协议分发器（D02 桥报文形状）
// ---------------------------------------------------------------------------

/** 线上来的报文（method 是六个会话方法之一；open 不带 sessionId） */
export interface SessionRequest {
    method: string;
    sessionId?: string;
    params?: any;
}

/** 把 { method, sessionId, params } 报文分发到 SessionRpc；未知 method → unknown_method */
export async function handleSessionRequest(rpc: SessionRpc, req: SessionRequest): Promise<any> {
    const id = req?.sessionId;
    switch (req?.method) {
        case "open":
            return rpc.open();
        case "load":
            return rpc.load(id as string, req?.params?.text);
        case "step":
            return rpc.step(id as string, req?.params);
        case "measure":
            return rpc.measure(id as string, req?.params);
        case "export":
            return rpc.export(id as string, req?.params);
        case "close":
            return rpc.close(id as string);
        default:
            return fail("unknown_method", `unknown session method ${JSON.stringify(req?.method)}`);
    }
}
