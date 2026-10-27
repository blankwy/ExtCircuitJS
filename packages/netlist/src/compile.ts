// @ext/netlist — 网表 → 电路 的编译器（C07）
//
// 为什么需要它：`load_netlist` 之前只能拒绝 JSON（引擎只认电路文本/XML）。但「网表投影」
// 是只读的，永远回不去；一张网表若要能**被载入**，中间必须有一次「几何 + 导线重建」。
// 这不是序列化补丁，而是一个编译器：拓扑是输入，坐标和导线是输出。
//
// 两条路（都在这里）：
//   1. `layout:true` 的网表（`exportNetlist({layout:true})` 或紧凑格式的 `L` 段）：坐标照搬，
//      等价于「无损往返」—— 这是唯一能做严格验收的形态。
//   2. 无 layout（AI 手写、或紧凑格式丢了坐标）：走 geom.ts 的自动布局 + 正交布线。
//      同一张网表有无数种摆法，本实现钉死一种**确定性**摆法并如实报 losses。
//
// 三条纪律（沿用 place.ts）：
//   · 不 import core（鸭子类型），不碰 elm.nodes[]；
//   · 绝不在"改坏电路"后返回成功：构造完必须重新分析、按**节点对象身份**校验拓扑同构，
//     不等则用快照回滚并返回 ok:false（拓扑是硬闸，视觉是尽力而为）；
//   · 一切失败以 { ok:false, reason, unsupported } 返回，不抛异常。
//
// 校验为什么用节点身份而不是 id：新构造的元件 id 全是新的（ids.ts 按实例分配），
// 输入网表的 id 无意义。真正要钉住的是「哪些引脚属于同一个网」这个**划分**，
// 而 preStampCircuit 之后 elm.nodes[i] 就是该引脚的 CircuitNode 对象 —— 直接按对象分组。

import { elementRegistry } from "./index";
import { decodeCompact } from "./compact";
import type { Netlist, NetlistComponent } from "./index";
import { autoLayout, routeNets } from "./geom";
import type { GeomComponent, Pt, Seg, Box } from "./geom";
import { applyProps, ensureFreshAnalysis, validateProps } from "./place";

export interface CompileOptions {
    /** 有 layout 时照搬坐标（默认 true）；false 强制自动布局 */
    keepLayout?: boolean;
    /** 网格（默认取 app.gridSize，再兜底 16） */
    grid?: number;
    /** 成功后在引擎里保留新电路（默认 false：编译完回滚，只返回文本） */
    apply?: boolean;
}

export interface CompileLosses {
    /** 坐标来源：照搬 or 生成 */
    geometry: "kept" | "generated";
    /**
     * 导线的来源：`kept` = 网表里自带 WireElm 且照搬坐标（无损还原）；
     * `rebuilt` = 网表不含导线，由路由算法重建。
     */
    wires: "kept" | "rebuilt";
    /** 输入里没被采用的字段/元件（不致命，但要报） */
    ignored: { component?: string; reason: string }[];
    /** 布线冲突：拓扑连上了，但某段导线躲不开元件本体或别的 post */
    conflicts: { net: string; from: string; to: string; reason: string; at: Pt }[];
    /** 多端元件位置与原坐标的偏差（core 自己定 bbox，可能对不齐） */
    positionDrift: { component: string; type: string; want: number[]; got: number[] }[];
}

export interface CompileStats {
    components: number;
    /** 重建出来的导线数（网表自带导线时为 0） */
    wires: number;
    /** 网表里自带的导线元件数 */
    explicitWires: number;
    nets: number;
    /** 自动布局时的网格尺寸（照搬时为 0,0） */
    cols: number;
    rows: number;
}

export interface CompileOk {
    ok: true;
    /** 电路 XML 文本（可直接 importCircuitFromText） */
    text: string;
    stats: CompileStats;
    losses: CompileLosses;
}

export interface CompileFail {
    ok: false;
    reason: string;
    unsupported: { code: string; reason: string; component?: string }[];
}

export type CompileResult = CompileOk | CompileFail;

const PIN_RE = /^(0|[1-9]\d*)$/;

/** 一个元件的引脚 → 网 id；输入不合法时返回错误串 */
function pinsOf(c: NetlistComponent): Record<string, string> | string {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.pins ?? {})) {
        if (!PIN_RE.test(k)) return `pins 的键必须是 post 序号（"0","1",…），收到 "${k}"`;
        if (typeof v !== "string" || v === "") return `pins["${k}"] 必须是网 id 字符串`;
        out[k] = v;
    }
    return out;
}

/** 预校验：全部在做任何破坏性动作之前完成 */
function preflight(nl: Netlist): CompileFail["unsupported"] {
    const bad: CompileFail["unsupported"] = [];
    if (nl == null || typeof nl !== "object") {
        bad.push({ code: "invalid_netlist", reason: "netlist 必须是对象" });
        return bad;
    }
    const comps = Array.isArray(nl.components) ? nl.components : null;
    if (comps == null) {
        bad.push({ code: "invalid_netlist", reason: "缺少 components 数组" });
        return bad;
    }
    if (comps.length === 0) {
        bad.push({ code: "empty_netlist", reason: "components 为空，没有可编译的内容" });
        return bad;
    }
    const reg = elementRegistry().elements ?? {};
    for (const c of comps) {
        if (c == null || typeof c.type !== "string" || c.type === "") {
            bad.push({ code: "invalid_component", reason: "元件缺少 type" });
            continue;
        }
        // 子电路元件需要先在引擎里注册定义（app 的 subcircuit 库），网表里只有实例、
        // 没有库本身。默默按普通元件构造会得到一个 1 脚的假元件，拓扑全错 —— 拒掉。
        if (c.type === "SubcircuitElm" || c.type.startsWith("SubcircuitElm:")) {
            bad.push({
                code: "subcircuit_not_supported",
                component: c.id,
                reason: `"${c.type}" 是子电路实例：网表不带子电路定义，载入前需先在引擎里注册该子电路`
                    + "（或用 XML 载入整张电路）",
            });
            continue;
        }
        if (!reg[c.type]) {
            bad.push({
                code: "unknown_element_type",
                component: c.id,
                reason: `类型 "${c.type}" 不在 registry 里（元件名拼错，或该元件未被导出）`,
            });
            continue;
        }
        const pins = pinsOf(c);
        if (typeof pins === "string") {
            bad.push({ code: "invalid_pins", component: c.id, reason: pins });
        }
        // 注意两件**不算错误**的事（真实语料里很常见，见 netlist-compile.browser.mjs 的语料）：
        //   · pins 为空：元件不参与连接（注释型/未接入的元件），照建不接线即可；
        //   · 多个引脚同属一个网：元件被自身短路（多脚开关的常闭对、调试短接），
        //     上游允许，编译时两脚重合即可（A* 起终点相同 → 零长导线）。
        // 把它们当致命错误会让编译器在一半的真实电路上直接拒载。
    }
    return bad;
}

/** 元件几何盒：有 layout 用之，否则由自动布局给 */
function boxesFor(
    comps: NetlistComponent[],
    keepLayout: boolean,
    grid: number,
): { boxes: Record<string, Box>; cols: number; rows: number; geometry: "kept" | "generated"; missing: string[] } {
    const geom: GeomComponent[] = comps.map((c) => ({
        id: c.id, type: c.type, pins: c.pins ?? {},
        ...(c.layout ? { layout: c.layout } : {}),
    }));
    const allHaveLayout = keepLayout && geom.every((g) => Array.isArray(g.layout) && g.layout.length === 4);
    if (allHaveLayout) {
        const boxes: Record<string, Box> = {};
        for (const g of geom) {
            const l = g.layout!;
            boxes[g.id] = { x1: l[0], y1: l[1], x2: l[2], y2: l[3] };
        }
        return { boxes, cols: 0, rows: 0, geometry: "kept", missing: [] };
    }
    const missing = keepLayout ? geom.filter((g) => !g.layout).map((g) => g.id) : [];
    const lay = autoLayout(geom, { grid });
    return { boxes: lay.boxes, cols: lay.cols, rows: lay.rows, geometry: "generated", missing };
}

/** 元件本体障碍：水平/垂直元件一条线段，斜的（多端元件 bbox）取四条边 */
function bodyObstacles(elm: any): Seg[] {
    const x1 = Number(elm?.x), y1 = Number(elm?.y);
    const x2 = Number(elm?.x2), y2 = Number(elm?.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return [];
    if (x1 === x2 || y1 === y2) return [{ x1, y1, x2, y2 }];
    const lo = { x: Math.min(x1, x2), y: Math.min(y1, y2) };
    const hi = { x: Math.max(x1, x2), y: Math.max(y1, y2) };
    return [
        { x1: lo.x, y1: lo.y, x2: hi.x, y2: lo.y },
        { x1: hi.x, y1: lo.y, x2: hi.x, y2: hi.y },
        { x1: hi.x, y1: hi.y, x2: lo.x, y2: hi.y },
        { x1: lo.x, y1: hi.y, x2: lo.x, y2: lo.y },
    ];
}

/** 拓扑划分：每个元件每个 pin → 一个分组键（节点对象身份 / 输入网 id） */
function partitionOf<T>(groups: T[][]): string {
    return groups
        .map((g) => g.slice().sort().join("|"))
        .sort()
        .join(";");
}

export function compileNetlist(app: any, nl: Netlist, opts: CompileOptions = {}): CompileResult {
    const fail = (reason: string, unsupported: CompileFail["unsupported"] = []): CompileFail =>
        ({ ok: false, reason, unsupported });

    // ── 1) 预校验（不动电路）────────────────────────────────────────────────
    const pre = preflight(nl);
    if (pre.length) return fail("netlist 未通过预校验", pre);
    if (typeof app?.constructElement !== "function")
        return fail("app.constructElement unavailable", [{ code: "no_engine", reason: "拿不到元件工厂" }]);

    let comps: NetlistComponent[] = nl.components;
    const grid = opts.grid ?? (Number(app.gridSize) > 0 ? Number(app.gridSize) : 16);
    const keepLayout = opts.keepLayout !== false;
    const apply = opts.apply === true;
    const ignored: CompileLosses["ignored"] = [];
    const positionDrift: CompileLosses["positionDrift"] = [];

    // ── 2) 几何 ─────────────────────────────────────────────────────────────
    // 典型场景：`get_netlist` 默认不带 layout，于是网表里有一堆没坐标的导线。
    // 导线是"连接"而不是"元件"，没有坐标就没法照搬 —— 直接剔除，让路由器重建；
    // 网表里 nets[].pins 已经记着每个网的全部成员，信息不丢。
    const layoutComplete = comps.every((c) => Array.isArray(c.layout) && c.layout.length === 4);
    if (!layoutComplete && comps.some((c) => c.type === "WireElm")) {
        const dropped = comps.filter((c) => c.type === "WireElm");
        comps = comps.filter((c) => c.type !== "WireElm");
        for (const c of dropped) {
            if (c.layout) continue;   // 有坐标的导线在下面按 needs_layout 处理
        }
        if (dropped.length) {
            ignored.push({
                reason: `网表里有 ${dropped.length} 条无坐标导线，已剔除并按拓扑重新布线`,
            });
        }
    }
    const geo = boxesFor(comps, keepLayout, grid);
    if (geo.geometry === "generated") {
        for (const id of geo.missing) {
            ignored.push({ component: id, reason: "网表缺 layout，坐标由自动布局生成" });
        }
    }
    // 网表里自带导线（WireElm）时只能照搬坐标：导线的两端就是连接语义，
    // 把它们当普通 2 端元件扔进自动布局，摆出来的图与拓扑无关。
    const hasWires = comps.some((c) => c.type === "WireElm");
    if (hasWires && geo.geometry !== "kept") {
        return fail("网表包含导线（WireElm）但缺少 layout：导线位置必须照搬", comps
            .filter((c) => c.type === "WireElm" && !c.layout)
            .slice(0, 5)
            .map((c) => ({
                code: "needs_layout", component: c.id,
                reason: `导线 ${c.id} 没有坐标；请用 exportNetlist({layout:true}) 导出，或先剔除 WireElm 再编译`,
            })));
    }

    // 自动布局只认 2 端元件：多端元件的 post 位置由 core 几何决定，硬摆会得到穿本体的线
    if (geo.geometry === "generated") {
        const multi = comps.filter((c) => Object.keys(c.pins ?? {}).length > 2);
        if (multi.length) {
            return fail("缺少 layout 的网表只能编译 2 端元件（自动布局不会摆多端元件）", multi.map((c) => ({
                code: "needs_layout",
                component: c.id,
                reason: `"${c.type}" 有 ${Object.keys(c.pins ?? {}).length} 个引脚；请用 exportNetlist({layout:true}) 导出后再编译`,
            })));
        }
    }

    // ── 3) 快照（供回滚）───────────────────────────────────────────────────
    const snapshot: string | null = typeof app.dumpCircuit === "function" ? app.dumpCircuit(false) : null;
    const canRestore = snapshot != null && typeof app.importCircuitFromText === "function";

    // 网格状态也是"被重建电路"的一部分：载入电路时 $ 头的 small-grid 位会把 app 网格
    // 设成 8（UIManager.setGrid 读 smallGridCheckItem），8 格语料的引脚位置全部经
    // calcLeads/adjustLeadsToGrid 的 snapGrid 对齐；而 clearCircuit() 会把检查项强制
    // 置假并 app.setGrid() 重置回默认 16（CircuitLoader.ts:76,82）——此后构造的元件
    // 引脚整体偏 8px（dram 的模拟开关控制脚、555int 曾有的电阻端点都是它）。
    // 快照网格并在清空后复原；回滚路径由 readCircuit 按快照头自行重推导，无需干预。
    const gridSnap = {
        gridSize: app.gridSize as number | undefined,
        gridMask: app.gridMask as number | undefined,
        gridRound: app.gridRound as number | undefined,
        smallGrid: typeof app.menus?.smallGridCheckItem?.getState === "function"
            ? (app.menus.smallGridCheckItem.getState() as boolean) : null,
    };

    const elms: any[] = [];        // 与 comps 同序
    const wires: any[] = [];
    const losses: CompileLosses = {
        geometry: geo.geometry, wires: hasWires ? "kept" : "rebuilt", ignored, conflicts: [], positionDrift,
    };

    const restore = (): boolean => {
        if (!canRestore) return false;
        try {
            app.importCircuitFromText(snapshot, false);
            app.needAnalyze?.();
            return true;
        } catch {
            return false;
        }
    };
    const bail = (reason: string, unsupported: CompileFail["unsupported"] = []): CompileFail => {
        // 失败一律回滚（含 apply:true）：半成品电路比"没载入"更糟
        const restored = restore();
        return fail(restored ? reason : `${reason}（电路已被改动且无法回滚）`, unsupported);
    };

    try {
        // ── 4) 清空 + 构造元件 ───────────────────────────────────────────────
        if (typeof app.clearCircuit === "function") app.clearCircuit();
        else if (Array.isArray(app.elmList)) app.elmList.length = 0;
        // 复原网格（clearCircuit 把它重置成默认 16 —— 见 gridSnap 注释）
        if (gridSnap.gridSize !== undefined) app.gridSize = gridSnap.gridSize;
        if (gridSnap.gridMask !== undefined) app.gridMask = gridSnap.gridMask;
        if (gridSnap.gridRound !== undefined) app.gridRound = gridSnap.gridRound;
        if (gridSnap.smallGrid != null && typeof app.menus?.smallGridCheckItem?.setState === "function")
            app.menus.smallGridCheckItem.setState(gridSnap.smallGrid);

        for (const c of comps) {
            const box = geo.boxes[c.id];
            if (!box) return bail(`内部错误：元件 ${c.id} 没有几何盒`, [{
                code: "no_box", component: c.id, reason: "布局阶段漏算",
            }]);
            const pins = pinsOf(c) as Record<string, string>;
            const want = Object.keys(pins).length;
            const elm = app.constructElement(c.type, box.x1, box.y1);
            if (elm == null) return bail(`元件类型 "${c.type}" 无法构造`, [{
                code: "construct_failed", component: c.id, reason: `ElementFactory.create("${c.type}") 返回 null`,
            }]);

            // 属性先应用：它可能改变引脚数（芯片的 bits、导线的 busWidth），而引脚数决定了
            // 几何与后面的校验。放在 drag 之前，避免"先按错误脚数算了一遍几何"。
            applyProps(elm, c.props ?? {});
            for (const k of Object.keys(c.props ?? {})) {
                if (validateProps(c.type, { [k]: (c.props as any)[k] }) != null)
                    ignored.push({ component: c.id, reason: `属性 "${k}" 不属于 ${c.type}，已丢弃` });
            }
            if (Number.isFinite(Number(c.f))) elm.flags = Number(c.f);

            // 模型驱动的引脚数：MOSFET/晶体管/继电器/二极管等家族的 setup() 从 modelName
            // 解析静态模型表（MosfetModel/RelayModel 的 modelMap 是 static，clearCircuit 后
            // 仍有效），bodyTerminal / poleCount 由此决定 postCount。applyProps 只改了字段，
            // 不重跑 setup() 就还是出厂默认模型 —— switchfilter 的 4 脚 MOSFET 被建成 3 脚
            // 就是这里漏的。上游 undumpXml 也是解析完属性立刻调 setup()（MosfetElm.ts:259）。
            if (typeof elm.setup === "function") elm.setup();

            // 纯 flags 派生状态：构造函数按默认档算过一次，flags 是之后才应用的，必须按
            // 上游 undumpXml 的同款配方重推导，否则 setPoints 的引脚位置与原图错位：
            //   · 画幅（FLAG_SMALL 家族：门/运放/芯片/诺顿运放）—— 555int 的小门
            //     gheight 8 被建成默认 16，输入脚整体外扩 ±8px；
            //   · 变压器绕组极性（FLAG_REVERSE → polarity）—— joule-thief 的副边两脚对调。
            const flagSmall = (elm as any).FLAG_SMALL ?? (elm.constructor as any)?.FLAG_SMALL;
            if (typeof elm.setSize === "function" && typeof flagSmall === "number")
                elm.setSize(((elm.flags ?? 0) & flagSmall) !== 0 ? 1 : 2);      // GateElm.ts:125 / ChipElm.ts:539
            if ("polarity" in elm && typeof (elm.constructor as any)?.FLAG_REVERSE === "number")
                (elm as any).polarity =
                    (((elm.flags ?? 0) & (elm.constructor as any).FLAG_REVERSE) !== 0) ? -1 : 1; // TransformerElm.ts:124

            // ChipElm 系列（复用器/计数器/ALU…）的 pins[] 是 setupPins() 建的，而引脚数
            // 取决于 inputMode / dataBusWidth / bits 这些**属性**。刚 applyProps 改过它们，
            // 数组还停在旧尺寸 → 后面 setPoints 遍历 this.pins[i] 直接读到 undefined。
            // 上游是在 undumpXml 末尾补 setupPins()，这里必须在 applyProps 之后补同一步。
            if (typeof elm.setupPins === "function" && Array.isArray(elm.pins)) {
                const need = elm.getPostCount?.() ?? -1;
                if (elm.pins.length !== need) elm.setupPins();
            }

            // 网表不存 busWidth / bits（registry 没这两个字段），但引脚数是它们的整数倍 ——
            // 用引脚数反推，反推不出来就按下面的校验结构化拒绝，不静默降级。
            // 声明的引脚序号一并传入：浮空引脚（网表只记**有连接**的脚）不算脚数错。
            if (!restoreWidthByPinCount(elm, want, Object.keys(pins).map(Number), c.id, ignored)) {
                const gotNow = elm.getPostCount?.() ?? -1;
                return bail(`元件 ${c.id}（${c.type}）有 ${gotNow} 个引脚，网表给了 ${want} 个`, [{
                    code: "pin_count_mismatch", component: c.id,
                    reason: `getPostCount()=${gotNow} vs pins=${want}`,
                }]);
            }

            const postCount = typeof elm.getPostCount === "function" ? elm.getPostCount() : 2;
            // 自动走线元件（RoutedWireElm）：setPoints() 会启动全局 router 扫描整张图，
            // 而此刻同电路后面的元件还没构造 → router 读到未初始化的 post 直接崩
            // （td4-add2 就是这么炸的）。它的**连接**只靠两端 + busWidth，走线路径本身
            // 不进网表（有损），所以这里 setPoints(false) 只算几何、不路由，并如实记 loss。
            const autoRouted = typeof (elm as any).routePoints !== "undefined";
            if (autoRouted) {
                elm.x2 = box.x2;
                elm.y2 = box.y2;
                elm.setPoints?.(false);
                ignored.push({ component: c.id, reason: "自动走线元件的路径不存在于网表，重建为直线" });
            } else if (postCount === 2) {
                // 2 端元件坐标必须**逐字保留**：drag() 会 snapGrid 到 app 网格（CirSim.gridMask=~15、
                // gridRound=7，104 → 96），而真实电路常画在 8 格上 —— 555int 的电阻 (240,56)-(240,104)
                // 被拖成 (240,96)，与自带导线错位 8px，拓扑全变（硬闸第一枪，373 语料里 20 例）。
                // 直接赋 x2/y2 再 setPoints，与上游 undump 路径同款；drag 相比只多了 snap 和
                // noDiagonal 调整 —— 自动布局的坐标已网格对齐且水平，两者等价；照搬时只有直赋正确。
                elm.x2 = box.x2;
                elm.y2 = box.y2;
                if (typeof elm.setPoints === "function") elm.setPoints();
                else if (typeof elm.drag === "function") elm.drag(box.x2, box.y2);
            } else if (typeof elm.drag === "function" || typeof elm.setPoints === "function") {
                // 1 端/多端元件：x2/y2 是 core 自己算出来的（晶体管 bbox、地的引线方向），
                // 照搬回去再 setPoints，post 位置才和原图一致；只 drag 到自身会丢掉这段几何。
                // 而且 setPoints 必须被调一次 —— point1/point2 只在它里面赋值，漏了
                // GroundElm/VarRailElm 的 getPost() 会返回 (0,0)（HANDOVER 坑位）。
                elm.x2 = box.x2;
                elm.y2 = box.y2;
                if (typeof elm.setPoints === "function") elm.setPoints();
                else elm.drag(elm.x, elm.y);
            } else if (postCount !== 2) {
                return bail(`元件 ${c.id}（${c.type}）既不能 drag 也没有 setPoints，无法定位`, [{
                    code: "no_geometry_api", component: c.id, reason: "既无 drag 也无 setPoints",
                }]);
            }

            {
                const drift = [elm.x, elm.y, elm.x2, elm.y2];
                if (drift[0] !== box.x1 || drift[1] !== box.y1)
                    positionDrift.push({ component: c.id, type: c.type, want: [box.x1, box.y1], got: drift });
            }

            // 示波器的监视对象（"第几个元件"）是显示状态，不在网表里；新建的 Scope 连
            // plots 都还是空的 → dumpCircuit 在 ScopeSerializer.dumpXml 读 plots[0].elm 时
            // 炸掉（multivib-a：Cannot read properties of undefined (reading 'elm')）。
            // 指向自身让电路可序列化；显示语义的损失如实记。
            if (typeof (elm as any).setScopeElm === "function") {
                try {
                    (elm as any).setScopeElm(elm);
                    ignored.push({ component: c.id, reason: "示波器的监视对象不在网表里，重建后指向自身" });
                } catch { /* 监视状态建不起来不影响拓扑，dump 阶段再论 */ }
            }

            app.elmList.push(elm);
            elms.push(elm);
        }

        // ── 5) 布线（引脚坐标以引擎为准）────────────────────────────────────
        // 网表自带导线 → 一条都不重建（照搬的 WireElm 已经把网连好了）
        if (hasWires) {
            const analyzeErr0 = ensureFreshAnalysis(app);
            if (analyzeErr0) return bail(`新建电路无法分析：${analyzeErr0}`, [{ code: "analysis_failed", reason: analyzeErr0 }]);
        }
        const pinPoints = new Map<string, Pt>();
        const posts: Pt[] = [];
        for (let i = 0; i < comps.length; i++) {
            const elm = elms[i];
            const count = elm.getPostCount();
            for (let n = 0; n < count; n++) {
                const p = elm.getPost?.(n);
                if (!p) continue;
                pinPoints.set(`${comps[i].id}:${n}`, { x: p.x, y: p.y });
                posts.push({ x: p.x, y: p.y });
            }
        }
        const bodies: Seg[] = [];
        for (const elm of elms) bodies.push(...bodyObstacles(elm));

        const nets = (nl.nets ?? []).map((n) => ({ id: n.id, pins: n.pins ?? [] }));
        const routed = hasWires
            ? { wires: [] as Seg[], conflicts: [] as any[], stats: { nets: nets.length, edges: 0, segments: 0, routed: 0 } }
            : routeNets({ nets, pinPoints, bodies, posts }, { grid });
        losses.conflicts = routed.conflicts;

        for (const s of routed.wires) {
            const w = app.constructElement("WireElm", s.x1, s.y1);
            if (w == null) return bail("无法构造导线（WireElm）", [{
                code: "construct_failed", reason: "ElementFactory.create(\"WireElm\") 返回 null",
            }]);
            // 同 2 端元件：坐标逐字保留，不走 drag()（snapGrid 会把 8 格语料的导线端点
            // 拖离元件引脚，导线悬空 = 拓扑断裂）
            w.x2 = s.x2;
            w.y2 = s.y2;
            if (typeof w.setPoints === "function") w.setPoints();
            else if (typeof w.drag === "function") w.drag(s.x2, s.y2);
            app.elmList.push(w);
            wires.push(w);
        }

        // ── 6) 硬闸：重新分析 → 按节点身份比对拓扑划分 ───────────────────────
        const analyzeErr = ensureFreshAnalysis(app);
        if (analyzeErr) return bail(`新建电路无法分析：${analyzeErr}`, [{ code: "analysis_failed", reason: analyzeErr }]);

        // 输入侧划分：按网 id 分组，键用 "组件下标:引脚号"（不依赖输入的 id 字符串）
        const inGroups = new Map<string, string[]>();
        for (let i = 0; i < comps.length; i++) {
            for (const [pin, net] of Object.entries(pinsOf(comps[i]) as Record<string, string>)) {
                const list = inGroups.get(net) ?? [];
                list.push(`${i}:${pin}`);
                inGroups.set(net, list);
            }
        }
        // 输出侧划分：按 elm.nodes[pin] 的对象身份分组
        const outGroupId = new Map<object, string>();
        const outGroups = new Map<string, string[]>();
        for (let i = 0; i < elms.length; i++) {
            const elm = elms[i];
            // 只看输入声明过的引脚：未声明的引脚（悬空/内部节点）不在划分里，否则口径不一致
            const declared = Object.keys(pinsOf(comps[i]) as Record<string, string>).map(Number);
            for (const n of declared) {
                const cn = elm.nodes?.[n];
                if (cn == null) continue;
                let key = outGroupId.get(cn);
                if (key == null) { key = `c${outGroupId.size}`; outGroupId.set(cn, key); }
                const list = outGroups.get(key) ?? [];
                list.push(`${i}:${n}`);
                outGroups.set(key, list);
            }
        }
        const want = partitionOf([...inGroups.values()]);
        const got = partitionOf([...outGroups.values()]);
        if (want !== got) {
            const diff = diffPartitions(want, got);
            return bail(`拓扑校验失败：重建后的引脚分组与网表不一致（${diff}）`, [{
                code: "topology_mismatch", reason: diff,
            }]);
        }

        // ── 7) 产出文本 ─────────────────────────────────────────────────────
        let text = "";
        if (typeof app.dumpCircuit === "function") {
            text = app.dumpCircuit(false);
        } else if (typeof app.ext?.api?.dumpCircuitXml === "function") {
            text = app.ext.api.dumpCircuitXml();
        }
        if (!text && apply) return bail("无法导出电路文本（app.dumpCircuit 不可用）", [{
            code: "no_dump", reason: "app.dumpCircuit / ext.api.dumpCircuitXml 都不可用",
        }]);

        if (!apply) {
            const restored = restore();
            if (!restored) {
                return fail("编译成功但无法回滚原电路（apply:false 需要可用的快照/载入接口）", [{
                    code: "no_restore", reason: "app.dumpCircuit 或 importCircuitFromText 不可用",
                }]);
            }
        }
        app.needAnalyze?.();

        return {
            ok: true,
            text,
            stats: {
                components: comps.length,
                wires: wires.length,
                explicitWires: comps.filter((c) => c.type === "WireElm").length,
                nets: (nl.nets ?? []).length,
                cols: geo.cols,
                rows: geo.rows,
            },
            losses,
        };
    } catch (e: any) {
        const where = typeof e?.stack === "string" ? e.stack.split("\n").slice(1, 4).join(" | ") : "";
        return bail(`编译异常：${e?.message ?? String(e)}${where ? ` @ ${where}` : ""}`);
    }
}

/**
 * 用网表给的引脚数反推"宽度"字段。
 * 网表的 props 里没有 busWidth（WireElm）也没有 bits（ChipElm 系列）—— registry 两个都没收，
 * 但两者的 postCount 都是「基准脚数 × 宽度」，所以引脚数本身就带着这个信息。
 * declared 是网表声明的引脚序号：网表只记**有连接**的引脚，元件上悬空的脚不出现，
 * 所以「声明的脚都在元件上、只是比元件的脚少」是合法输入（cs-integrator 的 VCVS
 * 感测脚），照建、多出的脚悬空；拓扑硬闸只比对声明的脚，不受影响。
 * 返回 true 表示引脚数已经对上（或本来就不用管）。
 */
function restoreWidthByPinCount(
    elm: any,
    want: number,
    declared: number[],
    id: string,
    ignored: CompileLosses["ignored"],
): boolean {
    if (want === 0) return true;                       // 未接入的元件，不校验脚数
    const got0 = typeof elm.getPostCount === "function" ? elm.getPostCount() : -1;
    if (got0 === want) return true;
    if (got0 > 0 && want < got0) {
        if (!declared.every((n) => Number.isInteger(n) && n >= 0 && n < got0)) return false;
        ignored.push({ component: id, reason: `元件有 ${got0 - want} 个未连接引脚，网表未声明（悬空）` });
        return true;
    }
    if (got0 <= 0 || want % got0 !== 0) return false;

    const factor = want / got0;
    let field: string | null = null;
    if (typeof elm.busWidth !== "undefined") field = "busWidth";
    else if (typeof elm.needsBits === "function" && elm.needsBits()) field = "bits";
    if (field == null) return false;

    const before = Number(elm[field] ?? 1);
    elm[field] = before * factor;
    if (typeof elm.setupPins === "function") elm.setupPins();   // ChipElm 的 pins[] 要重建
    const after = typeof elm.getPostCount === "function" ? elm.getPostCount() : -1;
    if (after !== want) {
        elm[field] = before;                                     // 还原，交由调用方拒绝
        if (typeof elm.setupPins === "function") elm.setupPins();
        return false;
    }
    ignored.push({ component: id, reason: `${field}=${elm[field]} 由引脚数推断（网表不存该字段）` });
    return true;
}

/** 划分差异的人类可读描述（只报第一个不同的组，够定位） */
function diffPartitions(want: string, got: string): string {
    const a = want ? want.split(";") : [];
    const b = got ? got.split(";") : [];
    const missing = a.filter((g) => !b.includes(g));
    const extra = b.filter((g) => !a.includes(g));
    if (missing.length === 0 && extra.length === 0) return "组数一致但键序不同";
    const fmt = (gs: string[]): string => gs.slice(0, 2).map((g) => `{${g}}`).join(" ") || "—";
    return `网表 ${a.length} 组 / 重建 ${b.length} 组；缺少 ${fmt(missing)}，多出 ${fmt(extra)}`;
}

/** 便捷封装：直接拿到可载入的电路文本 */
export function netlistToCircuitText(app: any, nl: Netlist, opts: CompileOptions = {}): CompileResult {
    return compileNetlist(app, nl, opts);
}

/** 供 MCP / 页面桥使用：把 JSON 字符串或对象编译进当前电路 */
export function loadNetlist(app: any, input: string | Netlist, opts: CompileOptions = {}): CompileResult {
    let nl: Netlist;
    if (typeof input === "string") {
        try {
            nl = JSON.parse(input) as Netlist;
        } catch (e: any) {
            return {
                ok: false,
                reason: `网表 JSON 解析失败：${e?.message ?? String(e)}`,
                unsupported: [{ code: "invalid_json", reason: String(e?.message ?? e) }],
            };
        }
    } else {
        nl = input;
    }
    // 紧凑格式（C05）：只读投影 + 自描述图例，解出来就是命名网表（无坐标 → 自动布局）。
    // 这样"读紧凑 → 改 → 写回电路"才闭环，不然还得让调用方先手调解码。
    if (nl != null && typeof nl === "object" && !Array.isArray((nl as any).components)
        && Array.isArray((nl as any).c) && (nl as any).t != null) {
        try {
            // 解码产物只保证 components/nets（正是编译器要的全部），其余段按可选处理
            nl = decodeCompact(nl as any).netlist as unknown as Netlist;
        } catch (e: any) {
            return {
                ok: false,
                reason: `紧凑格式解码失败：${e?.message ?? String(e)}`,
                unsupported: [{ code: "invalid_compact", reason: String(e?.message ?? e) }],
            };
        }
    }
    return compileNetlist(app, nl, { ...opts, apply: opts.apply !== false });
}

