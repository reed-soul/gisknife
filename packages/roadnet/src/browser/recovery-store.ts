/**
 * 浏览器端 OPFS + IndexedDB 增量崩溃恢复日志存储。
 */

import { hashText, StreamHash } from '../core/stream-hash.js'
import { RoadNetError, type RoadNetCoreHandle } from '../core/types.js'

export interface OpfsRecoveryMeta {
  status?: 'copying' | 'ready'
  forkOf?: string
  key: string
  draftKey: string
  projectId: string
  sourceDigest: string
  baseline: string
  baselineHash: string
  baselineBytes: number
  baseRevision: number
  revision: number
  sequence: number
  hash: string
  savedAtMs: number
}

export type { OpfsRecoveryMeta as BrowserRecoveryMeta }

export interface RecoveryAction {
  key: string
  operationId: string
  sequence: number
  before: number
  after: number
  method: string
  entry: unknown
  result: unknown
  previousHash: string
  hash: string
}

export interface RecoveryStorage {
  meta(key: string): Promise<OpfsRecoveryMeta | null>
  list(): Promise<OpfsRecoveryMeta[]>
  publish(meta: OpfsRecoveryMeta): Promise<void>
  finishFork(meta: OpfsRecoveryMeta): Promise<void>
  actions(key: string): AsyncIterable<RecoveryAction>
  operation(key: string, operationId: string): Promise<RecoveryAction | null>
  intent(key: string, operationId: string, method: string): Promise<void>
  discard(key: string): Promise<void>
  commit(meta: OpfsRecoveryMeta, action: RecoveryAction): Promise<void>
}

const DB = 'roadnet-recovery-v2'

export function indexedRecoveryStorage(factory: IDBFactory = indexedDB): RecoveryStorage {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB, 2)
      req.onupgradeneeded = () => {
        for (const name of ['meta', 'actions', 'intents']) {
          if (!req.result.objectStoreNames.contains(name)) {
            req.result.createObjectStore(name, { keyPath: 'key' })
          }
        }
        const actions = req.transaction!.objectStore('actions')
        if (!actions.indexNames.contains('operationId')) {
          actions.createIndex('operationId', 'operationId', { unique: true })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

  async function transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction) => IDBRequest<T>,
  ): Promise<T> {
    const db = await open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(stores, mode)
        let value: T
        tx.oncomplete = () => resolve(value)
        tx.onabort = () => reject(tx.error ?? new Error('Recovery transaction aborted.'))
        tx.onerror = () => {}
        try {
          const req = run(tx)
          req.onsuccess = () => {
            value = req.result
          }
        } catch (error) {
          tx.abort()
          reject(error)
        }
      })
    } finally {
      db.close()
    }
  }

  return {
    meta: async (key) => (await transaction(['meta'], 'readonly', (tx) => tx.objectStore('meta').get(key))) ?? null,
    list: () => transaction(['meta'], 'readonly', (tx) => tx.objectStore('meta').getAll()),
    publish: async (meta) => {
      await transaction(['meta'], 'readwrite', (tx) => tx.objectStore('meta').add(meta))
    },
    finishFork: async (meta) => {
      await transaction(['meta'], 'readwrite', (tx) => tx.objectStore('meta').put({ ...meta, status: 'ready' }))
    },
    async *actions(key) {
      let lower = `${key}:`
      let exclusive = false
      for (;;) {
        const page = await transaction<RecoveryAction[]>(['actions'], 'readonly', (tx) =>
          tx.objectStore('actions').getAll(IDBKeyRange.bound(lower, `${key}:\uffff`, exclusive), 100),
        )
        for (const action of page) yield action
        if (page.length < 100) return
        lower = page[page.length - 1].key
        exclusive = true
      }
    },
    operation: async (key, operationId) => {
      const action = await transaction<RecoveryAction | undefined>(['actions'], 'readonly', (tx) =>
        tx.objectStore('actions').index('operationId').get(operationId),
      )
      return action?.key.startsWith(`${key}:`) ? action : null
    },
    intent: async (key, operationId, method) => {
      await transaction(['intents'], 'readwrite', (tx) =>
        tx.objectStore('intents').put({ key: `${key}:${operationId}`, method }),
      )
    },
    discard: async (key) => {
      await transaction(['meta', 'actions', 'intents'], 'readwrite', (tx) => {
        const range = IDBKeyRange.bound(`${key}:`, `${key}:\uffff`)
        tx.objectStore('actions').delete(range)
        tx.objectStore('intents').delete(range)
        return tx.objectStore('meta').delete(key)
      })
    },
    commit: async (meta, action) => {
      const db = await open()
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['meta', 'actions', 'intents'], 'readwrite')
          let failure: Error | null = null
          tx.oncomplete = () => resolve()
          tx.onabort = () => reject(failure ?? tx.error ?? new Error('Recovery transaction aborted.'))
          tx.onerror = () => {}
          const read = tx.objectStore('meta').get(meta.key)
          read.onsuccess = () => {
            const previous = read.result as OpfsRecoveryMeta | undefined
            if (
              !previous ||
              previous.sequence !== action.sequence - 1 ||
              previous.revision !== action.before ||
              previous.hash !== action.previousHash
            ) {
              failure = new Error('Recovery log modified by concurrent write.')
              tx.abort()
              return
            }
            tx.objectStore('actions').add({
              ...action,
              key: `${meta.key}:${String(action.sequence).padStart(12, '0')}`,
            })
            tx.objectStore('intents').delete(`${meta.key}:${action.operationId}`)
            tx.objectStore('meta').put(meta)
          }
        })
      } finally {
        db.close()
      }
    },
  }
}

export interface SyncFile {
  write(bytes: Uint8Array, options: { at: number }): number
  flush(): void
  close(): void
  getSize(): number
}

export interface LocalFileHandle {
  createSyncAccessHandle(): Promise<SyncFile>
  getFile(): Promise<File>
}

export interface LocalDirectory {
  getFileHandle(name: string, options?: { create: boolean }): Promise<LocalFileHandle>
  removeEntry(name: string): Promise<void>
  entries?(): AsyncIterable<[string, LocalFileHandle]>
}

export async function recoveryDirectory(): Promise<LocalDirectory> {
  const root = await navigator.storage.getDirectory()
  return (await root.getDirectoryHandle('roadnet-recovery', { create: true })) as unknown as LocalDirectory
}

export async function hashFile(file: Blob): Promise<string> {
  const hash = new StreamHash()
  const reader = file.stream().getReader()
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    hash.update(part.value)
  }
  return hash.digest()
}

export async function writeCoreFile(
  handle: RoadNetCoreHandle,
  kind: string,
  directory: LocalDirectory,
  name: string,
  maxBytes = Infinity,
): Promise<{ file: File; hash: string }> {
  if (!handle.writeExport) {
    throw new RoadNetError({ code: 'CORE_INTEGRITY', message: 'Core WASM lacks chunked export interface.' })
  }
  let access: SyncFile | null = null
  let failure: unknown = null
  try {
    const target = await directory.getFileHandle(name, { create: true })
    if (typeof target.createSyncAccessHandle !== 'function') {
      throw new RoadNetError({
        code: 'PERSISTENCE_UNAVAILABLE',
        message: 'Worker synchronous OPFS access handle is unavailable in this browser.',
      })
    }
    access = await target.createSyncAccessHandle()
    const hash = new StreamHash()
    let offset = 0
    handle.writeExport(kind, {
      write(bytes) {
        if (offset + bytes.byteLength > maxBytes) {
          throw new RoadNetError({
            code: 'SESSION_SAVE_TOO_LARGE',
            message: 'Project exceeds session persistence cap (80 MiB); export to disk instead.',
          })
        }
        if (bytes.byteLength > 1024 * 1024) throw new Error('EXPORT_CHUNK_LIMIT')
        let used = 0
        while (used < bytes.length) {
          const written = access!.write(bytes.subarray(used), { at: offset + used })
          if (written <= 0 || written > bytes.length - used) {
            let size: number | null = null
            try {
              size = access!.getSize()
            } catch {
              /* 忽略长度查询异常 */
            }
            throw new RoadNetError({
              code: 'EXPORT_SHORT_WRITE',
              message: 'Incomplete file write; export aborted. Check available disk space and retry.',
              diagnostics: { kind, offset: offset + used, requested: bytes.length - used, written, size },
            })
          }
          used += written
        }
        offset += bytes.length
        hash.update(bytes)
      },
    })
    access.flush()
    if (access.getSize() !== offset) throw new Error('EXPORT_SIZE_MISMATCH')
    access.close()
    access = null
    const file = await target.getFile()
    const digest = hash.digest()
    if (file.size !== offset || (await hashFile(file)) !== digest) {
      throw new RoadNetError({ code: 'EXPORT_INTEGRITY', message: 'Exported file digest verification failed.' })
    }
    return { file, hash: digest }
  } catch (error) {
    failure = error
    if (error instanceof RoadNetError && error.diagnostics) {
      try {
        error.diagnostics.storage = await navigator.storage?.estimate?.()
      } catch {
        /* 忽略配额探测失败 */
      }
    }
    if ((error as DOMException)?.name === 'QuotaExceededError') {
      throw new RoadNetError({
        code: 'STORAGE_QUOTA',
        message: 'Insufficient browser storage quota; previous recovery checkpoint remains intact.',
      })
    }
    throw error
  } finally {
    if (access) {
      try {
        access.close()
      } catch (error) {
        if (!failure) failure = error
      }
    }
    if (failure) await directory.removeEntry(name).catch(() => {})
  }
}

function coreRevision(handle: RoadNetCoreHandle): number {
  return handle.revision ? JSON.parse(handle.revision()) : JSON.parse(handle.stats()).revision
}

export class RecoveryJournal {
  blocked = false
  constructor(
    public meta: OpfsRecoveryMeta,
    private storage: RecoveryStorage,
  ) {}

  async apply(
    operationId: string,
    method: string,
    run: () => Promise<unknown>,
    handle: RoadNetCoreHandle,
  ): Promise<unknown> {
    if (this.blocked) {
      throw new RoadNetError({
        code: 'PERSISTENCE_FAILED',
        message: `Draft persistence failed; editing paused at saved revision ${this.meta.revision}.`,
      })
    }
    const before = coreRevision(handle)
    if (before !== this.meta.revision) {
      throw new RoadNetError({ code: 'RECOVERY_INVALID', message: 'Core and recovery journal revisions diverged.' })
    }
    try {
      await this.storage.intent(this.meta.key, operationId, method)
    } catch (error) {
      this.blocked = true
      throw persistenceError(error)
    }
    const result = await run()
    try {
      const after = coreRevision(handle)
      const entry =
        method === 'undo' || method === 'redo' || after === before ? null : JSON.parse(handle.latestChangeSet!())
      const body = {
        key: this.meta.key,
        operationId,
        sequence: this.meta.sequence + 1,
        before,
        after,
        method,
        entry,
        result,
        previousHash: this.meta.hash,
      }
      const action: RecoveryAction = { ...body, hash: hashText(JSON.stringify(body)) }
      const meta: OpfsRecoveryMeta = {
        ...this.meta,
        revision: after,
        sequence: action.sequence,
        hash: action.hash,
        savedAtMs: Date.now(),
      }
      await this.storage.commit(meta, action)
      this.meta = meta
      return result
    } catch (error) {
      this.blocked = true
      if (error instanceof WebAssembly.RuntimeError) throw error
      throw persistenceError(error, this.meta.revision)
    }
  }
}

export function persistenceError(error: unknown, revision?: number): RoadNetError {
  const detail = (error as Error)?.message ?? String(error)
  const suffix = revision === undefined ? '' : ` (last saved revision ${revision})`
  return new RoadNetError({
    code: 'PERSISTENCE_FAILED',
    message: `Local draft persistence failed: ${detail}; editing paused${suffix}, project can still be exported.`,
  })
}

export async function replayRecovery(
  meta: OpfsRecoveryMeta,
  actions: AsyncIterable<RecoveryAction> | Iterable<RecoveryAction>,
  handle: RoadNetCoreHandle,
): Promise<void> {
  let revision = meta.baseRevision
  let hash = meta.baselineHash
  let sequence = 0
  if (coreRevision(handle) !== revision) throw new Error('RECOVERY_BASE_REVISION')
  for await (const action of actions) {
    if (action.sequence > meta.sequence) break
    const { hash: expected, ...body } = action
    body.key = meta.key
    if (
      action.sequence !== ++sequence ||
      action.before !== revision ||
      action.previousHash !== hash ||
      hashText(JSON.stringify(body)) !== expected
    ) {
      throw new Error('RECOVERY_LOG_INTEGRITY')
    }
    if (action.after !== action.before) {
      if (action.method === 'undo') handle.undo()
      else if (action.method === 'redo') handle.redo()
      else handle.restoreEntry!(JSON.stringify(action.entry))
    }
    revision = coreRevision(handle)
    if (revision !== action.after) throw new Error('RECOVERY_RESULT_REVISION')
    hash = expected
  }
  if (sequence !== meta.sequence || hash !== meta.hash || revision !== meta.revision) {
    throw new Error('RECOVERY_INCOMPLETE')
  }
}

export type RecoveryLeaseRelease = () => Promise<void>

export async function acquireRecoveryLease(key: string): Promise<RecoveryLeaseRelease> {
  if (!navigator.locks) {
    throw new RoadNetError({
      code: 'PERSISTENCE_UNAVAILABLE',
      message: 'Web Locks API is unavailable for exclusive draft locking.',
    })
  }
  let resolve!: (value: RecoveryLeaseRelease) => void
  let reject!: (reason: unknown) => void
  const ready = new Promise<RecoveryLeaseRelease>((yes, no) => {
    resolve = yes
    reject = no
  })
  const held = navigator.locks.request(`roadnet-recovery:${key}`, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      reject(
        new RoadNetError({
          code: 'RECOVERY_BUSY',
          message: 'This recovery session is locked by another browser tab.',
        }),
      )
      return
    }
    await new Promise<void>((resume) =>
      resolve(async () => {
        resume()
        await held
      }),
    )
  })
  void held.catch(reject)
  return ready
}

export async function collectAbandonedRecovery(
  storage = indexedRecoveryStorage(),
  directory?: LocalDirectory,
): Promise<{ pendingFiles: string[] }> {
  const local = directory ?? (await recoveryDirectory())
  const pendingFiles: string[] = []
  const remove = async (name: string) => {
    try {
      await local.removeEntry(name)
    } catch (error) {
      if ((error as DOMException).name === 'NoModificationAllowedError') pendingFiles.push(name)
      else if ((error as DOMException).name !== 'NotFoundError') throw error
    }
  }
  const withOwner = async (key: string, run: () => Promise<void>) => {
    let release: RecoveryLeaseRelease
    try {
      release = await acquireRecoveryLease(key)
    } catch (error) {
      if ((error as RoadNetError).code === 'RECOVERY_BUSY') return
      throw error
    }
    try {
      await run()
    } finally {
      await release()
    }
  }
  for (const meta of await storage.list()) {
    if (meta.status === 'copying') {
      await withOwner(meta.key, async () => {
        if ((await storage.meta(meta.key))?.status === 'copying') await storage.discard(meta.key)
      })
    }
  }
  if (!local.entries) return { pendingFiles }
  for await (const [name] of local.entries()) {
    const exportToken = name.match(/^export-([0-9a-f-]{36})-(project|geojson|nod|edg|con|tll|det)$/i)?.[1]
    if (exportToken) {
      await withOwner(`export:${exportToken}`, () => remove(name))
      continue
    }
    const owner = name.match(/^(.*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-baseline\.json$/i)?.[1]
    if (owner) {
      await withOwner(owner, async () => {
        if (!(await storage.list()).some((meta) => meta.baseline === name)) await remove(name)
      })
    }
  }
  return { pendingFiles }
}

export async function forkRecovery(
  meta: OpfsRecoveryMeta,
  key: string,
  storage: RecoveryStorage,
): Promise<OpfsRecoveryMeta> {
  let next: OpfsRecoveryMeta = {
    ...meta,
    key,
    status: 'copying',
    forkOf: meta.key,
    revision: meta.baseRevision,
    sequence: 0,
    hash: meta.baselineHash,
    savedAtMs: Date.now(),
  }
  await storage.publish(next)
  try {
    for await (const source of storage.actions(meta.key)) {
      if (source.sequence > meta.sequence) break
      const { hash: _, ...body } = source
      body.key = key
      body.operationId = crypto.randomUUID()
      body.previousHash = next.hash
      const action = { ...body, hash: hashText(JSON.stringify(body)) }
      next = {
        ...next,
        revision: action.after,
        sequence: action.sequence,
        hash: action.hash,
        savedAtMs: Date.now(),
      }
      await storage.commit(next, action)
    }
    next = { ...next, status: 'ready' }
    await storage.finishFork(next)
    return next
  } catch (error) {
    await storage.discard(key).catch(() => {})
    throw error
  }
}

export function exportFileNames(kind: string, token: string): string[] {
  return (kind === 'plain' ? ['nod', 'edg', 'con', 'tll', 'det'] : [kind]).map(
    (part) => `export-${token}-${part}`,
  )
}

export async function releaseExportFiles(names: string[]): Promise<void> {
  if (!names.length || !navigator.storage?.getDirectory) return
  const directory = await recoveryDirectory()
  await Promise.all(
    names.map(async (name) => {
      for (let attempt = 0; ; attempt++) {
        try {
          await directory.removeEntry(name)
          return
        } catch (error) {
          if ((error as DOMException).name === 'NotFoundError') return
          if (attempt === 39) throw error
          await new Promise((done) => setTimeout(done, 25))
        }
      }
    }),
  )
}
