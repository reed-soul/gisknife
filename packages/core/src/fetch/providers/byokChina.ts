import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, Position } from 'geojson'
import { reprojectGeoJson } from '../../crs/transform.js'
import type { ProviderConfig } from '../../types.js'
import { COMPLIANCE_NOTES, fetchJsonWithTimeout, type FetchedBoundary } from './types.js'

interface AmapDistrictResponse {
  status: string
  info?: string
  districts?: Array<{
    adcode?: string
    name?: string
    level?: string
    polyline?: string
    districts?: Array<{ adcode?: string; name?: string; level?: string; polyline?: string }>
  }>
}

function parseAmapPolyline(polyline: string): Geometry | null {
  const polygons = polyline
    .split('|')
    .map((ringStr) => {
      const coords: Position[] = ringStr
        .split(';')
        .map((pair) => pair.split(',').map(Number))
        .filter((xy) => xy.length === 2 && Number.isFinite(xy[0]) && Number.isFinite(xy[1]))
        .map(([lon, lat]) => [lon, lat])
      if (coords.length >= 3) {
        const first = coords[0]
        const last = coords[coords.length - 1]
        if (first[0] !== last[0] || first[1] !== last[1]) {
          coords.push([first[0], first[1]])
        }
      }
      return coords
    })
    .filter((ring) => ring.length >= 4)

  if (polygons.length === 0) return null
  if (polygons.length === 1) {
    return { type: 'Polygon', coordinates: [polygons[0]] }
  }
  return { type: 'MultiPolygon', coordinates: polygons.map((ring) => [ring]) }
}

/**
 * Optional BYOK Amap District API adapter (only runs when AMAP_KEY / config.amapKey is set).
 */
export async function fetchAmapBoundary(
  params: { keywords: string; subdistrict?: number; toWgs84?: boolean },
  config: ProviderConfig = {},
): Promise<FetchedBoundary | null> {
  const key = config.amapKey || process.env.AMAP_KEY
  if (!key) return null

  const query = new URLSearchParams({
    key,
    keywords: params.keywords,
    subdistrict: String(params.subdistrict ?? 1),
    extensions: 'all',
  })
  const url = `https://restapi.amap.com/v3/config/district?${query.toString()}`
  const data = (await fetchJsonWithTimeout(url, { fetchImpl: config.fetchImpl })) as AmapDistrictResponse

  if (data.status !== '1' || !data.districts?.length) {
    return null
  }

  const features: Array<Feature<Geometry, GeoJsonProperties>> = []
  const targetList =
    params.subdistrict
      ? data.districts[0].districts ?? []
      : data.districts

  for (const item of targetList) {
    if (!item.polyline) continue
    const geom = parseAmapPolyline(item.polyline)
    if (!geom) continue
    features.push({
      type: 'Feature',
      properties: {
        name: item.name,
        adcode: item.adcode,
        level: item.level,
      },
      geometry: geom,
    })
  }

  if (features.length === 0) return null
  let fc: FeatureCollection<Geometry, GeoJsonProperties> = {
    type: 'FeatureCollection',
    features,
  }
  let crs = 'GCJ02'
  if (params.toWgs84) {
    fc = reprojectGeoJson(fc, 'GCJ02', 'EPSG:4326').geojson
    crs = 'EPSG:4326'
  }

  return {
    geojson: fc,
    crs,
    source: 'amap-byok',
    complianceNote: COMPLIANCE_NOTES.byokChina,
    warnings: [],
  }
}

/**
 * Optional BYOK Tianditu administrative boundary lookup (only runs when TIANDITU_TOKEN is set).
 */
export async function fetchTiandituBoundary(
  params: { keyword: string },
  config: ProviderConfig = {},
): Promise<FetchedBoundary | null> {
  const tk = config.tiandituToken || process.env.TIANDITU_TOKEN
  if (!tk) return null

  const postStr = JSON.stringify({
    searchWord: params.keyword,
    searchType: '1',
    needSubInfo: 'true',
    needAll: 'true',
    needPolygon: 'true',
    needPre: 'true',
  })
  const url = `https://api.tianditu.gov.cn/administrative?postStr=${encodeURIComponent(postStr)}&tk=${encodeURIComponent(tk)}`
  const payload = (await fetchJsonWithTimeout(url, { fetchImpl: config.fetchImpl })) as {
    returncode?: string
    data?: Array<{
      name?: string
      gbCode?: string
      points?: Array<{ region?: string }>
    }>
  }

  if (payload.returncode !== '100' || !payload.data?.length) {
    return null
  }

  const features: Array<Feature<Geometry, GeoJsonProperties>> = []
  for (const item of payload.data) {
    for (const poly of item.points ?? []) {
      if (!poly.region) continue
      const ring: Position[] = poly.region
        .split(',')
        .map((pair) => pair.trim().split(/\s+/).map(Number))
        .filter((xy) => xy.length === 2 && Number.isFinite(xy[0]) && Number.isFinite(xy[1]))
        .map(([lon, lat]) => [lon, lat])
      if (ring.length >= 4) {
        features.push({
          type: 'Feature',
          properties: { name: item.name, gbCode: item.gbCode },
          geometry: { type: 'Polygon', coordinates: [ring] },
        })
      }
    }
  }

  if (features.length === 0) return null
  return {
    geojson: { type: 'FeatureCollection', features },
    crs: 'EPSG:4490',
    source: 'tianditu-byok',
    complianceNote: COMPLIANCE_NOTES.byokChina,
    warnings: [],
  }
}
