/**
 * OSM 转向限制关系（`type=restriction`）解析与 SUMO 边映射。
 */

import type { OsmRestrictionType, OsmTurnRestriction } from './types.js'
import { escapeXmlAttribute } from './xml-scan.js'

export interface RawOsmRelationMember {
  type: string
  ref: string
  role: string
}

export interface RawOsmRelation {
  id: string
  members: RawOsmRelationMember[]
  tags: Record<string, string>
}

export interface EdgeEndpointInfo {
  edgeId: string
  osmWayId: string
  from: string
  to: string
}

const VALID_RESTRICTION_TYPES: ReadonlySet<OsmRestrictionType> = new Set([
  'no_left_turn',
  'no_right_turn',
  'no_u_turn',
  'no_straight_on',
  'only_left_turn',
  'only_right_turn',
  'only_straight_on',
  'only_u_turn',
  'no_entry',
  'no_exit',
])

const MOTOR_RESTRICTION_REL_TYPES = new Set([
  'restriction',
  'restriction:motorcar',
  'restriction:motor_vehicle',
])

/**
 * 解析一条 OSM relation 上的机动车转向限制标签。
 * 忽略含 `except=motorcar|motor_vehicle`、非机动车专属限制以及带时间条件的条目。
 */
export function parseRestrictionTag(
  tags: Record<string, string>,
): { restriction: OsmRestrictionType; kind: 'prohibitory' | 'mandatory' } | null {
  const relType = (tags.type ?? '').trim().toLowerCase()
  if (!MOTOR_RESTRICTION_REL_TYPES.has(relType)) return null

  const exceptTokens = (tags.except ?? '')
    .split(';')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (exceptTokens.includes('motorcar') || exceptTokens.includes('motor_vehicle')) {
    return null
  }

  const rawValue = (
    tags['restriction:motorcar'] ??
    tags['restriction:motor_vehicle'] ??
    tags.restriction ??
    ''
  )
    .trim()
    .toLowerCase()
  if (!rawValue || rawValue.includes('@')) return null

  if (!VALID_RESTRICTION_TYPES.has(rawValue as OsmRestrictionType)) return null
  const restriction = rawValue as OsmRestrictionType
  const kind = restriction.startsWith('only_') ? 'mandatory' : 'prohibitory'
  return { restriction, kind }
}

/** 收集所有合法机动车限制关系的 via node id，解析 way 时必须在这些节点打断。 */
export function collectRestrictionViaNodes(relations: readonly RawOsmRelation[]): Set<string> {
  const viaNodes = new Set<string>()
  for (const rel of relations) {
    if (!parseRestrictionTag(rel.tags)) continue
    for (const member of rel.members) {
      if (member.role === 'via' && member.type === 'node' && member.ref) {
        viaNodes.add(member.ref)
      }
    }
  }
  return viaNodes
}

/** 将 OSM relation 映射为切分后的路网边集合，保留在 `keptWayIds` 内的限制。 */
export function resolveTurnRestrictions(
  relations: readonly RawOsmRelation[],
  keptWayIds: ReadonlySet<string>,
  edgesByWayId: ReadonlyMap<string, EdgeEndpointInfo[]>,
): OsmTurnRestriction[] {
  const resolved: OsmTurnRestriction[] = []
  for (const rel of relations) {
    const parsed = parseRestrictionTag(rel.tags)
    if (!parsed) continue

    const fromMember = rel.members.find((m) => m.role === 'from' && m.type === 'way')
    const toMember = rel.members.find((m) => m.role === 'to' && m.type === 'way')
    if (!fromMember || !toMember) continue
    if (!keptWayIds.has(fromMember.ref) || !keptWayIds.has(toMember.ref)) continue

    const viaNode = rel.members.find((m) => m.role === 'via' && m.type === 'node')?.ref
    const viaWays = rel.members.filter((m) => m.role === 'via' && m.type === 'way').map((m) => m.ref)

    const fromCandidates = edgesByWayId.get(fromMember.ref) ?? []
    const toCandidates = edgesByWayId.get(toMember.ref) ?? []

    const fromEdgeIds = (viaNode ? fromCandidates.filter((e) => e.to === viaNode) : fromCandidates).map(
      (e) => e.edgeId,
    )
    const toEdgeIds = (viaNode ? toCandidates.filter((e) => e.from === viaNode) : toCandidates).map(
      (e) => e.edgeId,
    )

    // 当 viaNode 匹配失败时（例如几何节点未对齐），回退该 way 的全部有向边供下游节点拓扑对齐
    const finalFromEdges = fromEdgeIds.length > 0 ? fromEdgeIds : fromCandidates.map((e) => e.edgeId)
    const finalToEdges = toEdgeIds.length > 0 ? toEdgeIds : toCandidates.map((e) => e.edgeId)
    if (finalFromEdges.length === 0 || finalToEdges.length === 0) continue

    resolved.push({
      relationId: rel.id,
      restriction: parsed.restriction,
      kind: parsed.kind,
      fromWayId: fromMember.ref,
      toWayId: toMember.ref,
      ...(viaNode ? { viaNodeId: viaNode } : {}),
      ...(viaWays.length > 0 ? { viaWayIds: viaWays } : {}),
      fromEdgeIds: finalFromEdges,
      toEdgeIds: finalToEdges,
    })
  }
  return resolved
}

/**
 * 为 SUMO con.xml 输出 `<prohibition>` 元数据元素（只针对明确禁止关系；`only_*` 需结合邻接边计算）。
 * `roadnet-core` 的 `import_plain_xml` 只消费 `<connection>` 与 `<crossing>`，不会受这些元素干扰。
 */
export function renderProhibitionsXml(restrictions: readonly OsmTurnRestriction[]): string {
  const lines: string[] = []
  for (const r of restrictions) {
    if (r.kind !== 'prohibitory') continue
    for (const fromEdge of r.fromEdgeIds) {
      for (const toEdge of r.toEdgeIds) {
        const prohibitor = `${escapeXmlAttribute(fromEdge)}->${escapeXmlAttribute(toEdge)}`
        lines.push(`    <prohibition prohibitor="${prohibitor}" prohibited="${prohibitor}"/>\n`)
      }
    }
  }
  return lines.join('')
}
