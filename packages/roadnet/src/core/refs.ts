/**
 * 对象引用的解析。车道级要素的引用：`lane:<路段>|<段>|<车道>`。
 */

export interface LaneAddress {
  linkId: string
  section: number
  lane: number
}

export function parseLaneRef(ref: string): LaneAddress | null {
  if (!ref.startsWith('lane:')) return null
  const parts = ref.slice('lane:'.length).split('|')
  if (parts.length < 3) return null
  const lane = Number(parts.pop())
  const section = Number(parts.pop())
  const linkId = parts.join('|')
  if (!linkId || !Number.isInteger(section) || !Number.isInteger(lane)) return null
  return { linkId, section, lane }
}

export function laneRef(linkId: string, section: number, lane: number): string {
  return `lane:${linkId}|${section}|${lane}`
}

export function detailRef(ref: string): string {
  const lane = parseLaneRef(ref)
  return lane ? `link:${lane.linkId}` : ref
}

export interface LaneEndAddress {
  junctionId: string
  role: 'in' | 'out'
  linkId: string
  lane: number
}

export function parseLaneEndRef(ref: string | null | undefined): LaneEndAddress | null {
  const match = (ref ?? '').match(/^lend:(.+?)\|(in|out)\|(.+)\|(\d+)$/)
  if (!match) return null
  return { junctionId: match[1], role: match[2] as 'in' | 'out', linkId: match[3], lane: Number(match[4]) }
}

export interface ConnectionAddress {
  junctionId: string
  fromLinkId: string
  fromLane: number
  toLinkId: string
  toLane: number
}

export function parseConnRef(ref: string | null | undefined): ConnectionAddress | null {
  const match = (ref ?? '').match(/^conn:(.+?)\|(.+):(\d+)->(.+):(\d+)$/)
  if (!match) return null
  return {
    junctionId: match[1],
    fromLinkId: match[2],
    fromLane: Number(match[3]),
    toLinkId: match[4],
    toLane: Number(match[5]),
  }
}

export function connRef(junctionId: string, c: Omit<ConnectionAddress, 'junctionId'>): string {
  return `conn:${junctionId}|${c.fromLinkId}:${c.fromLane}->${c.toLinkId}:${c.toLane}`
}
