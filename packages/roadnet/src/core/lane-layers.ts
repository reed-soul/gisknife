/**
 * 车道级要素拆层与按归属算增量的纯函数。
 */

import { hashText } from './stream-hash.js'
import {
  LANE_LAYER_NAMES,
  type GeoJsonFeature,
  type LaneLayerName,
  type LaneLayerPayload,
} from './types.js'

interface RawLaneLayers {
  full: boolean
  truncated?: boolean
  owners: string[]
  [layer: string]: unknown
}

function ownerOf(feature: GeoJsonFeature): string {
  return String(feature.properties?.owner ?? '')
}

function refOf(feature: GeoJsonFeature): string {
  return String(feature.properties?.ref ?? feature.id)
}

export function splitLaneLayers(raw: string | RawLaneLayers): LaneLayerPayload {
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as RawLaneLayers
  const index = {} as LaneLayerPayload['index']
  const collections: Partial<Record<LaneLayerName, string>> = {}
  const features: Partial<Record<LaneLayerName, GeoJsonFeature[]>> = {}
  const fingerprints: Partial<Record<LaneLayerName, Record<string, string>>> = {}
  let featureCount = 0
  for (const name of LANE_LAYER_NAMES) {
    const list = (parsed[name] as GeoJsonFeature[] | undefined) ?? []
    featureCount += list.length
    const byOwner: Record<string, string[]> = {}
    const hashes: Record<string, string> = {}
    for (const feature of list) {
      ;(byOwner[ownerOf(feature)] ??= []).push(refOf(feature))
      hashes[refOf(feature)] = hashText(JSON.stringify(feature))
    }
    index[name] = byOwner
    fingerprints[name] = hashes
    if (parsed.full) {
      collections[name] = JSON.stringify({ type: 'FeatureCollection', features: list })
    } else {
      features[name] = list
    }
  }
  return {
    full: Boolean(parsed.full),
    ...(parsed.truncated ? { truncated: true } : {}),
    owners: parsed.owners ?? [],
    ...(parsed.full ? { collections } : { features }),
    index,
    fingerprints,
    featureCount,
  }
}

export interface LaneLayerDiff {
  add: GeoJsonFeature[]
  update: GeoJsonFeature[]
  remove: string[]
}

export function diffLaneLayer(
  owners: string[],
  incoming: GeoJsonFeature[],
  ownerIds: Map<string, Set<string>>,
  present: Set<string>,
  fingerprints?: Map<string, string>,
  incomingHashes?: Record<string, string>,
): LaneLayerDiff {
  const fresh = new Map<string, GeoJsonFeature[]>()
  for (const feature of incoming) {
    const owner = ownerOf(feature)
    if (!fresh.has(owner)) fresh.set(owner, [])
    fresh.get(owner)!.push(feature)
  }
  const diff: LaneLayerDiff = { add: [], update: [], remove: [] }
  const touchedOwners = new Set([...owners, ...fresh.keys()])
  for (const owner of touchedOwners) {
    const before = ownerIds.get(owner) ?? new Set<string>()
    const now = fresh.get(owner) ?? []
    const nowIds = new Set(now.map(refOf))
    for (const id of before) {
      if (!nowIds.has(id)) {
        diff.remove.push(id)
        present.delete(id)
        fingerprints?.delete(id)
      }
    }
    for (const feature of now) {
      const id = refOf(feature)
      const hash = incomingHashes?.[id]
      if (present.has(id)) {
        if (!hash || fingerprints?.get(id) !== hash) diff.update.push(feature)
      } else {
        diff.add.push(feature)
        present.add(id)
      }
      if (hash) fingerprints?.set(id, hash)
      else fingerprints?.delete(id)
    }
    if (nowIds.size) ownerIds.set(owner, nowIds)
    else ownerIds.delete(owner)
  }
  return diff
}
