/**
 * Nominatim 地名检索（修复原硬编码 countrycodes=cn，默认全球搜索，按需传国家代码过滤）。
 */

import { RoadNetError } from '../core/types.js'
import { assertPublicHttpsEndpoint } from './net-guard.js'
import type { FetchImpl, OsmPlace } from './types.js'

export const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org'
export const NOMINATIM_TIMEOUT_MS = 30_000
export const NOMINATIM_QUERY_MAX_CHARS = 200
const NOMINATIM_ATTEMPTS = 2

export interface NominatimSearchOptions {
  fetchImpl?: FetchImpl
  timeoutMs?: number
  base?: string
  /** 可选 ISO 3166-1 alpha-2 国家代码（逗号分隔），不传则全球搜索。 */
  countrycodes?: string
}

export async function searchPlace(q: string, options: NominatimSearchOptions = {}): Promise<OsmPlace[]> {
  try {
    return await searchPlaceDetailed(q, options)
  } catch {
    return []
  }
}

export async function searchPlaceDetailed(q: string, options: NominatimSearchOptions = {}): Promise<OsmPlace[]> {
  const trimmed = q.trim()
  if (trimmed === '') {
    throw new RoadNetError({ code: 'INVALID_ARGUMENT', message: 'Missing search query q.' })
  }
  if (trimmed.length > NOMINATIM_QUERY_MAX_CHARS) {
    throw new RoadNetError({
      code: 'INVALID_ARGUMENT',
      message: `Search query exceeds maximum ${NOMINATIM_QUERY_MAX_CHARS} characters.`,
    })
  }

  const base = (options.base ?? NOMINATIM_BASE).replace(/\/$/, '')
  assertPublicHttpsEndpoint(base)
  const searchParams = new URLSearchParams({
    q: trimmed,
    format: 'jsonv2',
    extratags: '1',
    limit: '8',
  })
  if (options.countrycodes?.trim()) {
    searchParams.set('countrycodes', options.countrycodes.trim())
  }
  const url = `${base}/search?${searchParams}`

  const timeoutMs = options.timeoutMs ?? NOMINATIM_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch

  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response: Response
      try {
        response = await fetchImpl(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        })
      } catch (cause) {
        if (controller.signal.aborted || (cause as Error)?.name === 'AbortError') {
          throw new RoadNetError({
            code: 'OSM_IMPORT_TIMEOUT',
            message: `Nominatim request timed out (${Math.round(timeoutMs / 1000)}s).`,
          })
        }
        throw new RoadNetError({
          code: 'OSM_NETWORK_ERROR',
          message: 'Unable to reach Nominatim (network unavailable or blocked by CORS).',
        })
      }

      if (response.status === 503 && attempt < NOMINATIM_ATTEMPTS) {
        continue
      }
      if (!response.ok) {
        if (response.status === 503) {
          throw new RoadNetError({
            code: 'OSM_IMPORT_TIMEOUT',
            message: `Nominatim query timed out after ${NOMINATIM_ATTEMPTS} attempts; include city/country name or try later.`,
          })
        }
        if (response.status === 429) {
          throw new RoadNetError({
            code: 'OSM_RATE_LIMITED',
            message: 'Nominatim returned 429 rate limit.',
            diagnostics: { httpStatus: 429 },
          })
        }
        throw new RoadNetError({
          code: 'OSM_UPSTREAM_ERROR',
          message: `Nominatim returned HTTP ${response.status}`,
          diagnostics: { httpStatus: response.status },
        })
      }

      const text = await response.text()
      let payload: unknown
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        throw new RoadNetError({ code: 'OSM_UPSTREAM_ERROR', message: 'Nominatim returned invalid JSON.' })
      }
      return parseOsmPlaces(payload)
    } finally {
      clearTimeout(timer)
    }
  }
}

export function parseOsmPlaces(payload: unknown): OsmPlace[] {
  if (!Array.isArray(payload)) return []
  const places: OsmPlace[] = []
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const label = typeof record.display_name === 'string' ? record.display_name.trim() : ''
    if (label === '') continue
    const lat = toFiniteNumber(record.lat)
    const lon = toFiniteNumber(record.lon)
    if (lat === null || lon === null) continue
    places.push({ label, lat, lon })
  }
  return places
}

function toFiniteNumber(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(num) ? num : null
}
