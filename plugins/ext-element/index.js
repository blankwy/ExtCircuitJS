// 示例插件 · element：插件注册一个自定义元件，并让它"完整可用"。
// 完整可用 = 四件事同时成立（缺一件就是半成品）：
//   1) 类进 ElementFactory（能放置、能被 create）
//   2) dumpType / xmlType 进映射（存档能读回来）
//   3) Draw 菜单 / 右键菜单有条目（用户找得到）
//   4) 卸载时四样一起撤回（菜单条目、类、两份类型映射、可能的放置模式）
//
// 这里做的是 0.5Ω 分流电阻：内部就是核心 ResistorElm（电气行为完全复用），
// 只是默认阻值不同——这是最常见的插件元件形态（"常用规格的封装"）。
// 注意：插件拿不到 core 模块，基类只能经 ctx.element.base(...) 取。

export const name = "ext-element";

export async function activate(ctx) {
    const Base = ctx.element.base("ResistorElm");
    if (Base == null) {
        ctx.log("ResistorElm unavailable — element demo skipped");
        return;
    }

    // 文本存档类型号：核心已把 ASCII 码段占满，190 以上基本空闲。
    // 真实插件通常写死一个号（存档里存的就是它，换号会导致老存档读不回来）。
    const dumpType = ctx.element.freeDumpType();
    if (dumpType == null) {
        ctx.log("no free dump type — element demo skipped");
        return;
    }

    class ExtShuntElm extends Base {
        constructor(xa, ya, xb, yb, f, st) {
            super(xa, ya, xb, yb, f, st);
            // 放置（只有 xa/ya）时给 0.5Ω；从存档读入时保留文件里的阻值
            if (xb === undefined) this.resistance = 0.5;
        }
    }

    ctx.element.register({
        className: "ExtShuntElm",
        ctor: ExtShuntElm,
        dumpType,
        xmlType: "ExtShunt",
        label: "Add Ext Shunt (0.5Ω)",
    });

    ctx.log(`activated: ExtShuntElm (dumpType=${dumpType})`);
}

export async function deactivate() {
    // 类/映射/菜单条目都由 ctx.element.register 的 disposer 撤销，无需手工清理
}
