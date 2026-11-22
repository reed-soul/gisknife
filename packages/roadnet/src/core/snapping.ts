/**
 * 吸附规则：已有顶点 > 端点 > 边上垂足。
 */

export interface LngLat {
  lon: number
  lat: number
}

export type SnapKind = 'vertex' | 'endpoint' | 'edge'

export interface SnapCandidate {
  kind: SnapKind
  at: LngLat
  ref: string
  distanceM: number
}

export interface SnapInput {
  cursor: LngLat
  links: { ref: string; coordinates: [number, number][]; isEndpointRef?: (index: number) => string | null }[]
  nodes: { ref: string; at: LngLat }[]
  toleranceM: number
}

const EARTH_R = 6_371_008.8

export function distanceM(a: LngLat, b: LngLat): number {
  const latRad = ((a.lat + b.lat) / 2) * (Math.PI / 180)
  const dx = (b.lon - a.lon) * (Math.PI / 180) * Math.cos(latRad) * EARTH_R
  const dy = (b.lat - a.lat) * (Math.PI / 180) * EARTH_R
  return Math.hypot(dx, dy)
}

export function projectOnSegment(p: LngLat, a: LngLat, b: LngLat): LngLat {
  const latRad = (p.lat * Math.PI) / 180
  const kx = Math.cos(latRad)
  const ax = a.lon * kx
  const bx = b.lon * kx
  const px = p.lon * kx
  const dx = bx - ax
  const dy = b.lat - a.lat
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return a
  let t = ((px - ax) * dx + (p.lat - a.lat) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  return { lon: (ax + t * dx) / kx, lat: a.lat + t * dy }
}

export function toleranceInMeters(pixels: number, metersPerPixel: number, maxMeters: number): number {
  return Math.min(pixels * metersPerPixel, maxMeters)
}

export function findSnap(input: SnapInput): SnapCandidate | null {
  const { cursor, toleranceM } = input
  const candidates: SnapCandidate[] = []

  for (const node of input.nodes) {
    const d = distanceM(cursor, node.at)
    if (d <= toleranceM) candidates.push({ kind: 'endpoint', at: node.at, ref: node.ref, distanceM: d })
  }

  for (const link of input.links) {
    const points = link.coordinates.map(([lon, lat]) => ({ lon, lat }))
    for (let i = 0; i < points.length; i += 1) {
      const d = distanceM(cursor, points[i])
      if (d > toleranceM) continue
      const endpointRef = link.isEndpointRef?.(i) ?? null
      candidates.push({
        kind: endpointRef ? 'endpoint' : 'vertex',
        at: points[i],
        ref: endpointRef ?? link.ref,
        distanceM: d,
      })
    }
    for (let i = 0; i + 1 < points.length; i += 1) {
      const foot = projectOnSegment(cursor, points[i], points[i + 1])
      const d = distanceM(cursor, foot)
      if (d <= toleranceM) {
        candidates.push({ kind: 'edge', at: foot, ref: link.ref, distanceM: d })
      }
    }
  }

  if (!candidates.length) return null
  const rank: Record<SnapKind, number> = { vertex: 0, endpoint: 1, edge: 2 }
  candidates.sort((a, b) => rank[a.kind] - rank[b.kind] || a.distanceM - b.distanceM)
  return candidates[0]
}
