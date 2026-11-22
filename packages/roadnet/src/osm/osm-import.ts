/**
 * OSM 选区领域类型与面积预判（默认上限 300 km²）。
 */

export const AREA_CAP_KM2 = 300

export interface LonLat {
  lon: number
  lat: number
}

export interface BoundingBox {
  west: number
  south: number
  east: number
  north: number
}

export interface OsmSearchCandidate {
  relationId: number
  displayName: string
  adminLevel?: number
  boundingBox: BoundingBox
}

export interface OsmBoundary {
  relationId: number
  displayName: string
  adminLevel?: number
  boundingBox: BoundingBox
  outerRing: LonLat[]
  areaKm2: number
}

export interface OsmDistrictCandidate {
  relationId: number
  displayName: string
  adminLevel?: number
}

export type FetchArea =
  | { kind: 'boundary'; relationId: number }
  | { kind: 'bbox'; box: BoundingBox }

function polygonAreaKm2(ring: LonLat[]): number {
  if (ring.length < 3) return 0
  const meanLat = ring.reduce((sum, p) => sum + p.lat, 0) / ring.length
  const kmPerDegLat = 110.574
  const kmPerDegLon = 111.32 * Math.cos((meanLat * Math.PI) / 180)
  const points = ring.map((p) => ({ x: p.lon * kmPerDegLon, y: p.lat * kmPerDegLat }))
  let twiceArea = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    twiceArea += a.x * b.y - b.x * a.y
  }
  return Math.abs(twiceArea) / 2
}

export function bboxAreaKm2(box: BoundingBox): number {
  return polygonAreaKm2([
    { lon: box.west, lat: box.south },
    { lon: box.east, lat: box.south },
    { lon: box.east, lat: box.north },
    { lon: box.west, lat: box.north },
  ])
}

export function exceedsAreaCap(areaKm2: number, maxKm2 = AREA_CAP_KM2): boolean {
  return areaKm2 > maxKm2
}
