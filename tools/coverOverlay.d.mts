/** 类型声明：让 App 层的 vite.config.ts / vite.cover.config.ts 在 tsc 下能 import 这个原型 */
export interface CoverOverlayOptions {
  coreRoot?: string
  coverRoot?: string
  coverPublicDir?: string
  assetsDir?: string
  coreAlias?: string | false
  debug?: boolean
}

export interface ShadowResolver {
  resolve(source: string, importer?: string): string | null
  hits: Map<string, string>
  coreRoot: string
  coverRoot: string
}

export declare function splitId(id: string): [string, string]
export declare function resolveFile(p: string): string | null
export declare function createShadowResolver(options?: CoverOverlayOptions): ShadowResolver
export declare function coverOverlay(options?: CoverOverlayOptions): import('vite').Plugin
export default coverOverlay
