// Ext Worker Demo（B08）：跑在 Web Worker 里的不可信插件。
//
// 它能且只能经 postMessage 向宿主要答案（自己是 RPC 客户端，宿主是 serve 方）：
//   getNetlist()      读网表（元件数/稳定 id）
//   getMeasurements() 读测量（sim.observe 权限）
//   step()            推进仿真（确定性，宿主 G2 配方；sim.control 权限）
//   report(...)       打日志（透传到宿主 console，前缀 [worker:id]）
// 拿不到 DOM、拿不到引擎对象——这是"隔离不可信插件"的最小面。
//
// 宿主→worker 另有生命周期管理信号（activate/deactivate），由宿主的 request() 发出，
// 这里对应回复 { id, ok: true }。协议全文见 cover/ts/ExtPluginWorker.ts 文件头。

self.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.id !== "string") return;

    if (msg.id.startsWith("rpc-")) {
        // 宿主管理信号（activate / deactivate）
        if (msg.method === "activate") {
            // 激活即就绪：宿主 await 到这一步才把 fiber 置 ready
            self.postMessage({ id: msg.id, ok: true, data: { ready: true, id: msg.params?.id } });
        } else if (msg.method === "deactivate") {
            self.postMessage({ id: msg.id, ok: true, data: { bye: true } });
        } else {
            self.postMessage({ id: msg.id, ok: false, error: `unknown control "${msg.method}"` });
        }
        return;
    }

    // worker 主动数据请求：宿主 serve 后回帖 { id, ok, data|error }
    // （worker 侧无引擎引用，只能信宿主返回——隔离的代价）
    switch (msg.method) {
        case "getNetlist":
        case "getMeasurements":
        case "step":
            // 请求发出去，宿主回帖走 onmessage 的同一路由（id 非 rpc- 前缀即数据应答）
            break;
        case "report":
            break;
        default:
            self.postMessage({ id: msg.id, ok: false, error: `unknown method "${msg.method}"` });
    }
};
