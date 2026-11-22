import { searchPlace } from './nominatim.js'
import { parseOsmXml } from './osm-parse.js'
import { overpassFetchBbox } from './overpass.js'
import type { FetchImpl, OsmEngine } from './types.js'

export interface OsmEngineOptions {
  fetchImpl?: FetchImpl
  overpassMirrors?: string[]
  overpassTimeoutMs?: number
  nominatimTimeoutMs?: number
  countrycodes?: string
  maxAreaKm2?: number
  includeRestrictions?: boolean
}

export function createOsmEngine(options: OsmEngineOptions = {}): OsmEngine {
  return {
    parseOsmXml,
    overpassFetchBbox: (box) =>
      overpassFetchBbox(box, {
        fetchImpl: options.fetchImpl,
        mirrors: options.overpassMirrors,
        timeoutMs: options.overpassTimeoutMs,
        maxAreaKm2: options.maxAreaKm2,
        includeRestrictions: options.includeRestrictions,
      }),
    searchPlace: (q) =>
      searchPlace(q, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.nominatimTimeoutMs,
        countrycodes: options.countrycodes,
      }),
  }
}
