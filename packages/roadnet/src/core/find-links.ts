/**
 * 按路名找路段：内核表达式筛选 + 补齐反向路段 + 分幅路方向划分。
 */

import { RoadNetError, type FilterResult, type IncrementalFeatures, type LinkFilter } from './types.js'

export interface FindLinksSource {
  selectLinks(filter: LinkFilter): Promise<FilterResult>
  featuresFor(refs: string[]): Promise<IncrementalFeatures>
}

export const FIND_LINKS_MAX = 400

export type FindLinksMatch = 'contains' | 'exact'

export interface LinkGroup {
  name: string
  exact: boolean
  linkIds: string[]
  twoWayPairs: number
  oneWayLinks: number
  oneWayByDirection: [number, number]
  addedReverse: number
  roadClasses: Record<string, number>
  laneCounts: Record<string, number>
  speedKph: Record<string, number>
}

export type FindLinksResult =
  | { status: 'found'; query: string; match: FindLinksMatch; groups: LinkGroup[] }
  | { status: 'not_found'; query: string; match: FindLinksMatch; namedLinks: number; totalLinks: number }
  | { status: 'too_many'; query: string; match: FindLinksMatch; matched: number; limit: number }

interface LinkProps {
  linkId: string
  heading: number | null
  name: string | null
  reverseLinkId: string | null
  roadClass: string | null
  laneCount: number | null
  speedKph: number | null
}

export async function findLinksByName(
  source: FindLinksSource,
  name: string,
  match: FindLinksMatch = 'contains',
): Promise<FindLinksResult> {
  const query = String(name ?? '').trim()
  if (!query) throw new RoadNetError({ code: 'INVALID_ARGUMENT', message: 'roadnet_find_links requires a non-empty name.' })
  const filter: LinkFilter = {
    all: [{ field: 'name', op: match === 'exact' ? 'EQ' : 'CONTAINS', value: query }],
    limit: FIND_LINKS_MAX,
  }
  const hit = await source.selectLinks(filter)
  if (hit.overLimit) return { status: 'too_many', query, match, matched: hit.matched, limit: FIND_LINKS_MAX }
  if (hit.matched === 0) {
    const unnamed = await source.selectLinks({ all: [{ field: 'name', op: 'IS_NULL' }], limit: 1 })
    return { status: 'not_found', query, match, namedLinks: unnamed.scanned - unnamed.matched, totalLinks: unnamed.scanned }
  }

  const props = new Map<string, LinkProps>()
  await collect(source, hit.linkIds, props)
  const seeds = hit.linkIds.filter((id) => props.has(id))
  const seedSet = new Set(seeds)
  const missingReverse = seeds
    .map((id) => props.get(id)?.reverseLinkId)
    .filter((id): id is string => Boolean(id) && !seedSet.has(id as string))
  if (missingReverse.length) await collect(source, [...new Set(missingReverse)], props)

  const groups = new Map<string, { ids: string[]; added: Set<string> }>()
  const groupOf = new Map<string, string>()
  for (const id of seeds) {
    const key = props.get(id)?.name ?? ''
    if (!groups.has(key)) groups.set(key, { ids: [], added: new Set() })
    groups.get(key)!.ids.push(id)
    groupOf.set(id, key)
  }
  for (const id of seeds) {
    const reverse = props.get(id)?.reverseLinkId
    if (!reverse || groupOf.has(reverse) || !props.has(reverse)) continue
    const group = groups.get(groupOf.get(id)!)!
    group.ids.push(reverse)
    group.added.add(reverse)
    groupOf.set(reverse, groupOf.get(id)!)
  }

  const result: LinkGroup[] = [...groups.entries()].map(([groupName, group]) => {
    const inGroup = new Set(group.ids)
    let pairs = 0
    const oneWayIds: string[] = []
    for (const id of group.ids) {
      const reverse = props.get(id)?.reverseLinkId
      if (reverse && inGroup.has(reverse)) pairs += 1
      else oneWayIds.push(id)
    }
    return {
      name: groupName,
      exact: groupName === query,
      linkIds: [...group.ids].sort(),
      twoWayPairs: pairs / 2,
      oneWayLinks: oneWayIds.length,
      oneWayByDirection: splitByDirection(oneWayIds.map((id) => props.get(id)?.heading ?? null)),
      addedReverse: group.added.size,
      roadClasses: tally(group.ids.map((id) => props.get(id)?.roadClass)),
      laneCounts: tally(group.ids.map((id) => props.get(id)?.laneCount)),
      speedKph: tally(group.ids.map((id) => props.get(id)?.speedKph)),
    }
  })
  result.sort((a, b) => Number(b.exact) - Number(a.exact) || b.linkIds.length - a.linkIds.length || a.name.localeCompare(b.name, 'zh'))
  return { status: 'found', query, match, groups: result }
}

async function collect(source: FindLinksSource, linkIds: string[], into: Map<string, LinkProps>) {
  const features = await source.featuresFor(linkIds.map((id) => `link:${id}`))
  for (const feature of features.links.upsert) {
    const p = feature.properties as Record<string, unknown>
    const linkId = String(p.linkId ?? '')
    if (!linkId) continue
    into.set(linkId, {
      linkId,
      heading: heading(feature.geometry),
      name: typeof p.name === 'string' ? p.name : null,
      reverseLinkId: typeof p.reverseLinkId === 'string' ? p.reverseLinkId : null,
      roadClass: typeof p.roadClass === 'string' ? p.roadClass : null,
      laneCount: typeof p.laneCount === 'number' ? p.laneCount : null,
      speedKph: typeof p.speedKph === 'number' ? p.speedKph : null,
    })
  }
}

function heading(geometry: unknown): number | null {
  const coords = (geometry as { coordinates?: unknown })?.coordinates
  if (!Array.isArray(coords) || coords.length < 2) return null
  const [lon1, lat1] = coords[0] as number[]
  const [lon2, lat2] = coords[coords.length - 1] as number[]
  if (![lon1, lat1, lon2, lat2].every(Number.isFinite)) return null
  const dx = (lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180)
  const dy = lat2 - lat1
  return dx === 0 && dy === 0 ? null : Math.atan2(dy, dx)
}

function splitByDirection(headings: (number | null)[]): [number, number] {
  const known = headings.filter((h): h is number => h !== null)
  if (!known.length) return [0, 0]
  const axis =
    Math.atan2(
      known.reduce((sum, h) => sum + Math.sin(2 * h), 0),
      known.reduce((sum, h) => sum + Math.cos(2 * h), 0),
    ) / 2
  let forward = 0
  for (const h of known) if (Math.cos(h - axis) >= 0) forward += 1
  return [forward, known.length - forward]
}

function tally(values: (string | number | null | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) {
    const key = value === null || value === undefined ? 'unset' : String(value)
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}
