import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import type { BBox, GisknifeWarning, ProviderConfig } from '../../types.js'

export interface FetchedBoundary {
  geojson: FeatureCollection<Geometry, GeoJsonProperties>
  crs: string
  source: string
  complianceNote: string
  warnings: GisknifeWarning[]
}

export interface BoundaryFetchParams {
  query: string
  level?: 'country' | 'state' | 'province' | 'city' | 'district' | 'street' | 'county'
  subdivisions?: boolean
  toWgs84?: boolean
  adcode?: string
  stateFips?: string
  bbox?: BBox
  iso3?: string
}

export type OsmLayerType = 'roads' | 'buildings' | 'pois' | 'water' | 'landuse' | 'all'

export interface OsmFetchParams {
  bbox: BBox
  layers: OsmLayerType[]
  timeoutSec?: number
}

export const COMPLIANCE_NOTES = {
  osm: 'Data © OpenStreetMap contributors (ODbL). For official China public mapping/publication, use MNR Standard Maps.',
  datav:
    'Source: Aliyun DataV GeoAtlas (GCJ-02 natively; verify CRS). Suitable for engineering/analysis; official publication in China requires MNR Standard Maps.',
  tiger: 'Source: U.S. Census Bureau TIGERweb (Public Domain, WGS84 EPSG:4326).',
  geoboundaries: 'Source: geoBoundaries (CC-BY 4.0, WGS84 EPSG:4326).',
  byokChina:
    'Fetched via user-configured BYOK key. Respect provider terms of service and China surveying publication rules.',
  staticIndex:
    'Fetched from configured remote static index (GISKNIFE_INDEX_URL). Verify source license and mapping compliance.',
} as const

export async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  const fetchFn = init.fetchImpl ?? fetch
  const timeoutMs = init.timeoutMs ?? 20_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchFn(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': 'gisknife/0.2.0 (+https://github.com/reed-soul/gisknife)',
        ...(init.headers ?? {}),
      },
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${new URL(url).origin}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export type BoundaryProviderFn = (
  params: BoundaryFetchParams,
  config: ProviderConfig,
) => Promise<FetchedBoundary | null>
