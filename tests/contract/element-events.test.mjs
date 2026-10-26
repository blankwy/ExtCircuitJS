// 元件事件（cover/ts/ExtElementEvents.ts）的纯 Node 契约
//   node --test tests/contract/element-events.test.mjs
//
// 这里测的是**判定逻辑与接线**，不是"用户真的拖了"（那是 element-events.browser.test.mjs 的事）。
// 分工：浏览器那条证"真实鼠标/键盘能产生事件"，这条证"指纹判定、来源标注、增删配对、
// 卸载干净"这些跟 DOM 无关的部分 —— 所以它进 CI 的 Node 通道，不需要 Chromium。
//
// 断言：
//   1. refsOf/diffElementLists 按**对象身份**判定：追加只报 added、删中间只报 removed（带最后已知下标）、
//      纯换序不算变化、同类型新对象=一删一加
//   2. geometrySnapshot/movedSince 只认"改过坐标的老元件"，新建的元件不算拖动
//   3. 没有 canvas 时接线是 no-op（宿主/测试环境不完整也不许抛）
//   4. refresh() 同时同步 select 与 elementschange，source 可指定
//   5. 画布按下-移动-松开 → elemdrag start/move/end（帧合并：一帧最多一条），且不发 elementschange
//   6. document 上的 keyup → elementschange(source=keyboard)：键盘删元件后必须能看见
//   7. dispose 后画布与 document 上的监听器全部撤掉，且不再发事件

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const {
    elementType,
    refsOf,
    diffElementLists,
    geometrySnapshot,
    movedSince,
    wireElementEvents,
} = await import("../../cover/ts/ExtElementEvents.ts");

// ── 假 DOM / 假宿主 ──────────────────────────────────────────────────────────

/**
 * 极简 EventTarget：只支持 add/remove/fire，够覆盖"注册了哪些监听、会不会被撤掉"。
 * 按 `type|capture` 分开记账 —— 真实 DOM 就是这么区分的：用 addEventListener(t, f, true)
 * 注册的监听，必须用 removeEventListener(t, f, true) 才能撤掉，写成 false 会静默泄漏。
 */
function makeTarget() {
    const map = new Map();
    const key = (type, opts) => `${type}|${typeof opts === "boolean" ? opts : !!opts?.capture}`;
    return {
        addEventListener(type, fn, opts) {
            const k = key(type, opts);
            if (!map.has(k)) map.set(k, new Set());
            map.get(k).add(fn);
        },
        removeEventListener(type, fn, opts) {
            map.get(key(type, opts))?.delete(fn);
        },
        fire(type, ev = {}) {
            for (const k of [...map.keys()]) {
                if (!k.startsWith(type + "|")) continue;
                for (const fn of [...map.get(k)]) fn({ type, target: this, ...ev });
            }
        },
        listenerCount() {
            let n = 0;
            for (const s of map.values()) n += s.size;
            return n;
        },
        /** 诊断用：还挂着哪些监听（type|capture） */
        kinds() {
            return [...map.entries()].filter(([, s]) => s.size > 0).map(([k, s]) => `${k}×${s.size}`);
        },
    };
}

function makeCanvas() {
    const cv = makeTarget();
    cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    cv.contains = (node) => node === cv;
    return cv;
}

function makeElm(cls, x, y, x2 = x + 32, y2 = y) {
    return {
        cls,
        x,
        y,
        x2,
        y2,
        selected: false,
        isSelected() { return this.selected; },
        getClassName() { return this.cls; },
    };
}

/** 事件总线的探针：只记录，不做任何额外动作 */
function makeBus() {
    const log = [];
    return {
        log,
        emit(name, payload) { log.push({ name, payload }); },
        of(name) { return log.filter((e) => e.name === name); },
    };
}

/** 装一套宿主 + 假 document（wireElementEvents 在接线时会读全局 document） */
function harness({ withCanvas = true } = {}) {
    const cv = makeCanvas();
    const doc = makeTarget();
    const app = {
        ui: withCanvas ? { cv } : {},
        elmList: [],
        mouse: { inverseTransformX: (x) => x / 16, inverseTransformY: (y) => y / 16 },
    };
    const prevDoc = globalThis.document;
    globalThis.document = doc;
    const bus = makeBus();
    const wiring = wireElementEvents({ ...app, ui: app.ui }, bus);
    return {
        app,
        cv,
        doc,
        bus,
        wiring,
        restore() {
            wiring.dispose();
            if (prevDoc === undefined) delete globalThis.document;
            else globalThis.document = prevDoc;
        },
    };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

// ── 1~2：纯判定 ─────────────────────────────────────────────────────────────

test("diffElementLists：追加/删除/换序/替换，一律按对象身份判定", () => {
    const a = makeElm("ResistorElm", 0, 0);
    const b = makeElm("WireElm", 32, 0);
    const c = makeElm("CapacitorElm", 64, 0);

    assert.deepEqual(diffElementLists([a], [a, b]), {
        added: [{ index: 1, id: "c1", type: "WireElm", elm: b }],
        removed: [],
    }, "追加应只报 added，下标取新表位置");

    // 删中间一个：按下标比对会报成"b 变了 + 全删全加"，按身份才只报 1 条
    assert.deepEqual(diffElementLists([a, b, c], [a, c]), {
        added: [],
        removed: [{ index: 1, id: "c1", type: "WireElm", elm: b }],
    }, "删中间应只报 1 条 removed（下标是移除前的）");

    assert.deepEqual(diffElementLists([a, b], [b, a]), { added: [], removed: [] },
        "纯换序不算结构变化");

    const b2 = makeElm("WireElm", 32, 0); // 同类型、同坐标，但是另一个对象
    assert.deepEqual(diffElementLists([a, b], [a, b2]), {
        added: [{ index: 1, id: "c1", type: "WireElm", elm: b2 }],
        removed: [{ index: 1, id: "c1", type: "WireElm", elm: b }],
    }, "换成新对象 = 一删一加（上游重建导线就是这样）");

    assert.deepEqual(diffElementLists([], [a, b, c]).added.map((r) => r.id), ["c0", "c1", "c2"],
        "ids 应与 api.listComponents 同源");
});

test("refsOf / elementType：id 与类型都从当前表取", () => {
    const list = [makeElm("ResistorElm", 0, 0), makeElm("ScopeElm", 10, 10)];
    assert.deepEqual(refsOf(list).map((r) => [r.index, r.id, r.type]), [
        [0, "c0", "ResistorElm"],
        [1, "c1", "ScopeElm"],
    ]);
    assert.equal(elementType({}), "Unknown");
    assert.equal(elementType(null), "Unknown");
    assert.equal(elementType({ constructor: { name: "Anon" } }), "Anon", "没有 getClassName 时退到构造函数名");
});

test("geometrySnapshot / movedSince：只认动过坐标的老元件", () => {
    const a = makeElm("ResistorElm", 0, 0);
    const b = makeElm("WireElm", 32, 0);
    const snap = geometrySnapshot([a, b]);

    assert.deepEqual(movedSince(snap, [a, b]), [], "没动就不该报");

    a.x = 16;
    a.x2 = 48;
    assert.deepEqual(movedSince(snap, [a, b]), [a], "动过的元件要报出来");

    const fresh = makeElm("WireElm", 64, 0);
    assert.deepEqual(movedSince(snap, [a, b, fresh]), [a], "新建的元件不算拖动（它是 elementschange 的事）");
});

// ── 3：环境不完整 ───────────────────────────────────────────────────────────

test("没有 canvas 时接线是 no-op", () => {
    const seen = [];
    const w = wireElementEvents({ ui: {}, elmList: [] }, { emit: (n) => seen.push(n) });
    w.refresh("manual");
    w.dispose();
    assert.deepEqual(seen, []);
});

// ── 4~7：接线后的行为 ───────────────────────────────────────────────────────

test("refresh：select 与 elementschange 一起同步，source 可指定", () => {
    const h = harness();
    try {
        const a = makeElm("ResistorElm", 0, 0);
        h.app.elmList.push(a);
        h.wiring.refresh("load");

        const changes = h.bus.of("elementschange");
        assert.equal(changes.length, 1, `应发 1 条 elementschange，实际 ${JSON.stringify(h.bus.log.map((e) => e.name))}`);
        assert.equal(changes[0].payload.source, "load");
        assert.equal(changes[0].payload.count, 1);
        assert.deepEqual(changes[0].payload.added.map((r) => r.type), ["ResistorElm"]);

        a.selected = true;
        h.wiring.refresh();
        const sel = h.bus.of("select");
        assert.equal(sel.length, 1, "选择变了要发 select");
        assert.deepEqual(sel[0].payload.ids, ["c0"]);
        assert.equal(h.bus.of("elementschange").length, 1, "结构没变就不该再发 elementschange");

        h.wiring.refresh();
        assert.equal(h.bus.log.length, 2, "什么都没变时重复同步不发事件");
    } finally {
        h.restore();
    }
});

test("画布按下-移动-松开：elemdrag start/move/end，且不发 elementschange", async () => {
    const h = harness();
    try {
        const a = makeElm("ResistorElm", 100, 100, 300, 100);
        h.app.elmList.push(a);
        h.wiring.refresh("manual");
        h.bus.log.length = 0;

        h.cv.fire("mousedown", { button: 0, clientX: 100, clientY: 100 });
        a.x = 100 + 16;
        h.cv.fire("mousemove", { clientX: 116, clientY: 100 });
        await tick();
        a.x = 100 + 32;
        h.cv.fire("mousemove", { clientX: 132, clientY: 100 });
        await tick();
        h.cv.fire("mouseup", { button: 0, clientX: 132, clientY: 100 });
        await tick();

        const drags = h.bus.of("elemdrag");
        assert.deepEqual(drags.map((e) => e.payload.phase), ["start", "move", "end"],
            `相位序列不对：${JSON.stringify(drags.map((e) => e.payload.phase))}`);
        assert.deepEqual(drags[0].payload.ids, ["c0"]);
        assert.deepEqual(drags[0].payload.indices, [0]);
        const end = drags[drags.length - 1].payload;
        assert.deepEqual(end.delta, { x: 2, y: 0 }, `end 的位移应是 2 格（32px/16），实际 ${JSON.stringify(end.delta)}`);
        assert.equal(h.bus.of("elementschange").length, 0, "只挪位置不是结构变化");
    } finally {
        h.restore();
    }
});

test("拖动中新建的元件不算拖动，删除后才算结构变化", async () => {
    const h = harness();
    try {
        const a = makeElm("ResistorElm", 100, 100, 300, 100);
        h.app.elmList.push(a);
        h.wiring.refresh("manual");
        h.bus.log.length = 0;

        h.cv.fire("mousedown", { button: 0, clientX: 100, clientY: 100 });
        const fresh = makeElm("WireElm", 400, 400, 432, 400); // 按下之后才出现（例如吸附生成的导线）
        h.app.elmList.push(fresh);
        h.cv.fire("mousemove", { clientX: 100, clientY: 100 });
        await tick();
        h.cv.fire("mouseup", { button: 0, clientX: 100, clientY: 100 });
        await tick();

        assert.equal(h.bus.of("elemdrag").length, 0, "没动任何老元件就不该发 elemdrag");
        assert.equal(h.bus.of("elementschange").length, 1, "新增必须报出来");
        assert.deepEqual(h.bus.of("elementschange")[0].payload.added.map((r) => r.type), ["WireElm"]);
        assert.equal(h.bus.of("elementschange")[0].payload.source, "pointer");
    } finally {
        h.restore();
    }
});

test("document keyup：键盘删元件 → elementschange(source=keyboard)", async () => {
    const h = harness();
    try {
        const a = makeElm("ResistorElm", 100, 100, 300, 100);
        h.app.elmList.push(a);
        h.wiring.refresh("manual");
        h.bus.log.length = 0;

        h.app.elmList.length = 0;      // 模拟 core 的 Delete 实现（它直接 splice）
        h.doc.fire("keyup", { key: "Delete" });
        await tick();

        const changes = h.bus.of("elementschange");
        assert.equal(changes.length, 1, "键盘删除必须能看见");
        assert.equal(changes[0].payload.source, "keyboard");
        assert.deepEqual(changes[0].payload.removed.map((r) => r.type), ["ResistorElm"]);
        assert.equal(changes[0].payload.count, 0);
    } finally {
        h.restore();
    }
});

test("document 上的非画布交互标为 ui（菜单/工具栏/对话框走的都是这条路）", async () => {
    const h = harness();
    try {
        h.wiring.refresh("manual");
        h.bus.log.length = 0;
        h.app.elmList.push(makeElm("ResistorElm", 0, 0));
        h.doc.fire("click", { target: h.doc }); // 点在菜单上
        await tick();
        const changes = h.bus.of("elementschange");
        assert.equal(changes.length, 1);
        assert.equal(changes[0].payload.source, "ui");
    } finally {
        h.restore();
    }
});

test("dispose：监听器全部撤掉，之后不再发事件", async () => {
    const h = harness();
    const a = makeElm("ResistorElm", 0, 0);
    h.app.elmList.push(a);
    assert.ok(h.cv.listenerCount() > 0 && h.doc.listenerCount() > 0, "接线后两边都应有监听器");

    h.restore(); // 内部会 dispose()
    assert.equal(h.cv.listenerCount(), 0, `画布监听器没撤干净：${h.cv.kinds().join(",")}`);
    assert.equal(h.doc.listenerCount(), 0, `document 监听器没撤干净：${h.doc.kinds().join(",")}`);

    h.bus.log.length = 0;
    h.app.elmList.length = 0;
    h.doc.fire("keyup", { key: "Delete" });
    await tick();
    assert.deepEqual(h.bus.log, [], "卸载后不得再发事件");
});
