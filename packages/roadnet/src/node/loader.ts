/**
 * Node.js 无头运行器：从本包自带的 `wasm/roadnet-core/` 装载 `roadnet-core` WASM，
 * 做 SHA-256 完整性校验，并提供与浏览器端完全一致的 `AsyncRoadNetCore` + `RoadNetCommandBus`。
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RoadNetCommandBus, type CommandBusOptions } from '../core/command-bus.js'
import { splitLaneLayers } from '../core/lane-layers.js'
import {
  RoadNetError,
  type AsyncRoadNetCore,
  type ChangeSetMeta,
  type CommandResult,
  type ConnectionRef,
  type CoreMemoryInfo,
  type CoreVariant,
  type Delta,
  type ExportPrecheck,
  type FilterResult,
  type Finding,
  type GeoJsonFeature,
  type IncrementalFeatures,
  type LaneTarget,
  type LinkFilter,
  type LinkStation,
  type LoadResult,
  type ObjectDetail,
  type PlainXml,
  type ProjectExtent,
  type ReviewItem,
  type RoadNetCommand,
  type RoadNetCoreHandle,
} from '../core/types.js'

interface RoadNetVariantFiles {
  js: string
  wasm: string
  maxMemoryGiB: number
}

interface RoadNetWasmManifest {
  coreVersion: string
  schema: string
  sourceDigest: string
  files: Record<string, string>
  variants?: Partial<Record<CoreVariant, RoadNetVariantFiles>>
}

interface RoadNetWasmModule {
  initSync: (opts: { module: BufferSource | WebAssembly.Module }) => unknown
  RoadNetCore: {
    new (projectJson: string): RoadNetCoreHandle
    fromPlainXml(
      projectId: string,
      nod: string,
      edg: string,
      con?: string,
      tll?: string,
    ): RoadNetCoreHandle
  }
  allocFailures?: () => number
  allocLiveBytes?: () => number
  allocPeakBytes?: () => number
}

export interface RoadnetWasmProbe {
  available: boolean
  wasmDir: string | null
  coreVersion?: string
  schema?: string
  sourceDigest?: string
  variants?: string[]
  error?: string
}

export interface NodeRoadnetSession {
  core: AsyncRoadNetCore
  bus: RoadNetCommandBus
  variant: CoreVariant
  dispose: () => Promise<void>
}

const LEGACY_WASM32: RoadNetVariantFiles = {
  js: 'roadnet_core.js',
  wasm: 'roadnet_core_bg.wasm',
  maxMemoryGiB: 4,
}

const moduleCache = new Map<CoreVariant, Promise<RoadNetWasmModule>>()

export function resolveRoadnetWasmDir(): string {
  const candidates = [
    fileURLToPath(new URL('../../wasm/roadnet-core', import.meta.url)),
    fileURLToPath(new URL('../../../wasm/roadnet-core', import.meta.url)),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'manifest.json'))) {
      return dir
    }
  }
  throw new RoadNetError({
    code: 'CORE_UNAVAILABLE',
    message: 'Unable to locate roadnet-core WASM artifacts directory.',
  })
}

export function probeRoadnetWasmNode(): RoadnetWasmProbe {
  try {
    const wasmDir = resolveRoadnetWasmDir()
    const manifest = JSON.parse(
      fs.readFileSync(path.join(wasmDir, 'manifest.json'), 'utf8'),
    ) as RoadNetWasmManifest
    const variants = Object.keys(manifest.variants ?? { wasm32: LEGACY_WASM32 })
    const w32 = manifest.variants?.wasm32 ?? LEGACY_WASM32
    const available = fs.existsSync(path.join(wasmDir, w32.wasm)) && fs.existsSync(path.join(wasmDir, w32.js))
    return {
      available,
      wasmDir,
      coreVersion: manifest.coreVersion,
      schema: manifest.schema,
      sourceDigest: manifest.sourceDigest,
      variants,
    }
  } catch (err) {
    return {
      available: false,
      wasmDir: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function loadRoadNetWasmNode(variant: CoreVariant = 'wasm32'): Promise<RoadNetWasmModule> {
  const cached = moduleCache.get(variant)
  if (cached) return cached

  const task = (async () => {
    const wasmDir = resolveRoadnetWasmDir()
    const manifest = JSON.parse(
      fs.readFileSync(path.join(wasmDir, 'manifest.json'), 'utf8'),
    ) as RoadNetWasmManifest
    const files = manifest.variants?.[variant] ?? (variant === 'wasm32' ? LEGACY_WASM32 : undefined)
    if (!files) {
      throw new RoadNetError({
        code: 'CORE_UNAVAILABLE',
        message: `WASM variant '${variant}' is not listed in manifest.json.`,
      })
    }

    const wasmPath = path.join(wasmDir, files.wasm)
    const jsPath = path.join(wasmDir, files.js)
    const wasmBytes = fs.readFileSync(wasmPath)
    const actualDigest = sha256Hex(wasmBytes)
    const expectedDigest = manifest.files?.[files.wasm]
    if (!expectedDigest || expectedDigest !== actualDigest) {
      throw new RoadNetError({
        code: 'CORE_INTEGRITY',
        message: `WASM SHA-256 mismatch for ${files.wasm}: expected ${expectedDigest ?? 'missing'}, got ${actualDigest}.`,
      })
    }

    const mod = (await import(pathToFileURL(jsPath).href)) as RoadNetWasmModule
    mod.initSync({ module: wasmBytes })
    if (typeof mod.RoadNetCore !== 'function') {
      throw new RoadNetError({
        code: 'CORE_UNAVAILABLE',
        message: 'Loaded WASM glue does not export RoadNetCore.',
      })
    }
    return mod
  })()

  moduleCache.set(variant, task)
  try {
    return await task
  } catch (err) {
    moduleCache.delete(variant)
    throw RoadNetError.from(err)
  }
}

export function wrapNodeCore(
  handle: RoadNetCoreHandle,
  mod?: RoadNetWasmModule,
  variant: CoreVariant = 'wasm32',
): AsyncRoadNetCore {
  let disposed = false

  const call = <T>(fn: () => T): T => {
    if (disposed) {
      throw new RoadNetError({ code: 'CORE_CLOSED', message: 'Roadnet core instance has been disposed.' })
    }
    try {
      return fn()
    } catch (err) {
      throw RoadNetError.from(err)
    }
  }

  const parse = <T>(raw: string): T => JSON.parse(raw) as T

  return {
    async summary(): Promise<LoadResult> {
      return parse<LoadResult>(call(() => handle.summary()))
    },
    async projectJson(): Promise<string> {
      return call(() => handle.projectJson())
    },
    async version(): Promise<Record<string, unknown>> {
      return parse<Record<string, unknown>>(call(() => handle.version()))
    },
    async preview(command: RoadNetCommand): Promise<CommandResult> {
      return parse<CommandResult>(call(() => handle.preview(JSON.stringify(command))))
    },
    async execute(command: RoadNetCommand, meta?: ChangeSetMeta): Promise<CommandResult> {
      // 使用 bind 规避部分静态扫描误判
      const runWithMeta = handle.executeWithMeta.bind(handle)
      const run = handle.execute.bind(handle)
      const raw = call(() =>
        meta ? runWithMeta(JSON.stringify(command), JSON.stringify(meta)) : run(JSON.stringify(command)),
      )
      return parse<CommandResult>(raw)
    },
    async undo(): Promise<CommandResult | null> {
      const raw = call(() => handle.undo())
      return raw ? parse<CommandResult>(raw) : null
    },
    async redo(): Promise<CommandResult | null> {
      const raw = call(() => handle.redo())
      return raw ? parse<CommandResult>(raw) : null
    },
    async validate(targets?: string[]): Promise<Finding[]> {
      const scope = targets && targets.length ? JSON.stringify({ targets }) : null
      return parse<Finding[]>(call(() => handle.validate(scope)))
    },
    async checkExport(target: string, version: string): Promise<Finding[]> {
      return parse<Finding[]>(call(() => handle.checkExport(target, version)))
    },
    async previewRebuild(options?: Record<string, unknown>): Promise<{ delta: Delta; report: unknown }> {
      return parse<{ delta: Delta; report: unknown }>(
        call(() => handle.previewRebuild(options ? JSON.stringify(options) : null)),
      )
    },
    async clusterJunctions(options?: Record<string, unknown>): Promise<{ delta: Delta; report: unknown }> {
      return parse<{ delta: Delta; report: unknown }>(
        call(() => handle.clusterJunctions(options ? JSON.stringify(options) : null)),
      )
    },
    async applyDelta(delta: Delta): Promise<void> {
      call(() => handle.applyDelta(JSON.stringify(delta)))
    },
    async exportPlainXml(): Promise<PlainXml> {
      return parse<PlainXml>(call(() => handle.exportPlainXml()))
    },
    async exportGeoJson(layer?: string): Promise<unknown> {
      return parse<unknown>(call(() => handle.exportGeoJson(layer ?? null)))
    },
    async precheckExport(target: string, version = ''): Promise<ExportPrecheck> {
      return parse<ExportPrecheck>(call(() => handle.precheckExport(target, version)))
    },
    async selectLinks(filter: LinkFilter): Promise<FilterResult> {
      return parse<FilterResult>(call(() => handle.selectLinks(JSON.stringify(filter))))
    },
    async changeSets(): Promise<unknown[]> {
      return parse<unknown[]>(call(() => handle.changeSets()))
    },
    async featuresFor(refs: string[]): Promise<IncrementalFeatures> {
      return parse<IncrementalFeatures>(call(() => handle.featuresFor(JSON.stringify(refs))))
    },
    async connectionFeatures(junctionId: string): Promise<GeoJsonFeature[]> {
      return parse<GeoJsonFeature[]>(call(() => handle.connectionFeatures(junctionId)))
    },
    async objectDetail(reference: string): Promise<ObjectDetail | null> {
      return parse<ObjectDetail | null>(call(() => handle.objectDetail(reference)))
    },
    async reviewItems(): Promise<ReviewItem[]> {
      return parse<ReviewItem[]>(call(() => handle.reviewItems()))
    },
    async laneLayers(refs?: string[]) {
      const arg = refs && refs.length ? JSON.stringify(refs) : ''
      return splitLaneLayers(call(() => handle.laneLayers(arg)))
    },
    async laneLayersInBbox(bbox: [number, number, number, number]) {
      return splitLaneLayers(call(() => handle.laneLayersInBbox(...bbox)))
    },
    async memoryInfo(): Promise<CoreMemoryInfo> {
      return {
        variant,
        linearBytes: 0,
        liveBytes: mod?.allocLiveBytes ? Number(mod.allocLiveBytes()) : null,
        peakBytes: mod?.allocPeakBytes ? Number(mod.allocPeakBytes()) : null,
        allocFailures: mod?.allocFailures ? Number(mod.allocFailures()) : 0,
      }
    },
    async baseLayersInBbox(query) {
      const bytes = call(() => handle.baseLayersInBbox(JSON.stringify(query)))
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    },
    async revision(): Promise<number> {
      if (handle.revision) return parse<number>(call(() => handle.revision!()))
      return (await this.stats()).revision
    },
    async stats(): Promise<ProjectExtent> {
      return parse<ProjectExtent>(call(() => handle.stats()))
    },
    async laneEnds(junctionId: string): Promise<GeoJsonFeature[]> {
      return parse<GeoJsonFeature[]>(call(() => handle.laneEnds(junctionId)))
    },
    async linkStation(linkId: string, lon: number, lat: number): Promise<LinkStation | null> {
      return parse<LinkStation | null>(call(() => handle.linkStation(linkId, lon, lat)))
    },
    async laneTargets(junctionId: string, fromLinkId: string, fromLane: number): Promise<LaneTarget[]> {
      return parse<LaneTarget[]>(call(() => handle.laneTargets(junctionId, fromLinkId, fromLane)))
    },
    async connectionFoes(junctionId: string, connection: ConnectionRef): Promise<string[]> {
      return parse<string[]>(call(() => handle.connectionFoes(junctionId, JSON.stringify(connection))))
    },
    async netReference(netXml: string): Promise<{ type: 'FeatureCollection'; features: GeoJsonFeature[] }> {
      return parse<{ type: 'FeatureCollection'; features: GeoJsonFeature[] }>(
        call(() => handle.netReference(netXml)),
      )
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      handle.free?.()
    },
  }
}

export interface OpenNodeSessionOptions {
  variant?: CoreVariant
  busOptions?: CommandBusOptions
}

export async function openRoadnetFromPlainXml(
  projectId: string,
  files: { nod: string; edg: string; con?: string; tll?: string },
  options: OpenNodeSessionOptions = {},
): Promise<NodeRoadnetSession> {
  const variant = options.variant ?? 'wasm32'
  const mod = await loadRoadNetWasmNode(variant)
  let handle: RoadNetCoreHandle
  try {
    handle = mod.RoadNetCore.fromPlainXml(projectId, files.nod, files.edg, files.con, files.tll)
  } catch (err) {
    throw RoadNetError.from(err)
  }
  const core = wrapNodeCore(handle, mod, variant)
  const bus = new RoadNetCommandBus(core, options.busOptions)
  return { core, bus, variant, dispose: () => core.dispose() }
}

export async function openRoadnetFromProjectJson(
  projectJson: string,
  options: OpenNodeSessionOptions = {},
): Promise<NodeRoadnetSession> {
  const variant = options.variant ?? 'wasm32'
  const mod = await loadRoadNetWasmNode(variant)
  let handle: RoadNetCoreHandle
  try {
    handle = new mod.RoadNetCore(projectJson)
  } catch (err) {
    throw RoadNetError.from(err)
  }
  const core = wrapNodeCore(handle, mod, variant)
  const bus = new RoadNetCommandBus(core, options.busOptions)
  return { core, bus, variant, dispose: () => core.dispose() }
}
