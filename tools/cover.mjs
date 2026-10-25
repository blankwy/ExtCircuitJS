#!/usr/bin/env node
/**
 * cover.mjs — ExtCircuitJS 上游更新三方冲突扫描 / 物化原型（Spike B）
 *
 *   node tools/cover.mjs status [--core <上游克隆根>] [--cover <覆盖层根>] [--strict-anchors]
 *   node tools/cover.mjs scan   [--json <file>]
 *   node tools/cover.mjs apply  [--out <dir>] [--dry-run]
 *   node tools/cover.mjs bless  [--force]
 *   node tools/cover.mjs verify-hashes [--core <路径含 .git 的克隆>]
 *
 * 三方判定（base = 上次接受覆盖时的快照，ours = cover 现在的文件，theirs = 上游现在的文件）:
 *   clean           上游没变、本地也没变          -> 无需动作
 *   upstream-changed 上游变了、本地没变            -> 可以直接重新 fork（机械 rebase）
 *   local-only      只有本地改                    -> 正常，覆盖层自己的修改
 *   both-changed    两边都改                      -> 必须人工 rebase（exit 1）
 *   orphan          被覆盖的上游文件没了/改名      -> 必须人工移除或重命名（exit 1）
 *   added 条目被上游新增同名文件（collision）      -> 视作 both-changed（exit 1）
 *
 * 除 blob hash 外，manifest 每项还可以写 anchors（上游方法/字段签名），scan 会做轻量语义校验：
 * 上游"实现变了但签名没变" -> hash 变、anchor 通过（可机械 rebase）；
 * 上游"签名变了" -> anchor 失败，直接告诉你哪一条依赖断了。--strict-anchors 时 anchor 缺失算冲突。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDefault = path.resolve(here, '..')
const repoRootDefault = rootDefault

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const opts = {
    cmd: argv[0],
    core: path.join(rootDefault, 'core'),
    cover: path.join(rootDefault, 'cover'),
    tsSubdir: 'ts',
    out: path.join(rootDefault, 'build'),
    json: null,
    strictAnchors: false,
    dryRun: false,
    noFail: false,
    force: false
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--core') opts.core = path.resolve(argv[++i])
    else if (a === '--cover') opts.cover = path.resolve(argv[++i])
    else if (a === '--ts-subdir') opts.tsSubdir = argv[++i]
    else if (a === '--out') opts.out = path.resolve(argv[++i])
    else if (a === '--json') opts.json = path.resolve(argv[++i])
    else if (a === '--strict-anchors') opts.strictAnchors = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--no-fail') opts.noFail = true
    else if (a === '--force') opts.force = true
    else throw new Error(`unknown option: ${a}`)
  }
  return opts
}

// ---------------------------------------------------------------- hashing
/**
 * git blob hash（= git hash-object），纯 Node 实现：sha1("blob <len>\0" + content)
 *
 * 归一化策略：文本文件先把 CRLF 折成 LF 再算 hash（本仓库 .gitattributes 有 * text=auto，
 * git hash-object 也是这么算的 —— 否则 Windows 检出/cover 里 Node 写出的 LF 文件会互相判成"都改过"）。
 * 含 NUL 字节的文件按二进制原样 hash。
 */
export function gitBlobHash(buf) {
  let body = buf
  if (!buf.includes(0)) {
    const text = buf.toString('utf8').replace(/\r\n/g, '\n')
    body = Buffer.from(text, 'utf8')
  }
  const header = Buffer.from(`blob ${body.length}\0`, 'utf8')
  return crypto.createHash('sha1').update(Buffer.concat([header, body])).digest('hex')
}

function readBlob(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? gitBlobHash(fs.readFileSync(file)) : null
}

function readText(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null
}

const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n')

/** anchors: 纯文本签名 -> 去空白后做子串匹配（容忍格式化/换行变化，不懂语义） */
export function checkAnchors(text, anchors = []) {
  if (!text) return anchors.map((a) => ({ pattern: a, ok: false, reason: 'upstream file missing' }))
  const hay = norm(text).replace(/\s+/g, ' ')
  return anchors.map((a) => {
    const needle = norm(a).replace(/\s+/g, ' ')
    return { pattern: a, ok: hay.includes(needle), reason: hay.includes(needle) ? null : 'signature not found upstream' }
  })
}

// ---------------------------------------------------------------- manifest
function manifestPath(opts) {
  return path.join(opts.cover, 'cover.manifest.json')
}

function loadManifest(opts) {
  const p = manifestPath(opts)
  if (!fs.existsSync(p)) throw new Error(`manifest not found: ${p}`)
  const m = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (!Array.isArray(m.entries)) throw new Error('manifest.entries must be an array')
  for (const e of m.entries) {
    if (!e.upstreamPath || !e.localPath || !e.kind) throw new Error(`bad manifest entry: ${JSON.stringify(e)}`)
    // 兼容两套词汇：docs 用 override/add，旧 spike manifest 用 overridden/added
    const kind = e.kind === 'override' ? 'overridden' : e.kind === 'add' ? 'added' : e.kind
    if (kind !== 'overridden' && kind !== 'added') throw new Error(`bad kind: ${e.kind}`)
    e.kind = kind
  }
  return m
}

/** 上游路径以 ts/<rel> 形式存储，但 core 根可能是 work/ts（= ts 目录本身）或克隆根 */
function upstreamFile(opts, entry) {
  const m = /^ts\/(.*)$/.exec(entry.upstreamPath)
  if (!m) throw new Error(`upstreamPath must start with ts/: ${entry.upstreamPath}`)
  const rootIsTsDir = fs.existsSync(path.join(opts.core, 'vite.config.ts'))
  const base = rootIsTsDir ? opts.core : path.join(opts.core, opts.tsSubdir)
  return path.join(base, m[1])
}

function repoRelative(opts, entry) {
  return entry.localPath
}

function localFile(opts, entry) {
  // localPath 形如 cover/ResistorElm.ts —— 相对"覆盖层根的父目录"
  const m = /^([^/]+)\/(.*)$/.exec(entry.localPath)
  const base = m ? (m[1] === path.basename(opts.cover) ? path.dirname(opts.cover) : path.dirname(opts.cover)) : path.dirname(opts.cover)
  return path.join(base, entry.localPath)
}

/** 目录树拷贝（排除 node_modules / 产物目录） */
function copyTree(src, dest, exclude = new Set(['node_modules', 'dist', 'dist-thin', '.vite', '.git'])) {
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.has(e.name)) continue
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) copyTree(s, d, exclude)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}

function walkFiles(dir, prefix = '', out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, rel, out)
    else if (e.isFile()) out.push(rel)
  }
  return out
}

// ---------------------------------------------------------------- scan
export function scan(opts) {
  const manifest = loadManifest(opts)
  const entries = manifest.entries.map((e) => {
    const upFile = upstreamFile(opts, e)
    const locFile = localFile(opts, e)
    const upstreamNow = readBlob(upFile)
    const localNow = readBlob(locFile)
    const forkPoint = e.forkPointBlob || null
    const localBase = e.localBaseBlob ?? (e.kind === 'overridden' ? forkPoint : null)

    const upstreamChanged = upstreamNow !== forkPoint
    const localChanged = localNow !== localBase

    let status
    if (e.kind === 'added') {
      if (upstreamNow) status = 'both-changed' // 上游新增了同名文件：碰撞，必须人工
      else status = localNow ? 'local-only' : 'orphan'
    } else if (!upstreamNow) status = 'orphan'
    else if (upstreamChanged && localChanged) status = 'both-changed'
    else if (upstreamChanged) status = 'upstream-changed'
    else if (localChanged) status = 'local-only'
    else status = 'clean'

    const anchors = checkAnchors(readText(upFile), e.anchors || [])
    const anchorMisses = anchors.filter((a) => !a.ok && readText(upFile) !== null)

    return {
      upstreamPath: e.upstreamPath,
      localPath: repoRelative(opts, e),
      kind: e.kind,
      owner: e.owner ?? null,
      reason: e.reason ?? null,
      status,
      upstreamChanged,
      localChanged,
      forkPointBlob: forkPoint,
      upstreamNowBlob: upstreamNow,
      localNowBlob: localNow,
      localBaseBlob: localBase,
      diverged: e.kind === 'overridden' ? localNow !== forkPoint : true,
      anchors,
      anchorMisses: anchorMisses.length,
      note:
        e.kind === 'added'
          ? upstreamNow
            ? 'upstream now ships this path: collision'
            : 'cover-only file'
          : status === 'orphan'
            ? 'upstream file gone/renamed'
            : null
    }
  })

  const counts = {}
  for (const e of entries) counts[e.status] = (counts[e.status] || 0) + 1
  const hardConflicts = entries.filter((e) => e.status === 'both-changed' || e.status === 'orphan').length
  const anchorConflicts = opts.strictAnchors ? entries.filter((e) => e.anchorMisses > 0).length : 0

  return {
    generatedAt: new Date().toISOString(),
    core: opts.core,
    cover: opts.cover,
    upstream: manifest.upstream ?? null,
    counts,
    conflicts: hardConflicts + anchorConflicts,
    anchorWarnings: entries.filter((e) => e.anchorMisses > 0).length,
    entries
  }
}

// ---------------------------------------------------------------- render
const STATUS_LABEL = {
  clean: 'clean',
  'upstream-changed': 'upstream-changed(rebase)',
  'local-only': 'local-only',
  'both-changed': 'both-changed(HUMAN)',
  orphan: 'orphan(HUMAN)'
}

function renderStatus(report) {
  const rows = report.entries.map((e) => [
    e.status,
    e.kind,
    e.upstreamPath,
    e.localPath,
    e.anchors.length ? `${e.anchors.length - e.anchorMisses}/${e.anchors.length}` : '-',
    e.owner ?? '-'
  ])
  const head = ['STATUS', 'KIND', 'UPSTREAM', 'COVER', 'ANCHORS', 'OWNER']
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ')
  const out = []
  out.push(line(head))
  out.push(w.map((n) => '-'.repeat(n)).join('  '))
  for (const r of rows) out.push(line(r))
  out.push('')
  out.push(`summary: ${Object.entries(report.counts).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  out.push(`conflicts: ${report.conflicts}  anchorWarnings: ${report.anchorWarnings}`)
  const drifted = report.entries.filter((e) => e.anchorMisses > 0)
  for (const e of drifted) {
    for (const a of e.anchors.filter((x) => !x.ok)) out.push(`  ! ${e.upstreamPath}: anchor missing -> ${a.pattern}`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------- apply
function apply(opts, report) {
  const srcDir = path.join(opts.out, 'src')
  const plan = []
  if (!opts.dryRun) {
    if (fs.existsSync(srcDir)) fs.rmSync(srcDir, { recursive: true, force: true })
    copyTree(opts.core, srcDir)
  }
  // 清单以"真正落盘的 build/src"为准（dry-run 时用 core 树 + 同样的排除规则）
  const EXCLUDE_RE = /^(node_modules|dist|dist-thin|\.vite|\.git)\//
  const tree = opts.dryRun ? walkFiles(opts.core) : walkFiles(srcDir)
  for (const rel of tree) if (!EXCLUDE_RE.test(rel)) plan.push({ rel, source: 'core' })
  for (const e of report.entries) {
    const m = /^ts\/(.*)$/.exec(e.upstreamPath)
    if (!m) continue
    const target = path.join(srcDir, m[1])
    const src = localFile(opts, e)
    const exists = fs.existsSync(src)
    plan.push({ rel: m[1], source: exists ? 'cover' : 'MISSING', localPath: e.localPath, status: e.status })
    if (!opts.dryRun && exists) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(src, target)
    }
  }
  const reportOut = {
    generatedAt: report.generatedAt,
    core: opts.core,
    cover: opts.cover,
    out: opts.out,
    dryRun: opts.dryRun,
    counts: report.counts,
    conflicts: report.conflicts,
    entries: report.entries,
    materialized: plan
  }
  if (!opts.dryRun) {
    fs.mkdirSync(opts.out, { recursive: true })
    fs.writeFileSync(path.join(opts.out, 'cover-report.json'), JSON.stringify(reportOut, null, 2))
  }
  return reportOut
}

// ---------------------------------------------------------------- bless
function bless(opts) {
  const manifest = loadManifest(opts)
  for (const e of manifest.entries) {
    const upFile = upstreamFile(opts, e)
    const locFile = localFile(opts, e)
    e.forkPointBlob = readBlob(upFile)
    // base 语义：overridden 以"上游 fork 点"为 base（=> 有本地改动就是 local-only，符合直觉）；
    // added 条目 base 为 null。blessedLocalBlob 只是当次快照，便于审计。
    e.localBaseBlob = e.kind === 'overridden' ? e.forkPointBlob : null
    e.blessedLocalBlob = readBlob(locFile)
  }
  const out = {
    ...manifest,
    blessedAt: new Date().toISOString(),
    upstream: {
      ...(manifest.upstream ?? {}),
      commit: gitHead(opts.core)
    }
  }
  fs.writeFileSync(manifestPath(opts), JSON.stringify(out, null, 2) + '\n')
  return out
}

function gitHead(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function verifyHashes(opts) {
  const manifest = loadManifest(opts)
  const rows = []
  for (const e of manifest.entries) {
    const upFile = upstreamFile(opts, e)
    const ours = readBlob(upFile)
    let git = null
    try {
      git = execFileSync('git', ['-C', opts.core, 'hash-object', '--', upFile], { encoding: 'utf8' }).trim()
    } catch (err) {
      git = `error: ${String(err.message).split('\n')[0]}`
    }
    rows.push({
      upstreamPath: e.upstreamPath,
      nodeBlob: ours,
      gitHashObject: ours === null ? '(upstream file absent)' : git,
      match: ours === null ? null : ours === git
    })
  }
  return rows
}

// ---------------------------------------------------------------- main
function main() {
  const opts = parseArgs(process.argv.slice(2))
  let code = 0
  if (opts.cmd === 'scan' || opts.cmd === 'status') {
    const report = scan(opts)
    if (opts.json) {
      fs.mkdirSync(path.dirname(opts.json), { recursive: true })
      fs.writeFileSync(opts.json, JSON.stringify(report, null, 2))
    }
    if (opts.cmd === 'status') console.log(renderStatus(report))
    else console.log(JSON.stringify(report, null, 2))
    code = report.conflicts > 0 ? 1 : 0
  } else if (opts.cmd === 'apply') {
    const report = scan(opts)
    const result = apply(opts, report)
    console.log(
      `apply ${opts.dryRun ? '(dry-run) ' : ''}-> ${path.join(opts.out, 'src')}  files=${result.materialized.length}  ` +
        `cover=${result.materialized.filter((m) => m.source === 'cover').length}  conflicts=${report.conflicts}`
    )
    if (opts.dryRun) console.log(JSON.stringify(result.materialized.filter((m) => m.source !== 'core'), null, 2))
    code = report.conflicts > 0 ? 1 : 0
  } else if (opts.cmd === 'bless') {
    const out = bless(opts)
    console.log(`blessed ${out.entries.length} entries -> ${manifestPath(opts)}`)
  } else if (opts.cmd === 'verify-hashes') {
    const rows = verifyHashes(opts)
    console.table(rows)
    code = rows.every((r) => r.match !== false) ? 0 : 1
  } else {
    console.error('usage: node tools/cover.mjs <scan|status|apply|bless|verify-hashes> [options]')
    code = 2
  }
  process.exit(opts.noFail ? 0 : code)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
}
