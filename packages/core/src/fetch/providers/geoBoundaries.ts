import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import type { ProviderConfig } from '../../types.js'
import { COMPLIANCE_NOTES, fetchJsonWithTimeout, type FetchedBoundary } from './types.js'

interface GeoBoundariesMeta {
  gjDownloadURL?: string
  simplifiedGeometryGeoJSON?: string
  boundaryName?: string
  boundaryISO?: string
  boundaryType?: string
}

export async function fetchGeoBoundaries(
  params: { iso3: string; admLevel: number; filterName?: string },
  config: ProviderConfig = {},
): Promise<FetchedBoundary | null> {
  const iso = params.iso3.toUpperCase()
  const adm = `ADM${Math.max(0, Math.min(4, params.admLevel))}`
  const metaUrl = `https://www.geoboundaries.org/api/current/gbOpen/${encodeURIComponent(iso)}/${adm}/`

  const meta = (await fetchJsonWithTimeout(metaUrl, {
    fetchImpl: config.fetchImpl,
    timeoutMs: 15_000,
  })) as GeoBoundariesMeta

  const gjUrl = meta.gjDownloadURL ?? meta.simplifiedGeometryGeoJSON
  if (!gjUrl) {
    return null
  }

  const fc = (await fetchJsonWithTimeout(gjUrl, {
    fetchImpl: config.fetchImpl,
    timeoutMs: 30_000,
  })) as FeatureCollection<Geometry, GeoJsonProperties>

  if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) {
    return null
  }

  let features = fc.features
  if (params.filterName) {
    const q = params.filterName.trim().toLowerCase()
    const filtered = features.filter((f) => {
      const name = String(f.properties?.shapeName ?? f.properties?.NAME ?? '').toLowerCase()
      return name.includes(q)
    })
    if (filtered.length > 0) {
      features = filtered
    }
  }

  return {
    geojson: { type: 'FeatureCollection', features },
    crs: 'EPSG:4326',
    source: 'geoboundaries',
    complianceNote: COMPLIANCE_NOTES.geoboundaries,
    warnings: [],
  }
}
