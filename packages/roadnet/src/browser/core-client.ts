/**
 * 浏览器端异步内核客户端（Worker 与主线程回退双通道），向命令总线提供 `AsyncRoadNetCore`。
 */

import {
  RoadNetError,
  type AsyncRoadNetCore,
  type BaseLayerQuery,
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
  type LaneLayerPayload,
  type LaneTarget,
  type LinkFilter,
  type LinkStation,
  type LoadResult,
  type ObjectDetail,
  type PlainXml,
  type ProjectExtent,
  type ReviewItem,
  type RoadNetCommand,
  type TimelineEntry,
} from '../core/types.js'
import { detectMemory64 } from './core-loader.js'
import {
  acquireRecoveryLease,
  exportFileNames,
  releaseExportFiles,
  type OpfsRecoveryMeta,
} from './recovery-store.js'
import {
  handleRequest,
  payloadBytes,
  transferablesOfPayload,
  type OpenPayload,
  type WorkerRequest,
  type WorkerResponse,
} from './worker-host.js'

type Invoke = (method: string, args: unknown[]) => Promise<unknown>

function parse<T>(raw: unknown): T {
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw RoadNetError.from(error)
  }
}

function makeCore(
  invoke: Invoke,
  dispose: () => Promise<void>,
  cleanupReady: () => Promise<void> = async () => {},
): AsyncRoadNetCore {
  const tokens = new WeakMap<File, string>()
  const revisions = new WeakMap<File, number>()
  const leases = new Map<string, () => Promise<void>>()
  return {
    async exportFiles(kind, maxBytes) {
      const token = crypto.randomUUID()
      const names = exportFileNames(kind, token)
      try {
        if (typeof navigator.storage?.getDirectory === 'function' && navigator.locks) {
          leases.set(token, await acquireRecoveryLease(`export:${token}`))
        }
        const result = (await invoke('exportFiles', [kind, maxBytes, token])) as
          | File[]
          | { files: File[]; token?: string; revision: number }
        if (Array.isArray(result)) {
          await leases.get(token)?.()
          leases.delete(token)
          return result
        }
        for (const file of result.files) {
          if (result.token) tokens.set(file, result.token)
          revisions.set(file, result.revision)
        }
        if (!result.token) {
          await leases.get(token)?.()
          leases.delete(token)
        }
        return result.files
      } catch (error) {
        await cleanupReady()
        try {
          await releaseExportFiles(names)
        } catch (cleanup) {
          console.warn('Interrupted export cleanup deferred', cleanup)
        } finally {
          await leases.get(token)?.()
          leases.delete(token)
        }
        throw error
      }
    },
    exportRevision: (file) => revisions.get(file),
    async releaseExports(files) {
      const owned = [...new Set(files.map((file) => tokens.get(file)).filter((t): t is string => Boolean(t)))]
      for (const token of owned) {
        await cleanupReady()
        try {
          await releaseExportFiles(
            exportFileNames('plain', token).concat(exportFileNames('project', token), exportFileNames('geojson', token)),
          )
          await invoke('releaseExports', [token]).catch(() => {})
        } finally {
          await leases.get(token)?.()
          leases.delete(token)
        }
      }
      for (const file of files) tokens.delete(file)
    },
    async discardRecovery(key) {
      await invoke('discardRecovery', [key])
    },
    async recoveryInfo() {
      return (await invoke('recoveryInfo', [])) as OpfsRecoveryMeta | null
    },
    async recoveryHistory() {
      return (await invoke('recoveryHistory', [])) as { history: TimelineEntry[]; cursor: number }
    },
    async recoveryDrafts() {
      return (await invoke('recoveryDrafts', [])) as OpfsRecoveryMeta[]
    },
    async summary() {
      return parse<LoadResult>(await invoke('summary', []))
    },
    async projectJson() {
      return (await invoke('projectJson', [])) as string
    },
    async version() {
      return parse<Record<string, unknown>>(await invoke('version', []))
    },
    async preview(command: RoadNetCommand) {
      return parse<CommandResult>(await invoke('preview', [JSON.stringify(command)]))
    },
    async execute(command: RoadNetCommand, meta?: ChangeSetMeta) {
      const raw = meta
        ? await invoke('executeWithMeta', [JSON.stringify(command), JSON.stringify(meta)])
        : await invoke('execute', [JSON.stringify(command)])
      return parse<CommandResult>(raw)
    },
    async undo() {
      const raw = await invoke('undo', [])
      return raw ? parse<CommandResult>(raw) : null
    },
    async redo() {
      const raw = await invoke('redo', [])
      return raw ? parse<CommandResult>(raw) : null
    },
    async validate(targets?: string[]) {
      const scope = targets && targets.length ? JSON.stringify({ targets }) : null
      return parse<Finding[]>(await invoke('validate', [scope]))
    },
    async checkExport(target: string, version: string) {
      return parse<Finding[]>(await invoke('checkExport', [target, version]))
    },
    async previewRebuild(options?: Record<string, unknown>) {
      return parse<{ delta: Delta; report: unknown }>(
        await invoke('previewRebuild', [options ? JSON.stringify(options) : null]),
      )
    },
    async clusterJunctions(options?: Record<string, unknown>) {
      return parse<{ delta: Delta; report: unknown }>(
        await invoke('clusterJunctions', [options ? JSON.stringify(options) : null]),
      )
    },
    async applyDelta(delta: Delta) {
      await invoke('applyDelta', [JSON.stringify(delta)])
    },
    async exportPlainXml() {
      return parse<PlainXml>(await invoke('exportPlainXml', []))
    },
    async exportGeoJson(layer?: string) {
      return parse<unknown>(await invoke('exportGeoJson', [layer ?? null]))
    },
    async precheckExport(target: string, version = '') {
      return parse<ExportPrecheck>(await invoke('precheckExport', [target, version]))
    },
    async selectLinks(filter: LinkFilter) {
      return parse<FilterResult>(await invoke('selectLinks', [JSON.stringify(filter)]))
    },
    async changeSets() {
      return parse<unknown[]>(await invoke('changeSets', []))
    },
    async featuresFor(refs: string[]) {
      return parse<IncrementalFeatures>(await invoke('featuresFor', [JSON.stringify(refs)]))
    },
    async laneLayers(refs?: string[]) {
      const arg = refs && refs.length ? JSON.stringify(refs) : ''
      return (await invoke('laneLayers', [arg])) as LaneLayerPayload
    },
    async laneLayersInBbox(bbox: [number, number, number, number]) {
      return (await invoke('laneLayersInBbox', [...bbox])) as LaneLayerPayload
    },
    async baseLayersInBbox(query: BaseLayerQuery) {
      return (await invoke('baseLayersInBbox', [JSON.stringify(query)])) as ArrayBuffer
    },
    async revision() {
      return parse<number>(await invoke('revision', []))
    },
    async stats() {
      return parse<ProjectExtent>(await invoke('stats', []))
    },
    async memoryInfo() {
      return (await invoke('memoryInfo', [])) as CoreMemoryInfo
    },
    async linkStation(linkId: string, lon: number, lat: number) {
      return parse<LinkStation | null>(await invoke('linkStation', [linkId, lon, lat]))
    },
    async laneTargets(junctionId: string, fromLinkId: string, fromLane: number) {
      return parse<LaneTarget[]>(await invoke('laneTargets', [junctionId, fromLinkId, fromLane]))
    },
    async connectionFoes(junctionId: string, connection: ConnectionRef) {
      return parse<string[]>(await invoke('connectionFoes', [junctionId, JSON.stringify(connection)]))
    },
    async netReference(netXml: string) {
      return parse<{ type: 'FeatureCollection'; features: GeoJsonFeature[] }>(
        await invoke('netReference', [netXml]),
      )
    },
    async laneEnds(junctionId: string) {
      return parse<GeoJsonFeature[]>(await invoke('laneEnds', [junctionId]))
    },
    async connectionFeatures(junctionId: string) {
      return parse<GeoJsonFeature[]>(await invoke('connectionFeatures', [junctionId]))
    },
    async reviewItems() {
      return parse<ReviewItem[]>(await invoke('reviewItems', []))
    },
    async objectDetail(reference: string) {
      return parse<ObjectDetail | null>(await invoke('objectDetail', [reference]))
    },
    dispose,
  }
}

export class WorkerCoreClient {
  private readonly worker: Worker
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; fileWrite: boolean; opening: boolean }
  >()
  private seq = 0
  private stopped = false
  private opened = false
  private shutdownId: number | null = null
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null
  private shutdownPromise: Promise<void> | null = null
  private shutdownDone: (() => void) | null = null

  constructor(worker: Worker) {
    this.worker = worker
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      if (message?.id === this.shutdownId) {
        this.finishShutdown()
        return
      }
      const slot = this.pending.get(message?.id)
      if (!slot) return
      this.pending.delete(message.id)
      if (message.ok) {
        if (slot.opening) this.opened = true
        slot.resolve(message.result)
      } else {
        slot.reject(new RoadNetError(message.error ?? { code: 'CORE_FAILED', message: 'Unknown core error.' }))
      }
    })
    const fatal = (event: Event) => {
      const error = new RoadNetError({
        code: 'CORE_FAILED',
        message: `Roadnet worker crashed: ${(event as ErrorEvent).message ?? 'unknown error'}`,
      })
      this.stopped = true
      this.finishShutdown()
      for (const [, slot] of this.pending) slot.reject(error)
      this.pending.clear()
    }
    this.worker.addEventListener('error', fatal)
    this.worker.addEventListener('messageerror', fatal)
  }

  invoke: Invoke = (method, args) => this.send(method, args, [])

  send(method: string, args: unknown[], transfer: Transferable[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new RoadNetError({ code: 'CORE_CLOSED', message: 'Roadnet core is closed.' }))
        return
      }
      const id = ++this.seq
      const payload = args[0] as OpenPayload | undefined
      this.pending.set(id, {
        resolve,
        reject,
        opening: method === 'open',
        fileWrite:
          method === 'exportFiles' ||
          (method === 'open' && payload?.kind !== 'recovery' && Boolean(payload?.recoveryKey)),
      })
      const request: WorkerRequest = { id, method, args }
      try {
        this.worker.postMessage(request, transfer)
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private finishShutdown(): void {
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer)
    this.shutdownTimer = null
    this.shutdownId = null
    this.worker.terminate()
    this.shutdownDone?.()
    this.shutdownDone = null
  }

  terminate(graceful = true): Promise<void> {
    if (this.stopped) return this.shutdownPromise ?? Promise.resolve()
    this.shutdownPromise = new Promise((done) => {
      this.shutdownDone = done
    })
    const drain = graceful && (this.opened || [...this.pending.values()].some((slot) => slot.fileWrite))
    this.stopped = true
    for (const slot of this.pending.values()) {
      slot.reject(new RoadNetError({ code: 'CORE_CLOSED', message: 'Core disposed; pending request cancelled.' }))
    }
    this.pending.clear()
    if (drain) {
      this.shutdownId = ++this.seq
      this.shutdownTimer = setTimeout(() => {
        console.warn('Worker file cleanup unconfirmed after shutdown timeout')
        this.finishShutdown()
      }, 60000)
      try {
        this.worker.postMessage({ id: this.shutdownId, method: 'close', args: [] })
      } catch {
        this.finishShutdown()
      }
    } else {
      this.finishShutdown()
    }
    return this.shutdownPromise
  }
}

export function createRoadNetWorker(): Worker {
  return new Worker(new URL('./worker-host.js', import.meta.url), { type: 'module' })
}

export type VariantPreference = 'auto' | CoreVariant

const PEAK_FACTOR = { plain: 8, project: 4 } as const

export const MEMORY64_THRESHOLD_BYTES = 3.2 * 2 ** 30

export function predictPeakBytes(payload: OpenPayload): number {
  const factor =
    payload.kind === 'plain' || payload.kind === 'plain-bytes' ? PEAK_FACTOR.plain : PEAK_FACTOR.project
  return payloadBytes(payload) * factor
}

export function chooseVariant(
  _payload: OpenPayload,
  preference: VariantPreference = 'auto',
  _supportsMemory64: () => boolean = detectMemory64,
): CoreVariant {
  if (preference !== 'auto') return preference
  return 'wasm32'
}

export interface OpenCoreOptions {
  signal?: AbortSignal
  recoveryKey?: string
  draftKey?: string
  onMigrating?: () => void
  onRecovered?: (info: CoreMemoryInfo) => void
  variant?: VariantPreference
  supportsMemory64?: () => boolean
  workerFactory?: () => Worker
  inProcess?: boolean
  core?: AsyncRoadNetCore
}

export async function openRoadNetCore(
  payload: OpenPayload,
  options: OpenCoreOptions = {},
): Promise<AsyncRoadNetCore> {
  if (options.core) return options.core

  const supports = options.supportsMemory64 ?? detectMemory64
  const preference = options.variant ?? 'auto'
  let variant = chooseVariant(payload, preference, supports)
  payload = {
    ...payload,
    ...(options.recoveryKey ? { recoveryKey: options.recoveryKey, draftKey: options.draftKey } : {}),
  }
  const withVariant = (which: CoreVariant): OpenPayload => ({
    ...payload,
    options: { ...payload.options, variant: which },
  })

  const inProcess = options.inProcess || (!options.workerFactory && typeof Worker === 'undefined')
  if (inProcess) {
    await handleRequest('open', [withVariant(variant)])
    return makeCore(
      (method, args) => handleRequest(method, args),
      async () => {
        await handleRequest('close', [])
      },
    )
  }

  let disposed = false
  const liveClients = new Set<WorkerCoreClient>()
  let stopping: Promise<void> | null = null
  const stop = () => {
    if (stopping) return stopping
    disposed = true
    stopping = Promise.all([...liveClients].map((running) => running.terminate(true))).then(() => undefined)
    liveClients.clear()
    return stopping
  }
  options.signal?.addEventListener('abort', stop, { once: true })
  if (options.signal?.aborted) stop()

  const start = async (which: CoreVariant, transfer: boolean): Promise<WorkerCoreClient> => {
    if (disposed) throw new RoadNetError({ code: 'CORE_CLOSED', message: 'Project session closed.' })
    const client = new WorkerCoreClient((options.workerFactory ?? createRoadNetWorker)())
    liveClients.add(client)
    const request = withVariant(which)
    try {
      await client.send('open', [request], transfer ? transferablesOfPayload(request) : [])
      return client
    } catch (error) {
      await client.terminate()
      liveClients.delete(client)
      throw RoadNetError.from(error)
    }
  }

  const canRetry = preference === 'auto' && variant === 'wasm32' && supports()
  let client: WorkerCoreClient
  try {
    client = await start(variant, !canRetry)
  } catch (error) {
    if (!canRetry || (error as RoadNetError).code !== 'CORE_OOM') throw error
    variant = 'memory64'
    client = await start('memory64', true)
  }

  let hasRecovery = false
  let confirmedWrites = false
  if (options.recoveryKey || payload.kind === 'recovery') {
    try {
      const meta = (await client.invoke('recoveryInfo', [])) as OpfsRecoveryMeta | null
      if (meta) {
        hasRecovery = true
        payload = { kind: 'recovery', key: meta.key, options: payload.options }
      }
    } catch (error) {
      stop()
      throw error
    }
  }

  let queue: Promise<unknown> = Promise.resolve()
  const writes = new Set(['execute', 'executeWithMeta', 'applyDelta', 'undo', 'redo'])
  const invoke: Invoke = (method, args) => {
    const work = queue
      .catch(() => undefined)
      .then(async () => {
        if (disposed) throw new RoadNetError({ code: 'CORE_CLOSED', message: 'Project session closed.' })
        const mutation = writes.has(method) && (hasRecovery || Boolean(options.recoveryKey))
        const operationId = mutation ? crypto.randomUUID() : null
        const call = () =>
          mutation ? client.invoke('mutate', [operationId, method, args]) : client.invoke(method, args)
        try {
          const result = await call()
          if (writes.has(method)) confirmedWrites = true
          return result
        } catch (error) {
          const normalized = RoadNetError.from(error)
          if (
            disposed ||
            preference !== 'auto' ||
            variant !== 'wasm32' ||
            !supports() ||
            normalized.code !== 'CORE_OOM'
          ) {
            throw normalized
          }
          if (!hasRecovery && (writes.has(method) || confirmedWrites)) {
            throw new RoadNetError({
              code: 'CORE_OOM',
              message: 'Core out of memory and local recovery unavailable; reopen project.',
            })
          }
          options.onMigrating?.()
          await client.terminate()
          liveClients.delete(client)
          variant = 'memory64'
          try {
            client = await start(variant, false)
          } catch (recoveryError) {
            stop()
            const failed = RoadNetError.from(recoveryError)
            if (failed.code === 'CORE_CLOSED') throw failed
            throw new RoadNetError({
              code: 'RECOVERY_FAILED',
              message: `Memory64 migration failed: ${failed.message}; recovery log preserved.`,
            })
          }
          if (disposed) {
            void client.terminate()
            throw new RoadNetError({ code: 'CORE_CLOSED', message: 'Project closed during recovery.' })
          }
          options.onRecovered?.((await client.invoke('memoryInfo', [])) as CoreMemoryInfo)
          if (mutation) {
            const acknowledged = (await client.invoke('operationResult', [operationId])) as {
              committed: boolean
              result?: unknown
            }
            if (acknowledged.committed) return acknowledged.result
            throw new RoadNetError({
              code: 'CORE_RECOVERED',
              message: 'Migrated to Memory64 and recovered committed edits; retry the last operation.',
            })
          }
          return client.invoke(method, args)
        }
      })
    queue = work
    return work
  }

  return makeCore(
    invoke,
    async () => {
      await stop()
      options.signal?.removeEventListener('abort', stop)
    },
    async () => {
      if (stopping) await stopping
    },
  )
}
