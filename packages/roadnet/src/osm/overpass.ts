/**
 * Overpass 在线拉取：4 公共镜像轮询、300 km² 面积上限、错误分级。
 * 查询包含机动车路网与转向限制关系（`type=restriction`）及其关联节点。
 */

import { RoadNetError } from '../core/types.js'
import { assertPublicHttpsEndpoint } from './net-guard.js'
import { AREA_CAP_KM2, bboxAreaKm2, exceedsAreaCap } from './osm-import.js'
import type { BoundingBox } from './osm-import.js'
import { noWaysError, parseOsmXml } from './osm-parse.js'
import type { FetchImpl, OsmImportFiles } from './types.js'
import { inspectOsmRoads, normalizeSpace } from './xml-scan.js'

export const OVERPASS_MIRRORS: readonly string[] = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

export const OVERPASS_TIMEOUT_MS = 120_000
export const OVERPASS_QUERY_TIMEOUT_SECONDS = 60

const VEHICLE_HIGHWAY_FILTER =
  '[highway~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link' +
  '|tertiary|tertiary_link|unclassified|residential|living_street|service|road|busway)$"]'

export interface OverpassQueryOptions {
  includeRestrictions?: boolean
}

export function buildBboxRoadQuery(
  box: BoundingBox,
  timeoutSeconds: number = OVERPASS_QUERY_TIMEOUT_SECONDS,
  options: OverpassQueryOptions = {},
): string {
  validateBbox(box)
  const bb = `${formatNumber(box.south)},${formatNumber(box.west)},${formatNumber(box.north)},${formatNumber(box.east)}`
  if (options.includeRestrictions === false) {
    return `[out:xml][timeout:${timeoutSeconds}][bbox:${bb}];\nway${VEHICLE_HIGHWAY_FILTER};\n(._;>;);\nout body;`
  }
  return (
    `[out:xml][timeout:${timeoutSeconds}][bbox:${bb}];\n` +
    `(\n` +
    `  way${VEHICLE_HIGHWAY_FILTER};\n` +
    `  relation["type"="restriction"];\n` +
    `);\n` +
    `(._;>;);\n` +
    `out body;`
  )
}

export function validateBbox(box: BoundingBox): void {
  if (
    !box ||
    !Number.isFinite(box.west) ||
    !Number.isFinite(box.south) ||
    !Number.isFinite(box.east) ||
    !Number.isFinite(box.north)
  ) {
    throw new RoadNetError({ code: 'INVALID_ARGUMENT', message: 'Bounding box contains invalid coordinates.' })
  }
  if (
    Math.abs(box.west) > 180 ||
    Math.abs(box.east) > 180 ||
    Math.abs(box.south) > 90 ||
    Math.abs(box.north) > 90
  ) {
    throw new RoadNetError({ code: 'INVALID_ARGUMENT', message: 'Bounding box exceeds valid WGS84 lon/lat bounds.' })
  }
  if (box.west >= box.east || box.south >= box.north) {
    throw new RoadNetError({
      code: 'INVALID_ARGUMENT',
      message: 'Invalid bounding box: west must be < east and south must be < north.',
    })
  }
}

function assertWithinAreaCap(box: BoundingBox, maxAreaKm2: number): void {
  const areaKm2 = bboxAreaKm2(box)
  if (exceedsAreaCap(areaKm2, maxAreaKm2)) {
    throw new RoadNetError({
      code: 'AREA_TOO_LARGE',
      message: `Selected area is ~${Math.round(areaKm2)} km², exceeding limit ${maxAreaKm2} km². Draw a smaller area.`,
    })
  }
}

function formatNumber(value: number): string {
  return String(value)
}

export interface OverpassFetchOptions {
  fetchImpl?: FetchImpl
  mirrors?: string[]
  timeoutMs?: number
  maxAreaKm2?: number
  includeRestrictions?: boolean
}

let rotationCursor = 0

export function resetOverpassRotation(): void {
  rotationCursor = 0
}

export async function fetchOsmBboxXml(box: BoundingBox, options: OverpassFetchOptions = {}): Promise<string> {
  validateBbox(box)
  assertWithinAreaCap(box, options.maxAreaKm2 ?? AREA_CAP_KM2)

  const mirrors = options.mirrors ?? OVERPASS_MIRRORS
  if (mirrors.length === 0) {
    throw new RoadNetError({ code: 'INVALID_ARGUMENT', message: 'Overpass mirror list is empty.' })
  }
  const timeoutMs = options.timeoutMs ?? OVERPASS_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const query = buildBboxRoadQuery(box, OVERPASS_QUERY_TIMEOUT_SECONDS, {
    includeRestrictions: options.includeRestrictions,
  })

  const order = rotateFrom(mirrors, rotationCursor)
  rotationCursor = (rotationCursor + 1) % mirrors.length

  let lastFailure: RoadNetError | null = null
  for (const mirror of order) {
    assertPublicHttpsEndpoint(mirror)
    try {
      return await fetchFromMirror(mirror, query, timeoutMs, fetchImpl)
    } catch (error) {
      if (!(error instanceof RoadNetError)) throw error
      if (!shouldRotateToNextMirror(error)) throw error
      lastFailure = error
    }
  }
  const hosts = order.map((mirror) => hostOf(mirror)).join(', ')
  throw new RoadNetError({
    code: lastFailure?.code ?? 'OSM_UPSTREAM_ERROR',
    message: `${lastFailure?.message ?? 'Overpass request failed'} (tried mirrors: ${hosts})`,
    diagnostics: lastFailure?.diagnostics,
  })
}

export async function overpassFetchBbox(box: BoundingBox, options: OverpassFetchOptions = {}): Promise<OsmImportFiles> {
  const xml = await fetchOsmBboxXml(box, options)
  return parseOsmXml(xml)
}

function rotateFrom<T>(items: readonly T[], start: number): T[] {
  const at = ((start % items.length) + items.length) % items.length
  return [...items.slice(at), ...items.slice(0, at)]
}

function hostOf(mirror: string): string {
  try {
    return new URL(mirror).host
  } catch {
    return mirror
  }
}

function shouldRotateToNextMirror(error: RoadNetError): boolean {
  if (error.code === 'OSM_NETWORK_ERROR' || error.code === 'OSM_RATE_LIMITED') return true
  if (error.code === 'OSM_UPSTREAM_ERROR') {
    const status = error.diagnostics?.httpStatus
    return typeof status === 'number' && status >= 500
  }
  return false
}

async function fetchFromMirror(
  mirror: string,
  query: string,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetchImpl(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/xml, text/xml, */*',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal,
      })
    } catch (cause) {
      if (controller.signal.aborted || (cause as Error)?.name === 'AbortError') {
        throw new RoadNetError({
          code: 'OSM_IMPORT_TIMEOUT',
          message: `Overpass request timed out (${Math.round(timeoutMs / 1000)}s); area may be too large or upstream busy.`,
        })
      }
      throw new RoadNetError({
        code: 'OSM_NETWORK_ERROR',
        message: `Unable to reach ${hostOf(mirror)} (network unavailable or blocked by CORS).`,
      })
    }

    if (!response.ok) {
      const status = response.status
      if (status === 429) {
        throw new RoadNetError({
          code: 'OSM_RATE_LIMITED',
          message: `Overpass mirror ${hostOf(mirror)} returned 429 rate limit.`,
          diagnostics: { httpStatus: status },
        })
      }
      const preview = await response
        .text()
        .then((body) => normalizeSpace(body).slice(0, 200))
        .catch(() => '')
      throw new RoadNetError({
        code: 'OSM_UPSTREAM_ERROR',
        message: `Overpass returned HTTP ${status}${preview ? `: ${preview}` : ''}`,
        diagnostics: { httpStatus: status },
      })
    }

    const xml = await response.text()
    const { hasWay, remark } = inspectOsmRoads(xml)
    if (!hasWay) throw noWaysError(remark)
    return xml
  } finally {
    clearTimeout(timer)
  }
}
