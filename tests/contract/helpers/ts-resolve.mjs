// Node 契约测试的 TS 加载基座（coverOverlay 解析语义的 Node 子集）：
//   1. cover/core 的 TS 源码用无扩展名相对导入（"./StringTokenizer"），Node ESM 不认 → 补 ".ts" 重试；
//   2. cover/ts 内的相对导入若 cover 里没有对应文件 → 镜像回落到 core/ts 同位置
//      （对应 tools/coverOverlay.mjs 规则 3：覆盖文件的未覆盖导入解析到 core 真实路径）。
//   只在默认解析失败时介入，不改动任何源码，不处理裸模块。
// 用法（测试文件顶部，之后必须动态导入）：
//   import { register } from "node:module";
//   register(new URL("./helpers/ts-resolve.mjs", import.meta.url));
//   const mod = await import("../../cover/ts/SomeModule.ts");
// （Node ≥23.6 原生剥离类型，无需 flag；Node 22 需 --experimental-strip-types）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../.."); // helpers/ → 仓库根
const coverTs = path.join(repoRoot, "cover", "ts");
const coreTs = path.join(repoRoot, "core", "ts");

function isInside(root, p) {
    const r = path.relative(root, p);
    return !!r && !r.startsWith("..") && !path.isAbsolute(r);
}

/** 无扩展名路径的补全：先原文，再 .ts（与 Vite 补全规则的常用子集一致） */
function findFile(base) {
    for (const ext of ["", ".ts"]) {
        try {
            if (fs.statSync(base + ext).isFile()) return base + ext;
        } catch { /* not found */ }
    }
    return null;
}

export async function resolve(specifier, context, nextResolve) {
    try {
        return await nextResolve(specifier, context);
    } catch (err) {
        if (!specifier.startsWith(".")) throw err;
        const importer = context.parentURL ? fileURLToPath(context.parentURL) : null;
        if (!importer) throw err;
        const fromDir = path.dirname(importer);

        let target = findFile(path.resolve(fromDir, specifier));
        if (!target && isInside(coverTs, importer)) {
            // cover → core 镜像：按 cover/ts 内的相对位置映射到 core/ts
            const mirrored = path.join(coreTs, path.relative(coverTs, fromDir), specifier);
            target = findFile(mirrored);
        }
        if (!target) throw err;
        return nextResolve(pathToFileURL(target).href, context);
    }
}
