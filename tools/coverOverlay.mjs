/**
 * coverOverlay() — ExtCircuitJS "Cover 层" Vite/Rolldown 插件原型 (Spike B)
 *
 * 语义（按路径影子解析 / path-mirrored shadowing）:
 *   coreRoot/<rel>  存在 且 coverRoot/<rel> 存在  ->  解析到 coverRoot/<rel>
 *   coreRoot/<rel>  不存在 且 coverRoot/<rel> 存在 ->  解析到 coverRoot/<rel>（cover 新增文件）
 *   coverRoot/public/<rel> 存在                    ->  dev 中间件优先返回、build 后拷贝覆盖 dist/<assetsDir>/<rel>
 *   "@upstream/<rel>"（coreAlias）                 ->  强制走上游文件（薄影子薄覆盖用）
 *
 * 设计约束（见 docs/spikes/cover-build.md）:
 *   - 不复制、不改写 core 源码树；只在解析阶段做 id 重定向，并且把 cover 文件当成真实文件读。
 *   - 返回的 id 是 cover 目录里的真实绝对路径，所以 Vite 的 HMR 图、sourcemap、tsc 之外的
 *     转换管线都把它当普通模块处理；覆盖文件的修改会走标准 HMR 流程。
 *   - 不动 tsconfig / 不注入全局变量，构建产物里保留原类名（keepNames 由上游 vite.config.ts 保证）。
 *
 * @typedef {object} CoverOverlayOptions
 * @property {string} [coreRoot]       上游源码根（含 tsconfig.json / vite.config.ts 的目录），默认 process.cwd()
 * @property {string} [coverRoot]      覆盖层根，默认 <coreRoot>/../cover
 * @property {string} [coverPublicDir] 覆盖层静态资源根，默认 <coverRoot>/public
 * @property {string} [assetsDir]      上游 build.assetsDir，默认 'circuitjs'
 * @property {string} [coreAlias]      指向上游原文件的别名前缀，默认 '@upstream/'
 * @property {boolean} [debug]         打印每次影子解析命中
 */
import fs from 'node:fs'
import path from 'node:path'

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.html', '.txt', '.svg']

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

/** 把 "x.ts?raw" 拆成 ["x.ts", "?raw"] */
export function splitId(id) {
  const i = id.search(/[?#]/)
  return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i)]
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function isInside(root, p) {
  const r = path.relative(root, p)
  return !!r && !r.startsWith('..') && !path.isAbsolute(r)
}

/** 无扩展名导入的补全规则（Vite 默认能做的事，这里要自己做，因为 resolveId 抢先了） */
export function resolveFile(p) {
  if (isFile(p)) return p
  for (const ext of EXTENSIONS) if (isFile(p + ext)) return p + ext
  for (const ext of EXTENSIONS) {
    const idx = path.join(p, 'index' + ext)
    if (isFile(idx)) return idx
  }
  return null
}

/**
 * 影子解析核心（纯函数式，方便 node 单测）；返回 { resolve(source, importer) -> id|null, hits }
 */
export function createShadowResolver(options = {}) {
  const coreRoot = path.resolve(options.coreRoot ?? process.cwd())
  const coverRoot = path.resolve(options.coverRoot ?? path.join(coreRoot, '..', 'cover'))
  const coreAlias = options.coreAlias ?? '@upstream/'
  const hits = new Map() // coreRel -> coverAbs

  /** 相对 coreRoot 的路径；不在核心树内返回 null */
  function coreRelOf(abs) {
    return isInside(coreRoot, abs) ? path.relative(coreRoot, abs).split(path.sep).join('/') : null
  }

  /** 覆盖层文件（真实存在的），按 core 相对路径查 */
  function coverFileAt(rel) {
    const p = path.join(coverRoot, rel)
    return isFile(p) ? p : null
  }

  function note(rel, coverAbs) {
    hits.set(rel, coverAbs)
    return coverAbs
  }

  function resolve(source, importer) {
    const [spec, query] = splitId(source)
    if (!spec) return null
    if (spec.startsWith('\0')) return null
    if (spec.startsWith('virtual:') || spec.startsWith('node:') || spec.startsWith('/@')) return null

    // 0) 显式指向上游：@upstream/ResistorElm —— 供"薄影子"读取被覆盖的原文件
    if (coreAlias && spec.startsWith(coreAlias)) {
      const target = resolveFile(path.join(coreRoot, spec.slice(coreAlias.length)))
      return target ? target + query : null
    }

    // 1) 以 / 开头的 root-relative 请求（HTML 里的 /main.ts、/style.css；dev 直接 curl 模块）
    if (spec.startsWith('/')) {
      const rel = spec.replace(/^\/+/, '')
      const fromCore = resolveFile(path.join(coreRoot, rel))
      if (!fromCore) return null
      const coreRel = coreRelOf(fromCore)
      const cover = coreRel && coverFileAt(coreRel)
      return cover ? note(coreRel, cover) + query : null
    }

    if (!importer) return null
    if (!spec.startsWith('.')) return null // 裸模块（node_modules 等）不介入

    const importerFile = splitId(importer)[0]
    const importerInCover = isInside(coverRoot, importerFile)
    const importerCoreRel = coreRelOf(importerFile)
    // 导入者的"虚拟核心目录"：cover 文件按 coverRoot 的镜像位置计算
    const baseRel = importerInCover
      ? path.relative(coverRoot, importerFile).split(path.sep).join('/')
      : importerCoreRel
    if (!baseRel) return null

    const candidateRel = path.posix.normalize(path.posix.join(path.posix.dirname(baseRel), spec))

    // 2) 覆盖层内部相对导入：cover 里的新文件优先（cover 允许任意新增文件）
    if (importerInCover) {
      const local = resolveFile(path.join(coverRoot, candidateRel))
      if (local) return note(candidateRel, local) + query
    }

    // 3) 上游相对导入 -> 查覆盖
    const coreTarget = resolveFile(path.join(coreRoot, candidateRel))
    if (coreTarget) {
      const rel = coreRelOf(coreTarget)
      const cover = rel && coverFileAt(rel)
      if (cover) return note(rel, cover) + query
      // 关键：覆盖文件里的相对导入如果指向"没有覆盖"的上游文件，必须自己返回**绝对路径**。
      // 返 null 会把解析权交回 Vite，而 Vite 是按覆盖文件的物理位置（cover/）解析的，
      // 于是 ./CircuitElm 会去 cover/CircuitElm.ts 找 -> "Failed to resolve import"。
      // （Spike B 实测踩到过，见 docs/spikes/cover-build.md 的"已知坑"。）
      return importerInCover ? coreTarget + query : null
    }

    // 4) 上游没有、覆盖层有：覆盖层新增文件（被 core 代码 import 的场景）
    if (!importerInCover) {
      const coverOnly = resolveFile(path.join(coverRoot, candidateRel))
      if (coverOnly) return note(candidateRel, coverOnly) + query
    }
    return null
  }

  return { resolve, hits, coreRoot, coverRoot }
}

/**
 * @param {CoverOverlayOptions} options
 */
export function coverOverlay(options = {}) {
  const coreRoot = path.resolve(options.coreRoot ?? process.cwd())
  const coverRoot = path.resolve(options.coverRoot ?? path.join(coreRoot, '..', 'cover'))
  const coverPublicDir = path.resolve(options.coverPublicDir ?? path.join(coverRoot, 'public'))
  const assetsDir = options.assetsDir ?? 'circuitjs'
  // ExtCircuitJS：产物目录由 App 层决定（不在 core 树里），默认仍兼容 coreRoot/dist
  const outDir = path.resolve(options.outDir ?? path.join(coreRoot, 'dist'))
  const debug = options.debug ?? false
  const resolver = createShadowResolver({ ...options, coreRoot, coverRoot })
  const log = (...a) => {
    if (debug) console.log('[cover-overlay]', ...a)
  }

  let isBuild = false
  const written = []

  return {
    name: 'cover-overlay',
    enforce: 'pre',

    configResolved(config) {
      isBuild = config.command === 'build' && !config.isPreview
      log(`root=${config.root} coreRoot=${coreRoot} coverRoot=${coverRoot}`)
    },

    resolveId(source, importer) {
      const id = resolver.resolve(source, importer)
      if (id) log(`${source}  [${importer ?? '<entry>'}]  ->  ${id}`)
      return id
    },

    buildStart() {
      if (isBuild) log(`shadow hits during build start: ${resolver.hits.size}`)
    },

    configureServer(server) {
      // 覆盖层静态资源（public/ 镜像）在 dev 阶段抢在 Vite 静态中间件之前
      server.middlewares.use((req, res, next) => {
        if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) return next()
        const urlPath = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '')
        if (!urlPath) return next()
        const candidate = path.join(coverPublicDir, urlPath)
        if (!isInside(coverPublicDir, candidate) || !isFile(candidate)) return next()
        log(`public overlay: /${urlPath}`)
        res.setHeader('Content-Type', MIME[path.extname(candidate).toLowerCase()] ?? 'application/octet-stream')
        if (req.method === 'HEAD') return res.end()
        fs.createReadStream(candidate).pipe(res)
      })
    },

    handleHotUpdate(ctx) {
      const changed = ctx.file
      if (isInside(coverRoot, changed)) {
        log(`HMR cover change: ${path.relative(coverRoot, changed)} modules=${ctx.modules.length}`)
        if (ctx.modules.length === 0) {
          // 覆盖层文件不在模块图里（例如只被 public 中间件服务的资源）——直接整页刷新
          ctx.server.ws?.send?.({ type: 'full-reload' })
          return []
        }
      }
      return undefined
    },

    closeBundle() {
      if (!isBuild) return
      // 上游 copyPublicAssets 把 public/ 拍平进 dist/<assetsDir>/，这里做同样映射的覆盖层最后写入
      const distAssets = path.join(outDir, assetsDir)
      if (fs.existsSync(coverPublicDir)) {
        const walk = (dir, prefix = '') => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${e.name}` : e.name
            const src = path.join(dir, e.name)
            if (e.isDirectory()) walk(src, rel)
            else if (e.isFile()) {
              const dest = path.join(distAssets, rel)
              fs.mkdirSync(path.dirname(dest), { recursive: true })
              fs.copyFileSync(src, dest)
              written.push(rel)
            }
          }
        }
        walk(coverPublicDir)
        log(`public overlay copied ${written.length} file(s) into ${path.relative(coreRoot, distAssets)}`)
      }
      // 构建产物里的可观测报告（CI 可以直接断言/归档）
      const reportPath = path.join(outDir, 'cover-overlay.json')
      fs.mkdirSync(path.dirname(reportPath), { recursive: true })
      fs.writeFileSync(
        reportPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            coverRoot,
            shadowed: [...resolver.hits.keys()].sort(),
            publicOverlay: written.slice().sort()
          },
          null,
          2
        )
      )
    }
  }
}

export default coverOverlay
