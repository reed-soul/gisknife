/**
 * 浏览器端 WASM 内核装载器（带 SHA-256 摘要校验与 wasm32/memory64 变体检测）。
 */

import { RoadNetError, type CoreMemoryInfo, type CoreVariant, type RoadNetCoreHandle } from '../core/types.js'

export type { CoreMemoryInfo, CoreVariant }

export interface RoadNetWasmModule {
  default: (input?: unknown) => Promise<unknown>
  RoadNetCore: {
    new (projectJson: string): RoadNetCoreHandle
    fromPlainXml(
      projectId: string,
      nod: string,
      edg: string,
      con?: string,
      tll?: string,
    ): RoadNetCoreHandle
    fromPlainXmlBytes?(
      projectId: string,
      nod: Uint8Array,
      edg: Uint8Array,
      con?: Uint8Array,
      tll?: Uint8Array,
    ): RoadNetCoreHandle
    fromProjectBytes?(projectJson: Uint8Array): RoadNetCoreHandle
  }
  allocFailures?: () => number
  allocLiveBytes?: () => number
  allocPeakBytes?: () => number
  coreVersion?: () => string
  destructiveCommands?: () => string
  isDestructive?: (commandJson: string) => boolean
}

export interface RoadNetVariantFiles {
  js: string
  wasm: string
  maxMemoryGiB: number
}

export interface RoadNetWasmManifest {
  coreVersion: string
  schema: string
  sourceDigest: string
  files: Record<string, string>
  variants?: Partial<Record<CoreVariant, RoadNetVariantFiles>>
}

const identities = new WeakMap<RoadNetWasmModule, string>()
export function coreSourceDigest(module: RoadNetWasmModule): string {
  return identities.get(module) ?? ''
}

const LEGACY_WASM32: RoadNetVariantFiles = {
  js: 'roadnet_core.js',
  wasm: 'roadnet_core_bg.wasm',
  maxMemoryGiB: 4,
}

export function detectMemory64(): boolean {
  try {
    const bytes = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 3, 1, 4, 1)
    return typeof WebAssembly !== 'undefined' && WebAssembly.validate(bytes)
  } catch {
    return false
  }
}

export interface LoadCoreOptions {
  importModule?: (url: string) => Promise<RoadNetWasmModule>
  fetchResource?: (url: string) => Promise<Response>
  digest?: (bytes: ArrayBuffer) => Promise<string>
  baseUrl?: string
  variant?: CoreVariant
  supportsMemory64?: () => boolean
}

const DIR = 'wasm/roadnet-core/'

function resolveBase(options: LoadCoreOptions): string {
  if (options.baseUrl) {
    return options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`
  }
  const metaEnv = (import.meta as { env?: { BASE_URL?: string } }).env
  const base = metaEnv?.BASE_URL ?? '/'
  return `${base.endsWith('/') ? base : `${base}/`}${DIR}`
}

async function defaultDigest(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new RoadNetError({
      code: 'CORE_INTEGRITY',
      message: 'crypto.subtle is unavailable; open via HTTPS or localhost to verify WASM integrity.',
    })
  }
  const hash = await subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const cached = new Map<CoreVariant, Promise<RoadNetWasmModule>>()
const memories = new WeakMap<RoadNetWasmModule, WebAssembly.Memory>()

export function coreMemoryInfo(module: RoadNetWasmModule, variant: CoreVariant): CoreMemoryInfo {
  const num = (fn?: () => number): number | null => {
    try {
      return typeof fn === 'function' ? Number(fn()) : null
    } catch {
      return null
    }
  }
  return {
    variant,
    linearBytes: memories.get(module)?.buffer.byteLength ?? 0,
    liveBytes: num(module.allocLiveBytes),
    peakBytes: num(module.allocPeakBytes),
    allocFailures: num(module.allocFailures) ?? 0,
  }
}

function versioned(url: string, digest: string | undefined): string {
  return digest ? `${url}?v=${digest.slice(0, 16)}` : url
}

export async function loadRoadNetWasm(options: LoadCoreOptions = {}): Promise<RoadNetWasmModule> {
  const injected = Boolean(options.importModule || options.fetchResource)
  const variant: CoreVariant = options.variant ?? 'wasm32'
  const hit = injected ? undefined : cached.get(variant)
  if (hit) return hit

  if (variant === 'memory64' && !(options.supportsMemory64 ?? detectMemory64)()) {
    throw new RoadNetError({
      code: 'CORE_UNSUPPORTED',
      message: 'Browser does not support WebAssembly Memory64.',
    })
  }

  const task = (async () => {
    const base = resolveBase(options)
    const fetchResource = options.fetchResource ?? ((url: string) => fetch(url))

    const manifestResponse = await fetchResource(`${base}manifest.json`)
    if (!manifestResponse.ok) {
      throw new RoadNetError({
        code: 'CORE_UNAVAILABLE',
        message: `Failed to fetch WASM manifest (HTTP ${manifestResponse.status}): ${base}manifest.json`,
      })
    }
    const manifest = (await manifestResponse.json()) as RoadNetWasmManifest
    const files = manifest.variants?.[variant] ?? (variant === 'wasm32' ? LEGACY_WASM32 : undefined)
    if (!files) {
      throw new RoadNetError({
        code: 'CORE_UNAVAILABLE',
        message: `Variant '${variant}' missing from WASM manifest.`,
      })
    }

    const wasmResponse = await fetchResource(versioned(`${base}${files.wasm}`, manifest.files?.[files.wasm]))
    if (!wasmResponse.ok) {
      throw new RoadNetError({
        code: 'CORE_UNAVAILABLE',
        message: `Failed to fetch WASM binary (HTTP ${wasmResponse.status}).`,
      })
    }
    const bytes = await wasmResponse.arrayBuffer()
    const actual = await (options.digest ?? defaultDigest)(bytes)
    const expected = manifest.files?.[files.wasm]
    if (!expected || expected !== actual) {
      throw new RoadNetError({
        code: 'CORE_INTEGRITY',
        message: `WASM SHA-256 mismatch (expected ${expected ?? 'missing'}, actual ${actual}).`,
      })
    }

    const importModule = options.importModule ?? ((url: string) => importGlue(url, fetchResource))
    const module = await importModule(versioned(`${base}${files.js}`, manifest.files?.[files.js]))
    if (typeof module.default === 'function') {
      const exports = (await module.default({ module_or_path: bytes })) as { memory?: unknown } | undefined
      const memory = exports?.memory
      if (typeof WebAssembly !== 'undefined' && memory instanceof WebAssembly.Memory) memories.set(module, memory)
    }
    if (typeof module.RoadNetCore !== 'function') {
      throw new RoadNetError({
        code: 'CORE_UNAVAILABLE',
        message: 'WASM module does not export RoadNetCore.',
      })
    }
    identities.set(module, manifest.sourceDigest)
    return module
  })()

  if (!injected) cached.set(variant, task)
  try {
    return await task
  } catch (error) {
    if (!injected) cached.delete(variant)
    throw RoadNetError.from(error)
  }
}

function coreError(error: unknown): unknown {
  if (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError) return error
  return RoadNetError.from(error)
}

export async function createCoreFromProject(
  projectJson: string,
  options: LoadCoreOptions = {},
): Promise<RoadNetCoreHandle> {
  const module = await loadRoadNetWasm(options)
  try {
    return new module.RoadNetCore(projectJson)
  } catch (error) {
    throw coreError(error)
  }
}

export async function createCoreFromPlainXml(
  projectId: string,
  files: { nod: string; edg: string; con?: string; tll?: string },
  options: LoadCoreOptions = {},
): Promise<RoadNetCoreHandle> {
  const module = await loadRoadNetWasm(options)
  try {
    return module.RoadNetCore.fromPlainXml(projectId, files.nod, files.edg, files.con, files.tll)
  } catch (error) {
    throw coreError(error)
  }
}

const utf8 = new TextDecoder()

export async function createCoreFromProjectBytes(
  bytes: Uint8Array,
  options: LoadCoreOptions = {},
): Promise<RoadNetCoreHandle> {
  const module = await loadRoadNetWasm(options)
  try {
    return module.RoadNetCore.fromProjectBytes
      ? module.RoadNetCore.fromProjectBytes(bytes)
      : new module.RoadNetCore(utf8.decode(bytes))
  } catch (error) {
    throw coreError(error)
  }
}

export async function createCoreFromPlainXmlBytes(
  projectId: string,
  files: { nod: Uint8Array; edg: Uint8Array; con?: Uint8Array; tll?: Uint8Array },
  options: LoadCoreOptions = {},
): Promise<RoadNetCoreHandle> {
  const module = await loadRoadNetWasm(options)
  try {
    if (module.RoadNetCore.fromPlainXmlBytes) {
      return module.RoadNetCore.fromPlainXmlBytes(projectId, files.nod, files.edg, files.con, files.tll)
    }
    const text = (part?: Uint8Array) => (part ? utf8.decode(part) : undefined)
    return module.RoadNetCore.fromPlainXml(
      projectId,
      utf8.decode(files.nod),
      utf8.decode(files.edg),
      text(files.con),
      text(files.tll),
    )
  } catch (error) {
    throw coreError(error)
  }
}

async function importGlue(
  url: string,
  fetchResource: (url: string) => Promise<Response>,
): Promise<RoadNetWasmModule> {
  const response = await fetchResource(url)
  if (!response.ok) {
    throw new RoadNetError({
      code: 'CORE_UNAVAILABLE',
      message: `Failed to fetch WASM glue (HTTP ${response.status}): ${url}`,
    })
  }
  const source = await response.text()
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    return (await import(/* @vite-ignore */ blobUrl)) as RoadNetWasmModule
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

export function resetRoadNetWasmCache(): void {
  cached.clear()
}
