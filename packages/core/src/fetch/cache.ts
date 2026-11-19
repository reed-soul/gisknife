import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export function resolveCacheDir(override?: string): string {
  return override || process.env.GISKNIFE_CACHE_DIR || path.join(os.homedir(), '.cache', 'gisknife')
}

export function makeCacheKey(namespace: string, input: unknown): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${namespace}:${JSON.stringify(input)}`)
    .digest('hex')
  return `${namespace}-${hash.slice(0, 24)}.json`
}

export async function getOrFetchCached<T>(
  namespace: string,
  keyInput: unknown,
  fetcher: () => Promise<T>,
  options: { cacheDir?: string; noCache?: boolean; ttlMs?: number } = {},
): Promise<{ value: T; cacheHit: boolean }> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cacheDir = resolveCacheDir(options.cacheDir)
  const filePath = path.join(cacheDir, makeCacheKey(namespace, keyInput))

  if (!options.noCache && fs.existsSync(filePath)) {
    try {
      const stat = fs.statSync(filePath)
      if (Date.now() - stat.mtimeMs < ttlMs) {
        const cached = JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
        return { value: cached, cacheHit: true }
      }
    } catch {
      // Corrupt cache entry; refetch cleanly
    }
  }

  const value = await fetcher()
  if (!options.noCache) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(value), 'utf8')
    } catch {
      // Cache write failures should never break fetch execution
    }
  }

  return { value, cacheHit: false }
}
