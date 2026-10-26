// 示例插件 ext-hook —— 演示 load / save 钩子（`ctx.hook`）。
//
// 它做两件很具体的事，正好用满钩子的两个方向：
//   · load：把外部工具产出的存档**规范化**（去掉 UTF-8 BOM、CRLF → LF、去掉本插件的尾部标记），
//           于是「带 BOM 的文件」「Windows 另存的文件」都能正常打开；
//   · save：在文件尾部追加一行版本标记（只对**用户真的在存文件**时做）。
//
// 两个关键纪律，抄这个插件的时候请一起抄：
//
//   1. 改写必须幂等。这里都是「先删标记再追加」，所以 保存 → 打开 → 保存 不会累积出多行标记。
//   2. **save 侧要按 meta.source 过滤，load 侧不要过滤。**
//      撤销快照（source=undo）、崩溃恢复（recovery）也走 dumpCircuit / readCircuit：
//        - save 侧不过滤 → 每按一个键都要给撤销快照套一遍标记，还会让 isModified() 的
//          文本比较变得又慢又脆；
//        - load 侧过滤 → 反而会因为「自己写进 localStorage 的恢复文本没被还原」而把
//          崩溃恢复读成一堆看不懂的东西。**自己写出去的格式，自己必须无条件认得。**

const MARK = "<!-- ext-circuitjs:1 -->";
const MARK_RE = /<!--\s*ext-circuitjs:1\s*-->/g;

function stripMark(text) {
    return text.replace(MARK_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function normalize(text) {
    // BOM 会让 CircuitLoader 的 `text.startsWith("<")` 判成"非 XML"，是最常见的存档不认账
    return text.replace(/^\uFEFF+/, "").replace(/\r\n?/g, "\n");
}

export async function activate(ctx) {
    ctx.hook("load", (text) => {
        const t = normalize(text);
        // 不看 source：只要文本里有我们的标记就还原
        // （用 includes 而不是正则 .test —— 带 /g 的正则有 lastIndex 状态，会隔次失灵）
        return t.includes(MARK) ? stripMark(t) + "\n" : t;
    });

    ctx.hook("save", (text, meta) => {
        if (meta.source !== "document") return text;
        return stripMark(text) + "\n" + MARK + "\n";
    });

    ctx.command({
        id: "ext-hook.about",
        label: "Ext Hook: load/save 钩子示例",
        category: "Ext",
        keywords: "hook save load demo 钩子",
        run() {
            const xml = ctx.api.dumpCircuitXml();
            ctx.log(`存档标记 ${xml.includes(MARK) ? "已写入" : "未写入"}，长度 ${xml.length}`);
        },
    });
}
