import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'

export type BBox = [number, number, number, number] // [minLon, minLat, maxLon, maxLat]

export type EngineName = 'ts-core' | 'python-uvx'

export type WarningCode =
  | 'ZONE_PREFIX_MISMATCH'
  | 'SUSPECTED_AXIS_SWAP'
  | 'SUSPECTED_LAT_LON_SWAP'
  | 'OUT_OF_EXPECTED_BOUNDS'
  | 'CRS_GCJ02_OFFSET'
  | 'UNPROJECTED_METRIC_GUARDRAIL'
  | 'INFORMAL_REGION'
  | 'ADM4_COMPLETENESS_CHECK'
  | 'CACHE_HIT'

export interface GisknifeWarning {
  code: WarningCode | string
  message: string
  suggestion?: string
  details?: Record<string, unknown>
}

export interface DisambiguationCandidate {
  id: string
  label: string
  description: string
  queryHint: string
  country?: string
  level?: string
  adcode?: string
  bbox?: BBox
  providerHint?: string
}

export interface ResultEnvelope {
  ok: boolean
  status?: 'completed' | 'engine_required' | 'disambiguation_required' | 'picker_required' | 'error'
  command: string
  engine: EngineName
  outputPath?: string
  crs?: string
  featureCount?: number
  bbox?: BBox
  geometryTypes?: string[]
  sampleProperties?: string[]
  source?: string
  warnings?: GisknifeWarning[]
  complianceNote?: string
  candidates?: DisambiguationCandidate[]
  data?: unknown
  error?: string
}

export interface ProviderConfig {
  cacheDir?: string
  noCache?: boolean
  cacheTtlMs?: number
  staticIndexUrl?: string
  tiandituToken?: string
  amapKey?: string
  fetchImpl?: typeof fetch
  overpassMirrors?: string[]
}

export interface GeoJsonSummary {
  featureCount: number
  bbox?: BBox
  geometryTypes: string[]
  sampleProperties: string[]
}

export type AnyFeatureCollection = FeatureCollection<Geometry, GeoJsonProperties>
