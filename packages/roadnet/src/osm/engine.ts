import { RoadNetError } from '../core/types.js'
import type { OsmBbox, OsmEngine, OsmImportFiles, OsmPlace } from './types.js'

let engine: OsmEngine | null = null

export function setOsmEngine(next: OsmEngine | null): OsmEngine | null {
  const previous = engine
  engine = next
  return previous
}

export function osmEngine(): OsmEngine | null {
  return engine
}

function requireEngine(): OsmEngine {
  if (!engine) {
    throw new RoadNetError({
      code: 'OSM_ENGINE_MISSING',
      message: 'OSM engine is not configured; call setOsmEngine(createOsmEngine()) first.',
    })
  }
  return engine
}

export function parseOsmXmlWithEngine(xml: string): Promise<OsmImportFiles> {
  return requireEngine().parseOsmXml(xml)
}

export function overpassFetchBboxWithEngine(box: OsmBbox): Promise<OsmImportFiles> {
  return requireEngine().overpassFetchBbox(box)
}

export function searchPlaceWithEngine(q: string): Promise<OsmPlace[]> {
  return requireEngine().searchPlace(q)
}
