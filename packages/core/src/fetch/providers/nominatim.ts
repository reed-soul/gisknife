import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import type { ProviderConfig } from '../../types.js'
import { COMPLIANCE_NOTES, fetchJsonWithTimeout, type FetchedBoundary } from './types.js'

interface NominatimGeoJsonResponse {
  type: 'FeatureCollection'
  features: Array<Feature<Geometry, GeoJsonProperties>>
}

export async function fetchNominatimBoundary(
  query: string,
  config: ProviderConfig = {},
  options: { countrycodes?: string; limit?: number } = {},
): Promise<FetchedBoundary | null> {
  const search = new URLSearchParams({
    q: query,
    format: 'geojson',
    polygon_geojson: '1',
    addressdetails: '1',
    limit: String(options.limit ?? 5),
  })
  if (options.countrycodes) {
    search.set('countrycodes', options.countrycodes)
  }

  const url = `https://nominatim.openstreetmap.org/search?${search.toString()}`
  const fc = (await fetchJsonWithTimeout(url, {
    fetchImpl: config.fetchImpl,
    timeoutMs: 15_000,
  })) as NominatimGeoJsonResponse

  if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) {
    return null
  }

  const polygonal = fc.features.filter(
    (f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
  )
  if (polygonal.length === 0) {
    return null
  }

  return {
    geojson: {
      type: 'FeatureCollection',
      features: [polygonal[0]],
    },
    crs: 'EPSG:4326',
    source: 'osm-nominatim',
    complianceNote: COMPLIANCE_NOTES.osm,
    warnings: [],
  }
}
