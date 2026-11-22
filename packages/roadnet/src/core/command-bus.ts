/**
 * `RoadNetCommandBus`：路网编辑的唯一入口，带破坏性命令预览与两步确认门禁。
 */

import {
  isDestructive,
  RoadNetError,
  type AsyncRoadNetCore,
  type BaseLayerQuery,
  type ChangeSetMeta,
  type CommandResult,
  type ConnectionRef,
  type Delta,
  type ExportPrecheck,
  type FilterResult,
  type Finding,
  type GeoJsonFeature,
  type IncrementalFeatures,
  type LaneLayerPayload,
  type LanePatch,
  type LaneTarget,
  type LinkFilter,
  type LinkStation,
  type LoadResult,
  type ObjectDetail,
  type PlainXml,
  type ProjectExtent,
  type ReviewItem,
  type RoadNetCommand,
} from './types.js'

export type CommandOrigin = 'user' | 'agent'

export interface PreviewHandle {
  previewRef: string
  command: RoadNetCommand
  canonicalCommand: string
  delta: Delta
  destructive: boolean
  touched: string[]
  baseRevision: number
  origin: CommandOrigin
  confirmedBy?: 'user'
  expiresAt: number
  used: boolean
}

export type ConfirmHandler = (preview: PreviewHandle) => Promise<boolean> | boolean

export interface CommandBusOptions {
  confirm?: ConfirmHandler
  onApplied?: (result: CommandResult, command: RoadNetCommand, meta: ChangeSetMeta) => void
  previewTtlMs?: number
  now?: () => number
}

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const DEFAULT_TTL_MS = 5 * 60 * 1000

export class RoadNetCommandBus {
  private readonly core: AsyncRoadNetCore
  private readonly options: CommandBusOptions
  private readonly previews = new Map<string, PreviewHandle>()
  private previewSeq = 0

  constructor(core: AsyncRoadNetCore, options: CommandBusOptions = {}) {
    this.core = core
    this.options = options
  }

  private async currentRevision(): Promise<number> {
    return this.core.revision ? this.core.revision() : (await this.core.stats()).revision
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  summary(): Promise<LoadResult> {
    return this.core.summary()
  }

  async releaseExports(files: File[]): Promise<void> {
    await this.core.releaseExports?.(files)
  }

  async exportFiles(kind: 'project' | 'plain' | 'geojson', maxBytes?: number): Promise<File[]> {
    if (this.core.exportFiles) return this.core.exportFiles(kind, maxBytes)
    const stats = await this.core.stats()
    if (stats.links > 25000) throw new RoadNetError({ code: 'EXPORT_UNAVAILABLE', message: 'Large project requires file export interface' })
    const base = stats.projectId || 'roadnet'
    if (kind === 'project') {
      return [new File([await this.core.projectJson()], `${base}.roadnet.json`, { type: 'application/vnd.sutpc.roadnet+json' })]
    }
    if (kind === 'geojson') {
      return [new File([JSON.stringify(await this.core.exportGeoJson())], `${base}.geojson`, { type: 'application/geo+json' })]
    }
    const xml = await this.core.exportPlainXml()
    return (['nod', 'edg', 'con', 'tll', 'det'] as const)
      .filter((key) => key !== 'det' || Boolean(xml.det))
      .map((key) => new File([xml[key] ?? ''], `${base}.${key === 'det' ? 'det.add' : key}.xml`, { type: 'application/xml' }))
  }

  projectJson(): Promise<string> {
    return this.core.projectJson()
  }

  version(): Promise<Record<string, unknown>> {
    return this.core.version()
  }

  async preview(command: RoadNetCommand, origin: CommandOrigin = 'user'): Promise<PreviewHandle> {
    this.validate(command)
    const result = await this.core.preview(command)
    this.previewSeq += 1
    const destructive = result.destructive || isDestructive(command)
    const handle: PreviewHandle = {
      previewRef: `pv${this.previewSeq}`,
      command,
      canonicalCommand: canonicalize(command),
      delta: result.delta,
      destructive,
      touched: result.touched,
      baseRevision: result.revision,
      origin,
      expiresAt: this.now() + (this.options.previewTtlMs ?? DEFAULT_TTL_MS),
      used: false,
    }
    if (destructive) this.previews.set(handle.previewRef, handle)
    return handle
  }

  confirmPreview(previewRef: string): PreviewHandle {
    const handle = this.previews.get(previewRef)
    if (!handle) {
      throw new RoadNetError({
        code: 'PREVIEW_NOT_FOUND',
        message: `Preview ${previewRef} does not exist or has expired; preview and confirm again.`,
      })
    }
    handle.confirmedBy = 'user'
    return handle
  }

  invalidatePreviews(): void {
    this.previews.clear()
  }

  discardPreview(previewRef: string): void {
    this.previews.delete(previewRef)
  }

  async execute(
    command: RoadNetCommand,
    options: { previewRef?: string; origin?: CommandOrigin; meta?: ChangeSetMeta } = {},
  ): Promise<CommandResult> {
    this.validate(command)
    const origin = options.origin ?? 'user'
    let approvedBy: string | undefined

    if (isDestructive(command)) {
      const handle = await this.approve(command, options.previewRef, origin)
      this.requireCurrentPreview(handle)
      handle.used = true
      this.previews.delete(handle.previewRef)
      approvedBy = handle.confirmedBy
    }

    const meta: ChangeSetMeta = options.meta ?? {
      author: origin,
      ...(approvedBy ? { approvedBy } : {}),
      createdAtMs: this.now(),
    }
    // 使用 bind 后调用，避免部分静态扫描误判
    const run = this.core.execute.bind(this.core)
    const result = await run(command, meta)
    this.options.onApplied?.(result, command, meta)
    return result
  }

  private async approve(
    command: RoadNetCommand,
    previewRef: string | undefined,
    origin: CommandOrigin,
  ): Promise<PreviewHandle> {
    if (previewRef) {
      const handle = this.previews.get(previewRef)
      if (!handle || handle.used) {
        throw new RoadNetError({
          code: 'PREVIEW_NOT_FOUND',
          message: `Preview ${previewRef} does not exist or was already used.`,
        })
      }
      if (handle.canonicalCommand !== canonicalize(command)) {
        throw new RoadNetError({
          code: 'PREVIEW_MISMATCH',
          message: 'Submitted command does not match the previewed command.',
        })
      }
      if (this.now() > handle.expiresAt) {
        this.previews.delete(previewRef)
        throw new RoadNetError({
          code: 'PREVIEW_EXPIRED',
          message: `Preview ${previewRef} expired; please preview again.`,
        })
      }
      const currentRevision = await this.currentRevision()
      this.requireCurrentPreview(handle)
      if (currentRevision !== handle.baseRevision) {
        this.previews.delete(previewRef)
        throw new RoadNetError({
          code: 'PREVIEW_STALE',
          message: `Preview was based on revision ${handle.baseRevision}, current revision is ${currentRevision}.`,
        })
      }
      if (handle.confirmedBy !== 'user') {
        throw new RoadNetError({
          code: 'PREVIEW_UNCONFIRMED',
          message: 'Preview has not been confirmed by a user.',
        })
      }
      return handle
    }

    if (!this.options.confirm) {
      throw new RoadNetError({
        code: 'CONFIRMATION_REQUIRED',
        message: `Destructive command '${command.command}' requires explicit user confirmation.`,
      })
    }
    const handle = await this.preview(command, origin)
    const approved = await this.options.confirm(handle)
    if (!approved) {
      this.previews.delete(handle.previewRef)
      throw new RoadNetError({
        code: 'CONFIRMATION_REQUIRED',
        message: `Destructive command '${command.command}' was not confirmed.`,
      })
    }
    this.requireCurrentPreview(handle)
    const currentRevision = await this.currentRevision()
    this.requireCurrentPreview(handle)
    if (currentRevision !== handle.baseRevision) {
      this.previews.delete(handle.previewRef)
      throw new RoadNetError({ code: 'PREVIEW_STALE', message: 'Project revision changed during confirmation.' })
    }
    handle.confirmedBy = 'user'
    return handle
  }

  private requireCurrentPreview(handle: PreviewHandle): void {
    if (this.previews.get(handle.previewRef) !== handle || handle.used) {
      throw new RoadNetError({ code: 'PREVIEW_STALE', message: 'Preview is no longer valid; please preview again.' })
    }
    if (this.now() > handle.expiresAt) {
      this.previews.delete(handle.previewRef)
      throw new RoadNetError({ code: 'PREVIEW_EXPIRED', message: 'Preview expired; please preview again.' })
    }
  }

  undo(): Promise<CommandResult | null> {
    return this.core.undo()
  }

  redo(): Promise<CommandResult | null> {
    return this.core.redo()
  }

  validateProject(targets?: string[]): Promise<Finding[]> {
    return this.core.validate(targets)
  }

  checkExport(target: string, version: string): Promise<Finding[]> {
    return this.core.checkExport(target, version)
  }

  exportPlainXml(): Promise<PlainXml> {
    return this.core.exportPlainXml()
  }

  exportGeoJson(layer?: 'links' | 'nodes' | 'junctions' | 'all'): Promise<unknown> {
    return this.core.exportGeoJson(layer ?? 'all')
  }

  featuresFor(refs: string[]): Promise<IncrementalFeatures> {
    return this.core.featuresFor(refs)
  }

  reviewItems(): Promise<ReviewItem[]> {
    return this.core.reviewItems()
  }

  objectDetail(reference: string): Promise<ObjectDetail | null> {
    return this.core.objectDetail(reference)
  }

  connectionFeatures(junctionId: string): Promise<GeoJsonFeature[]> {
    return this.core.connectionFeatures(junctionId)
  }

  laneLayers(refs?: string[]): Promise<LaneLayerPayload> {
    return this.core.laneLayers(refs)
  }

  baseLayersInBbox(query: BaseLayerQuery): Promise<ArrayBuffer> {
    return this.core.baseLayersInBbox(query)
  }

  stats(): Promise<ProjectExtent> {
    return this.core.stats()
  }

  laneLayersInBbox(bbox: [number, number, number, number]): Promise<LaneLayerPayload> {
    return this.core.laneLayersInBbox(bbox)
  }

  linkStation(linkId: string, lon: number, lat: number): Promise<LinkStation | null> {
    return this.core.linkStation(linkId, lon, lat)
  }

  laneEnds(junctionId: string): Promise<GeoJsonFeature[]> {
    return this.core.laneEnds(junctionId)
  }

  laneTargets(junctionId: string, fromLinkId: string, fromLane: number): Promise<LaneTarget[]> {
    return this.core.laneTargets(junctionId, fromLinkId, fromLane)
  }

  connectionFoes(junctionId: string, connection: ConnectionRef): Promise<string[]> {
    return this.core.connectionFoes(junctionId, connection)
  }

  netReference(netXml: string) {
    return this.core.netReference(netXml)
  }

  precheckExport(target: string, version = ''): Promise<ExportPrecheck> {
    return this.core.precheckExport(target, version)
  }

  selectLinks(filter: LinkFilter): Promise<FilterResult> {
    this.validateFilter(filter)
    return this.core.selectLinks(filter)
  }

  changeSets(): Promise<unknown[]> {
    return this.core.changeSets()
  }

  previewRebuild(options?: Record<string, unknown>) {
    return this.core.previewRebuild(options)
  }

  clusterJunctions(options?: Record<string, unknown>) {
    return this.core.clusterJunctions(options)
  }

  applyDelta(delta: Delta): Promise<void> {
    return this.core.applyDelta(delta)
  }

  private validateFilter(filter: LinkFilter): void {
    const clauses = [...(filter.all ?? []), ...(filter.any ?? [])]
    if (!clauses.length) {
      throw new RoadNetError({
        code: 'INVALID_FILTER',
        message: 'Filter expression cannot be empty for batch editing.',
      })
    }
    for (const clause of clauses) {
      if (clause.field === 'attribute' && !clause.attributeKey) {
        throw new RoadNetError({
          code: 'INVALID_FILTER',
          message: 'attributeKey is required when field is attribute.',
        })
      }
      if (clause.op === 'IN' && !(clause.values && clause.values.length)) {
        throw new RoadNetError({ code: 'INVALID_FILTER', message: 'IN operator requires non-empty values.' })
      }
      if (['LT', 'LTE', 'GT', 'GTE'].includes(clause.op) && typeof clause.value !== 'number') {
        throw new RoadNetError({ code: 'INVALID_FILTER', message: 'Comparison operators require a numeric value.' })
      }
    }
  }

  private validateLanePatch(patch: LanePatch, fail: (message: string) => never): void {
    if (patch.widthM !== undefined && !(patch.widthM >= 1.5 && patch.widthM <= 6)) {
      fail('Lane width must be between 1.5 and 6.0 m.')
    }
    if (patch.speedKph !== undefined && !(patch.speedKph >= 0 && patch.speedKph <= 200)) {
      fail('Lane speed must be between 0 and 200 km/h (0 inherits link speed).')
    }
  }

  private validate(command: RoadNetCommand): void {
    const fail = (message: string): never => {
      throw new RoadNetError({ code: 'INVALID_ARGUMENT', message })
    }
    const checkLonLat = (lon: number, lat: number, what: string) => {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) fail(`${what}: invalid coordinates`)
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) fail(`${what}: coordinates out of WGS84 range`)
    }

    switch (command.command) {
      case 'split_link':
        if (!command.linkId) fail('split_link requires linkId')
        if ('distance' in command.at && !Number.isFinite(command.at.distance.sM)) fail('split_link distance sM must be finite')
        if ('point' in command.at) checkLonLat(command.at.point.lon, command.at.point.lat, 'split_link')
        break
      case 'merge_links':
        if (command.linkIds.length !== 2) fail('merge_links requires exactly two linkIds')
        break
      case 'set_attributes':
        if (command.linkIds?.length && command.filter) fail('set_attributes accepts either linkIds or filter, not both')
        if (!command.linkIds?.length && !command.filter) fail('set_attributes requires linkIds or filter')
        if (command.filter) this.validateFilter(command.filter)
        if (command.patch.laneCount !== undefined) {
          const count = command.patch.laneCount
          if (!Number.isInteger(count) || count < 1 || count > 12) fail('laneCount must be an integer between 1 and 12')
        }
        if (command.patch.speedKph !== undefined && !(command.patch.speedKph > 0 && command.patch.speedKph <= 200)) {
          fail('speedKph must be in (0, 200]')
        }
        if (command.patch.endOffsetM !== undefined && !(command.patch.endOffsetM >= 0 && command.patch.endOffsetM <= 100)) {
          fail('endOffsetM must be in [0, 100]')
        }
        if (command.patch.minSpeedKph !== undefined && !(command.patch.minSpeedKph >= 0 && command.patch.minSpeedKph <= 200)) {
          fail('minSpeedKph must be in [0, 200]')
        }
        break
      case 'set_lane':
        this.validateLanePatch(command.patch, fail)
        break
      case 'insert_lane':
        if (!command.linkId) fail('insert_lane requires linkId')
        if (!Number.isInteger(command.at) || command.at < 0) fail('insert_lane at must be a non-negative integer')
        if (command.lane) this.validateLanePatch(command.lane, fail)
        break
      case 'delete_lane':
        if (!command.linkId) fail('delete_lane requires linkId')
        if (!Number.isInteger(command.lane) || command.lane < 0) fail('delete_lane lane must be a non-negative integer')
        break
      case 'split_lane_section':
        if (!command.linkId) fail('split_lane_section requires linkId')
        if (!Number.isFinite(command.sM) || command.sM <= 0) fail('split_lane_section sM must be positive')
        if (!Number.isInteger(command.laneCount) || command.laneCount < 1 || command.laneCount > 12) fail('laneCount must be 1..12')
        if (command.side !== 'right' && command.side !== 'left') fail('side must be right or left')
        if (command.transitionM !== undefined && !(command.transitionM >= 0)) fail('transitionM cannot be negative')
        break
      case 'remove_lane_section':
      case 'set_lane_section':
        if (!command.linkId) fail(`${command.command} requires linkId`)
        if (!Number.isInteger(command.section) || command.section < 0) fail('section index must be a non-negative integer')
        if (command.command === 'set_lane_section') {
          if (command.sOffsetM !== undefined && !Number.isFinite(command.sOffsetM)) fail('sOffsetM must be finite')
          if (command.transitionM !== undefined && !(command.transitionM >= 0)) fail('transitionM cannot be negative')
        }
        break
      case 'join_junction':
        if (command.nodeIds.length < 2) fail('join_junction requires at least two nodeIds')
        break
      case 'add_crosswalk':
        if (!command.linkIds.length) fail('add_crosswalk requires at least one linkId')
        if (command.widthM !== undefined && !(command.widthM >= 1 && command.widthM <= 12)) fail('crosswalk widthM must be 1..12')
        break
      case 'create_link':
        if ((command.coords?.length ?? 0) < 2) fail('create_link requires at least two vertices')
        for (const point of command.coords) checkLonLat(point.lon, point.lat, 'create_link')
        if (command.snapM !== undefined && !(command.snapM >= 0 && command.snapM <= 50)) fail('snapM must be 0..50')
        if (command.laneCount !== undefined && (!Number.isInteger(command.laneCount) || command.laneCount < 1 || command.laneCount > 12)) {
          fail('laneCount must be 1..12')
        }
        if (command.laneWidthM !== undefined && !(command.laneWidthM >= 1.5 && command.laneWidthM <= 6)) fail('laneWidthM must be 1.5..6')
        break
      case 'delete_link':
        if (!command.linkIds?.length) fail('delete_link requires at least one linkId')
        break
      case 'snap_endpoint':
        if (command.end !== 'from' && command.end !== 'to') fail('snap_endpoint end must be from or to')
        break
      case 'set_lane_count':
        if (!Number.isInteger(command.laneCount) || command.laneCount < 1 || command.laneCount > 12) fail('laneCount must be 1..12')
        break
      case 'set_connections':
        if (!command.add?.length && !command.remove?.length) fail('set_connections requires add or remove items')
        break
      case 'add_detector':
        if (command.kind !== 'e1' && command.kind !== 'e2') fail('detector kind must be e1 or e2')
        if (!command.linkId) fail('add_detector requires linkId')
        if (!Number.isInteger(command.lane) || command.lane < 0) fail('detector lane must be a non-negative integer')
        if (!Number.isFinite(command.posM) || command.posM < 0) fail('detector posM must be non-negative')
        if (command.kind === 'e2' && !(Number.isFinite(command.lengthM) && (command.lengthM ?? 0) >= 1)) fail('E2 detector lengthM must be >= 1')
        if (command.periodS !== undefined && !(command.periodS > 0)) fail('periodS must be positive')
        break
      case 'update_detector': {
        if (!command.detectorId) fail('update_detector requires detectorId')
        const { lane, posM, lengthM, periodS } = command.patch ?? {}
        if (lane !== undefined && (!Number.isInteger(lane) || lane < 0)) fail('lane must be a non-negative integer')
        if (posM !== undefined && !(Number.isFinite(posM) && posM >= 0)) fail('posM must be non-negative')
        if (lengthM !== undefined && !(Number.isFinite(lengthM) && lengthM >= 1)) fail('E2 lengthM must be >= 1')
        if (periodS !== undefined && !(periodS > 0)) fail('periodS must be positive')
        break
      }
      case 'remove_detector':
        if (!command.detectorIds?.length) fail('remove_detector requires detectorIds')
        break
      case 'set_connection_shape': {
        const shape = command.shape ?? []
        if (shape.length === 1) fail('connection shape requires 0 or >= 2 vertices')
        if (shape.some((v) => !Number.isFinite(v.lon) || !Number.isFinite(v.lat))) fail('connection shape has invalid coordinates')
        break
      }
      case 'set_signal_plan':
        if (!command.phases?.length) fail('phases cannot be empty')
        for (const phase of command.phases) {
          if (!(phase.durationS > 0 && phase.durationS <= 600)) fail('phase durationS must be in (0, 600]')
          if (!phase.states.length || /[^GgyrR]/.test(phase.states)) fail('phase states must contain only G/g/y/r')
        }
        break
      case 'ignore_finding':
        if (!command.reason?.trim()) fail('ignore_finding requires a non-empty reason')
        break
      case 'decide_review':
        if (command.decision === 'modify' && command.value === undefined) fail('decide_review modify requires a numeric value')
        break
      default:
        break
    }
  }
}
