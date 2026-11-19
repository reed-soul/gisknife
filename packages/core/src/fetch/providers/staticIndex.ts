import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import type { ProviderConfig } from '../../types.js'
import { COMPLIANCE_NOTES, fetchJsonWithTimeout, type FetchedBoundary } from './types.js'

export interface StaticIndexManifest {
  version: number
  name?: string
  license?: string
  crs?: string
  templates?: {
    china_adm4_geojson?: string
    china_adm3_geojson?: string
    china_adm4_fgb?: string
    global_adm_geojson?: string
    [key: string]: string | undefined
  }
}

function interpolateTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) =>
    encodeURIComponent(vars[key] ?? ''),
  )
}

/**
 * Fetches pre-indexed GeoJSON shards from a user/community-configured remote
 * static index manifest (`GISKNIFE_INDEX_URL`), keeping the git repository free
 * of bundled boundary datasets.
 */
export async function fetchFromStaticIndex(
  params: { templateKey: 'china_adm4_geojson' | 'china_adm3_geojson' | 'global_adm_geojson'; vars: Record<string, string> },
  config: ProviderConfig = {},
): Promise<FetchedBoundary | null> {
  const indexUrl = config.staticIndexUrl || process.env.GISKNIFE_INDEX_URL
  if (!indexUrl) return null

  const manifest = (await fetchJsonWithTimeout(indexUrl, {
    fetchImpl: config.fetchImpl,
    timeoutMs: 10_000,
  })) as StaticIndexManifest

  const tpl = manifest.templates?.[params.templateKey]
  if (!tpl) return null

  const shardUrl = interpolateTemplate(tpl, params.vars)
  const fc = (await fetchJsonWithTimeout(shardUrl, {
    fetchImpl: config.fetchImpl,
    timeoutMs: 20_000,
  })) as FeatureCollection<Geometry, GeoJsonProperties>

  if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) {
    return null
  }

  return {
    geojson: fc,
    crs: manifest.crs || 'EPSG:4326',
    source: `static-index:${manifest.name ?? 'custom'}`,
    complianceNote: `${COMPLIANCE_NOTES.staticIndex}${manifest.license ? ` (${manifest.license})` : ''}`,
    warnings: [],
  }
}
