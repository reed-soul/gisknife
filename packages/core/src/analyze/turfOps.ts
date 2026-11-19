import * as turf from '@turf/turf'
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, MultiPolygon, Polygon } from 'geojson'
import type { BBox, GisknifeWarning } from '../types.js'

export type TurfOpName =
  | 'buffer'
  | 'simplify'
  | 'centroid'
  | 'bbox'
  | 'dissolve'
  | 'union'
  | 'intersect'
  | 'difference'
  | 'measure'
  | 'grid-square'
  | 'grid-hex'

export interface AnalyzeMeasureResult {
  featureCount: number
  totalAreaSqMeters: number
  totalAreaSqKm: number
  totalLengthMeters: number
  totalLengthKm: number
  perFeature: Array<{
    index: number
    name?: string
    geometryType: string
    areaSqMeters: number
    lengthMeters: number
  }>
}

export interface AnalyzeOpOptions {
  distanceMeters?: number
  tolerance?: number
  cellSizeMeters?: number
  dissolveProperty?: string
  secondGeoJson?: FeatureCollection<Geometry, GeoJsonProperties>
}

function assertGeographicWgs84(
  fc: FeatureCollection<Geometry, GeoJsonProperties>,
  opName: string,
): void {
  if (fc.features.length === 0) return
  try {
    const bb = turf.bbox(fc)
    if (
      Math.abs(bb[0]) > 180 ||
      Math.abs(bb[2]) > 180 ||
      Math.abs(bb[1]) > 90 ||
      Math.abs(bb[3]) > 90
    ) {
      throw new Error(
        `CRS guardrail: '${opName}' requires geographic WGS84 (EPSG:4326) coordinates for geodesic math, but bbox [${bb.join(', ')}] looks projected. Reproject with 'gisknife crs convert --to WGS84' first.`,
      )
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('CRS guardrail:')) {
      throw err
    }
  }
}

function toPolygonalFeatures(
  fc: FeatureCollection<Geometry, GeoJsonProperties>,
): Array<Feature<Polygon | MultiPolygon, GeoJsonProperties>> {
  return fc.features.filter(
    (f): f is Feature<Polygon | MultiPolygon, GeoJsonProperties> =>
      Boolean(f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')),
  )
}

export function runTurfOperator(
  op: TurfOpName,
  fc: FeatureCollection<Geometry, GeoJsonProperties>,
  options: AnalyzeOpOptions = {},
): {
  geojson?: FeatureCollection<Geometry, GeoJsonProperties>
  measure?: AnalyzeMeasureResult
  warnings: GisknifeWarning[]
} {
  const warnings: GisknifeWarning[] = []

  switch (op) {
    case 'buffer': {
      assertGeographicWgs84(fc, 'buffer')
      const distMeters = options.distanceMeters ?? 500
      const buffered = turf.buffer(fc, distMeters, { units: 'meters' })
      return {
        geojson: (buffered ?? { type: 'FeatureCollection', features: [] }) as FeatureCollection<
          Geometry,
          GeoJsonProperties
        >,
        warnings,
      }
    }

    case 'simplify': {
      const tolerance = options.tolerance ?? 0.0005
      const simplified = turf.simplify(fc, { tolerance, highQuality: true, mutate: false })
      return { geojson: simplified, warnings }
    }

    case 'centroid': {
      const features = fc.features
        .filter((f) => f.geometry)
        .map((f) => {
          const c = turf.centroid(f)
          c.properties = { ...(f.properties ?? {}) }
          return c
        })
      return { geojson: { type: 'FeatureCollection', features }, warnings }
    }

    case 'bbox': {
      const bb = turf.bbox(fc) as BBox
      const poly = turf.bboxPolygon(bb)
      return { geojson: { type: 'FeatureCollection', features: [poly] }, warnings }
    }

    case 'dissolve': {
      const polys = toPolygonalFeatures(fc)
      if (polys.length === 0) {
        throw new Error('dissolve requires Polygon or MultiPolygon features')
      }
      const flat = turf.flatten({ type: 'FeatureCollection', features: polys })
      const dissolved = turf.dissolve(flat, {
        propertyName: options.dissolveProperty,
      })
      return {
        geojson: dissolved as FeatureCollection<Geometry, GeoJsonProperties>,
        warnings,
      }
    }

    case 'union': {
      const polys = [
        ...toPolygonalFeatures(fc),
        ...(options.secondGeoJson ? toPolygonalFeatures(options.secondGeoJson) : []),
      ]
      if (polys.length < 2) {
        throw new Error('union requires at least 2 Polygon/MultiPolygon features')
      }
      const united = turf.union(turf.featureCollection(polys))
      return {
        geojson: {
          type: 'FeatureCollection',
          features: united ? [united] : [],
        },
        warnings,
      }
    }

    case 'intersect': {
      if (!options.secondGeoJson) {
        const polys = toPolygonalFeatures(fc)
        if (polys.length < 2) {
          throw new Error('intersect requires two polygon layers or >=2 polygons in input')
        }
        const hit = turf.intersect(turf.featureCollection([polys[0], polys[1]]))
        return { geojson: { type: 'FeatureCollection', features: hit ? [hit] : [] }, warnings }
      }
      const layerA = toPolygonalFeatures(fc)
      const layerB = toPolygonalFeatures(options.secondGeoJson)
      const out: Array<Feature<Geometry, GeoJsonProperties>> = []
      for (const a of layerA) {
        for (const b of layerB) {
          const hit = turf.intersect(turf.featureCollection([a, b]))
          if (hit) {
            hit.properties = { ...(a.properties ?? {}), ...(b.properties ?? {}) }
            out.push(hit)
          }
        }
      }
      return { geojson: { type: 'FeatureCollection', features: out }, warnings }
    }

    case 'difference': {
      const layerA = toPolygonalFeatures(fc)
      const layerB = options.secondGeoJson ? toPolygonalFeatures(options.secondGeoJson) : []
      if (layerA.length === 0 || (layerB.length === 0 && layerA.length < 2)) {
        throw new Error('difference requires a second polygon layer or >=2 polygons in input')
      }
      if (layerB.length === 0) {
        const diff = turf.difference(turf.featureCollection([layerA[0], layerA[1]]))
        return { geojson: { type: 'FeatureCollection', features: diff ? [diff] : [] }, warnings }
      }
      const out: Array<Feature<Geometry, GeoJsonProperties>> = []
      for (const a of layerA) {
        let current: Feature<Polygon | MultiPolygon, GeoJsonProperties> | null = a
        for (const b of layerB) {
          if (!current) break
          const diff = turf.difference(turf.featureCollection([current, b]))
          current = diff ? { ...diff, properties: current.properties } : null
        }
        if (current) out.push(current)
      }
      return { geojson: { type: 'FeatureCollection', features: out }, warnings }
    }

    case 'measure': {
      assertGeographicWgs84(fc, 'measure')
      let totalAreaSqMeters = 0
      let totalLengthMeters = 0
      const perFeature = fc.features.map((f, index) => {
        let areaM2 = 0
        let lenM = 0
        if (f.geometry) {
          if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
            areaM2 = turf.area(f)
            const boundary = turf.polygonToLine(f.geometry)
            lenM = turf.length(boundary, { units: 'meters' })
          } else if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
            lenM = turf.length(f, { units: 'meters' })
          }
        }
        totalAreaSqMeters += areaM2
        totalLengthMeters += lenM
        const rawName = f.properties?.name ?? f.properties?.NAME
        return {
          index,
          name: rawName !== undefined ? String(rawName) : undefined,
          geometryType: f.geometry?.type ?? 'Null',
          areaSqMeters: Math.round(areaM2 * 100) / 100,
          lengthMeters: Math.round(lenM * 100) / 100,
        }
      })

      return {
        measure: {
          featureCount: fc.features.length,
          totalAreaSqMeters: Math.round(totalAreaSqMeters * 100) / 100,
          totalAreaSqKm: Math.round((totalAreaSqMeters / 1_000_000) * 10_000) / 10_000,
          totalLengthMeters: Math.round(totalLengthMeters * 100) / 100,
          totalLengthKm: Math.round((totalLengthMeters / 1_000) * 10_000) / 10_000,
          perFeature: perFeature.slice(0, 100),
        },
        warnings,
      }
    }

    case 'grid-square':
    case 'grid-hex': {
      assertGeographicWgs84(fc, op)
      const bb = turf.bbox(fc) as BBox
      const cellKm = (options.cellSizeMeters ?? 1000) / 1000
      const grid =
        op === 'grid-hex'
          ? turf.hexGrid(bb, cellKm, { units: 'kilometers' })
          : turf.squareGrid(bb, cellKm, { units: 'kilometers' })
      return {
        geojson: grid as FeatureCollection<Geometry, GeoJsonProperties>,
        warnings,
      }
    }
  }
}
