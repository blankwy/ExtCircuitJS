#!/usr/bin/env node
/**
 * ext — ExtCircuitJS 的 App 层 CLI（零依赖，Node ≥22）
 *
 *   node tools/ext.mjs doctor              环境/完整性自检
 *   node tools/ext.mjs dev [--port 5174]   dev server（core/ts 为 root，cover overlay 生效）
 *   node tools/ext.mjs build               tsc(core) + tsc(cover) + vite build -> dist/
 *   node tools/ext.mjs test                vitest（上游单测）
 *   node tools/ext.mjs cover <scan|status|apply|bless> [...]
 *   node tools/ext.mjs plugin <list|lint> [path...]   lint 可带显式路径（文件/目录），只跑代码三禁令
 *   node tools/ext.mjs core <install|sync>
 *   node tools/ext.mjs netlist registry   从 core/ts 重生成 packages/netlist/src/registry.json
 *   node tools/ext.mjs netlist bench     373 语料紧凑编码基准 -> build/netlist-bench.json（需 dev server）
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const coreRoot = path.join(root, "core", "ts");
const coverRoot = path.join(root, "cover");
const distDir = path.join(root, "dist");
const NODE = process.execPath;

const c = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    ok: (s) => `\x1b[32m${s}\x1b[0m`,
    warn: (s) => `\x1b[33m${s}\x1b[0m`,
    err: (s) => `\x1b[31m${s}\x1b[0m`,
    b: (s) => `\x1b[1m${s}\x1b[0m`,
};

function bin(rel) {
    return path.join(coreRoot, "node_modules", rel);
}

function exists(p) {
    try { fs.statSync(p); return true; } catch { return false; }
}

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * cover/ 在 core/ts 之外，Vite 配置里的外部依赖（vitest/config 等）按 Node 规则
 * 会从 cover/ 往上找 node_modules —— 找不到（仓库根没有 node_modules，依赖只装在
 * core/ts）。这里给 cover/ 建一个指向 core/ts/node_modules 的 junction/symlink，
 * 零拷贝、零版本漂移。
 *
 * A07（CI 首绿修复）：这个函数早期只定义、没人调用，靠开发机上手工建的链接才绿；
 * 干净检出（CI runner）下 vite 加载 cover/vite.cover.config.ts 必报
 * ERR_MODULE_NOT_FOUND: vitest。凡是要跑 vite 的子命令（dev / build）都必须先调它。
 *
 * Windows 优先 junction（走 reparse point，不需要管理员/开发者模式），
 * 再退 mklink /J，最后才试 symlink（需要开发者模式）。POSIX 直接 symlink。
 */
function coverDepsReady(link) {
    return exists(path.join(link, "vite", "package.json"));
}

function ensureCoverDeps() {
    const link = path.join(coverRoot, "node_modules");
    const target = path.join(coreRoot, "node_modules");
    if (coverDepsReady(link)) return true;

    // 链接存在但指向失效（换了机器/依赖被清过）：先摘掉再重建
    if (exists(link)) {
        try { fs.rmSync(link, { recursive: false, force: true }); } catch { /* junction 无法 unlink 时走 rmdir */ }
        try { if (exists(link)) fs.rmdirSync(link); } catch { /* ignore */ }
    }

    if (!exists(target)) {
        console.error(c.err(`[ext] missing core/ts/node_modules`));
        console.error(c.dim(`      hint: npm install --prefix core/ts  (或 node tools/ext.mjs core install)`));
        return false;
    }

    const mklink = () => {
        const r = spawnSync("cmd", ["/c", "mklink", "/J", link, target], { stdio: "ignore" });
        if (r.status !== 0) throw new Error(`mklink /J exit ${r.status}`);
    };
    const attempts = process.platform === "win32"
        ? [() => fs.symlinkSync(target, link, "junction"), mklink, () => fs.symlinkSync(target, link, "dir")]
        : [() => fs.symlinkSync(target, link, "dir")];

    const errs = [];
    for (const attempt of attempts) {
        try {
            attempt();
            if (coverDepsReady(link)) {
                console.log(c.dim(`[ext] linked cover/node_modules -> core/ts/node_modules`));
                return true;
            }
            errs.push("link created but does not resolve");
        } catch (e) {
            errs.push(e.message);
        }
    }
    console.error(c.err(`[ext] cannot link cover/node_modules -> core/ts/node_modules`));
    for (const e of errs) console.error(c.dim(`      ${e}`));
    console.error(c.dim("      vite 加载 cover/vite.cover.config.ts 需要从 cover/ 解析到 vitest/vite；"));
    console.error(c.dim("      手工兜底：ln -s core/ts/node_modules cover/node_modules（POSIX）"));
    return false;
}

function runNode(label, script, args, opts = {}) {
    if (!exists(script)) {
        console.error(c.err(`[ext] missing ${label}: ${script}`));
        console.error(c.dim("      hint: node tools/ext.mjs core install"));
        return 1;
    }
    console.log(c.dim(`[ext] ${label}`));
    const r = spawnSync(NODE, [script, ...args], { cwd: opts.cwd ?? root, stdio: "inherit", env: process.env });
    return r.status ?? 1;
}

function argValue(argv, name, fallback) {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

// ─────────────────────────────────────────────────────────────── doctor

function doctor() {
    let bad = 0;
    const check = (ok, label, detail = "") => {
        console.log(`  ${ok ? c.ok("PASS") : c.err("FAIL")}  ${label}${detail ? c.dim("  " + detail) : ""}`);
        if (!ok) bad++;
    };
    const warn = (ok, label, detail = "") => {
        console.log(`  ${ok ? c.ok("PASS") : c.warn("WARN")}  ${label}${detail ? c.dim("  " + detail) : ""}`);
    };

    console.log(c.b("ExtCircuitJS doctor"));
    const major = Number(process.versions.node.split(".")[0]);
    check(major >= 22, "node >= 22", process.versions.node);
    check(exists(path.join(coreRoot, "package.json")), "core/ts/package.json");
    warn(exists(path.join(coreRoot, "node_modules")), "core/ts/node_modules", exists(path.join(coreRoot, "node_modules")) ? "" : "run: node tools/ext.mjs core install");
    warn(coverDepsReady(path.join(coverRoot, "node_modules")), "cover/node_modules -> core/ts", coverDepsReady(path.join(coverRoot, "node_modules")) ? "" : "auto-linked on dev/build");

    // core.lock 与源码一致性
    let lock = null;
    try {
        lock = readJson(path.join(root, "core", "core.lock.json"));
        check(!!lock.commit, "core.lock.json", (lock.commit ?? "").slice(0, 12));
    } catch (e) {
        check(false, "core.lock.json", String(e.message));
    }
    if (lock) {
        const vers = fs.readFileSync(path.join(coreRoot, "CirSim.ts"), "utf8").match(/versionString: string = "([^"]+)"/)?.[1];
        check(vers === lock.versionString, "core version matches lock", `src=${vers} lock=${lock.versionString}`);
    }

    // cover manifest + 文件存在性
    try {
        const m = readJson(path.join(coverRoot, "cover.manifest.json"));
        const entries = m.entries ?? [];
        const missing = entries.filter((e) => !exists(path.join(root, e.localPath)));
        check(missing.length === 0, `cover manifest (${entries.length} entries)`, missing.map((e) => e.localPath).join(", "));
        const overrides = entries.filter((e) => e.kind === "override").length;
        console.log(c.dim(`         overrides=${overrides} adds=${entries.length - overrides} core=${m.core?.versionString ?? "?"}`));
    } catch (e) {
        check(false, "cover/cover.manifest.json", String(e.message));
    }

    // plugins manifest
    try {
        const pm = readJson(path.join(root, "plugins", "plugins.manifest.json"));
        const missing = (pm.plugins ?? []).filter((p) => !exists(path.join(root, "plugins", p.id, p.entry)));
        check(missing.length === 0, `plugins manifest (${(pm.plugins ?? []).length})`, missing.map((p) => p.id).join(", "));
    } catch (e) {
        check(false, "plugins/plugins.manifest.json", String(e.message));
    }

    // fixtures
    const corpus = path.join(root, "tests", "fixtures", "corpus-xml");
    const n = exists(corpus) ? fs.readdirSync(corpus).filter((f) => f.endsWith(".xml")).length : 0;
    check(n > 0, "contract corpus", `${n} xml`);

    console.log(bad === 0 ? c.ok(`\nall checks passed`) : c.err(`\n${bad} check(s) failed`));
    return bad === 0 ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────── dev / build / test

function dev(argv) {
    const port = argValue(argv, "--port", process.env.EXT_PORT ?? "5174");
    console.log(c.b(`ExtCircuitJS dev`) + c.dim(`  (root=core/ts, cover overlay, port=${port})`));
    if (!ensureCoverDeps()) return 1;
    return runNode("vite", bin("vite/bin/vite.js"), [
        "--config", path.join(coverRoot, "vite.cover.config.ts"),
        "--port", String(port),
    ]);
}

function build() {
    console.log(c.b("ExtCircuitJS build"));
    if (!ensureCoverDeps()) return 1;
    const steps = [
        ["tsc(core)", bin("typescript/bin/tsc"), ["-p", path.join(coreRoot, "tsconfig.json")]],
        ["tsc(cover)", bin("typescript/bin/tsc"), ["-p", path.join(coverRoot, "tsconfig.cover.json")]],
        ["vite build", bin("vite/bin/vite.js"), ["build", "--config", path.join(coverRoot, "vite.cover.config.ts")]],
    ];
    for (const [label, script, args] of steps) {
        const code = runNode(label, script, args);
        if (code !== 0) {
            console.error(c.err(`[ext] build failed at ${label}`));
            return code;
        }
    }
    const js = fs.existsSync(distDir) ? fs.readdirSync(path.join(distDir, "circuitjs")).filter((f) => f.endsWith(".js")) : [];
    console.log(c.ok(`[ext] build ok -> ${distDir}`) + c.dim(`  (${js.join(", ") || "no js"})`));
    return 0;
}

function test() {
    return runNode("vitest", bin("vitest/vitest.mjs"), ["run"], { cwd: coreRoot });
}

// ─────────────────────────────────────────────────────────────── cover / plugin / core

function cover(argv) {
    const script = path.join(here, "cover.mjs");
    const r = spawnSync(NODE, [script, ...argv], { cwd: root, stdio: "inherit" });
    return r.status ?? 1;
}

// ── plugin lint 三禁令（B06）：禁 import 指向 ../core；禁动态执行（eval / new Function 调用）；禁裸 document.write。
//    文本级正则、零依赖；报错（不是 warn），命中即 lint 失败。
const LINT_RULES = [
    { id: "core-import", re: /(?:\bfrom|\bimport)\s*\(?\s*["']((?:\.\.\/)+core(?:\/[^"']*)?)["']/g, hit: (m) => `import 指向 core: "${m[1]}"` },
    { id: "eval", re: /\beval\s*\(/g, hit: () => `动态代码执行 eval(` },
    { id: "new-function", re: /\bnew\s+Function\s*\(/g, hit: () => `动态代码执行 new Function(` },
    { id: "document-write", re: /\bdocument\s*\.\s*write\s*\(/g, hit: () => `裸 document.write(` },
];

/** 对单个源文件跑三禁令，返回命中数（每处命中一行 err，带行号）。 */
function lintCodeRules(file) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    const lineOf = (idx) => text.slice(0, idx).split("\n").length;
    let bad = 0;
    for (const rule of LINT_RULES) {
        rule.re.lastIndex = 0;
        for (let m = rule.re.exec(text); m; m = rule.re.exec(text)) {
            console.log(c.err(`  ${rel}:${lineOf(m.index)}: ${rule.id}: ${rule.hit(m)}`));
            bad++;
        }
    }
    return bad;
}

/** 收集待 lint 的源文件：参数是文件则单收（限 js/ts 家族），是目录则递归走（跳 node_modules 与点目录）。 */
function collectJsFiles(p) {
    const JS_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === "node_modules" || e.name.startsWith(".")) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (JS_EXT.has(path.extname(e.name))) out.push(full);
        }
    };
    if (!exists(p)) return out;
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (JS_EXT.has(path.extname(p))) out.push(p);
    return out;
}

function plugin(argv) {
    const sub = argv[0] ?? "list";
    const manifestPath = path.join(root, "plugins", "plugins.manifest.json");
    let manifest;
    try { manifest = readJson(manifestPath); } catch (e) {
        console.error(c.err(`[ext] cannot read ${manifestPath}: ${e.message}`));
        return 1;
    }
    const plugins = manifest.plugins ?? [];
    if (sub === "list") {
        for (const p of plugins) {
            const ok = exists(path.join(root, "plugins", p.id, p.entry));
            console.log(`  ${ok ? c.ok("OK  ") : c.err("MISS")}  ${p.id}@${p.version ?? "?"}  ${c.dim(p.entry)}  ${p.mode ?? "in-page"}`);
        }
        return plugins.every((p) => exists(path.join(root, "plugins", p.id, p.entry))) ? 0 : 1;
    }
    if (sub === "lint") {
        const targets = argv.slice(1);
        if (targets.length > 0) {
            // 显式路径模式：只对给定文件/目录跑代码三禁令（不做 manifest 级检查），
            // 用于双向验证——对故意违规样例报错，不污染 plugins.manifest.json。
            let bad = 0;
            for (const t of targets) {
                // 先按 cwd 解析（验收命令常从仓库外层跑，带 ExtCircuitJS/ 前缀），再退回 repo root
                const abs = path.resolve(t);
                const files = collectJsFiles(exists(abs) ? abs : path.resolve(root, t));
                if (files.length === 0) { console.log(c.err(`  lint target not found (or no js/ts files): ${t}`)); bad++; continue; }
                for (const f of files) bad += lintCodeRules(f);
            }
            console.log(bad === 0 ? c.ok("  plugin lint ok") : c.err(`  ${bad} issue(s)`));
            return bad === 0 ? 0 : 1;
        }
        let bad = 0;
        const ids = new Set();
        const cmds = new Map();
        for (const p of plugins) {
            if (!p.id) { console.log(c.err("  plugin without id")); bad++; continue; }
            if (ids.has(p.id)) { console.log(c.err(`  duplicate plugin id: ${p.id}`)); bad++; }
            ids.add(p.id);
            if (!exists(path.join(root, "plugins", p.id, p.entry))) { console.log(c.err(`  ${p.id}: missing entry ${p.entry}`)); bad++; }
            for (const cmd of p.claims?.commands ?? []) {
                if (cmds.has(cmd)) { console.log(c.err(`  command conflict: ${cmd} (${cmds.get(cmd)} vs ${p.id})`)); bad++; }
                cmds.set(cmd, p.id);
            }
            for (const f of collectJsFiles(path.join(root, "plugins", p.id))) {
                bad += lintCodeRules(f);
            }
        }
        console.log(bad === 0 ? c.ok("  plugin lint ok") : c.err(`  ${bad} issue(s)`));
        return bad === 0 ? 0 : 1;
    }
    console.error(c.err(`[ext] unknown plugin subcommand: ${sub}`));
    return 1;
}

function core(argv) {
    const sub = argv[0] ?? "install";
    if (sub === "install") {
        console.log(c.dim(`[ext] npm install --prefix ${path.relative(root, coreRoot)}`));
        const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: coreRoot, stdio: "inherit", shell: true });
        return r.status ?? 1;
    }
    if (sub === "sync") {
        console.log(c.b("core sync"));
        const r = spawnSync("git", ["ls-remote", "https://github.com/pfalstad/circuitjs1", "HEAD"], { encoding: "utf8" });
        if (r.status !== 0) {
            console.error(c.err("[ext] git ls-remote failed (network?)"));
            return 1;
        }
        const remote = (r.stdout || "").split(/\s+/)[0];
        const lock = readJson(path.join(root, "core", "core.lock.json"));
        console.log(`  remote HEAD : ${remote}`);
        console.log(`  locked      : ${lock.commit}`);
        if (remote === lock.commit) {
            console.log(c.ok("  core is up to date"));
            return 0;
        }
        console.log(c.warn("  upstream moved. Steps (manual, by design):"));
        console.log("    1) git clone --filter=blob:none https://github.com/pfalstad/circuitjs1 build/upstream");
        console.log("    2) node tools/ext.mjs cover scan --core build/upstream");
        console.log("    3) rebase cover/, then update core.lock.json + cover/cover.manifest.json");
        return 0;
    }
    if (sub === "sync-drill") {
        // A03 假上游演练（自包含沙箱，不动真 cover/）：
        //   fake-upstream = core/ts 拷贝 + 模拟一次上游演进（main.ts 追加一行）
        //   fake-cover    = 与 fork 点字节一致的 main.ts + 最小 manifest（forkPointBlob 取自真 manifest）
        // 预期：scan 判定 upstream-changed（上游变了、本地未偏离 fork 点）。
        // 另以真 manifest 跑对照：本地已分叉的 seam 判 both-changed（真实同步时的"需人工"信号）。
        console.log(c.b("core sync-drill") + c.dim("  fake upstream drill (sandbox)"));
        const build = path.join(root, "build");
        const fakeUp = path.join(build, "fake-upstream");
        const fakeCover = path.join(build, "fake-cover");
        fs.rmSync(fakeUp, { recursive: true, force: true });
        fs.rmSync(fakeCover, { recursive: true, force: true });
        fs.mkdirSync(path.join(fakeUp, "ts"), { recursive: true });
        fs.mkdirSync(path.join(fakeCover, "ts"), { recursive: true });
        fs.cpSync(coreRoot, path.join(fakeUp, "ts"), {
            recursive: true,
            filter: (s) => !s.split(path.sep).includes("node_modules"),
        });
        fs.appendFileSync(
            path.join(fakeUp, "ts", "main.ts"),
            "\n// [sync-drill] simulated upstream change (A03 drill, not a real sync)\n",
        );
        // fork 点内容 = 当前 core/ts/main.ts（core 锁定在 fork 点，doctor 已验证一致性）
        fs.copyFileSync(path.join(coreRoot, "main.ts"), path.join(fakeCover, "ts", "main.ts"));
        const realManifest = readJson(path.join(coverRoot, "cover.manifest.json"));
        const seam = realManifest.entries.find((e) => e.upstreamPath === "ts/main.ts");
        const drillManifest = {
            entries: [{
                upstreamPath: "ts/main.ts",
                localPath: "fake-cover/ts/main.ts",
                kind: "overridden",
                reason: "A03 sync-drill sandbox entry",
                forkPointBlob: seam.forkPointBlob,
                anchors: seam.anchors ?? [],
            }],
        };
        fs.writeFileSync(path.join(fakeCover, "cover.manifest.json"), JSON.stringify(drillManifest, null, 1));
        const scanDrill = (coverDir, outJson) => spawnSync(NODE, [
            path.join(here, "cover.mjs"), "scan",
            "--core", fakeUp, "--cover", coverDir, "--json", outJson,
        ], { cwd: root, encoding: "utf8" });
        const r1 = scanDrill(fakeCover, path.join(build, "cover-scan-drill.json"));
        const out1 = (r1.stdout ?? "") + (r1.stderr ?? "");
        process.stdout.write(out1.slice(0, 2500));
        const okDrill = out1.includes("upstream-changed");
        const r2 = scanDrill(coverRoot, path.join(build, "cover-scan-drill-real.json"));
        const out2 = (r2.stdout ?? "") + (r2.stderr ?? "");
        const both = out2.includes("both-changed");
        if (okDrill) {
            console.log(c.ok(`\n[ext] sync-drill ok: 沙箱判定 upstream-changed；真 manifest 对照 both-changed=${both}（本地分叉 seam 的预期信号）`));
        } else {
            console.error(c.err("\n[ext] sync-drill FAILED: 沙箱 scan 未报 upstream-changed"));
        }
        return okDrill ? 0 : 1;
    }
    console.error(c.err(`[ext] unknown core subcommand: ${sub}`));
    return 1;
}

// ─────────────────────────────────────────────────────────────── netlist

function netlist(argv) {
    const sub = argv[0] ?? "registry";
    if (sub === "registry") {
        return runNode("registry-gen", path.join(root, "packages", "netlist", "src", "registry-gen.mjs"), [], { cwd: root });
    }
    if (sub === "bench") {
        return runNode("netlist-bench", path.join(root, "tests", "contract", "netlist-bench.mjs"),
            argv.slice(1), { cwd: root });
    }
    console.error(c.err(`[ext] unknown netlist subcommand: ${sub}`));
    return 1;
}

// ─────────────────────────────────────────────────────────────── main

const [cmd, ...rest] = process.argv.slice(2);
const table = {
    doctor: () => doctor(),
    dev: () => dev(rest),
    build: () => build(),
    test: () => test(),
    cover: () => cover(rest),
    plugin: () => plugin(rest),
    core: () => core(rest),
    netlist: () => netlist(rest),
    help: () => { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]); return 0; },
};

if (!cmd || !table[cmd]) {
    console.error(c.err(`usage: node tools/ext.mjs <doctor|dev|build|test|cover|plugin|core>`));
    process.exit(1);
}
process.exit(table[cmd]());
