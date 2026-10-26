// 站点配置的浏览器侧（运行时）。
//
// title 走的是「HTML 上的 data-* 属性」而不是 import JSON：
//   - dev 下改 cover/site.config.json 刷新即生效，不用等模块 HMR / 重启 dev server；
//   - 构建时值已经烘焙进产物 HTML，运行时无需再读文件。
// 其余字段（description / homeurl / about）是纯静态内容，构建期注入即可，运行时用不到。

/** CirSim.baseTitle 是 `static readonly`——TS 的只读只约束编译期，运行时是可写属性。
 *  这里通过 app.constructor 拿到类本身，避免 cover/ts 里多写一条到 core 的 import 路径。 */
export function applySiteConfig(app: any): void {
    const title = document.documentElement.dataset.extSiteTitle;
    if (!title) return;

    const CirSimClass = app?.constructor;
    if (!CirSimClass) return;
    const oldBase = CirSimClass.baseTitle;
    if (oldBase === title) return;

    const oldSuffix = ` - ${oldBase}`;
    CirSimClass.baseTitle = title;

    // UIManager 在 app.init() 期间已经写过一次 document.title（此时还是旧基名），
    // 这里就地换掉尾部，不用等下一次电路加载。
    if (document.title.endsWith(oldSuffix)) {
        document.title = document.title.slice(0, -oldSuffix.length) + ` - ${title}`;
    } else if (document.title === String(oldBase)) {
        document.title = title;
    }
}
