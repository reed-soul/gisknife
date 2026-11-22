/**
 * 浏览器端本地草稿存储（节流落盘 + 版本/修订号恢复校验）。
 */

export interface DraftRecord {
  key: string
  projectId: string
  revision: number
  projectJson: string
  savedAtMs: number
  coreVersion: string
}

export type DraftMeta = Omit<DraftRecord, 'projectJson' | 'savedAtMs'>

export interface DraftStorage {
  get(key: string): Promise<DraftRecord | null>
  put(record: DraftRecord): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<DraftRecord[]>
}

const DB_NAME = 'roadnet-drafts'
const STORE = 'drafts'
const DB_VERSION = 1

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB operation failed.'))
  })
}

export function createIndexedDbStorage(
  factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB,
): DraftStorage | null {
  if (!factory) return null

  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'key' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('Unable to open IndexedDB drafts database.'))
    })

  const withStore = async <T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open()
    try {
      return await request(fn(db.transaction(STORE, mode).objectStore(STORE)))
    } finally {
      db.close()
    }
  }

  return {
    async get(key) {
      return (await withStore<DraftRecord | undefined>('readonly', (s) => s.get(key))) ?? null
    },
    async put(record) {
      await withStore('readwrite', (s) => s.put(record))
    },
    async delete(key) {
      await withStore('readwrite', (s) => s.delete(key))
    },
    async list() {
      return (await withStore<DraftRecord[]>('readonly', (s) => s.getAll())) ?? []
    },
  }
}

export function createMemoryStorage(): DraftStorage {
  const map = new Map<string, DraftRecord>()
  return {
    async get(key) {
      return map.get(key) ?? null
    },
    async put(record) {
      map.set(record.key, record)
    },
    async delete(key) {
      map.delete(key)
    },
    async list() {
      return [...map.values()]
    },
  }
}

export interface DraftKeeperOptions {
  storage: DraftStorage | null
  /** 两次落盘之间最小间隔（毫秒），默认 5 秒 */
  throttleMs?: number
  now?: () => number
}

export class DraftKeeper {
  private readonly storage: DraftStorage | null
  private readonly throttleMs: number
  private readonly now: () => number
  private lastSavedAt = Number.NEGATIVE_INFINITY
  private pending: { meta: DraftMeta; load: () => Promise<string> } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: DraftKeeperOptions) {
    this.storage = options.storage
    this.throttleMs = options.throttleMs ?? 5_000
    this.now = options.now ?? (() => Date.now())
  }

  get enabled(): boolean {
    return this.storage !== null
  }

  record(meta: DraftMeta, load: () => Promise<string>): Promise<void> {
    if (!this.storage) return Promise.resolve()
    const at = this.now()
    if (at - this.lastSavedAt >= this.throttleMs) {
      this.pending = null
      return this.write(meta, load, at)
    }
    this.pending = { meta, load }
    if (!this.timer) {
      this.timer = setTimeout(
        () => {
          this.timer = null
          void this.flush()
        },
        this.throttleMs - (at - this.lastSavedAt),
      )
    }
    return Promise.resolve()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const queued = this.pending
    this.pending = null
    if (queued) await this.write(queued.meta, queued.load, this.now())
  }

  private async write(meta: DraftMeta, load: () => Promise<string>, at: number): Promise<void> {
    this.lastSavedAt = at
    try {
      await this.storage?.put({ ...meta, projectJson: await load(), savedAtMs: at })
    } catch {
      // 存储配额满或隐私模式写入失败时不阻断前台编辑
    }
  }

  async recoverable(
    key: string,
    current: { revision: number; coreVersion: string },
  ): Promise<DraftRecord | null> {
    if (!this.storage) return null
    let draft: DraftRecord | null = null
    try {
      draft = await this.storage.get(key)
    } catch {
      return null
    }
    if (!draft) return null
    if (draft.coreVersion !== current.coreVersion) return null
    if (draft.revision <= current.revision) return null
    return draft
  }

  async discard(key: string): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
    try {
      await this.storage?.delete(key)
    } catch {
      // 忽略删除失败
    }
  }
}
