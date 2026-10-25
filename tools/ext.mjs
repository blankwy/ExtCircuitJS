#!/usr/bin/env node
/**
 * ext — ExtCircuitJS 的 App 层 CLI（零依赖，Node ≥22）
 *
 *   node tools/ext.mjs doctor              环境/完整性自检
 *   node tools/ext.mjs dev [--port 5174]   dev server（core/ts 为 root，cover overlay 生效）
 *   node tools/ext.mjs build               tsc(core) + tsc(cover) + vite build -> dist/
 *   node tools/ext.mjs test                vitest（上游单测）
 *   node tools/ext.mjs cover <scan|status|apply|bless> [...]
 *   node tools/ext.mjs plugin <list|lint>
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
 * 会从 cover/ 往上找 node_modules —— 找不到。这里给 cover/ 建一个指向 core/ts/node_modules
 * 的 junction/symlink，零拷贝、零版本漂移。
 */
function ensureCoverDeps() {
    const link = path.join(coverRoot, "node_modules");
    const target = path.join(coreRoot, "node_modules");
    if (exists(link)) return true;
    if (!exists(target)) return false;
    try {
        fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
        console.log(c.dim(`[ext] linked cover/node_modules -> core/ts/node_modules`));
        return true;
    } catch (e) {
        console.error(c.err(`[ext] cannot link cover/node_modules: ${e.message}`));
        return false;
    }
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
    return runNode("vite", bin("vite/bin/vite.js"), [
        "--config", path.join(coverRoot, "vite.cover.config.ts"),
        "--port", String(port),
    ]);
}

function build() {
    console.log(c.b("ExtCircuitJS build"));
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
            const src = path.join(root, "plugins", p.id, p.entry);
            if (exists(src)) {
                const text = fs.readFileSync(src, "utf8");
                for (const badWord of ["document.write", "eval(", "new Function("]) {
                    if (text.includes(badWord)) { console.log(c.warn(`  ${p.id}: suspicious API "${badWord}"`)); }
                }
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
