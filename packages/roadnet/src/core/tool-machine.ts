/**
 * 工具状态机（15 个路网编辑工具的纯推演逻辑）。
 */

import { laneRef, parseConnRef, parseLaneEndRef, parseLaneRef } from './refs.js'
import type { LaneTargetStatus, RoadNetCommand } from './types.js'

export { laneRef, parseLaneRef }

export type ToolId =
  | 'select'
  | 'vertex'
  | 'split'
  | 'merge'
  | 'connect'
  | 'join'
  | 'split-junction'
  | 'draw'
  | 'lane'
  | 'lane-link'
  | 'detector'
  | 'widen'
  | 'reverse'
  | 'fillet'
  | 'delete'

export interface ToolDefinition {
  id: ToolId
  label: string
  shortcut: string
  hint: string
}

export const TOOLS: ToolDefinition[] = [
  { id: 'select', label: 'Select', shortcut: 'v', hint: 'Click feature to select, Shift-click to add/remove' },
  { id: 'vertex', label: 'Vertex', shortcut: 'e', hint: 'Select a link then drag its vertices' },
  { id: 'split', label: 'Split', shortcut: 'x', hint: 'Click on a link to split it in two' },
  { id: 'merge', label: 'Merge', shortcut: 'm', hint: 'Select two adjacent links then execute' },
  { id: 'connect', label: 'Connect', shortcut: 'c', hint: 'Click a link endpoint, then click target node' },
  { id: 'join', label: 'Join Junction', shortcut: 'j', hint: 'Select two or more nodes then execute' },
  { id: 'split-junction', label: 'Split Junction', shortcut: 'J', hint: 'Select a junction then execute' },
  { id: 'draw', label: 'Draw Link', shortcut: 'l', hint: 'Click points to draw a new link, double-click to finish' },
  { id: 'lane', label: 'Lane', shortcut: 'n', hint: 'Click a lane (>= z16); = insert right, Shift+= insert left, Delete remove' },
  { id: 'lane-link', label: 'Lane Connections', shortcut: 'k', hint: 'Pick incoming lane end, then click outgoing lane end' },
  { id: 'detector', label: 'Detector', shortcut: 'o', hint: 'Click for E1 loop or drag along lane for E2 detector' },
  { id: 'widen', label: 'Widen', shortcut: 'w', hint: 'Drag along approach from transition start to widen start' },
  { id: 'reverse', label: 'Reverse', shortcut: 'r', hint: 'Select one link then execute to reverse direction' },
  { id: 'fillet', label: 'Fillet', shortcut: 'f', hint: 'Select links then execute to smooth corners with tangent arcs' },
  { id: 'delete', label: 'Delete', shortcut: 'Delete', hint: 'Delete selected links (requires confirmation)' },
]

export interface ToolState {
  tool: ToolId
  selection: string[]
  pendingEndpoint: { linkId: string; end: 'from' | 'to' } | null
  pendingLane?: { junctionId: string; linkId: string; lane: number } | null
  hint: string
}

export function initialToolState(): ToolState {
  return { tool: 'select', selection: [], pendingEndpoint: null, pendingLane: null, hint: TOOLS[0].hint }
}

export interface MapClick {
  ref: string | null
  lon: number
  lat: number
  additive: boolean
  endpoint?: { linkId: string; end: 'from' | 'to' } | null
  alsoSelect?: string[]
  targetStatus?: LaneTargetStatus | null
  lastConnection?: boolean
  force?: boolean
}

export interface ToolOutcome {
  state: ToolState
  command: RoadNetCommand | null
  message?: string
  confirm?: boolean
}

const refsOf = (selection: string[], kind: string) =>
  selection.filter((ref) => ref.startsWith(`${kind}:`)).map((ref) => ref.slice(kind.length + 1))

export function selectTool(state: ToolState, tool: ToolId): ToolState {
  const hint = TOOLS.find((item) => item.id === tool)?.hint ?? ''
  return { ...state, tool, pendingEndpoint: null, pendingLane: null, hint }
}

export function cancel(state: ToolState): ToolState {
  return {
    ...state,
    pendingEndpoint: null,
    pendingLane: null,
    hint: TOOLS.find((t) => t.id === state.tool)?.hint ?? '',
  }
}

export function handleClick(state: ToolState, click: MapClick): ToolOutcome {
  switch (state.tool) {
    case 'select':
    case 'vertex':
    case 'reverse':
    case 'fillet':
    case 'delete':
    case 'merge':
    case 'join':
    case 'split-junction': {
      const selection = updateSelection(state.selection, click)
      return { state: { ...state, selection }, command: null }
    }
    case 'lane': {
      if (!click.ref?.startsWith('lane:')) {
        return {
          state: { ...state, selection: [] },
          command: null,
          message: click.ref ? 'Lane tool requires clicking on a lane polygon' : undefined,
        }
      }
      return { state: { ...state, selection: [click.ref] }, command: null }
    }
    case 'lane-link':
      return laneLinkClick(state, click)
    case 'detector': {
      if (click.ref?.startsWith('detector:')) return { state: { ...state, selection: [click.ref] }, command: null }
      return { state, command: null }
    }
    case 'widen':
      return { state, command: null }
    case 'split': {
      if (!click.ref?.startsWith('link:')) {
        return { state, command: null, message: 'Split tool requires clicking on a link' }
      }
      return {
        state,
        command: {
          command: 'split_link',
          linkId: click.ref.slice('link:'.length),
          at: { point: { lon: click.lon, lat: click.lat } },
        },
      }
    }
    case 'connect': {
      if (!state.pendingEndpoint) {
        if (!click.endpoint) return { state, command: null, message: 'Click a link endpoint first' }
        return {
          state: {
            ...state,
            pendingEndpoint: click.endpoint,
            hint: `Selected ${click.endpoint.linkId} (${click.endpoint.end}), now click target node`,
          },
          command: null,
        }
      }
      if (!click.ref?.startsWith('node:')) {
        return { state, command: null, message: 'Target must be a node' }
      }
      const command: RoadNetCommand = {
        command: 'snap_endpoint',
        linkId: state.pendingEndpoint.linkId,
        end: state.pendingEndpoint.end,
        target: { node: { nodeId: click.ref.slice('node:'.length) } },
      }
      return { state: cancel(state), command }
    }
    default:
      return { state, command: null }
  }
}

function laneLinkClick(state: ToolState, click: MapClick): ToolOutcome {
  const end = parseLaneEndRef(click.ref)
  if (end?.role === 'in') {
    return {
      state: {
        ...state,
        pendingLane: { junctionId: end.junctionId, linkId: end.linkId, lane: end.lane },
        selection: [`junction:${end.junctionId}`],
        hint: `Selected ${end.linkId} lane ${end.lane}: click outgoing lane end to add/remove connection`,
      },
      command: null,
    }
  }
  if (end?.role === 'out') {
    const source = state.pendingLane
    if (!source || source.junctionId !== end.junctionId) {
      return { state, command: null, message: 'Select an incoming lane end first' }
    }
    const connection = { fromLinkId: source.linkId, fromLane: source.lane, toLinkId: end.linkId, toLane: end.lane }
    if (click.targetStatus === 'connected') {
      return {
        state,
        command: { command: 'set_connections', junctionId: end.junctionId, remove: [connection] },
        confirm: Boolean(click.lastConnection),
      }
    }
    if (click.targetStatus === 'conflict' && !click.force) {
      return {
        state,
        command: null,
        message: 'Connection crosses existing approach movements; hold Ctrl/Cmd to force (C04 warning)',
      }
    }
    return { state, command: { command: 'set_connections', junctionId: end.junctionId, add: [connection] } }
  }
  const conn = parseConnRef(click.ref)
  if (conn) {
    return {
      state: { ...state, pendingLane: null, selection: [`junction:${conn.junctionId}`, click.ref as string] },
      command: null,
    }
  }
  if (click.ref?.startsWith('junction:')) {
    return { state: { ...state, pendingLane: null, selection: [click.ref] }, command: null }
  }
  return {
    state: { ...cancel(state), selection: [] },
    command: null,
    message: click.ref ? 'Click a lane end or connection curve at a junction' : undefined,
  }
}

export function connectionKeyCommand(
  state: ToolState,
  event: { key: string },
): { command: RoadNetCommand; connection: ReturnType<typeof parseConnRef> } | null {
  if (event.key !== 'Delete' && event.key !== 'Backspace') return null
  if (state.tool !== 'select' && state.tool !== 'lane-link') return null
  if (state.selection.some((ref) => ref.startsWith('link:'))) return null
  const connection = state.selection.map((ref) => parseConnRef(ref)).find(Boolean)
  if (!connection) return null
  const { junctionId, ...ref } = connection
  return { command: { command: 'set_connections', junctionId, remove: [ref] }, connection }
}

export const DETECTOR_DRAG_MIN_M = 3

export function detectorCommand(
  lane: { linkId: string; lane: number },
  a: { sM: number },
  b: { sM: number },
): RoadNetCommand {
  const span = Math.abs(b.sM - a.sM)
  const round = (v: number) => Math.round(v * 10) / 10
  if (span < DETECTOR_DRAG_MIN_M) {
    return { command: 'add_detector', kind: 'e1', linkId: lane.linkId, lane: lane.lane, posM: round(a.sM) }
  }
  return {
    command: 'add_detector',
    kind: 'e2',
    linkId: lane.linkId,
    lane: lane.lane,
    posM: round(Math.min(a.sM, b.sM)),
    lengthM: round(span),
  }
}

export function detectorKeyCommand(state: ToolState, event: { key: string }): RoadNetCommand | null {
  if (event.key !== 'Delete' && event.key !== 'Backspace') return null
  if (state.tool !== 'select' && state.tool !== 'detector') return null
  if (state.selection.some((ref) => ref.startsWith('link:'))) return null
  const ids = state.selection.filter((ref) => ref.startsWith('detector:')).map((ref) => ref.slice('detector:'.length))
  return ids.length ? { command: 'remove_detector', detectorIds: ids } : null
}

export function runTool(state: ToolState): ToolOutcome {
  switch (state.tool) {
    case 'merge': {
      const links = refsOf(state.selection, 'link')
      if (links.length !== 2) return { state, command: null, message: 'Merge requires exactly two selected links' }
      return { state, command: { command: 'merge_links', linkIds: links } }
    }
    case 'join': {
      const nodes = refsOf(state.selection, 'node')
      if (nodes.length < 2) return { state, command: null, message: 'Join junction requires at least two nodes' }
      return { state, command: { command: 'join_junction', nodeIds: nodes } }
    }
    case 'split-junction': {
      const junctions = refsOf(state.selection, 'junction')
      if (junctions.length !== 1) return { state, command: null, message: 'Split junction requires one selected junction' }
      return { state, command: { command: 'split_junction', junctionId: junctions[0] } }
    }
    case 'reverse': {
      const links = refsOf(state.selection, 'link')
      if (links.length !== 1) return { state, command: null, message: 'Reverse handles one link at a time' }
      return { state, command: { command: 'geometry_op', linkId: links[0], op: 'reverse' } }
    }
    case 'fillet': {
      const links = refsOf(state.selection, 'link')
      return { state, command: null, message: links.length ? undefined : 'Select link(s) to fillet first' }
    }
    case 'delete': {
      const links = refsOf(state.selection, 'link')
      if (!links.length) return { state, command: null, message: 'Select link(s) to delete first' }
      return { state, command: { command: 'delete_link', linkIds: links } }
    }
    default:
      return { state, command: null, message: 'Operate this tool directly on the map' }
  }
}

function updateSelection(selection: string[], click: MapClick): string[] {
  if (!click.ref) return click.additive ? selection : []
  if (!click.additive) return [click.ref, ...(click.alsoSelect ?? [])]
  return selection.includes(click.ref)
    ? selection.filter((ref) => ref !== click.ref)
    : [...selection, click.ref]
}

export interface LaneKeyOutcome {
  command: RoadNetCommand
  select: string | null
}

export function laneKeyCommand(
  state: ToolState,
  event: { key: string; shiftKey: boolean },
): LaneKeyOutcome | null {
  if (state.tool !== 'lane') return null
  const lane = state.selection.map(parseLaneRef).find(Boolean)
  if (!lane) return null
  if (event.key === 'Delete' || event.key === 'Backspace') {
    return {
      command: { command: 'delete_lane', linkId: lane.linkId, section: lane.section, lane: lane.lane },
      select: null,
    }
  }
  if (event.key === '=' || event.key === '+') {
    const at = event.shiftKey ? lane.lane + 1 : lane.lane
    return {
      command: { command: 'insert_lane', linkId: lane.linkId, section: lane.section, at },
      select: laneRef(lane.linkId, lane.section, at),
    }
  }
  return null
}

export function widenCommand(
  linkId: string,
  a: { sM: number },
  b: { sM: number },
  lengthM: number,
  laneCount: number,
  side: 'right' | 'left',
): { command: RoadNetCommand | null; message?: string } {
  const start = Math.max(a.sM, b.sM)
  const transition = Math.abs(a.sM - b.sM)
  if (lengthM - start < 1) {
    return { command: null, message: 'Widen start is too close to link end (leave at least 1 m)' }
  }
  if (start < 1) {
    return { command: null, message: 'Widen start is too close to link start' }
  }
  return {
    command: {
      command: 'split_lane_section',
      linkId,
      sM: Math.round(start * 10) / 10,
      laneCount,
      side,
      transitionM: transition < 2 ? undefined : Math.round(transition * 10) / 10,
    },
  }
}

export function toolForKey(event: { key: string; shiftKey: boolean }): ToolId | null {
  if (event.key === 'Delete' || event.key === 'Backspace') return 'delete'
  const key = event.shiftKey ? event.key.toUpperCase() : event.key.toLowerCase()
  return TOOLS.find((tool) => tool.shortcut === key)?.id ?? null
}
