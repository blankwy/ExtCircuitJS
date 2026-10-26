// 测试侧入口：实现已上移到 tools/ts-resolve.mjs（运行时 `ext mcp` 也复用同一份）。
// 保留本文件是为了让既有调用点零改动：
//   register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
// hooks 模块被 register() 时读的是它的 resolve/load 导出，re-export 等价。
export { resolve, load } from "../../../tools/ts-resolve.mjs";
