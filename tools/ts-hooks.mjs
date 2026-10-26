// 进程级 TS 加载钩子（`node --import ./tools/ts-hooks.mjs ...` 用）。
// 实现与测试基座同一份：tools/ts-resolve.mjs。
import { register } from "node:module";

register(new URL("./ts-resolve.mjs", import.meta.url));
