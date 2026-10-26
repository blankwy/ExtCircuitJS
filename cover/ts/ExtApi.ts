// Cover 层新增：对外 API facade（window.ExtCircuitJS.api）
// 只做"薄转发 + 结构化返回"，不放业务逻辑；网表逻辑在 @ext/netlist。

import { exportNetlist, applyOps, encodeCompact } from "@ext/netlist";
import type { NetlistOp } from "@ext/netlist";
import type { ExtEvents } from "./ExtEvents";

export class ExtApi {
    constructor(private readonly app: any, private readonly events: ExtEvents) {}

    get version(): string {
        // CirSim.versionString 是静态字段；实例上不一定有
        const ctor: any = this.app?.constructor;
        return ctor?.versionString ?? this.app?.versionString ?? "ext";
    }

    // ── 读 ────────────────────────────────────────────────────────────────
    dumpCircuitXml(): string {
        return this.app.dumpCircuit();
    }

    dumpNetlist(opts: { layout?: boolean; dropDefaults?: boolean } = {}) {
        return exportNetlist(this.app, opts);
    }

    /**
     * 紧凑投影（C05）。默认形态**自描述**：带 `t` 类型图例（类型名 + 该类型实际用到的
     * 属性名前缀），所以消费方不需要外部 registry 就能读懂位置化的 props。
     * `legend:false` 是纯投影形态（更小，但要自己拿 registry 翻译）。
     */
    dumpCompact(opts: { layout?: boolean; legend?: boolean } = {}) {
        return encodeCompact(this.dumpNetlist({ layout: opts.layout === true }), { legend: opts.legend !== false });
    }

    listComponents(): { id: string; type: string; tag: string; info: string[] }[] {
        const out: any[] = [];
        this.app.elmList.forEach((e: any, i: number) => {
            out.push({
                id: `c${i}`,
                type: e?.getClassName?.() ?? "Unknown",
                tag: e?.getXmlDumpType?.() ?? "?",
                info: e?.getInfoJS?.() ?? [],
            });
        });
        return out;
    }

    getNodeVoltage(name: string): number {
        return this.app.sim?.getLabeledNodeVoltage?.(name) ?? 0;
    }

    getMeasurements(filter: { nets?: string[]; components?: string[] } = {}) {
        const nets = (this.app.sim?.nodeList ?? []).map((cn: any, i: number) => ({
            index: i,
            v: cn?.v ?? 0,
            // setGroundNode() 把地节点固定为 nodeList[0]
            ground: i === 0,
        }));
        const components: any[] = [];
        this.app.elmList.forEach((e: any, i: number) => {
            const id = `c${i}`;
            if (filter.components && !filter.components.includes(id)) return;
            let vd: number | null = null;
            let current: number | null = null;
            try { vd = e?.getVoltageDiff?.() ?? null; } catch { /* digital elm */ }
            try { current = e?.getCurrent?.() ?? null; } catch { /* no current */ }
            components.push({ id, type: e?.getClassName?.(), vd, current });
        });
        return { t: this.app.sim?.t ?? 0, running: this.app.simIsRunning?.() ?? false, nets, components };
    }

    // ── 写 ────────────────────────────────────────────────────────────────
    applyOps(ops: NetlistOp[]) {
        return applyOps(this.app, ops);
    }

    loadCircuitText(text: string, subcircuitsOnly = false): void {
        this.app.importCircuitFromText(text, subcircuitsOnly);
    }

    loadCircuitXml(xml: string): void {
        this.app.importCircuitFromText(xml, false);
    }

    // ── 仿真控制 ──────────────────────────────────────────────────────────
    run(run = true): void { this.app.setSimRunning(run); }
    isRunning(): boolean { return this.app.simIsRunning(); }
    reset(): void { this.app.resetAction?.(); }
    getTime(): number { return this.app.sim?.t ?? 0; }
    setTimeStep(ts: number): void {
        if (!this.app.sim) return;
        this.app.sim.timeStep = ts;
        this.app.sim.maxTimeStep = ts;
    }

    // ── 事件 ──────────────────────────────────────────────────────────────
    on(
        name: "analyze" | "update" | "timestep" | "svgren" | "select" | "elemclick",
        h: (payload?: any) => void,
    ): () => void {
        return this.events.on(name, h);
    }
}
