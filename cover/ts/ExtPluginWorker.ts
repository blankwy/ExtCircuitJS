// Cover 层新增：Worker 模式插件桥（B08）
//
// 目标：让不可信插件跑在 Web Worker 里，拿不到 DOM、拿不到引擎对象。
// 它只能经 postMessage 向宿主要"服务的答案"，宿主按授予权限代理到 ExtApi。
//
// 协议（两边共用，明文在文件头方便对拍）：
//   worker → host  { id: "w1", method: "getNetlist"|"getMeasurements"|"step"|"report", params? }
//                   —— worker 主动请求数据（它是 RPC 客户端），宿主 serve 后回复
//   host  → worker { id: "w1", ok: true, data } | { id: "w1", ok: false, error }
//   host  → worker { id: "rpc-1", method: "activate"|"deactivate" }   —— 生命周期管理信号（宿主→worker）
//   worker → host  { id: "rpc-1", ok: true }                          —— 对管理信号的应答
//
// 权限面（与 in-page 的 ctx 同源，宿主侧校验）：
//   sim.observe  -> getMeasurements / step
//   sim.control  -> step 的仿真推进（复用 G2 确定性步进）
// 未授予的方法返回结构化错误，绝不把引擎对象传给 worker。

export interface WorkerRpcRequest {
    id: string;
    method: string;
    params?: any;
}
export interface WorkerRpcResponse {
    id: string;
    ok: boolean;
    data?: any;
    error?: string;
}

/** 宿主侧：封装一个 Worker 的 request/response，供插件桥与测试共用。
 *  双向：host→worker 管理信号（request()）；worker→host 数据请求（serve 并回帖）。 */
export class WorkerRpcClient {
    private pending = new Map<string, (r: WorkerRpcResponse) => void>();
    private seq = 0;
    private readonly worker: Worker;
    private readonly serve: (req: WorkerRpcRequest) => Promise<any>;
    readonly onMessage: (ev: MessageEvent) => void;

    constructor(
        worker: Worker,
        /** worker 主动请求的服务实现：入参 method/params，返回 data（或抛错 → 回 ok:false） */
        serve: (req: WorkerRpcRequest) => Promise<any>,
    ) {
        // 显式字段而非参数属性：Node strip-only 模式（tests/contract/fiber.test.mjs）不认参数属性。
        this.worker = worker;
        this.serve = serve;
        this.onMessage = (ev: MessageEvent) => {
            const msg = ev.data as WorkerRpcResponse & WorkerRpcRequest;
            if (!msg || typeof msg.id !== "string") return;
            if (msg.id.startsWith("rpc-")) {
                // 宿主→worker 管理信号的应答
                const resolve = this.pending.get(msg.id);
                if (resolve) {
                    this.pending.delete(msg.id);
                    resolve(msg);
                }
                return;
            }
            // worker→host 数据请求：serve 并回帖（不 resolve pending）
            void (async () => {
                let out: WorkerRpcResponse;
                try {
                    const data = await this.serve(msg);
                    out = { id: msg.id, ok: true, data };
                } catch (e: any) {
                    out = { id: msg.id, ok: false, error: String(e?.message ?? e) };
                }
                try { this.worker.postMessage(out); } catch { /* worker gone */ }
            })();
        };
        this.worker.addEventListener("message", this.onMessage);
    }

    request<T = any>(method: string, params?: any, timeoutMs = 30000): Promise<T> {
        const id = `rpc-${++this.seq}`;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`worker rpc "${method}" timeout`));
            }, timeoutMs);
            this.pending.set(id, (r) => {
                clearTimeout(timer);
                if (r.ok) resolve(r.data as T);
                else reject(new Error(r.error ?? `worker rpc "${method}" failed`));
            });
            const req: WorkerRpcRequest = { id, method, params };
            try {
                this.worker.postMessage(req);
            } catch (e: any) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    dispose(): void {
        this.worker.removeEventListener("message", this.onMessage);
        for (const [, resolve] of this.pending) resolve({ id: "", ok: false, error: "worker disposed" });
        this.pending.clear();
        try { this.worker.terminate(); } catch { /* already gone */ }
    }
}

/** 构造一个经典 Worker（插件样例用 classic 最稳；module 可经 createPluginWorker(url,"module") 演进） */
export function createPluginWorker(url: string, type: "module" | "classic" = "classic"): Worker {
    return new Worker(url, type === "module" ? { type: "module" } : undefined);
}