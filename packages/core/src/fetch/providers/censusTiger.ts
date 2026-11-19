import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import type { ProviderConfig } from '../../types.js'
import { COMPLIANCE_NOTES, fetchJsonWithTimeout, type FetchedBoundary } from './types.js'

const TIGER_BASE =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer'

export async function fetchCensusTigerBoundary(
  params: { stateFips?: string; countyName?: string; stateName?: string; subdivisions?: boolean },
  config: ProviderConfig = {},
): Promise<FetchedBoundary | null> {
  const layerId = params.subdivisions || params.countyName ? 1 : 0
  const clauses: string[] = []

  if (params.stateFips) {
    clauses.push(`STATE='${params.stateFips.replace(/[^0-9]/g, '')}'`)
  }
  if (params.countyName) {
    clauses.push(`BASENAME='${params.countyName.replace(/'/g, "''")}'`)
  }
  if (params.stateName && !params.stateFips && !params.countyName) {
    clauses.push(`NAME='${params.stateName.replace(/'/g, "''")}'`)
  }

  const where = clauses.length > 0 ? clauses.join(' AND ') : '1=1'
  const query = new URLSearchParams({
    where,
    outFields: 'NAME,BASENAME,STATE,GEOID,AREALAND,AREAWATER',
    outSR: '4326',
    f: 'geojson',
  })

  const url = `${TIGER_BASE}/${layerId}/query?${query.toString()}`
  const fc = (await fetchJsonWithTimeout(url, {
    fetchImpl: config.fetchImpl,
    timeoutMs: 25_000,
  })) as FeatureCollection<Geometry, GeoJsonProperties>

  if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) {
    return null
  }

  return {
    geojson: fc,
    crs: 'EPSG:4326',
    source: 'us-census-tiger',
    complianceNote: COMPLIANCE_NOTES.tiger,
    warnings: [],
  }
}
