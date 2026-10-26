/*
    Copyright (C) Paul Falstad and Iain Sharp

    This file is part of CircuitJS1.

    CircuitJS1 is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.
*/

// ExtCircuitJS A06 —— 菜单插槽（cover 新增文件）。
// 目的：插件/扩展向 Draw 菜单与右键菜单追加自定义元件项，**不改 core/ts/Menus.ts、
// 不改生成物 registerElements.ts**（development-plan 铁律 4）。
//
// 为什么不叫 Menus.ts：cover/ts 下的同名文件会经 coverOverlay 影子解析覆盖
// core/ts/Menus.ts（core 内部 import "./Menus" 全部命中 cover 副本），必须完整
// re-export 才安全；取新增文件名 ExtMenus.ts 零影子、零风险（偏离卡面已在 handoff 记录）。
//
// 机制（两层）：
//   1) 包装 Menus.prototype.composeMainMenu —— 覆盖未来的重组（core 仅在 init 时
//      compose 一次：popup=0、draw=1，Menus.ts:411-412）；
//   2) attach/detach 已构建的菜单 UL —— Menu 对象未存实例字段，只有 UL 在 DOM：
//      右键弹出菜单 = menus.mainMenuBar（实例字段），Draw 菜单 = menuBarRow 第 3 个
//      td（File/Edit/Draw/Scopes/Options 固定序，Menus.ts:465-469）下的 ul.menuDropdown，
//      并用 classToLabelMap 的 WireElm 标签做内容守卫（防索引漂移）。
//      追加逻辑自实现（Menu 类未导出，DOM 行为按 Menus.ts addCheckboxItem 复刻），不触碰既有条目。
// 自定义类必须已注册进 ElementFactory（registerClass），否则拒绝登记。

import { Menus } from "./Menus";
import { Locale } from "./Locale";
import { CirSim } from "./CirSim";

export interface ExtMenuEntry {
    /** 菜单显示名（建议 "Add " 开头，与 core 项一致） */
    label: string;
    /** ElementFactory 里已注册的元件类名 */
    className: string;
    /** 登记者（插件 id / "ext"），用于去重与卸载 */
    owner: string;
}

const entries: ExtMenuEntry[] = [];
let installed = false;
let origCompose: any = null;

/** 已登记的自定义菜单项（只读视图，测试/调试用） */
export function extMenuEntries(): readonly ExtMenuEntry[] {
    return entries;
}

function theApp(): any {
    return (CirSim as any).theApp;
}

/** 取已构建的目标 UL：右键弹出菜单 + Draw 菜单（内容守卫） */
function targetUls(): HTMLUListElement[] {
    const app = theApp();
    const menus = app?.menus;
    const out: HTMLUListElement[] = [];
    if (menus?.mainMenuBar != null) out.push(menus.mainMenuBar as HTMLUListElement);
    const row = menus?.menuBarRow as HTMLTableRowElement | undefined;
    const tds = row ? (Array.from(row.children) as HTMLElement[]) : [];
    // 固定序第 3 项是 Draw（Menus.ts:465-469）；用 WireElm 的本地化标签做内容守卫
    const drawTd = tds[2];
    const drawUl = drawTd?.querySelector("ul.menuDropdown") as HTMLUListElement | null;
    const wireLabel: string | undefined = app?.classToLabelMap?.get?.("WireElm");
    if (drawUl != null) {
        const labels = Array.from(drawUl.querySelectorAll(".itemLabel")).map((el) => el.textContent?.trim());
        if (wireLabel != null && labels.includes(wireLabel)) out.push(drawUl);
        else CirSim.console("[ExtCircuitJS] menu slot: Draw menu guard failed (index drift?), popup only");
    }
    return out;
}

/** 向既有 UL 追加一个条目（自实现 addCheckboxItem：Menu 类未导出，行为按 Menus.ts 复刻） */
function appendItem(ul: HTMLUListElement, entry: ExtMenuEntry): void {
    const app = theApp();
    const item: any = app.menus.getClassCheckItem(Locale.LS(entry.label), entry.className);
    const li = document.createElement("li");
    li.className = "menuItem";
    const label = item.getLabel ? item.getLabel() : entry.label;
    const sc = item.getShortcut ? item.getShortcut() : "";
    li.innerHTML = `<span class="checkMark">&#10003;</span> <span class="itemLabel">${Locale.LS(label)}</span>` +
        (sc ? `<span class="shortcutHint">${sc}</span>` : "");
    item._li = li;
    item.setState(item.getState());
    li.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    li.addEventListener("click", (e) => {
        e.stopPropagation();
        document.querySelectorAll(".gwt-MenuItem.open, .topMenuItem.open, li.hasSubmenu.open")
            .forEach((el) => el.classList.remove("open"));
        item.execute();
    });
    li.dataset.extMenu = entry.className;
    ul.appendChild(li);
}

/** 把全部登记项挂到已构建的菜单上 */
function attachAll(): void {
    if (entries.length === 0) return;
    for (const ul of targetUls()) {
        for (const e of entries) {
            try {
                if (ul.querySelector(`li[data-ext-menu="${e.className}"]`) == null) appendItem(ul, e);
            } catch (err) {
                CirSim.console(`[ExtCircuitJS] menu slot item "${e.label}" failed: ${err}`);
            }
        }
    }
}

/** 从既有 UL 摘除指定 className 的条目（主菜单栏的 Draw 在文档内；mainMenuBar 可能游离于 DOM 外，元素级查询同样有效） */
function detachClassNames(classNames: string[]): void {
    for (const ul of targetUls()) {
        for (const li of Array.from(ul.querySelectorAll("li[data-ext-menu]")) as HTMLElement[]) {
            if (classNames.includes(li.dataset.extMenu ?? "")) li.remove();
        }
    }
}

/**
 * 登记一个自定义元件菜单项。className 必须已注册进 ElementFactory；
 * label/className 重复或试图遮蔽核心元件会被拒绝（结构化结果，不抛异常）。
 */
export function registerMenuElement(
    label: string,
    className: string,
    owner: string = "ext",
): { ok: boolean; reason?: string } {
    if (!label || !className) return { ok: false, reason: "label and className are required" };
    if (entries.some((e) => e.label === label)) return { ok: false, reason: `duplicate label "${label}"` };
    if (entries.some((e) => e.className === className))
        return { ok: false, reason: `duplicate className "${className}"` };
    if (["ResistorElm", "WireElm", "GroundElm"].includes(className))
        return { ok: false, reason: `refusing to shadow core element "${className}"` };
    entries.push({ label, className, owner });
    attachAll(); // 菜单已构建：立即追加（app 未就绪时为 no-op，installMenuSlot 后再 attach）
    return { ok: true };
}

/** 按 owner 撤销登记（插件卸载用），返回撤销的条数 */
export function unregisterMenuElements(owner: string): number {
    const classNames = entries.filter((e) => e.owner === owner).map((e) => e.className);
    if (classNames.length === 0) return 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (classNames.includes(entries[i].className)) entries.splice(i, 1);
    }
    detachClassNames(classNames);
    return classNames.length;
}

/**
 * 安装插槽（幂等）：包装 Menus.prototype.composeMainMenu 覆盖未来的重组，
 * 并把当前登记项挂到已构建的菜单上。
 */
export function installMenuSlot(): { ok: boolean; reason?: string } {
    if (installed) {
        attachAll();
        return { ok: true };
    }
    const proto: any = Menus.prototype;
    if (typeof proto.composeMainMenu !== "function")
        return { ok: false, reason: "Menus.prototype.composeMainMenu not found (core drift? check anchors)" };
    origCompose = proto.composeMainMenu;
    proto.composeMainMenu = function (this: any, menu: any, num: number) {
        const r = origCompose.call(this, menu, num);
        for (const e of entries) {
            try {
                menu.addCheckboxItem(this.getClassCheckItem(Locale.LS(e.label), e.className));
                const li = (menu.ul as HTMLElement).lastElementChild as HTMLElement | null;
                if (li != null) li.dataset.extMenu = e.className;
            } catch (err) {
                CirSim.console(`[ExtCircuitJS] menu slot item "${e.label}" failed: ${err}`);
            }
        }
        return r;
    };
    installed = true;
    attachAll();
    return { ok: true };
}

/** 测试/重置用：卸下包装（恢复原方法）并清空登记与 DOM 标记条目 */
export function resetMenuSlot(): void {
    detachClassNames(entries.map((e) => e.className));
    const proto: any = Menus.prototype;
    if (installed && origCompose != null) {
        proto.composeMainMenu = origCompose;
    }
    installed = false;
    entries.length = 0;
}
