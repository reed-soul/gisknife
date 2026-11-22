/**
 * OSM highway 等级 → 车道/限速/优先级缺省表（对齐 SUMO 1.27.1 osmNetconvert.typ.xml）。
 */

export interface OsmHighwayDefaults {
  roadClass: string
  lanes: number
  speedMs: number
  priority: number
  oneway: boolean
}

export const OSM_HIGHWAY_DEFAULTS: Readonly<Record<string, OsmHighwayDefaults>> = {
  motorway: { roadClass: 'highway.motorway', lanes: 2, speedMs: 39.44, priority: 14, oneway: true },
  motorway_link: { roadClass: 'highway.motorway_link', lanes: 1, speedMs: 22.22, priority: 9, oneway: true },
  trunk: { roadClass: 'highway.trunk', lanes: 2, speedMs: 27.78, priority: 13, oneway: false },
  trunk_link: { roadClass: 'highway.trunk_link', lanes: 1, speedMs: 22.22, priority: 8, oneway: false },
  primary: { roadClass: 'highway.primary', lanes: 2, speedMs: 27.78, priority: 12, oneway: false },
  primary_link: { roadClass: 'highway.primary_link', lanes: 1, speedMs: 22.22, priority: 7, oneway: false },
  secondary: { roadClass: 'highway.secondary', lanes: 1, speedMs: 27.78, priority: 11, oneway: false },
  secondary_link: { roadClass: 'highway.secondary_link', lanes: 1, speedMs: 22.22, priority: 6, oneway: false },
  tertiary: { roadClass: 'highway.tertiary', lanes: 1, speedMs: 22.22, priority: 10, oneway: false },
  tertiary_link: { roadClass: 'highway.tertiary_link', lanes: 1, speedMs: 22.22, priority: 5, oneway: false },
  unclassified: { roadClass: 'highway.unclassified', lanes: 1, speedMs: 13.89, priority: 4, oneway: false },
  residential: { roadClass: 'highway.residential', lanes: 1, speedMs: 13.89, priority: 3, oneway: false },
  living_street: { roadClass: 'highway.living_street', lanes: 1, speedMs: 2.78, priority: 2, oneway: false },
  service: { roadClass: 'highway.service', lanes: 1, speedMs: 5.56, priority: 1, oneway: false },
}

export const OSM_IMPORTABLE_HIGHWAYS: ReadonlySet<string> = new Set(Object.keys(OSM_HIGHWAY_DEFAULTS))

export type OnewayDirection = 'forward' | 'reverse' | 'both'

const TWO_WAY_ONEWAY_VALUES = new Set(['', 'b', 'no', 'false', '0', 'none'])

export function resolveOneway(tags: Record<string, string>, defaultOneway: boolean): OnewayDirection {
  if ((tags.junction ?? '').trim().toLowerCase() === 'roundabout') return 'forward'
  const raw = tags.oneway
  if (raw === undefined) return defaultOneway ? 'forward' : 'both'
  const value = raw.trim().toLowerCase()
  if (value === 'yes' || value === 'true' || value === '1') return 'forward'
  if (value === '-1' || value === 'reverse') return 'reverse'
  if (TWO_WAY_ONEWAY_VALUES.has(value)) return 'both'
  return defaultOneway ? 'forward' : 'both'
}

export function parseLaneCount(value: string | undefined): number | null {
  if (value === undefined) return null
  const text = value.trim()
  if (!/^\d+$/.test(text)) return null
  const lanes = Number.parseInt(text, 10)
  return lanes > 0 ? lanes : null
}

export function splitTwoWayLanes(total: number): { forward: number; backward: number } {
  const forward = Math.ceil(total / 2)
  return { forward, backward: Math.max(1, total - forward) }
}

export function parseMaxspeedKph(value: string | undefined): number | null {
  if (value === undefined) return null
  const text = value.trim().toLowerCase()
  if (!text) return null
  const matched = text.match(/^(\d+(?:\.\d+)?)\s*(km\/h|kmh|kph|mph)?$/)
  if (!matched) return null
  const num = Number.parseFloat(matched[1] ?? '')
  if (!Number.isFinite(num) || num <= 0) return null
  const kph = matched[2] === 'mph' ? num * 1.609344 : num
  return Math.round(kph * 100) / 100
}

export function resolveLaneCount(
  tags: Record<string, string>,
  defaults: OsmHighwayDefaults,
  direction: OnewayDirection,
): number {
  const total = parseLaneCount(tags.lanes)
  const forward = parseLaneCount(tags['lanes:forward'])
  if (direction !== 'both') return forward ?? total ?? defaults.lanes
  if (forward !== null) return forward
  if (parseLaneCount(tags['lanes:backward']) !== null) return defaults.lanes
  if (total !== null) return splitTwoWayLanes(total).forward
  return defaults.lanes
}

export function resolveBackwardLaneCount(tags: Record<string, string>, defaults: OsmHighwayDefaults): number {
  const total = parseLaneCount(tags.lanes)
  const forward = parseLaneCount(tags['lanes:forward'])
  const backward = parseLaneCount(tags['lanes:backward'])
  if (backward !== null) return backward
  if (forward !== null) return defaults.lanes
  if (total !== null) return splitTwoWayLanes(total).backward
  return defaults.lanes
}

export function resolveMaxspeedKph(tags: Record<string, string>, edge: 'forward' | 'backward'): number | null {
  const shared = parseMaxspeedKph(tags.maxspeed)
  const directional = parseMaxspeedKph(edge === 'forward' ? tags['maxspeed:forward'] : tags['maxspeed:backward'])
  return directional ?? shared
}

export function isNegativeTagValue(value: string | undefined): boolean {
  if (value === undefined) return false
  const text = value.trim().toLowerCase()
  return text === '' || text === 'no' || text === 'false' || text === '0'
}

export function parseLayer(value: string | undefined): number | null {
  if (value === undefined) return null
  const text = value.trim()
  if (!/^[+-]?\d+$/.test(text)) return null
  const layer = Number.parseInt(text, 10)
  return layer === 0 ? null : layer
}
