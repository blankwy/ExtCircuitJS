// 文档钩子总线（cover/ts/ExtHooks.ts）的纯 Node 契约
//   node --test tests/contract/hooks.test.mjs
//
// 断言（ctx.hook 的全部语义，一条不绿就等于"插件看不见存档"）：
//   1. 没有处理器时原样返回，count() 反映在册数量
//   2. 多个处理器串成加工链（顺序执行，后者看到前者的结果）
//   3. 返回非字符串 = 不改（undefined / null / 其它类型），不得把文本变成 "[object Object]"
//   4. 单个处理器抛错只记一条 console.error，其余处理器照常执行、文本不被污染
//   5. 重入保护：处理器内部再触发同名 run 不再套娃（否则 save 里 dumpCircuit 会死循环）
//   6. withSource 打标：meta.source 正确、嵌套恢复、抛错也恢复
//   7. disposer：撤销后不再调用，重复撤销无副作用，clear() 清空
//   8. wireAppHooks：readCircuit / dumpCircuit 被真的包住（flags/saveState 透传、非字符串透传），
//      undo/recovery/isModified/paste 的来源标注正确，dispose 后方法还原且不再触发
//
// 被测对象是浏览器/Node 通用的纯逻辑模块（不 import core、不碰 DOM），
// 所以这条契约进 CI 的 Node 通道，不需要 Chromium。

import { register } from "node:module";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { ExtHooks, wireAppHooks } = await import("../../cover/ts/ExtHooks.ts");

// ── 1~3：基本链路 ────────────────────────────────────────────────────────────
test("无处理器时原样返回；count 反映在册数量", () => {
    const hooks = new ExtHooks();
    assert.equal(hooks.count(), 0);
    assert.equal(hooks.count("save"), 0);
    assert.equal(hooks.run("save", "<cir/>"), "<cir/>");
    assert.equal(hooks.run("load", "1 100 100"), "1 100 100");

    const off = hooks.on("save", (t) => t + "A");
    assert.equal(hooks.count("save"), 1);
    assert.equal(hooks.count(), 1);
    off();
    assert.equal(hooks.count("save"), 0, "撤销后不应留在册");
});

test("多个处理器串成加工链，后者看到前者的结果", () => {
    const hooks = new ExtHooks();
    hooks.on("load", (t) => t + "1");
    hooks.on("load", (t) => t + "2");
    assert.equal(hooks.run("load", "x"), "x12");
});

test("返回非字符串 = 不改文本", () => {
    const hooks = new ExtHooks();
    hooks.on("load", () => undefined);
    hooks.on("load", () => null);
    hooks.on("load", () => ({ nope: true }));
    hooks.on("load", () => 42);
    assert.equal(hooks.run("load", "keep"), "keep", "非字符串返回值必须被忽略");
});

// ── 4：错误隔离 ──────────────────────────────────────────────────────────────
test("单个处理器抛错只记日志，其余处理器照跑，文本不被污染", () => {
    const hooks = new ExtHooks();
    const err = mock.method(console, "error", () => {});
    try {
        hooks.on("save", () => { throw new Error("boom"); });
        hooks.on("save", (t) => t + "!");
        assert.equal(hooks.run("save", "ok"), "ok!", "抛错的处理器之后仍应继续执行");
        assert.equal(err.mock.calls.length, 1, "异常必须恰好记录一次");
        assert.match(String(err.mock.calls[0].arguments[1]), /boom/);
    } finally {
        err.mock.restore();
    }
});

// ── 5：重入保护 ──────────────────────────────────────────────────────────────
test("重入保护：处理器内部再触发同名 run 不再套娃", () => {
    const hooks = new ExtHooks();
    let inner = 0;
    hooks.on("save", (t) => {
        const again = hooks.run("save", t); // 处理器里再跑一次同一钩子
        if (again === t) inner++;           // 命中直通分支
        return t + "S";
    });
    assert.equal(hooks.run("save", "a"), "aS");
    assert.equal(inner, 1, "内层调用应直通（不重复调度处理器）");

    // 不同钩子之间互不影响
    let loadSeen = null;
    hooks.on("load", (t, meta) => { loadSeen = meta.hook; return t; });
    hooks.on("save", () => { hooks.run("load", "inner"); return "x"; });
    hooks.run("save", "a");
    assert.equal(loadSeen, "load", "save 处理器内触发 load 钩子应正常执行（只有同名才直通）");
});

// ── 6：来源标注 ──────────────────────────────────────────────────────────────
test("withSource 打标、嵌套恢复、抛错恢复", () => {
    const hooks = new ExtHooks();
    const seen = [];
    hooks.on("save", (t, meta) => { seen.push(meta.source); return t; });

    assert.equal(hooks.source, "document", "默认来源是 document");
    hooks.run("save", "a");

    hooks.withSource("undo", () => hooks.run("save", "b"));
    hooks.withSource("recovery", () => {
        hooks.run("save", "c");
        hooks.withSource("internal", () => hooks.run("save", "d"));
        hooks.run("save", "e");
    });
    assert.equal(hooks.source, "document", "嵌套 withSource 结束后必须回到外层值");

    assert.throws(() => hooks.withSource("paste", () => { throw new Error("x"); }));
    assert.equal(hooks.source, "document", "withSource 内抛错也必须恢复来源");

    assert.deepEqual(seen, ["document", "undo", "recovery", "internal", "recovery"]);
});

// ── 7：disposer ─────────────────────────────────────────────────────────────
test("disposer 撤销后不再调用，重复撤销无副作用", () => {
    const hooks = new ExtHooks();
    let n = 0;
    const off = hooks.on("load", (t) => { n++; return t; });
    hooks.run("load", "a");
    off();
    off();
    hooks.run("load", "b");
    assert.equal(n, 1);

    hooks.on("save", (t) => t);
    hooks.clear();
    assert.equal(hooks.count(), 0);
});

// ── 8：wireAppHooks 接线 ────────────────────────────────────────────────────
/** 假 app：表面与 CirSim 中被包住的那些方法一致 */
function fakeApp() {
    const calls = { load: [], save: [], source: [] };
    const app = {
        loader: {
            readCircuit(text, flags = 0) { calls.load.push({ text, flags }); },
        },
        dumpCircuit(saveState = true) { calls.save.push({ saveState }); return "<cir s=1></cir>"; },
        undoManager: {
            pushUndo() { app.dumpCircuit(); },
            doUndo() { app.loader.readCircuit("<cir/>", 0); },
            doRedo() {},
            writeRecoveryToStorage() { app.dumpCircuit(); },
            readRecovery() {},
            doRecover() {},
        },
        isModified() { app.dumpCircuit(false); return false; },
        popContext() {},
        commands: { doPaste() { app.loader.readCircuit("pasted", 4); } },
    };
    return { app, calls };
}

test("wireAppHooks：readCircuit/dumpCircuit 被包住，来源标注正确，dispose 后还原", () => {
    const { app, calls } = fakeApp();
    const rawRead = app.loader.readCircuit;
    const rawDump = app.dumpCircuit;
    const hooks = new ExtHooks();
    const seen = [];
    hooks.on("load", (text, meta) => { seen.push(["load", meta.source, meta.flags]); return text.replace("OLD", "NEW"); });
    hooks.on("save", (text, meta) => { seen.push(["save", meta.source, meta.saveState]); return text + "<!--m-->"; });

    const dispose = wireAppHooks(app, hooks);

    // load：改写生效、flags 原样透传
    app.loader.readCircuit("OLD 1 2", 8);
    assert.deepEqual(calls.load.at(-1), { text: "NEW 1 2", flags: 8 });

    // save：返回值被改写、saveState 透传
    assert.equal(app.dumpCircuit(false), "<cir s=1></cir><!--m-->");
    assert.equal(calls.save.at(-1).saveState, false);

    // 非字符串透传（上游偶有 null 走这条路），不得被钩子弄坏
    assert.doesNotThrow(() => app.loader.readCircuit(null, 0));
    assert.equal(calls.load.at(-1).text, null);

    // 来源标注
    seen.length = 0;
    app.dumpCircuit();                    // 页内直接调用 = 用户在存文件
    app.undoManager.pushUndo();           // 撤销快照
    app.undoManager.writeRecoveryToStorage();
    app.isModified();
    app.commands.doPaste();
    assert.deepEqual(seen, [
        ["save", "document", true],
        ["save", "undo", true],
        ["save", "recovery", true],
        ["save", "internal", false],
        ["load", "paste", 4],
    ]);

    // dispose 后：方法身份还原、钩子不再触发
    dispose();
    assert.equal(app.loader.readCircuit, rawRead, "dispose 后 readCircuit 必须还原为原函数");
    assert.equal(app.dumpCircuit, rawDump, "dispose 后 dumpCircuit 必须还原为原函数");
    seen.length = 0;
    app.loader.readCircuit("x", 0);
    app.dumpCircuit();
    assert.deepEqual(seen, [], "dispose 后不得再触发钩子");
});

test("wireAppHooks：缺少某些宿主方法时不抛（上游版本差异）", () => {
    const { app } = fakeApp();
    const bare = { loader: app.loader, dumpCircuit: app.dumpCircuit };
    const hooks = new ExtHooks();
    const dispose = wireAppHooks(bare, hooks);
    assert.doesNotThrow(() => bare.dumpCircuit());
    assert.doesNotThrow(() => dispose());
});

// ── 9：afterLoad —— 载入**完成后**的旁观者 ──────────────────────────────────
// 宿主内部用（ExtBoot 拿它同步元件事件）：它不改文本、不进 ctx，但必须是"此刻 elmList 已就绪"。
test("afterLoad：载入完成才回调，来源取进入时的标注，嵌套载入不连发", () => {
    const { app } = fakeApp();
    const hooks = new ExtHooks();
    const dispose = wireAppHooks(app, hooks);
    const seen = [];
    const off = hooks.afterLoad((meta) => seen.push(meta));

    app.loader.readCircuit("a", 0);
    assert.deepEqual(seen, [{ hook: "load", source: "document", flags: 0 }], "普通载入应通知一次");

    app.commands.doPaste();
    assert.deepEqual(seen[1], { hook: "load", source: "paste", flags: 4 }, "粘贴来源要带对");

    // 嵌套（子电路/连续载入）：只有最外层结束才通知，避免插件看见"半截电路"
    seen.length = 0;
    hooks.noteLoadStart();
    hooks.noteLoadStart();
    hooks.noteLoadEnd();
    assert.equal(seen.length, 0, "内层结束不得通知");
    hooks.noteLoadEnd();
    assert.equal(seen.length, 1, "外层结束必须通知且只通知一次");

    // 旁观者抛错不能把载入搞坏
    const restoreErr = mock.method(console, "error", () => {});
    off();
    const off2 = hooks.afterLoad(() => { throw new Error("boom"); });
    assert.doesNotThrow(() => app.loader.readCircuit("b", 0), "旁观者抛错不得影响载入");
    assert.equal(restoreErr.mock.callCount(), 1, "旁观者抛错应记一条 console.error");
    off2();

    hooks.clear();
    app.loader.readCircuit("c", 0);
    dispose();
});
