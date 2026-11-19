import * as turf from '@turf/turf'
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, MultiPolygon, Polygon, Position } from 'geojson'

export interface QaIssue {
  featureIndex: number
  code:
    | 'NULL_GEOMETRY'
    | 'INVALID_COORDINATE'
    | 'OUT_OF_WGS84_RANGE'
    | 'UNCLOSED_RING'
    | 'SELF_INTERSECTION'
    | 'DUPLICATE_VERTICES'
  message: string
}

export interface QaReport {
  featureCount: number
  validFeatureCount: number
  issueCount: number
  issues: QaIssue[]
  fixed: boolean
  crsWarning?: string
}

function walkPositions(geom: Geometry, cb: (pos: Position) => void): void {
  switch (geom.type) {
    case 'Point':
      cb(geom.coordinates)
      break
    case 'MultiPoint':
    case 'LineString':
      geom.coordinates.forEach(cb)
      break
    case 'MultiLineString':
    case 'Polygon':
      geom.coordinates.forEach((ring) => ring.forEach(cb))
      break
    case 'MultiPolygon':
      geom.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach(cb)))
      break
    case 'GeometryCollection':
      geom.geometries.forEach((g) => walkPositions(g, cb))
      break
  }
}

function closeRingIfNeeded(ring: Position[]): Position[] {
  if (ring.length < 3) return ring
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] === last[0] && first[1] === last[1]) {
    return ring
  }
  return [...ring, [...first]]
}

function fixGeometryRingsAndWinding(geom: Geometry): Geometry {
  if (geom.type === 'Polygon') {
    const closed: Polygon = {
      type: 'Polygon',
      coordinates: geom.coordinates.map(closeRingIfNeeded),
    }
    return turf.cleanCoords(turf.rewind(closed, { mutate: false }) as Feature<Polygon> | Polygon) as Geometry
  }
  if (geom.type === 'MultiPolygon') {
    const closed: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: geom.coordinates.map((poly) => poly.map(closeRingIfNeeded)),
    }
    return turf.cleanCoords(
      turf.rewind(closed, { mutate: false }) as Feature<MultiPolygon> | MultiPolygon,
    ) as Geometry
  }
  if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
    return turf.cleanCoords(geom) as Geometry
  }
  return geom
}

export function runGeometryQa(
  fc: FeatureCollection<Geometry, GeoJsonProperties>,
  options: { fix?: boolean; expectWgs84?: boolean } = {},
): { report: QaReport; geojson: FeatureCollection<Geometry, GeoJsonProperties> } {
  const issues: QaIssue[] = []
  const expectWgs84 = options.expectWgs84 ?? true
  const outFeatures: Array<Feature<Geometry, GeoJsonProperties>> = []
  let outOfWgs84Count = 0

  for (let i = 0; i < fc.features.length; i += 1) {
    const feat = fc.features[i]
    if (!feat.geometry) {
      issues.push({
        featureIndex: i,
        code: 'NULL_GEOMETRY',
        message: `Feature #${i} has null geometry`,
      })
      if (!options.fix) outFeatures.push(feat)
      continue
    }

    let hasInvalidCoord = false
    let hasOutOfWgs84 = false
    walkPositions(feat.geometry, (pos) => {
      if (pos.length < 2 || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) {
        hasInvalidCoord = true
      } else if (
        expectWgs84 &&
        (Math.abs(pos[0]) > 180 || Math.abs(pos[1]) > 90)
      ) {
        hasOutOfWgs84 = true
      }
    })

    if (hasInvalidCoord) {
      issues.push({
        featureIndex: i,
        code: 'INVALID_COORDINATE',
        message: `Feature #${i} contains NaN or non-finite coordinate`,
      })
    }
    if (hasOutOfWgs84) {
      outOfWgs84Count += 1
      issues.push({
        featureIndex: i,
        code: 'OUT_OF_WGS84_RANGE',
        message: `Feature #${i} has coordinates exceeding [-180..180, -90..90]`,
      })
    }

    const checkRings = (rings: Position[][]) => {
      for (const ring of rings) {
        if (ring.length >= 3) {
          const first = ring[0]
          const last = ring[ring.length - 1]
          if (first[0] !== last[0] || first[1] !== last[1]) {
            issues.push({
              featureIndex: i,
              code: 'UNCLOSED_RING',
              message: `Feature #${i} contains an unclosed polygon ring`,
            })
            break
          }
        }
      }
    }

    if (feat.geometry.type === 'Polygon') {
      checkRings(feat.geometry.coordinates)
    } else if (feat.geometry.type === 'MultiPolygon') {
      feat.geometry.coordinates.forEach(checkRings)
    }

    if (!hasInvalidCoord && (feat.geometry.type === 'Polygon' || feat.geometry.type === 'MultiPolygon')) {
      try {
        const k = turf.kinks(feat.geometry)
        if (k.features.length > 0) {
          issues.push({
            featureIndex: i,
            code: 'SELF_INTERSECTION',
            message: `Feature #${i} has ${k.features.length} self-intersection(s)`,
          })
        }
      } catch {
        // Ignore kinks failure on degenerate geometry already flagged
      }
    }

    if (options.fix && !hasInvalidCoord) {
      let fixedGeom = fixGeometryRingsAndWinding(feat.geometry)
      if (fixedGeom.type === 'Polygon') {
        try {
          const k = turf.kinks(fixedGeom)
          if (k.features.length > 0) {
            const unkinked = turf.unkinkPolygon(fixedGeom)
            if (unkinked.features.length === 1) {
              fixedGeom = unkinked.features[0].geometry
            } else if (unkinked.features.length > 1) {
              fixedGeom = {
                type: 'MultiPolygon',
                coordinates: unkinked.features.map((uf) => uf.geometry.coordinates),
              }
            }
          }
        } catch {
          // Keep closed/rewound geometry if unkink cannot split
        }
      }
      outFeatures.push({ ...feat, geometry: fixedGeom })
    } else {
      outFeatures.push(feat)
    }
  }

  const badFeatureIndexes = new Set(issues.map((is) => is.featureIndex))
  const report: QaReport = {
    featureCount: fc.features.length,
    validFeatureCount: fc.features.length - badFeatureIndexes.size,
    issueCount: issues.length,
    issues: issues.slice(0, 100),
    fixed: Boolean(options.fix),
    crsWarning:
      outOfWgs84Count > 0
        ? `${outOfWgs84Count} feature(s) appear to be in a projected CRS rather than WGS84. Reproject before geographic QA or web mapping.`
        : undefined,
  }

  return {
    report,
    geojson: {
      type: 'FeatureCollection',
      features: outFeatures,
    },
  }
}
