/*
    Copyright (C) Paul Falstad and Iain Sharp

    This file is part of CircuitJS1.

    CircuitJS1 is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.
*/

// Cover 层：ts/ElementFactory.ts 的覆盖副本。
// 与上游差异：新增 deregisterClass / listClasses / hasConflict + owner 命名空间。
// 原因：上游只有 registerClass/hasClass/create，classMap 是 private static，
//       没有卸载就没有真正的插件生命周期（见 docs/architecture-review.md §2.3）。
// 同步上游时只看 anchors：classMap 声明 / registerClass 签名。

import { StringTokenizer } from "./StringTokenizer";

// Constructor signatures for the two creation patterns used throughout the codebase
type ElmCtor = {
    new(x: number, y: number): any;
    new(xa: number, ya: number, xb: number, yb: number, f: number, st: StringTokenizer): any;
};

export class ElementFactory {
    private static classMap: Map<string, ElmCtor> = new Map();
    // ExtCircuitJS: 记录注册者，插件卸载时只允许删除自己注册的类型
    private static owners: Map<string, string> = new Map();

    // Register a class so create() can find it by name
    static registerClass(name: string, ctor: ElmCtor, owner: string = "core"): void {
        const prev = ElementFactory.owners.get(name);
        if (prev != null && prev !== owner)
            throw new Error(`[ExtCircuitJS] element type conflict: "${name}" owned by "${prev}", not "${owner}"`);
        ElementFactory.classMap.set(name, ctor);
        ElementFactory.owners.set(name, owner);
    }

    // ExtCircuitJS: 注销（插件卸载）。owner 不匹配则拒绝，防止误删核心元件。
    static deregisterClass(name: string, owner: string = "core"): boolean {
        const cur = ElementFactory.owners.get(name);
        if (cur == null) return false;
        if (cur !== owner) throw new Error(`[ExtCircuitJS] refuse to deregister "${name}" owned by "${cur}"`);
        ElementFactory.classMap.delete(name);
        ElementFactory.owners.delete(name);
        return true;
    }

    // ExtCircuitJS: 取已注册的构造函数——插件自定义元件靠继承核心元件实现，
    // 但它不能 import core 内部模块（lint 禁令），只能经宿主拿到基类。
    static getClass(name: string): ElmCtor | null {
        return ElementFactory.classMap.get(name) ?? null;
    }

    static listClasses(): string[] {
        return Array.from(ElementFactory.classMap.keys()).sort();
    }

    static hasConflict(name: string): boolean {
        return ElementFactory.classMap.has(name);
    }

    static ownerOf(name: string): string | null {
        return ElementFactory.owners.get(name) ?? null;
    }

    // Create element placed at (x1,y1) — used when user places a new element
    static create(name: string, x1: number, y1: number): any;
    // Create element from saved/loaded dump — used when loading a circuit file
    static create(name: string, x1: number, y1: number, x2: number, y2: number, f: number, st: StringTokenizer): any;
    static create(name: string, x1: number, y1: number, x2?: number, y2?: number, f?: number, st?: StringTokenizer): any {
        const ctor = ElementFactory.classMap.get(name);
        if (ctor == null) return null;
        if (x2 === undefined)
            return new ctor(x1, y1);
        return new ctor(x1, y1, x2, y2!, f!, st!);
    }

    static hasClass(name: string): boolean {
        return ElementFactory.classMap.has(name);
    }
}
