/**
 * 浏览器 / Node 同构的 OSM → SUMO plain XML 转换器：
 * - 支持 14 种机动车道路等级、单双向拆分、oneway=-1 几何反向、车道与限速、桥隧与层号；
 * - 支持识别 `highway=traffic_signals` 信号节点（在节点处打断道路并写出 `type="traffic_light" tl=...` 与 `<tlLogic>` 骨架）；
 * - 支持识别 `type=restriction` 转向限制关系（在 `via` 节点打断道路并解析 `OsmTurnRestriction[]`）。
 */

import { RoadNetError } from '../core/types.js'
import {
  collectRestrictionViaNodes,
  renderProhibitionsXml,
  resolveTurnRestrictions,
  type EdgeEndpointInfo,
  type RawOsmRelation,
} from './osm-restrictions.js'
import {
  OSM_HIGHWAY_DEFAULTS,
  OSM_IMPORTABLE_HIGHWAYS,
  isNegativeTagValue,
  parseLayer,
  resolveBackwardLaneCount,
  resolveLaneCount,
  resolveMaxspeedKph,
  resolveOneway,
} from './osm-typemap.js'
import type { OsmImportFiles, OsmTrafficSignal } from './types.js'
import { escapeXmlAttribute, inspectOsmRoads, rejectEntityDeclarations, scanXmlElements } from './xml-scan.js'

const ODBL_NOTICE =
  'Data © OpenStreetMap contributors (ODbL 1.0): https://www.openstreetmap.org/copyright'

const NODE_ID_PATTERN = /^\d+$/

interface RawNode {
  id: string
  lon: number
  lat: number
  tags: Record<string, string>
}

interface RawWay {
  id: string
  refs: string[]
  tags: Record<string, string>
}

interface KeptSegment {
  id: string
  osmWayId: string
  from: string
  to: string
  shape: Array<{ lon: number; lat: number }>
  roadClass: string
  priority: number
  lanes: number
  backwardLanes: number | null
  forwardSpeedMs: number
  backwardSpeedMs: number
  name: string | null
  params: Array<{ key: string; value: string }>
}

export async function parseOsmXml(xml: string): Promise<OsmImportFiles> {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new RoadNetError({ code: 'INVALID_ARGUMENT', message: 'Input is not a valid OSM XML document.' })
  }
  try {
    rejectEntityDeclarations(xml)
  } catch {
    throw new RoadNetError({
      code: 'INVALID_ARGUMENT',
      message: 'OSM XML contains DOCTYPE/ENTITY declarations and was rejected.',
    })
  }

  const { hasWay, remark } = inspectOsmRoads(xml)
  if (!hasWay) throw noWaysError(remark)

  const { nodes, ways, relations } = scanOsmDocument(xml)
  const signalNodeIds = collectTrafficSignalNodes(nodes)
  const viaNodeIds = collectRestrictionViaNodes(relations)
  const kept = collectKeptSegments(nodes, ways, signalNodeIds, viaNodeIds)

  const keptWayIds = new Set(kept.map((seg) => seg.osmWayId))
  const edgesByWayId = indexSegmentsByWayId(kept)
  const restrictions = resolveTurnRestrictions(relations, keptWayIds, edgesByWayId)

  const referencedNodeIds = collectReferencedNodeIds(kept)
  const signals = extractTrafficSignals(nodes, signalNodeIds, referencedNodeIds)
  const emittedSignalIds = new Set(signals.map((s) => s.nodeId))

  const conBody = renderProhibitionsXml(restrictions)

  return {
    files: {
      nod: renderNod(kept, emittedSignalIds),
      edg: renderEdg(kept),
      con: conBody ? `${fileHeader('connections')}${conBody}</connections>\n` : renderEmptyFile('connections'),
      tll: renderTll(signals),
    },
    stats: {
      edges: kept.reduce((count, seg) => count + (seg.backwardLanes === null ? 1 : 2), 0),
      namedEdges: kept.reduce((count, seg) => count + (seg.name === null ? 0 : seg.backwardLanes === null ? 1 : 2), 0),
      trafficSignals: signals.length,
      turnRestrictions: restrictions.length,
    },
    signals,
    restrictions,
  }
}

export function noWaysError(remark: string | null): RoadNetError {
  if (remark && remark.includes('runtime error')) {
    const detail = remark.slice(0, 200)
    if (detail.toLowerCase().includes('timed out')) {
      return new RoadNetError({
        code: 'OSM_IMPORT_TIMEOUT',
        message: `Overpass query timed out; try a smaller area: ${detail}`,
      })
    }
    return new RoadNetError({ code: 'OSM_UPSTREAM_ERROR', message: `Overpass query failed: ${detail}` })
  }
  return new RoadNetError({ code: 'NO_ROADS_FOUND', message: 'No road ways found in the selected OSM data.' })
}

function scanOsmDocument(xml: string): {
  nodes: Map<string, RawNode>
  ways: RawWay[]
  relations: RawOsmRelation[]
} {
  const nodes = new Map<string, RawNode>()
  const ways: RawWay[] = []
  const relations: RawOsmRelation[] = []

  let currentNode: RawNode | null = null
  let currentWay: RawWay | null = null
  let currentRelation: RawOsmRelation | null = null

  scanXmlElements(xml, ({ tag, attrs, selfClosing }) => {
    if (tag === 'node' && !currentWay && !currentRelation) {
      const id = attrs.id
      const lat = Number.parseFloat(attrs.lat ?? '')
      const lon = Number.parseFloat(attrs.lon ?? '')
      if (id && NODE_ID_PATTERN.test(id) && Number.isFinite(lat) && Number.isFinite(lon)) {
        const node: RawNode = { id, lon, lat, tags: {} }
        nodes.set(id, node)
        currentNode = selfClosing ? null : node
      } else {
        currentNode = null
      }
      return
    }
    if (tag === '/node') {
      currentNode = null
      return
    }
    if (tag === 'way' && !currentRelation) {
      currentNode = null
      const id = attrs.id
      currentWay = !selfClosing && id && NODE_ID_PATTERN.test(id) ? { id, refs: [], tags: {} } : null
      return
    }
    if (tag === '/way') {
      if (currentWay) ways.push(currentWay)
      currentWay = null
      return
    }
    if (tag === 'relation') {
      currentNode = null
      currentWay = null
      const id = attrs.id
      currentRelation = !selfClosing && id && NODE_ID_PATTERN.test(id) ? { id, members: [], tags: {} } : null
      return
    }
    if (tag === '/relation') {
      if (currentRelation) relations.push(currentRelation)
      currentRelation = null
      return
    }

    if (tag === 'nd' && currentWay) {
      const ref = attrs.ref
      if (ref && NODE_ID_PATTERN.test(ref)) currentWay.refs.push(ref)
      return
    }
    if (tag === 'member' && currentRelation) {
      const type = attrs.type ?? ''
      const ref = attrs.ref ?? ''
      const role = attrs.role ?? ''
      if (type && ref) currentRelation.members.push({ type, ref, role })
      return
    }
    if (tag === 'tag') {
      const key = attrs.k
      const value = attrs.v
      if (!key || value === undefined) return
      if (currentNode) currentNode.tags[key] = value
      else if (currentWay) currentWay.tags[key] = value
      else if (currentRelation) currentRelation.tags[key] = value
    }
  })

  return { nodes, ways, relations }
}

function collectTrafficSignalNodes(nodes: Map<string, RawNode>): Set<string> {
  const signalIds = new Set<string>()
  for (const [id, node] of nodes) {
    if ((node.tags.highway ?? '').trim().toLowerCase() === 'traffic_signals') {
      signalIds.add(id)
    }
  }
  return signalIds
}

interface FilteredWay {
  id: string
  endpoints: string[]
  shape: Array<{ lon: number; lat: number }>
  tags: Record<string, string>
}

function collectKeptSegments(
  nodes: Map<string, RawNode>,
  ways: RawWay[],
  signalNodeIds: ReadonlySet<string>,
  viaNodeIds: ReadonlySet<string>,
): KeptSegment[] {
  const filtered: FilteredWay[] = []
  const nodeUsage = new Map<string, number>()

  for (const way of ways) {
    const highway = way.tags.highway
    if (!highway || !OSM_IMPORTABLE_HIGHWAYS.has(highway)) continue
    if ((way.tags.area ?? '').trim().toLowerCase() === 'yes') continue
    if (!OSM_HIGHWAY_DEFAULTS[highway]) continue

    const shape: Array<{ lon: number; lat: number }> = []
    const endpoints: string[] = []
    for (const ref of way.refs) {
      const node = nodes.get(ref)
      if (!node) continue
      if (endpoints[endpoints.length - 1] === ref) continue
      endpoints.push(ref)
      shape.push({ lon: node.lon, lat: node.lat })
    }
    if (shape.length < 2) continue

    filtered.push({ id: way.id, endpoints, shape, tags: way.tags })
    for (const ref of new Set(endpoints)) {
      nodeUsage.set(ref, (nodeUsage.get(ref) ?? 0) + 1)
    }
  }

  // 在共享节点、红绿灯节点、转向限制 via 节点处切分 way，确保节点落在路段端点上
  const splitNodes = new Set<string>()
  for (const [nodeId, count] of nodeUsage) {
    if (count >= 2 || signalNodeIds.has(nodeId) || viaNodeIds.has(nodeId)) {
      splitNodes.add(nodeId)
    }
  }

  const kept: KeptSegment[] = []
  for (const way of filtered) {
    const defaults = OSM_HIGHWAY_DEFAULTS[way.tags.highway]!
    const direction = resolveOneway(way.tags, defaults.oneway)
    const lanes = resolveLaneCount(way.tags, defaults, direction)
    const forwardSpeedMs = speedMs(resolveMaxspeedKph(way.tags, 'forward'), defaults.speedMs)
    const backwardSpeedMs = speedMs(resolveMaxspeedKph(way.tags, 'backward'), defaults.speedMs)

    const params: KeptSegment['params'] = [{ key: 'osmWayId', value: way.id }]
    if (way.tags.bridge !== undefined && !isNegativeTagValue(way.tags.bridge)) {
      params.push({ key: 'bridge', value: 'yes' })
    }
    if (way.tags.tunnel !== undefined && !isNegativeTagValue(way.tags.tunnel)) {
      params.push({ key: 'tunnel', value: 'yes' })
    }
    const layer = parseLayer(way.tags.layer)
    if (layer !== null) params.push({ key: 'osmLayer', value: String(layer) })

    const name = way.tags.name && way.tags.name.trim() !== '' ? way.tags.name : null
    const slices = splitWayAtNodes(way.endpoints, way.shape, splitNodes)

    for (let idx = 0; idx < slices.length; idx += 1) {
      const slice = slices[idx]
      const segId = slices.length === 1 ? way.id : `${way.id}#${idx}`
      if (direction === 'reverse') {
        kept.push({
          id: segId,
          osmWayId: way.id,
          from: slice.endpoints[slice.endpoints.length - 1],
          to: slice.endpoints[0],
          shape: [...slice.shape].reverse(),
          roadClass: defaults.roadClass,
          priority: defaults.priority,
          lanes,
          backwardLanes: null,
          forwardSpeedMs: backwardSpeedMs,
          backwardSpeedMs,
          name,
          params,
        })
        continue
      }
      kept.push({
        id: segId,
        osmWayId: way.id,
        from: slice.endpoints[0],
        to: slice.endpoints[slice.endpoints.length - 1],
        shape: slice.shape,
        roadClass: defaults.roadClass,
        priority: defaults.priority,
        lanes,
        backwardLanes: direction === 'both' ? resolveBackwardLaneCount(way.tags, defaults) : null,
        forwardSpeedMs,
        backwardSpeedMs,
        name,
        params,
      })
    }
  }
  return kept
}

function splitWayAtNodes(
  endpoints: string[],
  shape: Array<{ lon: number; lat: number }>,
  splitNodes: ReadonlySet<string>,
): Array<{ endpoints: string[]; shape: Array<{ lon: number; lat: number }> }> {
  const cutIndexes: number[] = [0]
  for (let i = 1; i < endpoints.length - 1; i += 1) {
    if (splitNodes.has(endpoints[i])) {
      cutIndexes.push(i)
    }
  }
  cutIndexes.push(endpoints.length - 1)

  const slices: Array<{ endpoints: string[]; shape: Array<{ lon: number; lat: number }> }> = []
  for (let i = 0; i < cutIndexes.length - 1; i += 1) {
    const start = cutIndexes[i]
    const end = cutIndexes[i + 1]
    slices.push({
      endpoints: endpoints.slice(start, end + 1),
      shape: shape.slice(start, end + 1),
    })
  }
  return slices
}

function indexSegmentsByWayId(kept: readonly KeptSegment[]): Map<string, EdgeEndpointInfo[]> {
  const byWay = new Map<string, EdgeEndpointInfo[]>()
  for (const seg of kept) {
    const list = byWay.get(seg.osmWayId) ?? []
    list.push({ edgeId: seg.id, osmWayId: seg.osmWayId, from: seg.from, to: seg.to })
    if (seg.backwardLanes !== null) {
      list.push({ edgeId: `-${seg.id}`, osmWayId: seg.osmWayId, from: seg.to, to: seg.from })
    }
    byWay.set(seg.osmWayId, list)
  }
  return byWay
}

function collectReferencedNodeIds(kept: readonly KeptSegment[]): Set<string> {
  const ids = new Set<string>()
  for (const seg of kept) {
    ids.add(seg.from)
    ids.add(seg.to)
  }
  return ids
}

function extractTrafficSignals(
  nodes: Map<string, RawNode>,
  signalNodeIds: ReadonlySet<string>,
  referencedNodeIds: ReadonlySet<string>,
): OsmTrafficSignal[] {
  const signals: OsmTrafficSignal[] = []
  for (const nodeId of signalNodeIds) {
    if (!referencedNodeIds.has(nodeId)) continue
    const node = nodes.get(nodeId)
    if (!node) continue
    const direction = node.tags['traffic_signals:direction']?.trim()
    signals.push({
      nodeId,
      lon: node.lon,
      lat: node.lat,
      ...(direction ? { direction } : {}),
    })
  }
  return signals
}

function speedMs(kph: number | null, defaultMs: number): number {
  if (kph === null) return defaultMs
  return Math.round((kph / 3.6) * 100) / 100
}

function fileHeader(rootTag: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${ODBL_NOTICE} -->\n<${rootTag}>\n`
}

function renderEmptyFile(rootTag: string): string {
  return `${fileHeader(rootTag)}</${rootTag}>\n`
}

function renderNod(kept: KeptSegment[], signalIds: ReadonlySet<string>): string {
  const incidence = new Map<string, number>()
  const coordinates = new Map<string, { lon: number; lat: number }>()
  for (const seg of kept) {
    for (const [nodeId, lonLat] of [
      [seg.from, seg.shape[0]],
      [seg.to, seg.shape[seg.shape.length - 1]],
    ] as Array<[string, { lon: number; lat: number }]>) {
      incidence.set(nodeId, (incidence.get(nodeId) ?? 0) + 1)
      coordinates.set(nodeId, lonLat)
    }
  }

  const lines: string[] = []
  for (const [nodeId, point] of coordinates) {
    if (signalIds.has(nodeId)) {
      const escaped = escapeXmlAttribute(nodeId)
      lines.push(
        `    <node id="${escaped}" x="${formatCoord(point.lon)}" y="${formatCoord(point.lat)}" type="traffic_light" tl="${escaped}"/>\n`,
      )
      continue
    }
    const degree = incidence.get(nodeId) ?? 0
    const type = degree <= 1 ? ' type="dead_end"' : degree >= 3 ? ' type="priority"' : ''
    lines.push(
      `    <node id="${escapeXmlAttribute(nodeId)}" x="${formatCoord(point.lon)}" y="${formatCoord(point.lat)}"${type}/>\n`,
    )
  }
  return `${fileHeader('nodes')}${lines.join('')}</nodes>\n`
}

function renderEdg(kept: KeptSegment[]): string {
  const lines: string[] = []
  for (const seg of kept) {
    lines.push(renderEdge(seg, seg.id, seg.from, seg.to, seg.shape, seg.lanes, seg.forwardSpeedMs))
    if (seg.backwardLanes !== null) {
      lines.push(
        renderEdge(seg, `-${seg.id}`, seg.to, seg.from, [...seg.shape].reverse(), seg.backwardLanes, seg.backwardSpeedMs),
      )
    }
  }
  return `${fileHeader('edges')}${lines.join('')}</edges>\n`
}

function renderEdge(
  seg: KeptSegment,
  edgeId: string,
  from: string,
  to: string,
  shape: KeptSegment['shape'],
  lanes: number,
  speedMsValue: number,
): string {
  let line = `    <edge id="${escapeXmlAttribute(edgeId)}" from="${escapeXmlAttribute(from)}" to="${escapeXmlAttribute(to)}" numLanes="${Math.max(1, lanes)}"`
  if (seg.name !== null) line += ` name="${escapeXmlAttribute(seg.name)}"`
  line += ` type="${escapeXmlAttribute(seg.roadClass)}" priority="${seg.priority}" speed="${speedMsValue.toFixed(2)}"`
  line += ` shape="${formatShape(shape)}"`
  if (seg.params.length === 0) return `${line}/>\n`
  line += '>\n'
  for (const param of seg.params) {
    line += `        <param key="${escapeXmlAttribute(param.key)}" value="${escapeXmlAttribute(param.value)}"/>\n`
  }
  return `${line}    </edge>\n`
}

function renderTll(signals: readonly OsmTrafficSignal[]): string {
  if (signals.length === 0) return renderEmptyFile('tlLogics')
  const lines: string[] = []
  for (const sig of signals) {
    const escaped = escapeXmlAttribute(sig.nodeId)
    lines.push(`    <tlLogic id="${escaped}" type="static" programID="0" offset="0">\n`)
    lines.push(`        <phase duration="30" state="r"/>\n`)
    lines.push(`    </tlLogic>\n`)
  }
  return `${fileHeader('tlLogics')}${lines.join('')}</tlLogics>\n`
}

function formatShape(shape: KeptSegment['shape']): string {
  return shape.map((point) => `${formatCoord(point.lon)},${formatCoord(point.lat)}`).join(' ')
}

function formatCoord(value: number): string {
  return String(value)
}
