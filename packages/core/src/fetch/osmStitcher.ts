import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, Position } from 'geojson'

export interface OverpassLatLon {
  lat: number
  lon: number
}

export interface OverpassRelationMember {
  type: 'node' | 'way' | 'relation'
  ref: number
  role: string
  geometry?: OverpassLatLon[]
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  nodes?: number[]
  geometry?: OverpassLatLon[]
  members?: OverpassRelationMember[]
  tags?: Record<string, string>
}

export interface OverpassResponse {
  elements: OverpassElement[]
}

const EPS = 1e-7

function coordsEqual(a: Position, b: Position): boolean {
  return Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS
}

function toPositions(geom: OverpassLatLon[] | undefined): Position[] {
  if (!geom || geom.length === 0) return []
  return geom.map((pt) => [pt.lon, pt.lat])
}

/**
 * Stitches unordered Overpass way segments (each an array of [lon, lat])
 * into closed GeoJSON LinearRings by matching endpoints.
 */
export function stitchWaySegmentsToRings(segments: Position[][]): Position[][] {
  const pool = segments.filter((s) => s.length >= 2).map((s) => [...s])
  const rings: Position[][] = []

  while (pool.length > 0) {
    let current = pool.shift()!
    let madeProgress = true

    while (madeProgress && !coordsEqual(current[0], current[current.length - 1])) {
      madeProgress = false
      const tail = current[current.length - 1]
      const head = current[0]

      for (let i = 0; i < pool.length; i += 1) {
        const seg = pool[i]
        const segStart = seg[0]
        const segEnd = seg[seg.length - 1]

        if (coordsEqual(tail, segStart)) {
          current = [...current, ...seg.slice(1)]
          pool.splice(i, 1)
          madeProgress = true
          break
        }
        if (coordsEqual(tail, segEnd)) {
          current = [...current, ...[...seg].reverse().slice(1)]
          pool.splice(i, 1)
          madeProgress = true
          break
        }
        if (coordsEqual(head, segEnd)) {
          current = [...seg.slice(0, -1), ...current]
          pool.splice(i, 1)
          madeProgress = true
          break
        }
        if (coordsEqual(head, segStart)) {
          current = [...[...seg].reverse().slice(0, -1), ...current]
          pool.splice(i, 1)
          madeProgress = true
          break
        }
      }
    }

    if (current.length >= 3) {
      if (!coordsEqual(current[0], current[current.length - 1])) {
        current.push([...current[0]])
      }
      if (current.length >= 4) {
        rings.push(current)
      }
    }
  }

  return rings
}

function isClosedWayPolygon(coords: Position[], tags?: Record<string, string>): boolean {
  if (coords.length < 4) return false
  if (!coordsEqual(coords[0], coords[coords.length - 1])) return false
  if (!tags) return false
  if (tags.area === 'no' || tags.highway) return false
  return Boolean(
    tags.building ||
      tags.landuse ||
      tags.leisure ||
      tags.natural === 'water' ||
      tags.waterway === 'riverbank' ||
      tags.boundary ||
      tags.area === 'yes',
  )
}

/**
 * Converts Overpass JSON (with `out geom;`) into a valid GeoJSON FeatureCollection.
 */
export function overpassToGeoJson(
  payload: OverpassResponse,
): FeatureCollection<Geometry, GeoJsonProperties> {
  const nodeMap = new Map<number, Position>()
  const wayMap = new Map<number, Position[]>()

  for (const el of payload.elements) {
    if (el.type === 'node' && el.lon !== undefined && el.lat !== undefined) {
      nodeMap.set(el.id, [el.lon, el.lat])
    }
  }

  for (const el of payload.elements) {
    if (el.type === 'way') {
      const coords =
        el.geometry && el.geometry.length > 0
          ? toPositions(el.geometry)
          : (el.nodes ?? [])
              .map((nid) => nodeMap.get(nid))
              .filter((p): p is Position => Boolean(p))
      if (coords.length >= 2) {
        wayMap.set(el.id, coords)
      }
    }
  }

  const features: Array<Feature<Geometry, GeoJsonProperties>> = []

  for (const el of payload.elements) {
    const props: GeoJsonProperties = {
      osm_type: el.type,
      osm_id: el.id,
      ...(el.tags ?? {}),
    }

    if (el.type === 'node') {
      // Only include tagged POI/feature nodes (skip untagged geometry nodes)
      if (el.lon !== undefined && el.lat !== undefined && el.tags && Object.keys(el.tags).length > 0) {
        features.push({
          type: 'Feature',
          id: `node/${el.id}`,
          properties: props,
          geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
        })
      }
      continue
    }

    if (el.type === 'way') {
      // Skip ways without tags that only exist as relation members
      if (!el.tags || Object.keys(el.tags).length === 0) continue
      const coords = wayMap.get(el.id)
      if (!coords || coords.length < 2) continue

      const geometry: Geometry = isClosedWayPolygon(coords, el.tags)
        ? { type: 'Polygon', coordinates: [coords] }
        : { type: 'LineString', coordinates: coords }

      features.push({
        type: 'Feature',
        id: `way/${el.id}`,
        properties: props,
        geometry,
      })
      continue
    }

    if (el.type === 'relation' && el.members) {
      const outerSegs: Position[][] = []
      const innerSegs: Position[][] = []

      for (const m of el.members) {
        if (m.type !== 'way') continue
        const seg =
          m.geometry && m.geometry.length > 0
            ? toPositions(m.geometry)
            : wayMap.get(m.ref) ?? []
        if (seg.length < 2) continue
        if (m.role === 'inner') {
          innerSegs.push(seg)
        } else {
          outerSegs.push(seg)
        }
      }

      const outerRings = stitchWaySegmentsToRings(outerSegs)
      const innerRings = stitchWaySegmentsToRings(innerSegs)

      if (outerRings.length === 0) continue

      const geometry: Geometry =
        outerRings.length === 1 && innerRings.length === 0
          ? { type: 'Polygon', coordinates: [outerRings[0]] }
          : outerRings.length === 1
            ? { type: 'Polygon', coordinates: [outerRings[0], ...innerRings] }
            : {
                type: 'MultiPolygon',
                coordinates: outerRings.map((ring, idx) =>
                  idx === 0 && innerRings.length > 0 ? [ring, ...innerRings] : [ring],
                ),
              }

      features.push({
        type: 'Feature',
        id: `relation/${el.id}`,
        properties: props,
        geometry,
      })
    }
  }

  return {
    type: 'FeatureCollection',
    features,
  }
}
