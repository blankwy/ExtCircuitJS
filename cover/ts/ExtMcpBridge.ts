// Cover 层新增：MCP WebSocket 桥 —— 页面侧（D02，Stage 5）
//
// 角色：把 window.ExtCircuitJS 上的真实引擎封装成 D01（packages/mcp/src/session.ts）
// 定义的会话式 RPC（open → load → step → measure → export → close），经本地环回
// WebSocket 提供给 Node 侧客户端（packages/mcp/src/bridge-client.ts）。
//
// 会话与连接解耦：sessions Map 挂在页面生命周期上，WS 断开后页面按固定间隔自动
// 重连，会话、时间轴、元件状态原样存活——「会话跨一次重连存活」的可观察契约
// （zcode-goal_step.md Stage 5）。
//
// 纪律：
//   - 不改 core/ts 仿真循环。step 是「拉取」语义：冻结墙钟（Date.now）并按
//     tests/contract/netlist-g2.browser.mjs 的确定性配方手动驱动 runCircuit
//     （analyzeCircuit → preStampAndStampCircuit → runCircuit 帧循环）；
//     load 时暂停宿主自动步进（setSimRunning(false)），时间轴由会话显式 step
//     独占（轮询拉取，不推）。
//   - SSRF：connect() 只接受本地环回地址（127.0.0.1 / localhost / ::1），
//     其他 host 直接抛错。Node 侧也只监听 127.0.0.1（见 bridge-client.ts）。
//
// 装载方式：本模块是 cover 新增文件，不进入应用主包图（无人静态 import，
// ExtBoot 不动，保持 Stage 5 写作用域）。使用方在页面内动态 import 后自动挂载：
//   const m = await import("/@fs/…/cover/ts/ExtMcpBridge.ts");
//   window.ExtCircuitJS.mcp.connect("ws://127.0.0.1:<port>");
// （/@fs 由 Vite dev server 提供，须在 server.fs.allow 允许范围内。）
//
// 线协议（与 packages/mcp/src/bridge-client.ts 一致；res.payload 形状 = D01
// session.ts 的结构化返回，内容级失败沿用 {ok:false, unsupported[]} 不走 error）：
//   请求  {v:1, kind:"req", id:"q7", method:"step", sessionId:"p1", params:{...}}
//   应答  {v:1, kind:"res", id:"q7", payload:{ok:true, t:…, timeStepCount:…}}
// method ∈ echo | ping | open | isAlive | load | step | measure | export | close
//          （D03 工具集后端，packages/mcp/src/tools.ts 一一对应）
//          | list_components | set_param | sim_run | sim_stop | sim_reset
//          | read_scope | screenshot
// 错误码沿用 D01 六码（unknown_session / session_closed / no_circuit /
// invalid_args / load_failed / unknown_method），另有桥内两个扩展码：
//   sim_stopped    引擎 stopMessage 置位（奇异矩阵等），step 中止（只报不清理）
//   internal_error 分发中未预期的异常（兜底，正常不应出现）
//
// D03 方法语义（与 tools.ts 工具一一对应；会话纪律同上——live+loaded 校验，
// screenshot 只要求 live：画布截图是「视觉兜底」，不依赖会话是否载入过电路）：
//   list_components  元件清单（dumpNetlist 的稳定 id + 类型 + 参数投影）
//   set_param        {target,prop,value} → api.applyOps set + analyzeNow（G2 配方
//                    重 stamp，保证后续 step 确定性）
//   sim_run/stop     宿主实时步进的恢复/暂停（墙钟驱动，与会话显式 step 并存但
//                    不要混用——run 期间 step 的确定性不成立）
//   sim_reset        resetAction()（t=0、元件状态复位、scope 清空）+ analyzeNow +
//                    恢复暂停（resetAction 在 t===0 时会自动开跑，桥模式把时间轴
//                    交给会话显式 step，故复位后立刻恢复 paused）
//   read_scope       scope 波形缓冲**全量**返回（minValues/maxValues 环形缓冲原样，
//                    不降采样——zcode-goal_step.md Stage 5 禁止项）
//   screenshot       imageExporter 画布截图：png dataURL（CAC_IMAGE）或 svg 文本

export type ExtMcpBridgeState = "idle" | "connecting" | "online" | "stopped";

export interface ExtMcpBridgeOptions {
    /** 断线后重连间隔（ms），默认 500；固定间隔，不放大 */
    reconnectDelayMs?: number;
    /** 是否打 console 日志（浏览器端证据），默认 true */
    log?: boolean;
}

export interface ExtMcpBridgeStatus {
    state: ExtMcpBridgeState;
    url: string | null;
    sessions: number;
    aliveSessions: number;
    connects: number;
    reconnects: number;
    requests: number;
    responses: number;
    lastError: string | null;
}

/** 会话状态：页面生命周期，不随 WS 连接销毁（跨重连存活的全部秘密） */
interface BridgeSession {
    id: string;
    alive: boolean;
    loaded: boolean;
    openedAt: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** D01 风格结构化失败（绝不向外抛异常） */
function fail(code: string, message: string) {
    return { ok: false as const, error: { code, message } };
}

function isFailure(r: any): boolean {
    return r != null && typeof r === "object" && r.ok === false && r.error != null;
}

/** catch 变量在 strict 下是 unknown：统一转成可读消息 */
function errText(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
}

export class ExtMcpBridge {
    private readonly ext: any;
    private readonly opts: { reconnectDelayMs: number; log: boolean };
    /** 真实墙钟（构造时捕获）：runFor 冻结 Date.now 用它还原 */
    private readonly realNow: () => number = Date.now;
    private ws: WebSocket | null = null;
    private url: string | null = null;
    private state: ExtMcpBridgeState = "idle";
    private stopped = false;
    private reconnectTimer: any = null;
    /** 请求串行链：防止两个 step 的帧循环交错改引擎状态 */
    private chain: Promise<void> = Promise.resolve();
    private sessions = new Map<string, BridgeSession>();
    private nextSession = 0;
    private connects = 0;
    private requests = 0;
    private responses = 0;
    private lastError: string | null = null;

    constructor(ext: any, opts: ExtMcpBridgeOptions = {}) {
        if (ext == null || ext.app == null || ext.api == null) {
            throw new Error("ExtMcpBridge 需要 window.ExtCircuitJS 运行时句柄（app/api）");
        }
        this.ext = ext;
        this.opts = {
            reconnectDelayMs: opts.reconnectDelayMs ?? 500,
            log: opts.log ?? true,
        };
    }

    // ── 连接管理 ────────────────────────────────────────────────────────────

    /** 连到 Node 侧桥服务器；仅允许本地环回（SSRF 纪律），断线自动重连 */
    connect(url: string): void {
        let u: URL;
        try {
            u = new URL(url);
        } catch (e) {
            throw new Error(`ExtMcpBridge: 非法 URL ${JSON.stringify(url)}`);
        }
        if (u.protocol !== "ws:" && u.protocol !== "wss:") {
            throw new Error(`ExtMcpBridge: 仅支持 ws/wss 协议，收到 ${u.protocol}`);
        }
        if (!LOOPBACK_HOSTS.has(u.hostname)) {
            throw new Error(
                `ExtMcpBridge: 仅允许本地环回地址（ws://127.0.0.1:…），拒绝 ${u.hostname}`,
            );
        }
        this.url = url;
        this.stopped = false;
        this.state = "connecting";
        this.dial();
    }

    /** 主动断开并停止重连（会话保留，可再次 connect） */
    disconnect(): void {
        this.stopped = true;
        if (this.reconnectTimer != null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws != null) {
            try { this.ws.close(); } catch { /* already closing */ }
            this.ws = null;
        }
        this.state = "stopped";
        this.logLine("disconnected (manual)");
    }

    private dial(): void {
        if (this.stopped || this.url == null) return;
        this.state = "connecting";
        let ws: WebSocket;
        try {
            ws = new WebSocket(this.url);
        } catch (e) {
            this.lastError = errText(e);
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.onopen = () => {
            this.connects++;
            this.state = "online";
            this.logLine(`online ${this.url} (connect #${this.connects})`);
        };
        ws.onmessage = (ev: MessageEvent) => {
            this.onFrame(String(ev.data));
        };
        ws.onerror = () => {
            // onclose 随后必到，重连在那里统一处理
        };
        ws.onclose = () => {
            if (this.ws === ws) this.ws = null;
            this.state = this.stopped ? "stopped" : "connecting";
            if (!this.stopped) this.scheduleReconnect();
        };
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer != null) return;
        this.logLine(`socket closed; retry in ${this.opts.reconnectDelayMs}ms`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.dial();
        }, this.opts.reconnectDelayMs);
    }

    // ── 线协议 ──────────────────────────────────────────────────────────────

    private send(envelope: any): void {
        if (this.ws == null || this.ws.readyState !== WebSocket.OPEN) {
            this.lastError = "send: socket 未连接（应答丢失）";
            return;
        }
        try {
            this.ws.send(JSON.stringify(envelope));
            this.responses++;
        } catch (e) {
            this.lastError = errText(e);
        }
    }

    private onFrame(text: string): void {
        let msg: any;
        try {
            msg = JSON.parse(text);
        } catch (e) {
            this.lastError = "收到非 JSON 帧，忽略";
            return;
        }
        if (msg == null || msg.v !== 1 || msg.kind !== "req" || msg.id == null) return;
        this.requests++;
        // 串行分发：同一时刻只有一个请求在碰引擎
        this.chain = this.chain
            .then(() => this.dispatch(msg))
            .then((payload) => {
                this.send({ v: 1, kind: "res", id: msg.id, payload });
            })
            .catch((e) => {
                this.send({
                    v: 1,
                    kind: "res",
                    id: msg.id,
                    payload: fail("internal_error", errText(e)),
                });
            });
    }

    private async dispatch(msg: any): Promise<any> {
        const method = msg.method;
        const sessionId = msg.sessionId;
        const params = msg.params;
        switch (method) {
            case "echo":
                return { ok: true, echo: params ?? null };
            case "ping":
                return { ok: true, pong: true, t: this.sim()?.t ?? null, state: this.state };
            case "open":
                return this.openSession();
            case "isAlive": {
                const s = this.sessions.get(String(sessionId ?? ""));
                return { ok: true, alive: s != null && s.alive };
            }
            case "load":
                return this.load(sessionId, params?.text);
            case "step":
                return this.step(sessionId, params);
            case "measure":
                return this.measure(sessionId, params);
            case "export":
                return this.exportNetlist(sessionId, params);
            case "close":
                return this.closeSession(sessionId);
            case "list_components":
                return this.listComponents(sessionId);
            case "set_param":
                return this.setParam(sessionId, params);
            case "sim_run":
                return this.simRun(sessionId);
            case "sim_stop":
                return this.simStop(sessionId);
            case "sim_reset":
                return this.simReset(sessionId);
            case "read_scope":
                return this.readScope(sessionId, params);
            case "screenshot":
                return this.screenshot(params);
            default:
                return fail("unknown_method", `unknown session method ${JSON.stringify(method)}`);
        }
    }

    // ── 会话 RPC（语义对齐 D01 session.ts 的 SessionRpc）───────────────────

    private openSession(): any {
        const id = `p${++this.nextSession}`;
        this.sessions.set(id, { id, alive: true, loaded: false, openedAt: this.realNow() });
        return { ok: true, sessionId: id };
    }

    /** 存活校验：未知 id → unknown_session；已 close → session_closed */
    private live(sessionId: string): BridgeSession | any {
        const s = this.sessions.get(String(sessionId ?? ""));
        if (s == null) return fail("unknown_session", `unknown session "${sessionId}"`);
        if (!s.alive) return fail("session_closed", `session "${sessionId}" is closed`);
        return s;
    }

    private load(sessionId: string, text: any): any {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (typeof text !== "string") {
            return fail("invalid_args", "load 需要 string 类型的 text 参数");
        }
        const app = this.app();
        // 桥接管时间轴：暂停宿主自动步进（轮询拉取模型；不改 core 仿真循环）
        try { app.setSimRunning(false); } catch { /* UI 未就绪时忽略 */ }
        let loadError: string | null = null;
        try {
            this.ext.api.loadCircuitText(text, false);
        } catch (e) {
            loadError = errText(e);
        }
        if (loadError == null && (app.elmList?.length ?? 0) === 0) {
            loadError = "empty circuit (no elements parsed)";
        }
        if (loadError == null) {
            this.analyzeNow();
            if (app.stopMessage != null) {
                loadError = String(app.stopMessage);
                app.stopMessage = null; // 清掉以免毒化后续操作
            }
        }
        if (loadError != null) {
            // 内容级失败沿用 loader 形状：ok:false + unsupported，不走 error 通道
            return { ok: false, unsupported: [{ reason: loadError }] };
        }
        s.loaded = true;
        this.sim().resetTime(); // 载入成功时间轴归零（与 D01 语义一致）
        return { ok: true, t: 0, timeStepCount: 0, unsupported: [] };
    }

    private step(sessionId: string, args: any): any {
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
        let elapsed: number;
        if (hasSteps) {
            if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1) {
                return fail("invalid_args", `steps 必须是正整数，收到 ${JSON.stringify(steps)}`);
            }
            // 引擎自适应步长（minTimeStep→maxTimeStep 翻倍），steps:N 的确定性
            // 解释为「推进 N×maxTimeStep 仿真时间」；返回的 timeStepCount 是引擎真值
            elapsed = steps * Number(this.sim().maxTimeStep);
        } else if (hasSeconds) {
            if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
                return fail("invalid_args", `seconds 必须是正的有限数，收到 ${JSON.stringify(seconds)}`);
            }
            elapsed = seconds;
        } else {
            return fail("invalid_args", "step 需要 steps 或 seconds 之一");
        }

        const r = this.runFor(elapsed);
        if (r.stopped != null) {
            return fail("sim_stopped", `仿真停止：${r.stopped}`);
        }
        const sim = this.sim();
        return {
            ok: true,
            t: sim.t,
            timeStepCount: sim.timeStepCount,
            frames: r.frames,
            elapsedSim: r.elapsed,
        };
    }

    private measure(sessionId: string, args: any): any {
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

        // 电压读取走网表 pins → elmList 下标 → node.v（netlist-g2.browser.mjs 同款）
        const nl = this.ext.api.dumpNetlist();
        const elms: any[] = this.app().elmList ?? [];
        const values: Record<string, number> = {};
        if (components != null) {
            for (const c of components) {
                // 稳定 id（e1..eN）为主，旧 cN（下标即 elmList 下标）双轨兼容
                let idx = nl.components.findIndex((k: any) => k.id === c);
                if (idx < 0) {
                    const legacy = String(c).match(/^c(\d+)$/);
                    if (legacy) idx = Number(legacy[1]);
                }
                const elm = elms[idx];
                if (elm == null) continue; // 宽松：未知 id 不进 values
                if (quantity === "current") {
                    let cur: any = null;
                    try { cur = elm.getCurrent?.(); } catch { /* digital elm */ }
                    if (typeof cur === "number") values[c] = cur;
                } else {
                    let vd: any = null;
                    try { vd = elm.getVoltageDiff?.(); } catch { /* digital elm */ }
                    let cur: any = null;
                    try { cur = elm.getCurrent?.(); } catch { /* no current */ }
                    if (typeof vd === "number" && typeof cur === "number") values[c] = vd * cur;
                    else {
                        let p: any = null;
                        try { p = elm.getPower?.(); } catch { /* not a power elm */ }
                        if (typeof p === "number") values[c] = p;
                    }
                }
            }
        } else {
            const wanted: string[] = nets ?? nl.nets.map((n: any) => n.id);
            for (const want of wanted) {
                const net = nl.nets.find((n: any) => n.id === want);
                const pin = net?.pins?.[0];
                const m = pin != null ? String(pin).match(/^([^:]+):(\d+)$/) : null;
                if (m == null) continue; // 空 pins 网络 / 未知 net：宽松跳过
                const ci = nl.components.findIndex((k: any) => k.id === m[1]);
                if (ci < 0) continue;
                const v = elms[ci]?.nodes?.[Number(m[2])]?.v;
                if (typeof v === "number") values[want] = v;
            }
        }
        return { ok: true, t: this.sim().t, quantity, values };
    }

    private exportNetlist(sessionId: string, args: any): any {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (!s.loaded) return fail("no_circuit", "load a netlist before export");

        const format = args?.format;
        if (format !== "netlist" && format !== "xml") {
            return fail("invalid_args", `format 必须是 netlist|xml，收到 ${JSON.stringify(format)}`);
        }
        // D03 get_netlist 工具：layout 透传给导出（默认 false，坐标不输出）
        const payload =
            format === "netlist"
                ? JSON.stringify(this.ext.api.dumpNetlist({ layout: args?.layout === true }))
                : String(this.app().dumpCircuit());
        return { ok: true, format, payload, bytes: new TextEncoder().encode(payload).length };
    }

    private closeSession(sessionId: string): any {
        const s = this.sessions.get(String(sessionId ?? ""));
        if (s == null) return fail("unknown_session", `unknown session "${sessionId}"`);
        if (!s.alive) return fail("session_closed", `session "${sessionId}" is closed`);
        s.alive = false;
        return { ok: true, sessionId: s.id };
    }

    // ── D03 工具集后端（packages/mcp/src/tools.ts 一一对应）─────────────────
    // 会话纪律与上面一致：live + loaded；screenshot 只要求 live（视觉兜底）。

    /** 元件清单：dumpNetlist 的稳定 id（e1..eN）+ 类型 + 参数投影 */
    private listComponents(sessionId: string): any {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (!s.loaded) return fail("no_circuit", "load a netlist before list_components");
        const nl = this.ext.api.dumpNetlist();
        return {
            ok: true,
            t: this.sim().t,
            counts: { components: nl.components.length, nets: nl.nets.length },
            components: nl.components.map((c: any) => ({
                id: c.id,
                type: c.type,
                tag: c.tag,
                props: c.props,
            })),
            unsupported: nl.unsupported,
        };
    }

    /** 改元件参数：api.applyOps 单条 set + G2 配方 re-stamp（后续 step 才确定性） */
    private setParam(sessionId: string, args: any): any {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (!s.loaded) return fail("no_circuit", "load a netlist before set_param");

        const target = args?.target;
        const prop = args?.prop;
        const value = args?.value;
        if (typeof target !== "string" || target === "") {
            return fail("invalid_args", "set_param 需要 string 类型的 target（稳定 id 或旧 cN）");
        }
        if (typeof prop !== "string" || prop === "") {
            return fail("invalid_args", "set_param 需要 string 类型的 prop（registry 字段名）");
        }
        if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") {
            return fail("invalid_args", `set_param 的 value 必须是 number|string|boolean，收到 ${typeof value}`);
        }
        const r = this.ext.api.applyOps([{ op: "set", target, prop, value }]);
        if (r.applied > 0) {
            this.analyzeNow();
            if (this.app().stopMessage != null) {
                const m = String(this.app().stopMessage);
                this.app().stopMessage = null; // 清掉以免毒化后续操作
                return fail("sim_stopped", `改参后分析停止：${m}`);
            }
        }
        return {
            ok: r.ok === true,
            applied: r.applied,
            atoms: r.atoms,
            unsupported: r.unsupported,
            t: this.sim().t,
        };
    }

    /** 恢复宿主实时步进（墙钟驱动；stopMessage 置位时 setSimRunning(true) 是 no-op） */
    private simRun(sessionId: string): any {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (!s.loaded) return fail("no_circuit", "load a netlist before sim.run");
        try {
            this.app().setSimRunning(true);
        } catch (e) {
            return fail("internal_error", errText(e));
        }
        return {
            ok: true,
            running: this.app().simIsRunning?.() === true,
            t: this.sim().t,
            timeStepCount: this.sim().timeStepCount,
        };
    }

    /** 暂停宿主实时步进（时间轴回到会话显式 step 独占） */
    private simStop(sessionId: string): any {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (!s.loaded) return fail("no_circuit", "load a netlist before sim.stop");
        try {
            this.app().setSimRunning(false);
        } catch (e) {
            return fail("internal_error", errText(e));
        }
        return {
            ok: true,
            running: false,
            t: this.sim().t,
            timeStepCount: this.sim().timeStepCount,
        };
    }

    /**
     * 复位：resetAction()（t=0、元件状态复位、scope 清空）+ analyzeNow 重 stamp +
     * 恢复暂停。resetAction 在 t===0 时会自动 setSimRunning(true)（UI「复位即开跑」
     * 语义），桥模式时间轴由会话显式 step 独占，故复位后立刻恢复 paused——
     * running 状态只由 sim_run/sim_stop 显式控制。
     */
    private simReset(sessionId: string): any {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (!s.loaded) return fail("no_circuit", "load a netlist before sim.reset");
        try {
            this.app().resetAction();
        } catch (e) {
            return fail("internal_error", errText(e));
        }
        this.analyzeNow();
        if (this.app().stopMessage != null) {
            const m = String(this.app().stopMessage);
            this.app().stopMessage = null;
            return fail("sim_stopped", `复位后分析停止：${m}`);
        }
        try {
            this.app().setSimRunning(false);
        } catch { /* UI 未就绪时忽略 */ }
        return {
            ok: true,
            running: false,
            t: this.sim().t,
            timeStepCount: this.sim().timeStepCount,
        };
    }

    // ScopeConstants.ts 的常量（core 只读，此处按值镜像并注明出处）
    private static readonly SCOPE_VALUE_NAMES: Record<number, string> = {
        0: "voltage", // VAL_VOLTAGE
        3: "current", // VAL_CURRENT
        7: "power", // VAL_POWER
    };
    private static readonly SCOPE_UNITS_NAMES: Record<number, string> = {
        0: "V", // UNITS_V
        1: "A", // UNITS_A
        2: "W", // UNITS_W
        3: "ohm", // UNITS_OHMS
        4: "C", // UNITS_C
    };

    /**
     * scope 波形数据：minValues/maxValues 环形缓冲**全量**返回，不做任何降采样
     * （zcode-goal_step.md Stage 5 禁止项「read_scope 不做降采样防爆 token」）。
     * 缓冲是环形：pointCount 为容量，ptr 为当前写指针，min/max 同下标成对。
     */
    private readScope(sessionId: string, args: any): any {
        const s = this.live(sessionId);
        if (isFailure(s)) return s;
        if (!s.loaded) return fail("no_circuit", "load a netlist before read_scope");

        const sm = this.app().scopeManager;
        if (sm == null) return fail("internal_error", "scopeManager 尚未初始化");
        const idx = args?.index;
        if (idx !== undefined &&
            (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= sm.scopeCount)) {
            return fail("invalid_args", `index 必须是 0..${sm.scopeCount - 1} 的整数，收到 ${JSON.stringify(idx)}`);
        }

        // 稳定 id：exportNetlist 的 components 与 elmList 同序，用 elmList 下标反查
        const nl = this.ext.api.dumpNetlist();
        const elms: any[] = this.app().elmList ?? [];
        const elmIdOf = (elm: any): { id: string | null; type: string | null } => {
            if (elm == null) return { id: null, type: null };
            const i = elms.indexOf(elm);
            return {
                id: i >= 0 ? (nl.components[i]?.id ?? null) : null,
                type: elm.getClassName?.() ?? null,
            };
        };

        const scopes: any[] = [];
        for (let i = 0; i < sm.scopeCount; i++) {
            if (typeof idx === "number" && i !== idx) continue;
            const sc = sm.scopes[i];
            if (sc == null) continue;
            const plots = (sc.plots ?? []).map((p: any) => {
                const e = elmIdOf(p.elm);
                return {
                    elm: e.id,
                    elmType: e.type,
                    value: p.value,
                    valueName: ExtMcpBridge.SCOPE_VALUE_NAMES[p.value] ?? `other(${p.value})`,
                    units: p.units,
                    unitsName: ExtMcpBridge.SCOPE_UNITS_NAMES[p.units] ?? `other(${p.units})`,
                    pointCount: p.scopePointCount,
                    ptr: p.ptr,
                    lastValue: p.lastValue,
                    // 全量缓冲，原样（禁止降采样）
                    minValues: Array.from(p.minValues ?? []),
                    maxValues: Array.from(p.maxValues ?? []),
                };
            });
            scopes.push({ index: i, position: sc.position, plots });
        }
        return {
            ok: true,
            t: this.sim().t,
            scopeCount: sm.scopeCount,
            returned: scopes.length,
            scopes,
        };
    }

    /** 画布截图：png dataURL（ImageExporter.CAC_IMAGE=1，core/ts/ImageExporter.ts:28）或 svg 文本 */
    private screenshot(args: any): any {
        const format = args?.format ?? "png";
        if (format !== "png" && format !== "svg") {
            return fail("invalid_args", `format 必须是 png|svg，收到 ${JSON.stringify(format)}`);
        }
        const exporter = this.app().imageExporter;
        if (exporter == null) return fail("internal_error", "imageExporter 尚未初始化");
        let data: string;
        try {
            data = format === "png"
                ? String(exporter.getCircuitAsCanvas(1).toDataURL())
                : String(exporter.getCircuitAsSVG());
        } catch (e) {
            return fail("internal_error", `截图失败：${errText(e)}`);
        }
        return { ok: true, format, data, bytes: new TextEncoder().encode(data).length };
    }

    // ── 引擎驱动（确定性配方，见文件头纪律段）──────────────────────────────

    private app(): any {
        return this.ext.app;
    }

    private sim(): any {
        return this.ext.app?.sim;
    }

    /** G2 配方：analyzeCircuit 后必须 preStampAndStampCircuit（只 preStamp 会在 NaN 检查处崩） */
    private analyzeNow(): void {
        const app = this.app();
        app.needAnalyze();
        app.sim.analyzeCircuit();
        app.analyzeFlag = false;
        app.sim.preStampAndStampCircuit();
    }

    /**
     * 冻结墙钟 + 手动驱动 runCircuit 帧循环，直到 sim.t 前进 elapsedTarget。
     * 与 netlist-g2.browser.mjs stepFor 相同的配方；结束时还原 Date.now。
     */
    private runFor(
        elapsedTarget: number,
        maxFrames = 20000,
    ): { frames: number; elapsed: number; stopped: string | null } {
        const app = this.app();
        const sim = this.sim();
        // 固定 epoch 起点逐帧 +16ms：绕过 runCircuit 的墙钟节流
        // （若 Date.now 恒定，tm-lastIterTime 恒 0，1000>=steprate*0 每帧早退，t 不动）
        let fake = 1700000000000;
        Date.now = () => fake;
        try {
            const t0 = sim.t;
            let frames = 0;
            const frame = (didAnalyze: boolean) => {
                fake += 16;
                if (app.analyzeFlag) {
                    app.analyzeFlag = false;
                    sim.analyzeCircuit();
                }
                sim.runCircuit(didAnalyze);
                frames++;
            };
            frame(true); // didAnalyze=true：越过墙钟节流的首帧
            while (sim.t - t0 < elapsedTarget && frames < maxFrames && app.stopMessage == null) {
                frame(false);
            }
            return { frames, elapsed: sim.t - t0, stopped: app.stopMessage ?? null };
        } finally {
            Date.now = this.realNow;
        }
    }

    // ── 杂项 ────────────────────────────────────────────────────────────────

    status(): ExtMcpBridgeStatus {
        let alive = 0;
        for (const s of this.sessions.values()) if (s.alive) alive++;
        return {
            state: this.state,
            url: this.url,
            sessions: this.sessions.size,
            aliveSessions: alive,
            connects: this.connects,
            reconnects: Math.max(0, this.connects - 1),
            requests: this.requests,
            responses: this.responses,
            lastError: this.lastError,
        };
    }

    private logLine(msg: string): void {
        if (this.opts.log) console.log(`[ExtMcpBridge] ${msg}`);
    }
}

// ── 挂载（经 window.ExtCircuitJS 暴露）────────────────────────────────────

let attached: ExtMcpBridge | null = null;

/** 把桥挂到 window.ExtCircuitJS.mcp（重复调用幂等，返回同一实例） */
export function attachMcpBridge(ext?: any, opts?: ExtMcpBridgeOptions): ExtMcpBridge {
    const target = ext ?? (window as any).ExtCircuitJS;
    if (target == null) throw new Error("ExtMcpBridge: window.ExtCircuitJS 尚未就绪");
    if (attached) return attached;
    attached = new ExtMcpBridge(target, opts);
    (target as any).mcp = attached;
    console.log("[ExtMcpBridge] attached to window.ExtCircuitJS; call connect(ws://127.0.0.1:<port>)");
    return attached;
}

export function getMcpBridge(): ExtMcpBridge | null {
    return attached;
}

// 模块加载即挂载（使用方在 ExtBoot 完成后动态 import 本模块）
if (typeof window !== "undefined") {
    const w = window as any;
    if (w.ExtCircuitJS != null && w.ExtCircuitJS.mcp == null) {
        try {
            attachMcpBridge(w.ExtCircuitJS);
        } catch (e) {
            console.error("[ExtMcpBridge] attach failed:", e);
        }
    }
}
