/**
 * 同构 OSM 路网构建流水线（浏览器与 Node.js 共用）：
 * 拓扑重建 → 多边形裁剪 → 路口聚类 → 生成连接 →
 * 应用 OSM 转向限制 → 合成默认红绿灯两相位方案 → 弯道倒圆 → 校验 & 导出预检。
 */

import type { MultiPolygon, Polygon, Position } from 'geojson'
import type { RoadNetCommandBus } from './command-bus.js'
import { NOTHING_TO_ROUND } from './fillet.js'
import type {
  AsyncRoadNetCore,
  Connection,
  ConnectionRef,
  ExportPrecheck,
  Finding,
  LoadResult,
  RoadNetCommand,
  SignalLink,
  SignalPhaseInput,
  Vertex,
} from './types.js'
import type { OsmTurnRestriction } from '../osm/types.js'

interface ProjectLinkRecord {
  linkId: string
  fromNodeId: string
  toNodeId: string
  shape: Vertex[]
  attributes?: Record<string, string>
}

interface ProjectJunctionRecord {
  junctionId: string
  type: string
  nodeIds: string[]
  connections: Connection[]
  signalPlanId?: string | null
}

interface ProjectSignalPlanRecord {
  signalPlanId: string
  phases: SignalPhaseInput[]
  links?: SignalLink[]
}

interface RawProjectSnapshot {
  links: ProjectLinkRecord[]
  junctions: ProjectJunctionRecord[]
  signalPlans?: ProjectSignalPlanRecord[]
}

export interface RestrictionsApplyReport {
  totalRestrictions: number
  appliedRestrictions: number
  removedConnections: number
  unmatchedRelationIds: string[]
}

export interface SignalsSynthesizeReport {
  signalizedJunctions: number
  synthesizedPlans: number
  skippedEmptyJunctions: number
}

export interface RoadnetPipelineSession {
  core: AsyncRoadNetCore
  bus: RoadNetCommandBus
}

export interface RoadnetPipelineOptions {
  rebuildTopology?: boolean
  clusterJunctions?: boolean
  generateConnections?: boolean
  applyRestrictions?: boolean
  synthesizeSignals?: boolean
  fillet?: boolean
  clipPolygon?: Polygon | MultiPolygon
}

export interface RoadnetPipelineResult {
  summary: LoadResult
  findings: Finding[]
  precheck: ExportPrecheck
  restrictionsReport: RestrictionsApplyReport
  signalsReport: SignalsSynthesizeReport
}

async function runPreapprovedDestructive(bus: RoadNetCommandBus, command: RoadNetCommand): Promise<void> {
  const preview = await bus.preview(command, 'user')
  bus.confirmPreview(preview.previewRef)
  const run = bus.execute.bind(bus)
  await run(command, { previewRef: preview.previewRef })
}

async function readSnapshot(core: AsyncRoadNetCore): Promise<RawProjectSnapshot> {
  return JSON.parse(await core.projectJson()) as RawProjectSnapshot
}

/**
 * 将解析出来的 OSM 转向限制应用到已聚类并生成连接的路口上：
 * - `prohibitory`（no_left_turn / no_u_turn 等）：删除对应的 from->to 连接；
 * - `mandatory`（only_straight_on 等）：删除 fromWayId 驶向非 toWayId 的所有其他出口连接。
 */
export async function applyOsmTurnRestrictions(
  bus: RoadNetCommandBus,
  core: AsyncRoadNetCore,
  restrictions: readonly OsmTurnRestriction[],
): Promise<RestrictionsApplyReport> {
  if (restrictions.length === 0) {
    return { totalRestrictions: 0, appliedRestrictions: 0, removedConnections: 0, unmatchedRelationIds: [] }
  }

  const snapshot = await readSnapshot(core)
  const linkById = new Map<string, ProjectLinkRecord>(snapshot.links.map((l) => [l.linkId, l]))

  // 预先为每个路口索引进入/驶出 link，按 osmWayId 分组
  const junctionInboundWays = new Map<string, Map<string, ProjectLinkRecord[]>>()
  const junctionOutboundWays = new Map<string, Map<string, ProjectLinkRecord[]>>()
  for (const j of snapshot.junctions) {
    const inMap = new Map<string, ProjectLinkRecord[]>()
    const outMap = new Map<string, ProjectLinkRecord[]>()
    for (const c of j.connections) {
      const fromLink = linkById.get(c.fromLinkId)
      const toLink = linkById.get(c.toLinkId)
      if (fromLink) {
        const wayId = fromLink.attributes?.osmWayId
        if (wayId) {
          const list = inMap.get(wayId) ?? []
          if (!list.some((item) => item.linkId === fromLink.linkId)) list.push(fromLink)
          inMap.set(wayId, list)
        }
      }
      if (toLink) {
        const wayId = toLink.attributes?.osmWayId
        if (wayId) {
          const list = outMap.get(wayId) ?? []
          if (!list.some((item) => item.linkId === toLink.linkId)) list.push(toLink)
          outMap.set(wayId, list)
        }
      }
    }
    junctionInboundWays.set(j.junctionId, inMap)
    junctionOutboundWays.set(j.junctionId, outMap)
  }

  const removalsByJunction = new Map<string, Map<string, ConnectionRef>>()
  const unmatchedRelationIds: string[] = []
  let appliedRestrictions = 0

  for (const r of restrictions) {
    // 先找含 viaNodeId 的路口，没有再回退到同时拥有 fromWayId 进口与 toWayId 出口的路口
    const candidates = snapshot.junctions.filter((j) => {
      const inLinks = junctionInboundWays.get(j.junctionId)?.get(r.fromWayId)
      const outLinks = junctionOutboundWays.get(j.junctionId)?.get(r.toWayId)
      return Boolean(inLinks?.length && outLinks?.length)
    })

    const prioritized = r.viaNodeId
      ? candidates.filter((j) => j.nodeIds.includes(r.viaNodeId!))
      : candidates
    const targetJunctions = prioritized.length > 0 ? prioritized : candidates

    if (targetJunctions.length === 0) {
      unmatchedRelationIds.push(r.relationId)
      continue
    }

    let matchedAny = false
    for (const junction of targetJunctions) {
      const inLinks = junctionInboundWays.get(junction.junctionId)?.get(r.fromWayId) ?? []
      const outLinks = junctionOutboundWays.get(junction.junctionId)?.get(r.toWayId) ?? []

      const exactFrom = r.viaNodeId ? inLinks.filter((l) => l.toNodeId === r.viaNodeId) : []
      const exactTo = r.viaNodeId ? outLinks.filter((l) => l.fromNodeId === r.viaNodeId) : []

      const fromSet = new Set((exactFrom.length > 0 ? exactFrom : inLinks).map((l) => l.linkId))
      const toSet = new Set((exactTo.length > 0 ? exactTo : outLinks).map((l) => l.linkId))

      const toRemove = junction.connections.filter((c) => {
        if (!fromSet.has(c.fromLinkId)) return false
        return r.kind === 'prohibitory' ? toSet.has(c.toLinkId) : !toSet.has(c.toLinkId)
      })

      if (toRemove.length > 0) {
        matchedAny = true
        const bucket = removalsByJunction.get(junction.junctionId) ?? new Map<string, ConnectionRef>()
        for (const c of toRemove) {
          const key = `${c.fromLinkId}:${c.fromLane}->${c.toLinkId}:${c.toLane}`
          bucket.set(key, {
            fromLinkId: c.fromLinkId,
            fromLane: c.fromLane,
            toLinkId: c.toLinkId,
            toLane: c.toLane,
          })
        }
        removalsByJunction.set(junction.junctionId, bucket)
      }
    }

    if (matchedAny) appliedRestrictions += 1
    else unmatchedRelationIds.push(r.relationId)
  }

  let removedConnections = 0
  const run = bus.execute.bind(bus)
  for (const [junctionId, bucket] of removalsByJunction) {
    const remove = [...bucket.values()]
    if (remove.length === 0) continue
    await run({ command: 'set_connections', junctionId, remove }, { origin: 'user' })
    removedConnections += remove.length
  }

  return {
    totalRestrictions: restrictions.length,
    appliedRestrictions,
    removedConnections,
    unmatchedRelationIds,
  }
}

function linkApproachAxis(link: ProjectLinkRecord | undefined): 0 | 1 {
  if (!link || link.shape.length < 2) return 0
  const a = link.shape[link.shape.length - 2]
  const b = link.shape[link.shape.length - 1]
  const meanLatRad = (((a.lat + b.lat) / 2) * Math.PI) / 180
  const dx = (b.lon - a.lon) * Math.cos(meanLatRad)
  const dy = b.lat - a.lat
  // 角度折半到 [0, 180) 判断东西向 vs 南北向两对正交相位组
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI
  deg = ((deg % 180) + 180) % 180
  return deg >= 45 && deg < 135 ? 1 : 0
}

function buildStateChar(dir: string): string {
  return dir === 'l' || dir === 't' ? 'g' : 'G'
}

/**
 * 为信号路口生成默认定时两相位方案（先对齐 `sync_signal_phases` 保证 `linkIndex` 与长度严格吻合）。
 */
export async function synthesizeDefaultSignalPlans(
  bus: RoadNetCommandBus,
  core: AsyncRoadNetCore,
): Promise<SignalsSynthesizeReport> {
  const initial = await readSnapshot(core)
  const run = bus.execute.bind(bus)

  const signalJunctions = initial.junctions.filter(
    (j) => Boolean(j.signalPlanId) || j.type === 'traffic_light',
  )
  let synthesizedPlans = 0
  let skippedEmptyJunctions = 0

  for (const j of signalJunctions) {
    if (j.connections.length === 0) {
      skippedEmptyJunctions += 1
      continue
    }
    if (j.signalPlanId) {
      await run({ command: 'sync_signal_phases', junctionId: j.junctionId }, { origin: 'user' })
    }
  }

  const synced = await readSnapshot(core)
  const linkMap = new Map<string, ProjectLinkRecord>(synced.links.map((l) => [l.linkId, l]))
  const planMap = new Map<string, ProjectSignalPlanRecord>(
    (synced.signalPlans ?? []).map((p) => [p.signalPlanId, p]),
  )

  for (const j of synced.junctions) {
    if (!j.signalPlanId && j.type !== 'traffic_light') continue
    if (j.connections.length === 0) continue

    const plan = j.signalPlanId ? planMap.get(j.signalPlanId) : undefined
    const effectiveLinks = plan?.links && plan.links.length > 0 ? plan.links : null
    const needed = effectiveLinks
      ? Math.max(...effectiveLinks.map((l) => l.linkIndex)) + 1
      : j.connections.length

    if (needed <= 0) {
      skippedEmptyJunctions += 1
      continue
    }

    // 建立每个 slot（linkIndex）对应的连接集合（允许信号组共用下标）
    const connLookup = new Map<string, Connection>()
    for (const c of j.connections) {
      connLookup.set(`${c.fromLinkId}:${c.fromLane}->${c.toLinkId}:${c.toLane}`, c)
    }

    const slotConns: Connection[][] = Array.from({ length: needed }, () => [])
    if (effectiveLinks) {
      for (const sl of effectiveLinks) {
        const c = connLookup.get(`${sl.fromLinkId}:${sl.fromLane}->${sl.toLinkId}:${sl.toLane}`)
        if (c && sl.linkIndex < needed) slotConns[sl.linkIndex].push(c)
      }
    } else {
      for (let i = 0; i < j.connections.length; i += 1) {
        slotConns[i].push(j.connections[i])
      }
    }

    const slotAxis: Array<0 | 1> = slotConns.map((group) => {
      const first = group[0]
      return first ? linkApproachAxis(linkMap.get(first.fromLinkId)) : 0
    })

    const hasAxis0 = slotAxis.includes(0)
    const hasAxis1 = slotAxis.includes(1)
    const activeAxes: Array<0 | 1> = []
    if (hasAxis0) activeAxes.push(0)
    if (hasAxis1) activeAxes.push(1)
    if (activeAxes.length === 0) activeAxes.push(0)

    const phases: SignalPhaseInput[] = []
    for (const axis of activeAxes) {
      let green = ''
      let yellow = ''
      for (let slot = 0; slot < needed; slot += 1) {
        if (slotAxis[slot] === axis) {
          const primary = slotConns[slot][0]
          green += buildStateChar(primary?.dir ?? 's')
          yellow += 'y'
        } else {
          green += 'r'
          yellow += 'r'
        }
      }
      phases.push({ durationS: 30, states: green, name: axis === 0 ? 'Axis-EW' : 'Axis-NS' })
      phases.push({ durationS: 3, states: yellow, name: axis === 0 ? 'Axis-EW-Yellow' : 'Axis-NS-Yellow' })
    }

    await run(
      { command: 'set_signal_plan', junctionId: j.junctionId, phases, offsetS: 0 },
      { origin: 'user' },
    )
    synthesizedPlans += 1
  }

  return {
    signalizedJunctions: signalJunctions.length,
    synthesizedPlans,
    skippedEmptyJunctions,
  }
}

function pointInRing(lon: number, lat: number, ring: Position[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-18) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function pointInPolygonCoords(lon: number, lat: number, rings: Position[][]): boolean {
  if (rings.length === 0 || !pointInRing(lon, lat, rings[0])) return false
  for (let i = 1; i < rings.length; i += 1) {
    if (pointInRing(lon, lat, rings[i])) return false
  }
  return true
}

function pointInGeoJsonPolygon(lon: number, lat: number, poly: Polygon | MultiPolygon): boolean {
  if (poly.type === 'Polygon') {
    return pointInPolygonCoords(lon, lat, poly.coordinates)
  }
  return poly.coordinates.some((coords) => pointInPolygonCoords(lon, lat, coords))
}

export async function clipOutsidePolygon(
  bus: RoadNetCommandBus,
  core: AsyncRoadNetCore,
  poly: Polygon | MultiPolygon,
): Promise<void> {
  const snapshot = await readSnapshot(core)
  const outsideIds: string[] = []
  for (const link of snapshot.links) {
    if (link.shape.length === 0) continue
    const mid = link.shape[Math.floor(link.shape.length / 2)]
    const first = link.shape[0]
    const last = link.shape[link.shape.length - 1]
    const anyInside =
      pointInGeoJsonPolygon(mid.lon, mid.lat, poly) ||
      pointInGeoJsonPolygon(first.lon, first.lat, poly) ||
      pointInGeoJsonPolygon(last.lon, last.lat, poly)
    if (!anyInside) outsideIds.push(link.linkId)
  }
  if (outsideIds.length > 0) {
    await runPreapprovedDestructive(bus, {
      command: 'delete_link',
      linkIds: outsideIds,
      withReverse: false,
    })
  }
}

export async function runRoadnetBuildPipeline(
  session: RoadnetPipelineSession,
  restrictions: readonly OsmTurnRestriction[],
  options: RoadnetPipelineOptions = {},
): Promise<RoadnetPipelineResult> {
  const { bus, core } = session

  if (options.rebuildTopology !== false) {
    await runPreapprovedDestructive(bus, { command: 'rebuild_topology' })
  }

  if (options.clipPolygon) {
    await clipOutsidePolygon(bus, core, options.clipPolygon)
  }

  if (options.clusterJunctions !== false) {
    const { delta } = await bus.clusterJunctions()
    if (delta.operations.length > 0) {
      await bus.applyDelta(delta)
    }
  }

  if (options.generateConnections !== false) {
    const snapshot = await readSnapshot(core)
    const run = bus.execute.bind(bus)
    for (const j of snapshot.junctions) {
      await run({ command: 'generate_connections', junctionId: j.junctionId }, { origin: 'user' })
    }
  }

  const restrictionsReport =
    options.applyRestrictions !== false && options.generateConnections !== false
      ? await applyOsmTurnRestrictions(bus, core, restrictions)
      : {
          totalRestrictions: restrictions.length,
          appliedRestrictions: 0,
          removedConnections: 0,
          unmatchedRelationIds: restrictions.map((r) => r.relationId),
        }

  const signalsReport =
    options.synthesizeSignals !== false
      ? await synthesizeDefaultSignalPlans(bus, core)
      : { signalizedJunctions: 0, synthesizedPlans: 0, skippedEmptyJunctions: 0 }

  if (options.fillet !== false) {
    try {
      const run = bus.execute.bind(bus)
      await run({ command: 'fillet_links' }, { origin: 'user' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes(NOTHING_TO_ROUND)) {
        throw err
      }
    }
  }

  const [findings, precheck, summary] = await Promise.all([
    core.validate(),
    bus.precheckExport('sumo', '1.27'),
    core.summary(),
  ])

  return { summary, findings, precheck, restrictionsReport, signalsReport }
}
