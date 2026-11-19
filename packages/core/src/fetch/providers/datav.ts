import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import { reprojectGeoJson } from '../../crs/transform.js'
import type { GisknifeWarning, ProviderConfig } from '../../types.js'
import { COMPLIANCE_NOTES, fetchJsonWithTimeout, type FetchedBoundary } from './types.js'

export async function fetchDataVBoundary(
  params: { adcode: string; subdivisions?: boolean; toWgs84?: boolean },
  config: ProviderConfig = {},
): Promise<FetchedBoundary | null> {
  const suffix = params.subdivisions ? '_full' : ''
  const url = `https://geo.datav.aliyun.com/areas_v3/bound/${params.adcode}${suffix}.json`

  let fc: FeatureCollection<Geometry, GeoJsonProperties>
  try {
    fc = (await fetchJsonWithTimeout(url, {
      fetchImpl: config.fetchImpl,
      timeoutMs: 15_000,
    })) as FeatureCollection<Geometry, GeoJsonProperties>
  } catch (err) {
    // Subdistrict / leaf district has no _full.json; fallback to single bound file
    if (params.subdivisions) {
      const fallbackUrl = `https://geo.datav.aliyun.com/areas_v3/bound/${params.adcode}.json`
      fc = (await fetchJsonWithTimeout(fallbackUrl, {
        fetchImpl: config.fetchImpl,
        timeoutMs: 15_000,
      })) as FeatureCollection<Geometry, GeoJsonProperties>
    } else {
      throw err
    }
  }

  if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) {
    return null
  }

  const warnings: GisknifeWarning[] = []
  let outputFc = fc
  let crs = 'GCJ02'

  if (params.toWgs84) {
    const converted = reprojectGeoJson(fc, 'GCJ02', 'EPSG:4326')
    outputFc = converted.geojson
    crs = 'EPSG:4326'
  } else {
    warnings.push({
      code: 'CRS_GCJ02_OFFSET',
      message: 'Aliyun DataV GeoAtlas natively serves coordinates in GCJ-02 (encrypted Mars CRS).',
      suggestion: 'Pass --to-wgs84 to apply mathematical GCJ-02 -> WGS84 de-offset.',
    })
  }

  return {
    geojson: outputFc,
    crs,
    source: 'aliyun-datav-geoatlas',
    complianceNote: COMPLIANCE_NOTES.datav,
    warnings,
  }
}
