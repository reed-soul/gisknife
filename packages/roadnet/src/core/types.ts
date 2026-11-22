/**
 * 路网编辑器的核心类型契约，与 Rust/WASM 内核 `roadnet-core` 的 JSON 结构一一对应。
 * 纯同构声明，不含任何 I/O 或浏览器存储依赖（可安全用于 Node CLI、SSR、Worker、浏览器）。
 */

/** 模型契约版本；与内核 `SCHEMA_VERSION` 保持一致。 */
export const ROADNET_SCHEMA_VERSION = 'sutpc.roadnet-project.v1'

export interface Vertex {
  lon: number
  lat: number
  z?: number
}

export type NodeKind = 'plain' | 'junction' | 'dead_end' | 'rail_crossing'

export type TurnDir = 's' | 'l' | 'r' | 't'

export type ConnectionOrigin = 'generated' | 'manual' | 'imported'

export type JunctionType =
  | 'priority'
  | 'traffic_light'
  | 'right_before_left'
  | 'roundabout'
  | 'zipper'

export type Severity = 'blocking' | 'warning'

/** 校验结果。 */
export interface Finding {
  ruleId: string
  severity: Severity
  /** 形如 `link:e1`、`node:n2`、`junction:j_c`。 */
  targetRef: string
  observed: string
  expected: string
  evidence?: string[]
  /** 被人工忽略（带理由，记在项目的 ignoredFindings 里）；仍然列出来，只是不计入阻断。 */
  ignored?: boolean
}

/** 一次命令产生的增量；前端据此局部更新图层与变更集。 */
export interface Delta {
  command: string
  operations: unknown[]
  notes?: string[]
}

export interface CommandResult {
  delta: Delta
  revision: number
  /** 受影响对象的引用，用于脏区域重绘与复校。 */
  touched: string[]
  /** 车道级几何重算用的引用。 */
  geometryRefs?: string[]
  findings: Finding[]
  /** `findings` 覆盖的对象。 */
  validationRefs?: string[]
  /** 破坏性命令：智能体调用必须带用户确认过的 previewRef。 */
  destructive: boolean
  /** 新内核随修改返回规模计数。 */
  projectStats?: Pick<LoadResult, 'nodes' | 'links' | 'junctions' | 'signalPlans'>
}

export interface LoadResult {
  projectId: string
  revision: number
  nodes: number
  links: number
  junctions: number
  signalPlans: number
  computeCrs: string
  blockingFindings: number
  warningFindings: number
}

export type FilterOperator = 'EQ' | 'NE' | 'LT' | 'LTE' | 'GT' | 'GTE' | 'IN' | 'IS_NULL' | 'CONTAINS'

export type FilterField =
  | 'linkId'
  | 'name'
  | 'roadClass'
  | 'oneway'
  | 'speedKph'
  | 'priority'
  | 'layer'
  | 'bridge'
  | 'tunnel'
  | 'laneCount'
  | 'fromNodeId'
  | 'toNodeId'
  | 'provenanceSource'
  | 'attribute'

export type FilterValue = string | number | boolean

export interface FilterClause {
  field: FilterField
  op: FilterOperator
  value?: FilterValue
  /** IN 用的候选集合。 */
  values?: FilterValue[]
  /** field 为 attribute 时必填。 */
  attributeKey?: string
}

export interface LinkFilter {
  all?: FilterClause[]
  any?: FilterClause[]
  /** 一次批量编辑的命中上限，默认 2000。 */
  limit?: number
}

export interface FilterResult {
  linkIds: string[]
  matched: number
  scanned: number
  /** 超限时 linkIds 为空，必须收紧条件后重试。 */
  overLimit: boolean
  limit: number
}

/** 导出前的语义损失预检。 */
export interface LossItem {
  aspect: string
  detail: string
  count: number
}

export interface ExportPrecheck {
  target: string
  version: string
  links: number
  nodes: number
  junctions: number
  connections: number
  provenance: string
  losses: LossItem[]
  openReviewItems: number
}

export interface PlainXml {
  nod: string
  edg: string
  con: string
  tll: string
  /** 检测器（SUMO additional）；没有检测器时内核不给这一项。 */
  det?: string
}

/** 恢复元数据（纯结构契约，不耦合特定存储实现）。 */
export interface RecoveryMeta {
  key: string
  projectId: string
  revision: number
  savedAtMs: number
  coreVersion?: string
  sourceDigest?: string
}

/** 内核的构建变体：`wasm32` 每个实例最多 4 GiB，`memory64` 最多 16 GiB。 */
export type CoreVariant = 'wasm32' | 'memory64'

/** 内核占了多少内存。 */
export interface CoreMemoryInfo {
  variant: CoreVariant
  linearBytes: number
  liveBytes: number | null
  peakBytes: number | null
  allocFailures: number
}

/** 内核返回的错误；调用方按 code 分支处理，不解析文案。 */
export interface RoadNetErrorPayload {
  code: string
  message: string
  memory?: CoreMemoryInfo
  diagnostics?: Record<string, unknown>
}

export class RoadNetError extends Error {
  readonly code: string
  readonly memory?: CoreMemoryInfo
  readonly diagnostics?: Record<string, unknown>

  constructor(payload: RoadNetErrorPayload) {
    super(payload.message)
    this.name = 'RoadNetError'
    this.code = payload.code
    this.memory = payload.memory
    this.diagnostics = payload.diagnostics
  }

  /** 内核经 WASM 抛出的是 JSON 字符串，这里还原成带 code 的错误。 */
  static from(raw: unknown): RoadNetError {
    if (raw instanceof RoadNetError) return raw
    const text = typeof raw === 'string' ? raw : (raw as Error)?.message ?? String(raw)
    try {
      const parsed = JSON.parse(text) as RoadNetErrorPayload
      if (parsed && typeof parsed.code === 'string') return new RoadNetError(parsed)
    } catch {
      // 不是 JSON，按未知错误处理
    }
    return new RoadNetError({ code: 'CORE_FAILED', message: text })
  }
}

export type SplitAt = { point: { lon: number; lat: number } } | { distance: { sM: number } }

export type VertexEdit =
  | { move: { index: number; lon: number; lat: number } }
  | { insert: { index: number; lon: number; lat: number } }
  | { delete: { index: number } }

export type GeometryOp =
  | { simplify: { toleranceM: number } }
  | { smooth: { iterations: number } }
  | { fillet: { radiusM?: number; toleranceM?: number } }
  | 'straighten'
  | 'reverse'

export interface AttributePatch {
  roadClass?: string
  name?: string
  oneway?: boolean
  speedKph?: number
  priority?: number
  layer?: number
  bridge?: boolean
  tunnel?: boolean
  laneCount?: number
  provenanceSource?: string
  endOffsetM?: number
  minSpeedKph?: number
}

export interface LanePatch {
  widthM?: number
  laneType?: string
  turnMarks?: string[]
  allow?: string[]
  disallow?: string[]
  speedKph?: number
  changeLeft?: string
  changeRight?: string
}

export interface LinkStation {
  sM: number
  lengthM: number
  offsetM: number
}

export type LaneSide = 'right' | 'left'

/** 命令；与内核 `session::Command` 的 JSON 表示一致。 */
export type RoadNetCommand =
  | { command: 'rebuild_topology'; options?: Record<string, unknown> }
  | { command: 'split_link'; linkId: string; at: SplitAt }
  | { command: 'merge_links'; linkIds: string[] }
  | { command: 'edit_vertex'; linkId: string; edit: VertexEdit }
  | { command: 'geometry_op'; linkId: string; op: GeometryOp }
  | { command: 'fillet_links'; linkIds?: string[]; radiusM?: number; toleranceM?: number }
  | {
      command: 'set_attributes'
      linkIds?: string[]
      filter?: LinkFilter
      patch: AttributePatch
    }
  | {
      command: 'set_lane'
      linkId: string
      sectionIndex: number
      laneIndex: number
      patch: LanePatch
    }
  | { command: 'join_junction'; nodeIds: string[]; options?: Record<string, unknown> }
  | { command: 'split_junction'; junctionId: string }
  | { command: 'generate_connections'; junctionId: string; policy?: Record<string, unknown> }
  | { command: 'sync_signal_phases'; junctionId: string }
  | {
      command: 'add_crosswalk'
      junctionId: string
      crosswalkId: string
      linkIds: string[]
      widthM?: number
      priority?: boolean
    }
  | { command: 'remove_crosswalk'; junctionId: string; crosswalkId: string }
  | {
      command: 'create_link'
      coords: Vertex[]
      linkId?: string
      attributes?: AttributePatch
      twoWay?: boolean
      snapM?: number
      laneCount?: number
      laneWidthM?: number
    }
  | { command: 'delete_link'; linkIds: string[]; withReverse?: boolean }
  | {
      command: 'snap_endpoint'
      linkId: string
      end: 'from' | 'to'
      target: { node: { nodeId: string } } | { link: { linkId: string; lon: number; lat: number } }
    }
  | { command: 'set_lane_count'; linkId: string; sectionIndex?: number; laneCount: number }
  | {
      command: 'insert_lane'
      linkId: string
      section?: number
      at: number
      lane?: LanePatch
    }
  | { command: 'delete_lane'; linkId: string; section?: number; lane: number }
  | {
      command: 'split_lane_section'
      linkId: string
      sM: number
      laneCount: number
      side: LaneSide
      transitionM?: number
    }
  | { command: 'remove_lane_section'; linkId: string; section: number }
  | {
      command: 'set_lane_section'
      linkId: string
      section: number
      sOffsetM?: number
      transitionM?: number
    }
  | {
      command: 'set_connections'
      junctionId: string
      add?: ConnectionRef[]
      remove?: ConnectionRef[]
    }
  | ({ command: 'add_detector' } & AddDetectorParams)
  | { command: 'update_detector'; detectorId: string; patch: DetectorPatch }
  | { command: 'remove_detector'; detectorIds: string[] }
  | {
      command: 'set_connection_shape'
      junctionId: string
      connection: ConnectionRef
      shape?: Vertex[]
    }
  | {
      command: 'set_signal_plan'
      junctionId: string
      phases: SignalPhaseInput[]
      offsetS?: number
    }
  | { command: 'ignore_finding'; ruleId: string; targetRef: string; reason: string }
  | { command: 'unignore_finding'; ruleId: string; targetRef: string }
  | { command: 'import_review_items'; items: ReviewItem[] }
  | {
      command: 'decide_review'
      itemId: string
      decision: 'accept' | 'modify' | 'reject'
      value?: number
      decidedBy?: string
    }

export const ALWAYS_DESTRUCTIVE_COMMANDS: ReadonlySet<RoadNetCommand['command']> = new Set([
  'rebuild_topology',
  'merge_links',
  'join_junction',
  'split_junction',
  'delete_link',
  'delete_lane',
  'remove_lane_section',
])

export const BULK_ATTRIBUTE_LIMIT = 50

export function isDestructive(command: RoadNetCommand): boolean {
  if (ALWAYS_DESTRUCTIVE_COMMANDS.has(command.command)) return true
  if (command.command === 'set_attributes') {
    return Boolean(command.filter) || (command.linkIds?.length ?? 0) > BULK_ATTRIBUTE_LIMIT
  }
  return false
}

export interface ConnectionRef {
  fromLinkId: string
  fromLane: number
  toLinkId: string
  toLane: number
}

export type LaneTargetStatus = 'connected' | 'free' | 'conflict'

export interface LaneTarget {
  endRef: string
  linkId: string
  lane: number
  status: LaneTargetStatus
  dir: string
}

export interface SignalPhaseInput {
  durationS: number
  states: string
  minDurS?: number
  maxDurS?: number
  name?: string
}

export interface SignalLink {
  fromLinkId: string
  fromLane: number
  toLinkId: string
  toLane: number
  linkIndex: number
}

export type ReviewKind = 'lane_count' | 'junction_join' | 'connection' | 'topology'
export type ReviewStatus = 'open' | 'accepted' | 'rejected'

export interface ReviewItem {
  itemId: string
  targetRef: string
  kind: ReviewKind
  proposal?: string
  evidence?: string[]
  status?: ReviewStatus
  decidedBy?: string
}

export interface ChangeSetMeta {
  author: 'user' | 'agent'
  approvedBy?: string
  createdAtMs?: number
  note?: string
}

export interface FeatureDelta {
  upsert: GeoJsonFeature[]
  remove: string[]
}

export interface Lane {
  index: number
  widthM: number
  type: string
  turnMarks?: string[]
  allow?: string[]
  disallow?: string[]
  speedKph?: number
  changeLeft?: string
  changeRight?: string
}

export interface LaneSection {
  sOffsetM: number
  lanes: Lane[]
  transitionM?: number
  slotOffset?: number
}

export interface Connection {
  fromLinkId: string
  fromLane: number
  toLinkId: string
  toLane: number
  dir: string
  pass?: boolean
  origin: 'generated' | 'manual' | 'imported'
  shape?: Vertex[]
}

export interface Crosswalk {
  crosswalkId: string
  linkIds: string[]
  widthM: number
  priority: boolean
}

export interface SignalPlan {
  signalPlanId: string
  junctionId: string
  phases: SignalPhaseInput[]
  offsetS: number
  kind?: string
  programId?: string
  links?: SignalLink[]
}

export interface Provenance {
  source?: string
  confidence?: number
  note?: string
}

export interface LinkDetail {
  kind: 'link'
  linkId: string
  fromNodeId: string
  toNodeId: string
  name: string | null
  roadClass: string | null
  oneway: boolean
  speedKph: number | null
  priority: number | null
  layer: number
  bridge: boolean
  tunnel: boolean
  reverseLinkId: string | null
  laneCount: number
  lengthM: number
  vertices: number
  laneSections: LaneSection[]
  provenance: Provenance
  endOffsetM: number
  spreadType: 'right' | 'center' | 'roadCenter'
  minSpeedKph: number | null
  laneConnections: { fromLanes: number[]; toLanes: number[] }
}

export interface NodeDetail {
  kind: 'node'
  nodeId: string
  lon: number
  lat: number
  nodeKind: string
  junctionId: string | null
  signalPlanId: string | null
  incoming: string[]
  outgoing: string[]
  provenance: Provenance
}

export interface ApproachLink {
  linkId: string
  name: string | null
  roadClass: string | null
  laneCount: number
}

export interface JunctionDetail {
  kind: 'junction'
  junctionId: string
  type: string
  nodeIds: string[]
  incoming: ApproachLink[]
  outgoing: ApproachLink[]
  connections: Connection[]
  crosswalks: Crosswalk[]
  signalPlanId: string | null
  signalPlan: SignalPlan | null
}

export type DetectorKind = 'e1' | 'e2'

export interface AddDetectorParams {
  kind: DetectorKind
  linkId: string
  lane: number
  posM: number
  lengthM?: number
  periodS?: number
  name?: string
  detectorId?: string
}

export interface DetectorPatch {
  lane?: number
  posM?: number
  lengthM?: number
  periodS?: number
  name?: string
}

export interface DetectorDetail {
  kind: 'detector'
  detectorId: string
  detectorKind: DetectorKind
  linkId: string
  lane: number
  posM: number
  lengthM: number | null
  periodS: number
  name: string | null
  linkLengthM: number
  lanesHere: number
  linkName: string | null
}

export type ObjectDetail = LinkDetail | NodeDetail | JunctionDetail | DetectorDetail

export interface GeoJsonFeature {
  type: 'Feature'
  id: string
  geometry: unknown
  properties: Record<string, unknown>
}

export const LANE_LAYER_NAMES = [
  'lanes',
  'markings',
  'stopLines',
  'arrows',
  'connectors',
  'junctionSurfaces',
  'detectors',
] as const

export type LaneLayerName = (typeof LANE_LAYER_NAMES)[number]

export interface LaneLayerPayload {
  fingerprints?: Partial<Record<LaneLayerName, Record<string, string>>>
  full: boolean
  truncated?: boolean
  owners: string[]
  collections?: Partial<Record<LaneLayerName, string>>
  features?: Partial<Record<LaneLayerName, GeoJsonFeature[]>>
  index: Record<LaneLayerName, Record<string, string[]>>
  featureCount: number
}

export interface BaseLayerQuery {
  outer: [number, number, number, number]
  inner: [number, number, number, number]
  includeNodes: boolean
  maxLinks: number
  maxVertices: number
}

export interface ProjectExtent {
  projectId: string
  revision: number
  nodes: number
  links: number
  junctions: number
  signalPlans: number
  vertices: number
  extent: [number, number, number, number] | null
  computeCrs: string
}

export interface IncrementalFeatures {
  links: FeatureDelta
  nodes: FeatureDelta
  junctions: FeatureDelta
  connections: FeatureDelta
}

export interface RoadNetCoreHandle {
  writeExport?(kind: string, sink: { write(bytes: Uint8Array): void }): void
  latestChangeSet?(): string
  restoreEntry?(entryJson: string): void
  summary(): string
  exportGeoJson(layer?: string | null): string
  precheckExport(target: string, version: string): string
  selectLinks(filterJson: string): string
  projectJson(): string
  preview(commandJson: string): string
  execute(commandJson: string): string
  undo(): string | undefined
  redo(): string | undefined
  validate(scopeJson?: string | null): string
  checkExport(target: string, version: string): string
  previewRebuild(optionsJson?: string | null): string
  clusterJunctions(optionsJson?: string | null): string
  applyDelta(deltaJson: string): void
  exportPlainXml(): string
  changeSets(): string
  version(): string
  executeWithMeta(commandJson: string, metaJson: string): string
  featuresFor(refsJson: string): string
  connectionFeatures(junctionId: string): string
  objectDetail(reference: string): string
  reviewItems(): string
  laneLayers(refsJson: string): string
  laneLayersInBbox(west: number, south: number, east: number, north: number): string
  baseLayersInBbox(queryJson: string): Uint8Array
  revision?(): string
  stats(): string
  laneEnds(junctionId: string): string
  linkStation(linkId: string, lon: number, lat: number): string
  laneTargets(junctionId: string, fromLinkId: string, fromLane: number): string
  connectionFoes(junctionId: string, connectionJson: string): string
  netReference(netXml: string): string
  free?(): void
}

export interface AsyncRoadNetCore {
  exportRevision?(file: File): number | undefined
  releaseExports?(files: File[]): Promise<void>
  exportFiles?(kind: 'project' | 'plain' | 'geojson', maxBytes?: number): Promise<File[]>
  recoveryHistory?(): Promise<{ history: TimelineEntry[]; cursor: number }>
  recoveryInfo?(): Promise<RecoveryMeta | null>
  recoveryDrafts?(): Promise<RecoveryMeta[]>
  discardRecovery?(key: string): Promise<void>
  summary(): Promise<LoadResult>
  projectJson(): Promise<string>
  version(): Promise<Record<string, unknown>>
  preview(command: RoadNetCommand): Promise<CommandResult>
  execute(command: RoadNetCommand, meta?: ChangeSetMeta): Promise<CommandResult>
  undo(): Promise<CommandResult | null>
  redo(): Promise<CommandResult | null>
  validate(targets?: string[]): Promise<Finding[]>
  checkExport(target: string, version: string): Promise<Finding[]>
  previewRebuild(options?: Record<string, unknown>): Promise<{ delta: Delta; report: unknown }>
  clusterJunctions(options?: Record<string, unknown>): Promise<{ delta: Delta; report: unknown }>
  applyDelta(delta: Delta): Promise<void>
  exportPlainXml(): Promise<PlainXml>
  exportGeoJson(layer?: string): Promise<unknown>
  precheckExport(target: string, version?: string): Promise<ExportPrecheck>
  selectLinks(filter: LinkFilter): Promise<FilterResult>
  changeSets(): Promise<unknown[]>
  featuresFor(refs: string[]): Promise<IncrementalFeatures>
  connectionFeatures(junctionId: string): Promise<GeoJsonFeature[]>
  objectDetail(reference: string): Promise<ObjectDetail | null>
  reviewItems(): Promise<ReviewItem[]>
  laneLayers(refs?: string[]): Promise<LaneLayerPayload>
  laneLayersInBbox(bbox: [number, number, number, number]): Promise<LaneLayerPayload>
  memoryInfo(): Promise<CoreMemoryInfo>
  baseLayersInBbox(query: BaseLayerQuery): Promise<ArrayBuffer>
  revision?(): Promise<number>
  stats(): Promise<ProjectExtent>
  laneEnds(junctionId: string): Promise<GeoJsonFeature[]>
  linkStation(linkId: string, lon: number, lat: number): Promise<LinkStation | null>
  laneTargets(junctionId: string, fromLinkId: string, fromLane: number): Promise<LaneTarget[]>
  connectionFoes(junctionId: string, connection: ConnectionRef): Promise<string[]>
  netReference(netXml: string): Promise<{ type: 'FeatureCollection'; features: GeoJsonFeature[] }>
  dispose(): Promise<void>
}

export interface TimelineEntry {
  command: string
  baseRevision: number
  touched: number
  notes: string[]
  author: ChangeSetMeta['author']
  approvedBy?: string
  createdAtMs: number
}
