import fs from 'node:fs'
import path from 'node:path'
import * as turf from '@turf/turf'
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import type { BBox, GeoJsonSummary } from '../types.js'

export interface FieldSchemaInfo {
  name: string
  types: string[]
  nullCount: number
  sampleValues: unknown[]
}

export interface InspectReport extends GeoJsonSummary {
  filePath?: string
  fileSizeBytes?: number
  format: string
  crsHint: string
  schema: FieldSchemaInfo[]
}

export function summarizeGeoJson(
  fc: FeatureCollection<Geometry, GeoJsonProperties>,
): GeoJsonSummary {
  const geomTypes = new Set<string>()
  const propKeys = new Set<string>()

  for (const feat of fc.features) {
    if (feat.geometry?.type) {
      geomTypes.add(feat.geometry.type)
    }
    if (feat.properties) {
      for (const k of Object.keys(feat.properties)) {
        propKeys.add(k)
      }
    }
  }

  let computedBbox: BBox | undefined
  if (fc.features.some((f) => f.geometry !== null)) {
    try {
      const bb = turf.bbox(fc)
      if (bb.length === 4 && bb.every(Number.isFinite)) {
        computedBbox = [bb[0], bb[1], bb[2], bb[3]]
      }
    } catch {
      computedBbox = undefined
    }
  }

  return {
    featureCount: fc.features.length,
    bbox: computedBbox,
    geometryTypes: Array.from(geomTypes),
    sampleProperties: Array.from(propKeys).slice(0, 20),
  }
}

export function inspectGeoJson(
  fc: FeatureCollection<Geometry, GeoJsonProperties>,
  meta: { filePath?: string; fileSizeBytes?: number; format?: string } = {},
): InspectReport {
  const summary = summarizeGeoJson(fc)
  const schemaMap = new Map<
    string,
    { types: Set<string>; nullCount: number; samples: unknown[] }
  >()

  for (const feat of fc.features) {
    const props = feat.properties ?? {}
    for (const key of Object.keys(props)) {
      if (!schemaMap.has(key)) {
        schemaMap.set(key, { types: new Set(), nullCount: 0, samples: [] })
      }
      const entry = schemaMap.get(key)!
      const val = props[key]
      if (val === null || val === undefined || val === '') {
        entry.nullCount += 1
      } else {
        entry.types.add(Array.isArray(val) ? 'array' : typeof val)
        if (entry.samples.length < 3 && !entry.samples.includes(val)) {
          entry.samples.push(val)
        }
      }
    }
  }

  // Heuristic CRS guess from bbox
  let crsHint = 'EPSG:4326 (assumed WGS84)'
  if (summary.bbox) {
    const [minX, minY, maxX, maxY] = summary.bbox
    if (Math.abs(minX) > 180 || Math.abs(maxX) > 180 || Math.abs(minY) > 90 || Math.abs(maxY) > 90) {
      crsHint = 'Projected CRS (coordinates exceed [-180..180, -90..90])'
    }
  }

  return {
    ...summary,
    filePath: meta.filePath ? path.resolve(meta.filePath) : undefined,
    fileSizeBytes: meta.fileSizeBytes,
    format: meta.format ?? 'geojson',
    crsHint,
    schema: Array.from(schemaMap.entries()).map(([name, info]) => ({
      name,
      types: Array.from(info.types),
      nullCount: info.nullCount,
      sampleValues: info.samples,
    })),
  }
}

export function normalizeToFeatureCollection(
  input: unknown,
): FeatureCollection<Geometry, GeoJsonProperties> {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid GeoJSON object')
  }
  const obj = input as { type?: string }
  if (obj.type === 'FeatureCollection') {
    return obj as FeatureCollection<Geometry, GeoJsonProperties>
  }
  if (obj.type === 'Feature') {
    return {
      type: 'FeatureCollection',
      features: [obj as Feature<Geometry, GeoJsonProperties>],
    }
  }
  if (
    obj.type === 'Point' ||
    obj.type === 'MultiPoint' ||
    obj.type === 'LineString' ||
    obj.type === 'MultiLineString' ||
    obj.type === 'Polygon' ||
    obj.type === 'MultiPolygon' ||
    obj.type === 'GeometryCollection'
  ) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: obj as Geometry }],
    }
  }
  throw new Error(`Unsupported GeoJSON root type: ${String(obj.type)}`)
}

export function readGeoJsonFile(filePath: string): FeatureCollection<Geometry, GeoJsonProperties> {
  const raw = fs.readFileSync(filePath, 'utf8')
  return normalizeToFeatureCollection(JSON.parse(raw))
}

export function writeGeoJsonFile(
  filePath: string,
  fc: FeatureCollection<Geometry, GeoJsonProperties>,
  pretty = false,
): string {
  const resolved = path.resolve(filePath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, JSON.stringify(fc, null, pretty ? 2 : undefined), 'utf8')
  return resolved
}
