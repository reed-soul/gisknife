import type { BBox, ProviderConfig } from '../../types.js'
import { overpassToGeoJson, type OverpassResponse } from '../osmStitcher.js'
import { COMPLIANCE_NOTES, type FetchedBoundary, type OsmLayerType } from './types.js'

export const DEFAULT_OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]

function toOverpassBBox(bbox: BBox): string {
  // Overpass expects (south,west,north,east)
  const [minLon, minLat, maxLon, maxLat] = bbox
  return `${minLat},${minLon},${maxLat},${maxLon}`
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function queryOverpassWithMirrors(
  ql: string,
  config: ProviderConfig = {},
  timeoutMs = 30_000,
): Promise<OverpassResponse> {
  const fetchFn = config.fetchImpl ?? fetch
  const mirrors = config.overpassMirrors?.length ? config.overpassMirrors : DEFAULT_OVERPASS_MIRRORS
  const errors: string[] = []

  for (let i = 0; i < mirrors.length; i += 1) {
    const mirror = mirrors[i]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchFn(mirror, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'gisknife/0.1.0 (+https://github.com/reed-soul/gisknife)',
        },
        body: `data=${encodeURIComponent(ql)}`,
      })
      if (!res.ok) {
        errors.push(`${mirror}: HTTP ${res.status} ${res.statusText}`)
      } else {
        const json = (await res.json()) as OverpassResponse & { remark?: string }
        if (json?.remark) throw new Error(`Incomplete Overpass response: ${json.remark}`)
        if (json && Array.isArray(json.elements)) {
          return json
        }
        errors.push(`${mirror}: invalid Overpass response shape`)
      }
    } catch (err) {
      errors.push(`${mirror}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
    }

    if (i < mirrors.length - 1) {
      await sleep(300 * (i + 1))
    }
  }

  throw new Error(`All Overpass mirrors failed: ${errors.join('; ')}`)
}

export async function fetchOverpassSubdivisions(
  params: {
    bbox?: BBox
    areaName?: string
    parentAdcode?: string
    adminLevels?: string[]
    timeoutSec?: number
  },
  config: ProviderConfig = {},
): Promise<FetchedBoundary | null> {
  const levels = params.adminLevels?.length ? params.adminLevels.join('|') : '8|9'
  const timeoutSec = params.timeoutSec ?? 25

  let ql: string
  if (params.parentAdcode) {
    if (!/^\d{6}$/.test(params.parentAdcode)) throw new Error('Expected a six-digit parent adcode')
    const codePattern = `^${params.parentAdcode}[0-9]{3,6}$`
    ql = `[out:json][timeout:${timeoutSec}];(relation["ref:admin:CN:nbs"~"${codePattern}"]["boundary"="administrative"]["admin_level"~"^(${levels})$"];relation["ref:admin:CN:mca"~"${codePattern}"]["boundary"="administrative"]["admin_level"~"^(${levels})$"];);out geom;`
  } else if (params.bbox) {
    const bb = toOverpassBBox(params.bbox)
    ql = `[out:json][timeout:${timeoutSec}];
relation["boundary"="administrative"]["admin_level"~"^(${levels})$"](${bb});
out geom;`
  } else if (params.areaName) {
    const safeName = params.areaName.replace(/"/g, '\\"')
    ql = `[out:json][timeout:${timeoutSec}];
area["name"="${safeName}"]["boundary"="administrative"]->.searchArea;
relation(area.searchArea)["boundary"="administrative"]["admin_level"~"^(${levels})$"];
out geom;`
  } else {
    throw new Error('fetchOverpassSubdivisions requires either bbox or areaName')
  }

  const raw = await queryOverpassWithMirrors(ql, config, (timeoutSec + 10) * 1000)
  const geojson = overpassToGeoJson(raw)
  if (geojson.features.length === 0) {
    return null
  }

  return {
    geojson,
    crs: 'EPSG:4326',
    source: 'osm-overpass',
    complianceNote: COMPLIANCE_NOTES.osm,
    warnings: [
      {
        code: 'ADM4_COMPLETENESS_CHECK',
        message: 'Subdistrict/street boundaries were extracted from OpenStreetMap Overpass.',
        suggestion:
          'Verify completeness against local planning data or attach GISKNIFE_INDEX_URL / BYOK keys if an OSM subdistrict is missing.',
      },
    ],
  }
}

export function buildOverpassLayersQuery(
  bbox: BBox,
  layers: OsmLayerType[],
  timeoutSec = 30,
): string {
  const bb = toOverpassBBox(bbox)
  const active = layers.includes('all')
    ? (['roads', 'buildings', 'pois', 'water', 'landuse'] as const)
    : layers

  const statements: string[] = []
  for (const layer of active) {
    switch (layer) {
      case 'roads':
        statements.push(`way["highway"](${bb});`)
        break
      case 'buildings':
        statements.push(`way["building"](${bb});`)
        statements.push(`relation["building"](${bb});`)
        break
      case 'pois':
        statements.push(`node["name"]["amenity"](${bb});`)
        statements.push(`node["name"]["shop"](${bb});`)
        statements.push(`node["name"]["tourism"](${bb});`)
        break
      case 'water':
        statements.push(`way["natural"="water"](${bb});`)
        statements.push(`way["waterway"](${bb});`)
        statements.push(`relation["natural"="water"](${bb});`)
        break
      case 'landuse':
        statements.push(`way["landuse"](${bb});`)
        statements.push(`way["leisure"](${bb});`)
        break
    }
  }

  if (statements.length === 0) {
    statements.push(`way["highway"](${bb});`)
  }

  return `[out:json][timeout:${timeoutSec}];
(
  ${statements.join('\n  ')}
);
out geom;`
}

export async function fetchOverpassLayers(
  params: { bbox: BBox; layers: OsmLayerType[]; timeoutSec?: number },
  config: ProviderConfig = {},
): Promise<FetchedBoundary> {
  const timeoutSec = params.timeoutSec ?? 30
  const ql = buildOverpassLayersQuery(params.bbox, params.layers, timeoutSec)
  const raw = await queryOverpassWithMirrors(ql, config, (timeoutSec + 15) * 1000)
  const geojson = overpassToGeoJson(raw)

  return {
    geojson,
    crs: 'EPSG:4326',
    source: 'osm-overpass',
    complianceNote: COMPLIANCE_NOTES.osm,
    warnings: [],
  }
}
