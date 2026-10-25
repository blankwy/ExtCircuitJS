// @ext/netlist — 会话内稳定 id（C06，WeakMap 方案，见 docs/format-strategy.md §5）
//
// 问题：exportNetlist 原先用 elmList 下标当 id（c0..cN），删除一个元件后全体前移，
//       AI 会话里"改 R1"会命中错误元件。
// 方案：WeakMap<elm 实例, id> 按**首次导出顺序**分配 e1,e2,...；counter 单调递增，
//       删除后的 id 不复用。WeakMap 键是弱引用，实例被引擎丢弃后可被 GC。
//
// 全新电路重置规则（与 C07 round-trip 契约配套）：导出时若当前 elmList 里没有任何
// 已知实例（importCircuitFromText 重建全部实例的典型情形），清空映射、counter 归零。
// 这样 dump→reload→再导出的两次 id 序列一致；而"编辑"（set/delete）不触发重置，
// 幸存元件保持原 id。

let byElm = new WeakMap<object, string>();
// WeakMap 不可逆查；byId 持强引用，每次 assignStableIds 时清理已消失实例，防泄漏
let byId = new Map<string, object>();
let counter = 0;

/**
 * 为 elmList 分配/延续稳定 id，返回 elm → id 快照。
 * 调用时机：exportNetlist（读通道唯一入口）；applyOps 经 elmOf 用逆查表定位。
 */
export function assignStableIds(elms: object[]): Map<object, string> {
    let anyKnown = false;
    for (const e of elms) {
        if (byElm.has(e)) { anyKnown = true; break; }
    }
    if (!anyKnown && byId.size > 0) {
        // 全新电路：重置（WeakMap 不可 clear，换实例）
        byElm = new WeakMap();
        byId = new Map();
        counter = 0;
    }
    const ids = new Map<object, string>();
    for (const e of elms) {
        let id = byElm.get(e);
        if (id == null) {
            id = `e${++counter}`;
            byElm.set(e, id);
            byId.set(id, e);
        }
        ids.set(e, id);
    }
    // 清理已从 elmList 消失的实例（delete 之后、下次导出之前）——只影响逆查，
    // counter 不回退，被删 id 永不复用
    const alive = new Set<object>(elms);
    for (const [id, e] of byId) {
        if (!alive.has(e)) byId.delete(id);
    }
    return ids;
}

/** 稳定 id → elm 实例（不在当前电路里时为 null） */
export function elmOf(id: string): object | null {
    return byId.get(id) ?? null;
}

/** elm 实例 → 稳定 id（尚未经 exportNetlist 分配时为 null） */
export function idOf(e: object): string | null {
    return byElm.get(e) ?? null;
}

/** 重置全部 id 状态（测试隔离用） */
export function resetIds(): void {
    byElm = new WeakMap();
    byId = new Map();
    counter = 0;
}
