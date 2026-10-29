#!/usr/bin/env node
/**
 * 生成电路分享链接 / 分享页 —— Node 侧离线完成，不需要浏览器。
 *
 *   node tools/ext-share-url.mjs --circuit lrc
 *   node tools/ext-share-url.mjs --text "r 100 100 300 100 0 1000"
 *   node tools/ext-share-url.mjs --file my-circuit.txt
 *   node tools/ext-share-url.mjs --circuit lrc --base https://blankwy.github.io/ExtCircuitJS
 *   node tools/ext-share-url.mjs --circuit lrc --out build/share.html   # 同时出分享页
 *
 * 输出：一行分享 URL（`<base>/circuitjs.html?ctz=<LZString 压缩电路>`）。
 * 对方点开 = 立即可见电路 + 可点 RUN 仿真 + 可拖滑块调参。
 *
 * 为什么这是「最轻的交付路径」：
 *   · 不需要对方装 Node / Chrome / 任何东西（浏览器打开即可）
 *   · 不需要传文件、不需要服务端（ctz 全在 URL 里）
 *   · 链接可长可短：lrc 这类电路约 700 字符，复杂电路几 KB
 *
 * 限制：URL 长度。浏览器/聊天工具对 URL 长度容忍度不同（一般 <8KB 安全，
 * 部分 IM 会截断更早）。超过阈值时脚本会明确警告并建议改用分享页或单文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const argOf = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

/** LZString 来自上游依赖（纯 JS，无需浏览器） */
function loadLz() {
    const candidates = [
        path.join(root, "core/ts/node_modules/lz-string"),
        path.join(root, "node_modules/lz-string"),
    ];
    for (const p of candidates) {
        try {
            return require(p);
        } catch { /* 试下一个 */ }
    }
    throw new Error("找不到 lz-string —— 先运行 npm install --prefix core/ts");
}

/** 取电路文本：--circuit（内置语料）/ --file / --text */
function readCircuitText() {
    const builtin = argOf("circuit", null);
    const file = argOf("file", null);
    const inline = argOf("text", null);

    if (builtin) {
        const p = path.join(root, "core/ts/public/circuits", `${builtin}.txt`);
        if (!fs.existsSync(p)) throw new Error(`内置电路不存在: ${builtin}（路径 ${p}）`);
        return { text: fs.readFileSync(p, "utf8"), label: builtin };
    }
    if (file) {
        if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`);
        return { text: fs.readFileSync(path.resolve(file), "utf8"), label: path.basename(file) };
    }
    if (inline) return { text: inline, label: "(inline)" };
    throw new Error("必须指定 --circuit <名字> 或 --file <路径> 或 --text <电路文本>");
}

const lz = loadLz();
const { text, label } = readCircuitText();
if (!text.trim()) throw new Error("电路文本为空");

const ctz = lz.compressToEncodedURIComponent(text);
if (!ctz) throw new Error("压缩失败");

// 自检：解压必须逐字节还原（防止编码差异导致对方打开是空电路）
const back = lz.decompressFromEncodedURIComponent(ctz);
if (back !== text) throw new Error("压缩自检失败：解压结果与原文不一致");

const base = argOf("base", process.env.EXC_SHARE_BASE ?? "https://blankwy.github.io/ExtCircuitJS").replace(/\/+$/, "");
const url = `${base}/circuitjs.html?ctz=${ctz}`;

console.log(url);

// 长度评估（不同渠道容忍度不同，超阈值要提示）
const len = url.length;
const warn = [];
if (len > 2000) warn.push(`URL ${len} 字符：部分 IM/邮件客户端可能截断（>2000 开始有风险）`);
if (len > 8000) warn.push(`URL ${len} 字符：已超过常见安全上限（8000），强烈建议改用 --out 出分享页或单文件`);
for (const w of warn) console.error(`[warn] ${w}`);

// 可选：同时产出分享页（轻量，依赖原站点的脚本）
const outFile = argOf("out", null);
if (outFile) {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CircuitJS · ${label}</title>
<style>html,body{margin:0;height:100%;overflow:hidden}#cjs{position:absolute;inset:0;width:100%;height:100%;border:0}</style>
</head>
<body>
<iframe id="cjs" src="${url}" allow="clipboard-write"></iframe>
</body>
</html>`;
    const p = path.resolve(outFile);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, html, "utf8");
    console.error(`[out] 分享页: ${p}（${(Buffer.byteLength(html) / 1024).toFixed(1)} KB）`);
}

// 诊断信息走 stderr，保证 stdout 只有一行 URL（便于管道/Skill 直接抓取）
console.error(`[share] 电路 ${label}: ${text.length} 字节 → ctz ${ctz.length} 字符 → URL ${len} 字符`);
