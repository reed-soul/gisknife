/**
 * 浏览器路网内核 Worker 宿主：负责装载 `roadnet-core` WASM、管理 OPFS 恢复日志并序列化处理命令。
 * 不包含任何 UI/Vue/Map 依赖。
 */

import { splitLaneLayers } from '../core/lane-layers.js'
import { RoadNetError, type CoreMemoryInfo, type CoreVariant, type RoadNetCoreHandle } from '../core/types.js'
import {
  coreMemoryInfo,
  coreSourceDigest,
  createCoreFromPlainXml,
  createCoreFromPlainXmlBytes,
  createCoreFromProject,
  createCoreFromProjectBytes,
  loadRoadNetWasm,
  type LoadCoreOptions,
  type RoadNetWasmModule,
} from './core-loader.js'
import {
  acquireRecoveryLease,
  collectAbandonedRecovery,
  forkRecovery,
  hashFile,
  indexedRecoveryStorage,
  persistenceError,
  recoveryDirectory,
  RecoveryJournal,
  replayRecovery,
  writeCoreFile,
  type OpfsRecoveryMeta,
  type RecoveryLeaseRelease,
} from './recovery-store.js'

export function confirmedTouchedRefs(operations: unknown[]): Set<string> {
  const refs = new Set<string>()
  const fields: Record<string, [string, string, string]> = {
    node: ['node', 'nodeId', 'node'],
    link: ['link', 'linkId', 'link'],
    junction: ['junction', 'junctionId', 'junction'],
    signal_plan: ['plan', 'signalPlanId', 'signal'],
    detector: ['detector', 'detectorId', 'detector'],
    review_item: ['item', 'targetRef', ''],
    ignored_finding: ['item', 'targetRef', ''],
  }
  for (const raw of operations) {
    const operation = raw as Record<string, unknown>
    const op = String(operation.op)
    const match = op.match(/^(add|remove|update)_(.+)$/)
    const fieldsForOp = match && fields[match[2]!]
    const snapshot =
      fieldsForOp &&
      (operation[match![1] === 'update' ? 'after' : fieldsForOp[0]] as Record<string, unknown> | undefined)
    const id = snapshot && fieldsForOp && snapshot[fieldsForOp[1]]
    if (typeof id !== 'string') {
      throw new RoadNetError({ code: 'RECOVERY_INVALID', message: 'Recovery entry is missing touched object reference.' })
    }
    refs.add(fieldsForOp![2] ? `${fieldsForOp![2]}:${id}` : id)
    if (match![2] === 'link' && typeof snapshot?.reverseLinkId === 'string') {
      refs.add(`link:${snapshot.reverseLinkId}`)
    }
  }
  return refs
}

export interface WorkerRequest {
  id: number
  method: string
  args: unknown[]
}

export interface WorkerResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; memory?: CoreMemoryInfo; diagnostics?: Record<string, unknown> }
}

function transferablesOf(result: unknown): Transferable[] {
  return result instanceof ArrayBuffer ? [result] : []
}

export type OpenPayload = (
  | { kind: 'recovery'; key: string; options?: LoadCoreOptions }
  | { kind: 'project'; projectJson: string; options?: LoadCoreOptions }
  | {
      kind: 'plain'
      projectId: string
      files: { nod: string; edg: string; con?: string; tll?: string }
      options?: LoadCoreOptions
    }
  | { kind: 'project-bytes'; bytes: ArrayBuffer; options?: LoadCoreOptions }
  | {
      kind: 'plain-bytes'
      projectId: string
      files: { nod: ArrayBuffer; edg: ArrayBuffer; con?: ArrayBuffer; tll?: ArrayBuffer }
      options?: LoadCoreOptions
    }
) & { recoveryKey?: string; draftKey?: string }

export function transferablesOfPayload(payload: OpenPayload): ArrayBuffer[] {
  if (payload.kind === 'project-bytes') return [payload.bytes]
  if (payload.kind === 'plain-bytes') {
    return [payload.files.nod, payload.files.edg, payload.files.con, payload.files.tll].filter(
      (part): part is ArrayBuffer => part instanceof ArrayBuffer,
    )
  }
  return []
}

export function payloadBytes(payload: OpenPayload): number {
  switch (payload.kind) {
    case 'recovery':
      return 0
    case 'project':
      return payload.projectJson.length
    case 'plain':
      return [payload.files.nod, payload.files.edg, payload.files.con, payload.files.tll].reduce(
        (sum, part) => sum + (part?.length ?? 0),
        0,
      )
    case 'project-bytes':
      return payload.bytes.byteLength
    case 'plain-bytes':
      return [payload.files.nod, payload.files.edg, payload.files.con, payload.files.tll].reduce(
        (sum, part) => sum + (part?.byteLength ?? 0),
        0,
      )
  }
}

let core: RoadNetCoreHandle | null = null
let journal: RecoveryJournal | null = null
let releaseLease: RecoveryLeaseRelease | null = null
const activeExports = new Map<string, string[]>()
let filesAvailable = false
let closing = false
let variant: CoreVariant = 'wasm32'
let loaded: RoadNetWasmModule | null = null
let poison: RoadNetError | null = null
const WRITES = new Set(['execute', 'executeWithMeta', 'applyDelta', 'undo', 'redo'])

function requireCore(): RoadNetCoreHandle {
  if (poison) throw poison
  if (!core) {
    throw new RoadNetError({ code: 'CORE_UNAVAILABLE', message: 'Roadnet core is not open.' })
  }
  return core
}

const VARIANT_LIMIT: Record<CoreVariant, string> = { wasm32: '4 GiB', memory64: '16 GiB' }

function isTrap(error: unknown): boolean {
  return typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError
}

function classifyTrap(error: unknown): RoadNetError {
  const failures = loaded ? coreMemoryInfo(loaded, variant).allocFailures : 0
  const detail = (error as Error)?.message ?? String(error)
  return failures > 0
    ? new RoadNetError({
        code: 'CORE_OOM',
        memory: loaded ? coreMemoryInfo(loaded, variant) : undefined,
        message: `Core out of memory (${variant} limit ${VARIANT_LIMIT[variant]}): ${detail}`,
      })
    : new RoadNetError({
        code: 'CORE_CRASHED',
        message: `Roadnet core aborted unexpectedly (${detail}); reopen project to recover.`,
      })
}

async function openCore(payload: OpenPayload): Promise<RoadNetCoreHandle> {
  const bytes = (buffer: ArrayBuffer) => new Uint8Array(buffer)
  switch (payload.kind) {
    case 'recovery': {
      const storage = indexedRecoveryStorage()
      const key = payload.recoveryKey ?? payload.key
      releaseLease = await acquireRecoveryLease(key)
      let releaseSource: RecoveryLeaseRelease | null = null
      try {
        if (key !== payload.key) releaseSource = await acquireRecoveryLease(payload.key)
        let meta = await storage.meta(payload.key)
        if (key !== payload.key) {
          const previous = await storage.meta(key)
          if (previous?.status === 'copying') await storage.discard(key)
          else if (previous) {
            if (previous.forkOf !== payload.key) {
              throw new RoadNetError({ code: 'RECOVERY_INVALID', message: 'Recovery key belongs to another project.' })
            }
            meta = previous
          }
        }
        if (!meta || meta.status === 'copying' || meta.sourceDigest !== coreSourceDigest(loaded!)) {
          throw new RoadNetError({
            code: 'RECOVERY_INCOMPATIBLE',
            message: 'Recovery checkpoint is incomplete or core source digest mismatch.',
          })
        }
        const directory = await recoveryDirectory()
        const file = await (await directory.getFileHandle(meta.baseline)).getFile()
        if (file.size !== meta.baselineBytes || (await hashFile(file)) !== meta.baselineHash) {
          throw new RoadNetError({ code: 'RECOVERY_INVALID', message: 'Recovery baseline snapshot is corrupted.' })
        }
        const handle = await createCoreFromProjectBytes(new Uint8Array(await file.arrayBuffer()), payload.options)
        await replayRecovery(meta, storage.actions(meta.key), handle)
        if (key !== meta.key) meta = await forkRecovery(meta, key, storage)
        journal = new RecoveryJournal(meta, storage)
        return handle
      } finally {
        await releaseSource?.()
      }
    }
    case 'project':
      return createCoreFromProject(payload.projectJson, payload.options)
    case 'plain':
      return createCoreFromPlainXml(payload.projectId, payload.files, payload.options)
    case 'project-bytes':
      return createCoreFromProjectBytes(bytes(payload.bytes), payload.options)
    case 'plain-bytes':
      return createCoreFromPlainXmlBytes(
        payload.projectId,
        {
          nod: bytes(payload.files.nod),
          edg: bytes(payload.files.edg),
          con: payload.files.con && bytes(payload.files.con),
          tll: payload.files.tll && bytes(payload.files.tll),
        },
        payload.options,
      )
  }
}

function memoryInfo(): CoreMemoryInfo {
  if (!loaded) throw new RoadNetError({ code: 'CORE_UNAVAILABLE', message: 'Roadnet core is not open.' })
  return coreMemoryInfo(loaded, variant)
}

export async function handleRequest(method: string, args: unknown[]): Promise<unknown> {
  if (method === 'open' || method === 'close' || method === 'memoryInfo') return dispatch(method, args)
  try {
    return await dispatch(
      WRITES.has(method) ? 'mutate' : method,
      WRITES.has(method) ? [crypto.randomUUID(), method, args] : args,
    )
  } catch (error) {
    if (!poison && isTrap(error)) poison = classifyTrap(error)
    throw poison ?? error
  }
}

export function resetWorkerState(): void {
  void releaseLease?.()
  releaseLease = null
  core = null
  journal = null
  poison = null
  loaded = null
  variant = 'wasm32'
  closing = false
}

export function beginWorkerClose(): void {
  closing = true
}

async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'open': {
      if (poison) throw poison
      const payload = args[0] as OpenPayload
      variant = payload.options?.variant ?? 'wasm32'
      await releaseLease?.()
      releaseLease = null
      filesAvailable = Boolean(navigator.storage?.getDirectory) && typeof document === 'undefined'
      try {
        if (filesAvailable && typeof indexedDB !== 'undefined' && navigator.locks) {
          try {
            await collectAbandonedRecovery()
          } catch (error) {
            if (!['NotAllowedError', 'NotSupportedError', 'SecurityError'].includes((error as DOMException).name)) {
              throw error
            }
            filesAvailable = false
          }
        }
        loaded = await loadRoadNetWasm(payload.options)
        if (closing) throw new RoadNetError({ code: 'CORE_CLOSED', message: 'Project session closed.' })
        journal = null
        core = await openCore(payload)
        if (
          payload.kind !== 'recovery' &&
          payload.recoveryKey &&
          typeof indexedDB !== 'undefined' &&
          filesAvailable &&
          navigator.locks
        ) {
          const storage = indexedRecoveryStorage()
          const directory = await recoveryDirectory()
          releaseLease = await acquireRecoveryLease(payload.recoveryKey)
          const name = `${payload.recoveryKey}-${crypto.randomUUID()}-baseline.json`
          try {
            const saved = await writeCoreFile(core, 'project', directory, name)
            if (closing) {
              await directory.removeEntry(name)
              throw new RoadNetError({ code: 'CORE_CLOSED', message: 'Project closed before baseline finalized.' })
            }
            const stats = JSON.parse(core.stats())
            const meta: OpfsRecoveryMeta = {
              status: 'ready',
              key: payload.recoveryKey,
              draftKey: payload.draftKey ?? '',
              projectId: stats.projectId,
              sourceDigest: coreSourceDigest(loaded!),
              baseline: name,
              baselineHash: saved.hash,
              baselineBytes: saved.file.size,
              baseRevision: stats.revision,
              revision: stats.revision,
              sequence: 0,
              hash: saved.hash,
              savedAtMs: Date.now(),
            }
            try {
              await storage.publish(meta)
            } catch (error) {
              await directory.removeEntry(name).catch(() => {})
              throw persistenceError(error)
            }
            if (closing) {
              await storage.discard(meta.key)
              await directory.removeEntry(name)
              throw new RoadNetError({ code: 'CORE_CLOSED', message: 'Project closed before baseline published.' })
            }
            journal = new RecoveryJournal(meta, storage)
          } catch (error) {
            if ((error as RoadNetError).code !== 'PERSISTENCE_UNAVAILABLE') throw error
            await releaseLease?.()
            releaseLease = null
            filesAvailable = false
          }
        }
        return core.stats()
      } catch (error) {
        await releaseLease?.()
        releaseLease = null
        core = null
        if (isTrap(error)) poison = classifyTrap(error)
        throw poison ?? error
      }
    }
    case 'close': {
      await releaseLease?.()
      releaseLease = null
      activeExports.clear()
      journal = null
      core = null
      return null
    }
    case 'mutate': {
      const [operationId, operation, arguments_] = args as [string, string, unknown[]]
      const handle = requireCore()
      if (journal) return journal.apply(operationId, operation, () => dispatch(operation, arguments_), handle)
      const stats = JSON.parse(handle.stats())
      if (stats.links > 25000) {
        throw new RoadNetError({
          code: 'PERSISTENCE_UNAVAILABLE',
          message: 'Large project editing is disabled without OPFS persistence support.',
        })
      }
      return dispatch(operation, arguments_)
    }
    case 'recoveryInfo':
      return journal?.meta ?? null
    case 'recoveryDrafts': {
      if (!journal) return []
      const meta = journal.meta
      return (await indexedRecoveryStorage().list()).filter(
        (item) =>
          item.status !== 'copying' &&
          item.key !== meta.key &&
          item.draftKey === meta.draftKey &&
          item.baselineHash === meta.baselineHash &&
          item.sourceDigest === meta.sourceDigest &&
          item.revision > meta.revision,
      )
    }
    case 'discardRecovery': {
      if (!journal || journal.meta.key === args[0]) {
        throw new RoadNetError({ code: 'RECOVERY_INVALID', message: 'Cannot discard the active recovery session.' })
      }
      const storage = indexedRecoveryStorage()
      const meta = await storage.meta(String(args[0]))
      if (!meta || meta.draftKey !== journal.meta.draftKey || meta.baselineHash !== journal.meta.baselineHash) {
        return null
      }
      const release = await acquireRecoveryLease(meta.key)
      try {
        await storage.discard(meta.key)
        if (!(await storage.list()).some((item) => item.baseline === meta.baseline)) {
          await (await recoveryDirectory()).removeEntry(meta.baseline).catch(() => {})
        }
      } finally {
        await release()
      }
      return null
    }
    case 'recoveryHistory': {
      const history: unknown[] = []
      let cursor = 0
      if (journal) {
        for await (const action of indexedRecoveryStorage().actions(journal.meta.key)) {
          if (action.before === action.after) continue
          if (action.method === 'undo') cursor--
          else if (action.method === 'redo') cursor++
          else {
            const entry = action.entry as {
              command: string
              baseRevision: number
              operations: unknown[]
              notes?: string[]
              meta: { author: 'user' | 'agent'; approvedBy?: string; createdAtMs?: number }
            }
            history.splice(cursor)
            const result =
              typeof action.result === 'string'
                ? JSON.parse(action.result)
                : (action.result as { touched?: unknown[] } | undefined)
            const refs = confirmedTouchedRefs(entry.operations)
            history.push({
              command: entry.command,
              baseRevision: action.after,
              touched: result?.touched?.length ?? refs.size,
              notes: entry.notes ?? [],
              author: entry.meta.author,
              approvedBy: entry.meta.approvedBy,
              createdAtMs: entry.meta.createdAtMs ?? 0,
            })
            cursor++
          }
        }
      }
      return { history, cursor }
    }
    case 'operationResult': {
      if (!journal) return { committed: false }
      const action = await indexedRecoveryStorage().operation(journal.meta.key, String(args[0]))
      return action ? { committed: true, result: action.result } : { committed: false }
    }
    case 'exportFiles': {
      const handle = requireCore()
      const stats = JSON.parse(handle.stats())
      const kind = String(args[0])
      const base = String(stats.projectId || 'roadnet').replace(/[\\/:*?"<>|\s]+/g, '-')
      if (!filesAvailable) {
        if (stats.links > 25000) {
          throw new RoadNetError({
            code: 'EXPORT_UNAVAILABLE',
            message: 'Large project export requires OPFS support in this browser.',
          })
        }
        let files: File[]
        if (kind === 'project') {
          files = [
            new File([handle.projectJson()], `${base}.roadnet.json`, { type: 'application/vnd.sutpc.roadnet+json' }),
          ]
        } else if (kind === 'geojson') {
          files = [new File([handle.exportGeoJson('all')], `${base}.geojson`, { type: 'application/geo+json' })]
        } else {
          const xml = JSON.parse(handle.exportPlainXml())
          files = (['nod', 'edg', 'con', 'tll', 'det'] as const)
            .filter((key) => key !== 'det' || Boolean(xml.det))
            .map(
              (key) =>
                new File([xml[key] ?? ''], `${base}.${key === 'det' ? 'det.add' : key}.xml`, {
                  type: 'application/xml',
                }),
            )
        }
        return { files, revision: stats.revision }
      }
      const directory = await recoveryDirectory()
      const files: File[] = []
      const names: string[] = []
      const token = typeof args[2] === 'string' ? args[2] : crypto.randomUUID()
      try {
        for (const part of kind === 'plain' ? ['nod', 'edg', 'con', 'tll', 'det'] : [kind]) {
          const name = `export-${token}-${part}`
          names.push(name)
          const saved = await writeCoreFile(
            handle,
            part,
            directory,
            name,
            typeof args[1] === 'number' ? args[1] : Infinity,
          )
          if (part === 'det' && !saved.file.size) {
            await directory.removeEntry(name)
            names.pop()
            continue
          }
          const suffix =
            part === 'project'
              ? '.roadnet.json'
              : part === 'geojson'
                ? '.geojson'
                : `.${part === 'det' ? 'det.add' : part}.xml`
          files.push(
            new File([saved.file], base + suffix, {
              type:
                part === 'project'
                  ? 'application/vnd.sutpc.roadnet+json'
                  : part === 'geojson'
                    ? 'application/geo+json'
                    : 'application/xml',
            }),
          )
        }
        activeExports.set(token, names)
        if (closing) {
          activeExports.delete(token)
          throw new RoadNetError({ code: 'CORE_CLOSED', message: 'Project closed; export cancelled.' })
        }
        return { files, token, revision: stats.revision }
      } catch (error) {
        await Promise.all(names.map((name) => directory.removeEntry(name).catch(() => {})))
        throw error
      }
    }
    case 'releaseExports': {
      const token = String(args[0])
      const names = activeExports.get(token)
      if (names) {
        const directory = await recoveryDirectory()
        await Promise.all(names.map((name) => directory.removeEntry(name).catch(() => {})))
        activeExports.delete(token)
      }
      return null
    }
    case 'memoryInfo': {
      requireCore()
      return memoryInfo()
    }
    case 'laneLayers': {
      return splitLaneLayers(requireCore().laneLayers(String(args[0] ?? '')))
    }
    case 'laneLayersInBbox': {
      const [west, south, east, north] = args as [number, number, number, number]
      return splitLaneLayers(requireCore().laneLayersInBbox(west, south, east, north))
    }
    case 'baseLayersInBbox': {
      const frame = requireCore().baseLayersInBbox(String(args[0] ?? '{}'))
      return frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength
        ? (frame.buffer as ArrayBuffer)
        : (frame.slice().buffer as ArrayBuffer)
    }
    default: {
      if (
        ['projectJson', 'exportGeoJson', 'exportPlainXml', 'changeSets'].includes(method) &&
        JSON.parse(requireCore().stats()).links > 25000
      ) {
        throw new RoadNetError({
          code: 'EXPORT_UNAVAILABLE',
          message: 'Large project requires exportFiles interface.',
        })
      }
      const handle = requireCore() as unknown as Record<string, unknown>
      const fn = handle[method]
      if (typeof fn !== 'function') {
        throw new RoadNetError({ code: 'INVALID_ARGUMENT', message: `Core method '${method}' not found.` })
      }
      return (fn as (...rest: unknown[]) => unknown).apply(handle, args)
    }
  }
}

function toErrorPayload(error: unknown): {
  code: string
  message: string
  memory?: CoreMemoryInfo
  diagnostics?: Record<string, unknown>
} {
  const normalized = RoadNetError.from(error)
  return {
    code: normalized.code,
    message: normalized.message,
    ...(normalized.memory ? { memory: normalized.memory } : {}),
    ...(normalized.diagnostics ? { diagnostics: normalized.diagnostics } : {}),
  }
}

export function isDedicatedWorkerScope(scope: unknown = globalThis): boolean {
  const ctor = (scope as { WorkerGlobalScope?: new () => unknown }).WorkerGlobalScope
  return typeof ctor === 'function' && scope instanceof ctor
}

function isWorkerRequest(data: unknown): data is WorkerRequest {
  return (
    typeof data === 'object' && data !== null && typeof (data as { method?: unknown }).method === 'string'
  )
}

export interface WorkerScopeLike {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  postMessage(message: unknown, transfer?: Transferable[]): void
}

const installedScopes = new WeakSet<object>()

export function installWorkerHost(scope: WorkerScopeLike): void {
  if (installedScopes.has(scope)) return
  installedScopes.add(scope)
  let queue: Promise<unknown> = Promise.resolve()
  scope.addEventListener('message', (event: MessageEvent) => {
    if (!isWorkerRequest(event.data)) return
    const { id, method, args } = event.data
    if (method === 'close') beginWorkerClose()
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        try {
          if (closing && method !== 'close') {
            throw new RoadNetError({ code: 'CORE_CLOSED', message: 'Project closed; request cancelled.' })
          }
          const result = await handleRequest(method, args ?? [])
          const response: WorkerResponse = { id, ok: true, result }
          scope.postMessage(response, transferablesOf(result))
        } catch (error) {
          const response: WorkerResponse = { id, ok: false, error: toErrorPayload(error) }
          scope.postMessage(response)
        }
      })
  })
}

export function installWorkerMessageHandler(): void {
  if (isDedicatedWorkerScope()) {
    installWorkerHost(self as unknown as WorkerScopeLike)
  }
}

// 若该模块被直接作为 Worker 入口运行则自动挂载，在主线程仅导出 API
installWorkerMessageHandler()
