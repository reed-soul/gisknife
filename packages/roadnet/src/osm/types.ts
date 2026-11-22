/**
 * OSM 引擎与导入链路的类型总出口（支持红绿灯与转向限制关系）。
 */

import type { BoundingBox } from './osm-import.js'

export type {
  BoundingBox,
  FetchArea,
  LonLat,
  OsmBoundary,
  OsmDistrictCandidate,
  OsmSearchCandidate,
} from './osm-import.js'

export interface OsmTrafficSignal {
  nodeId: string
  lon: number
  lat: number
  direction?: string
}

export type OsmRestrictionType =
  | 'no_left_turn'
  | 'no_right_turn'
  | 'no_u_turn'
  | 'no_straight_on'
  | 'only_left_turn'
  | 'only_right_turn'
  | 'only_straight_on'
  | 'only_u_turn'
  | 'no_entry'
  | 'no_exit'

export interface OsmTurnRestriction {
  relationId: string
  restriction: OsmRestrictionType
  kind: 'prohibitory' | 'mandatory'
  fromWayId: string
  toWayId: string
  viaNodeId?: string
  viaWayIds?: string[]
  fromEdgeIds: string[]
  toEdgeIds: string[]
}

export interface OsmImportFiles {
  files: { nod: string; edg: string; con: string; tll: string }
  stats: {
    edges: number
    namedEdges: number
    trafficSignals: number
    turnRestrictions: number
  }
  signals: OsmTrafficSignal[]
  restrictions: OsmTurnRestriction[]
}

export type OsmBbox = BoundingBox

export interface OsmPlace {
  label: string
  lat: number
  lon: number
}

export interface OsmEngine {
  parseOsmXml(xml: string): Promise<OsmImportFiles>
  overpassFetchBbox(box: OsmBbox): Promise<OsmImportFiles>
  searchPlace(q: string): Promise<OsmPlace[]>
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>
