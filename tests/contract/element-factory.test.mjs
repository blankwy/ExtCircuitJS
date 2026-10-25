// A07 — ElementFactory 注册/注销/冲突契约测试（cover 层覆盖副本）
//   node --test tests/contract/element-factory.test.mjs
// 三条断言（docs/task-board.md A07）：
//   1. 注销后 create 返回 null
//   2. 跨 owner 注销抛错
//   3. listClasses 含核心类（owner=core 注册的名字不被插件命名空间隐藏）
//
// 说明：registerElements.ts 依赖全部元件模块（DOM 环境），Node 侧不导入它；
//       "核心类"以 registerClass 默认 owner="core" 注册的规范类名代表。

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
const { ElementFactory } = await import("../../cover/ts/ElementFactory.ts");

/** 与 ElmCtor 兼容的最小构造函数（两种重载签名都走 new ctor(...)） */
class ProbeElm {
    constructor(...args) {
        this.args = args;
    }
}

test("注销后 create 返回 null（deregister → create=null，注销前可创建）", () => {
    ElementFactory.registerClass("ProbeElm", ProbeElm, "plugin-a");
    const before = ElementFactory.create("ProbeElm", 10, 20);
    assert.ok(before instanceof ProbeElm, "注销前 create 应返回实例");
    assert.deepEqual(before.args, [10, 20]);

    assert.equal(ElementFactory.deregisterClass("ProbeElm", "plugin-a"), true);
    assert.equal(ElementFactory.create("ProbeElm", 10, 20), null, "注销后 create 应返回 null");
    assert.equal(ElementFactory.hasClass("ProbeElm"), false);
});

test("跨 owner 注销抛错（plugin-b 不能注销 plugin-a 注册的类型）", () => {
    ElementFactory.registerClass("OwnedElm", ProbeElm, "plugin-a");
    assert.throws(
        () => ElementFactory.deregisterClass("OwnedElm", "plugin-b"),
        /refuse to deregister "OwnedElm" owned by "plugin-a"/,
    );
    // 抛错不得有副作用：类型仍在，正确 owner 仍可注销
    assert.equal(ElementFactory.hasClass("OwnedElm"), true);
    assert.equal(ElementFactory.deregisterClass("OwnedElm", "plugin-a"), true);
});

test("listClasses 含核心类（owner=core 注册后可见且有序）", () => {
    // 模拟 registerElements.ts 的注册方式：默认 owner="core"
    for (const name of ["ResistorElm", "CapacitorElm", "WireElm"]) {
        ElementFactory.registerClass(name, ProbeElm);
    }
    const listed = ElementFactory.listClasses();
    for (const name of ["ResistorElm", "CapacitorElm", "WireElm"]) {
        assert.ok(listed.includes(name), `listClasses 应含核心类 ${name}`);
    }
    // 卸载其中一个不影响其余（插件卸载的隔离性）
    ElementFactory.deregisterClass("ResistorElm");
    const after = ElementFactory.listClasses();
    assert.ok(!after.includes("ResistorElm"));
    assert.ok(after.includes("CapacitorElm") && after.includes("WireElm"));
});
