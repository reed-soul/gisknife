import * as turf from '@turf/turf'
import { assertDistinctOutput } from '../files.js'
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, MultiPolygon, Polygon } from 'geojson'
import { readGeoJsonFile, summarizeGeoJson, writeGeoJsonFile } from '../convert/inspect.js'
import type { BBox, GisknifeWarning, ProviderConfig, ResultEnvelope } from '../types.js'
import { getOrFetchCached } from './cache.js'
import { resolvePlaceIntent } from './disambiguate.js'
import {
  fetchAmapBoundary,
  fetchCensusTigerBoundary,
  fetchDataVBoundary,
  fetchFromStaticIndex,
  fetchGeoBoundaries,
  fetchNominatimBoundary,
  fetchOverpassLayers,
  fetchOverpassSubdivisions,
  fetchTiandituBoundary,
  type FetchedBoundary,
  type OsmLayerType,
} from './providers/index.js'

export type BoundarySourcePreference =
  | 'auto'
  | 'datav'
  | 'overpass'
  | 'nominatim'
  | 'tiger'
  | 'geoboundaries'
  | 'index'
  | 'amap'
  | 'tianditu'

export interface FetchBoundaryOptions extends ProviderConfig {
  level?: 'country' | 'state' | 'province' | 'city' | 'district' | 'street' | 'county'
  subdivisions?: boolean
  toWgs84?: boolean
  pickFirst?: boolean
  source?: BoundarySourcePreference
  iso3?: string
  outputPath?: string
}

export interface FetchOsmOptions extends ProviderConfig {
  place?: string
  bbox?: BBox
  polygonPath?: string
  layers?: OsmLayerType[]
  source?: 'auto' | 'overpass' | 'overture'
  maxOverpassKm2?: number
  forceOverpass?: boolean
  outputPath?: string
}

export function estimateBBoxAreaKm2(bbox: BBox): number {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const midLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180
  const kmPerDegLat = 111.32
  const kmPerDegLon = 111.32 * Math.cos(midLatRad)
  const heightKm = Math.max(0, maxLat - minLat) * kmPerDegLat
  const widthKm = Math.max(0, maxLon - minLon) * Math.max(0.01, kmPerDegLon)
  return Math.round(heightKm * widthKm * 100) / 100
}

function filterFeaturesInsideParent(
  subdivisions: FeatureCollection<Geometry, GeoJsonProperties>,
  parent: FeatureCollection<Geometry, GeoJsonProperties>,
  parentCode: string,
): FeatureCollection<Geometry, GeoJsonProperties> {
  const parentPolys = parent.features.filter(
    (f): f is Feature<Polygon | MultiPolygon, GeoJsonProperties> =>
      Boolean(f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')),
  )
  if (parentPolys.length === 0) return { type: 'FeatureCollection', features: [] }

  const kept = subdivisions.features.filter((feat) => {
    if (feat.geometry?.type !== 'Polygon' && feat.geometry?.type !== 'MultiPolygon') return false
    const adminCode = String(feat.properties?.['ref:admin:CN:mca'] ?? feat.properties?.['ref:admin:CN:nbs'] ?? '')
    if (/^\d{9,12}$/.test(adminCode)) return adminCode.startsWith(parentCode)
    try {
      const polygon = turf.feature(feat.geometry)
      const area = turf.area(polygon)
      return area > 0 && parentPolys.some(parentPolygon => {
        const common = turf.intersect(turf.featureCollection([polygon, parentPolygon]))
        return common !== null && turf.area(common) / area > 0.5
      })
    } catch {
      return false
    }
  })

  return { type: 'FeatureCollection', features: kept }
}

function buildResultEnvelope(
  command: string,
  fetched: FetchedBoundary,
  outputPath?: string,
  extraWarnings: GisknifeWarning[] = [],
): ResultEnvelope {
  let finalPath = outputPath
  if (outputPath) {
    finalPath = writeGeoJsonFile(outputPath, fetched.geojson)
  }
  const summary = summarizeGeoJson(fetched.geojson)
  return {
    ok: true,
    status: 'completed',
    command,
    engine: 'ts-core',
    outputPath: finalPath,
    crs: fetched.crs,
    featureCount: summary.featureCount,
    bbox: summary.bbox,
    geometryTypes: summary.geometryTypes,
    sampleProperties: summary.sampleProperties,
    source: fetched.source,
    warnings: [...fetched.warnings, ...extraWarnings],
    complianceNote: fetched.complianceNote,
    data: outputPath ? undefined : fetched.geojson,
  }
}

export async function fetchBoundary(
  query: string,
  options: FetchBoundaryOptions = {},
): Promise<ResultEnvelope> {
  const resolution = resolvePlaceIntent(query, {
    pickFirst: options.pickFirst,
    level: options.level,
  })
  if (options.source && !['auto', 'tiger', 'datav', 'overpass', 'nominatim', 'index', 'amap', 'tianditu', 'geoboundaries'].includes(options.source)) throw new Error('Unknown boundary source')

  if (resolution.status === 'disambiguation_required') {
    return {
      ok: true,
      status: 'disambiguation_required',
      command: 'fetch boundary',
      engine: 'ts-core',
      candidates: resolution.candidates,
      warnings: [
        {
          code: 'DISAMBIGUATION_REQUIRED',
          message: `Query "${query}" is ambiguous. Ask the user to select a candidate or pass --pick-first.`,
        },
      ],
    }
  }

  if (resolution.chinaMatch && options.level && options.level !== 'street' && options.level !== resolution.chinaMatch.level) {
    return { ok: false, status: 'error', command: 'fetch boundary', engine: 'ts-core', error: `Requested ${options.level}, but ${query} resolves to ${resolution.chinaMatch.level}.` }
  }

  const cacheKey = {
    query: resolution.canonicalQuery,
    adcode: resolution.chinaMatch?.adcode,
    level: options.level,
    subdivisions: options.subdivisions,
    toWgs84: options.toWgs84,
    source: options.source ?? 'auto',
    iso3: options.iso3,
  }

  const { value: fetched, cacheHit } = await getOrFetchCached<FetchedBoundary | null>(
    'boundary-v3',
    cacheKey,
    async () => {
      const srcPref = options.source ?? 'auto'
      const errors: string[] = []

      const tryProvider = async (label: string, fn: () => Promise<FetchedBoundary | null>) => {
        try {
          return await fn()
        } catch (err) {
          errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
          return null
        }
      }

      // Explicit source overrides
      if (resolution.regionGroup === 'china' && !resolution.chinaMatch && /[区县]$/.test(query.trim())) throw new Error(`Cannot verify the parent district for "${query}". Use a supported, qualified district name.`)
      const geoBoundary = () => fetchGeoBoundaries({ iso3: options.iso3!, admLevel: ({ country: 0, province: 1, state: 1, city: 2, county: 2, district: 3, street: 4 })[options.level ?? 'country'], filterName: resolution.canonicalQuery }, options)
      if (srcPref === 'geoboundaries') return options.iso3 && !options.subdivisions ? geoBoundary() : null
      if (srcPref === 'index') return resolution.chinaMatch && (!options.subdivisions || options.level === 'street') ? fetchFromStaticIndex({ templateKey: options.level === 'street' ? 'china_adm4_geojson' : 'china_adm3_geojson', vars: { adcode: resolution.chinaMatch.adcode } }, options) : null
      if (srcPref === 'tianditu') return !options.subdivisions && options.level !== 'street' ? fetchTiandituBoundary({ keyword: query }, options) : null
      if (srcPref === 'amap') {
        const result = await fetchAmapBoundary({ keywords: resolution.chinaMatch?.adcode ?? query, subdistrict: options.subdivisions || options.level === 'street' ? 1 : 0, toWgs84: options.toWgs84 }, options)
        return options.level !== 'street' || result?.geojson.features.every(feature => feature.properties?.level === 'street') ? result : null
      }
      if (srcPref === 'datav' && !resolution.chinaMatch) return null
      if (srcPref === 'datav' && options.level === 'street') return null
      if (srcPref === 'datav' && resolution.chinaMatch) {
        return tryProvider('datav', () =>
          fetchDataVBoundary(
            {
              adcode: resolution.chinaMatch!.adcode,
              subdivisions: options.subdivisions,
              toWgs84: options.toWgs84,
            },
            options,
          ),
        )
      }
      if (srcPref === 'tiger') {
        return tryProvider('tiger', () =>
          fetchCensusTigerBoundary(
            {
              stateFips: resolution.usMatch?.fips,
              stateName: resolution.usMatch ? undefined : resolution.canonicalQuery,
              subdivisions: options.subdivisions,
            },
            options,
          ),
        )
      }
      if (srcPref === 'nominatim') {
        if (options.subdivisions || options.level === 'street') return null
        return tryProvider('nominatim', () =>
          fetchNominatimBoundary(resolution.chinaMatch ? query : resolution.canonicalQuery, options, { countrycodes: resolution.regionGroup === 'china' ? 'cn' : resolution.regionGroup === 'us' ? 'us' : undefined }),
        )
      }
      const chineseStreets = resolution.regionGroup === 'china' && options.level === 'street'
      if (srcPref === 'overpass' && !chineseStreets) {
        if (!options.subdivisions) return null
        return tryProvider('overpass', () =>
          fetchOverpassSubdivisions(
            { areaName: resolution.canonicalQuery },
            options,
          ),
        )
      }

      // Auto routing: 1. US Census TIGER -> geoBoundaries -> Nominatim
      if (resolution.regionGroup === 'us' && resolution.usMatch) {
        const tiger = await tryProvider('tiger', () =>
          fetchCensusTigerBoundary(
            {
              stateFips: resolution.usMatch!.fips,
              subdivisions: options.subdivisions,
            },
            options,
          ),
        )
        if (tiger) return tiger
        if (options.subdivisions) return null
      }

      // Auto routing: 2. China street / ADM4 subdivisions
      if (resolution.regionGroup === 'china' && options.level === 'street') {
        if (resolution.chinaMatch) {
          const fromIdx = srcPref === 'overpass' ? null : await tryProvider('staticIndex', () =>
            fetchFromStaticIndex(
              { templateKey: 'china_adm4_geojson', vars: { adcode: resolution.chinaMatch!.adcode } },
              options,
            ),
          )
          if (fromIdx) return fromIdx

          // Resolve parent district polygon + WGS84 bbox via DataV first so Overpass is bounded and accurate
          const parent = await tryProvider('datav-parent', () =>
            fetchDataVBoundary(
              { adcode: resolution.chinaMatch!.adcode, subdivisions: false, toWgs84: true },
              options,
            ),
          )
          if (parent) {
            const parentSummary = summarizeGeoJson(parent.geojson)
            if (parentSummary.bbox) {
              const streets = await tryProvider('overpass-bbox', () =>
                fetchOverpassSubdivisions(
                  { bbox: parentSummary.bbox, adminLevels: ['8', '9'] },
                  options,
                ),
              )
              if (streets) {
                const contained = filterFeaturesInsideParent(streets.geojson, parent.geojson, resolution.chinaMatch.adcode)
                if (contained.features.length) return {
                  ...streets,
                  geojson: contained,
                }
              }
            }
          }
          const coded = await tryProvider('overpass-adcode', () => fetchOverpassSubdivisions({ parentAdcode: resolution.chinaMatch!.adcode }, options))
          if (coded) return coded
        }

        if (srcPref === 'overpass') {
          if (errors.length) throw new Error(errors.join(' | '))
          return null
        }
        const amapSub = await tryProvider('amap', () =>
          fetchAmapBoundary(
            {
              keywords: resolution.chinaMatch?.adcode ?? resolution.canonicalQuery,
              subdistrict: 1,
              toWgs84: options.toWgs84 ?? true,
            },
            options,
          ),
        )
        if (amapSub && amapSub.geojson.features.every(feature => feature.properties?.level === 'street')) return amapSub

        if (resolution.chinaMatch) {
          if (errors.length) throw new Error(errors.join(' | '))
          return null
        }
        const overpassByName = await tryProvider('overpass-name', () =>
          fetchOverpassSubdivisions(
            { areaName: resolution.chinaMatch?.name ?? resolution.canonicalQuery, adminLevels: ['8', '9'] },
            options,
          ),
        )
        if (overpassByName && !resolution.chinaMatch) return overpassByName
        return null
      }

      // Auto routing: 3. China province / city / district
      if (resolution.regionGroup === 'china') {
        if (resolution.chinaMatch) {
          const datav = await tryProvider('datav', () =>
            fetchDataVBoundary(
              {
                adcode: resolution.chinaMatch!.adcode,
                subdivisions: options.subdivisions,
                toWgs84: options.toWgs84,
              },
              options,
            ),
          )
          if (datav) return datav
          if (options.subdivisions) return null

          const idx = await tryProvider('staticIndex', () =>
            fetchFromStaticIndex(
              { templateKey: 'china_adm3_geojson', vars: { adcode: resolution.chinaMatch!.adcode } },
              options,
            ),
          )
          if (idx) return idx
        }

        if (resolution.chinaMatch?.level === 'district' || options.subdivisions) return null
        const tdt = await tryProvider('tianditu', () =>
          fetchTiandituBoundary({ keyword: resolution.chinaMatch?.name ?? resolution.canonicalQuery }, options),
        )
        if (tdt) return tdt

        const amap = await tryProvider('amap', () =>
          fetchAmapBoundary(
            {
              keywords: resolution.chinaMatch?.name ?? resolution.canonicalQuery,
              subdistrict: options.subdivisions ? 1 : 0,
              toWgs84: options.toWgs84,
            },
            options,
          ),
        )
        if (amap) return amap

        const nomCn = await tryProvider('nominatim-cn', () =>
          fetchNominatimBoundary(resolution.canonicalQuery, options, { countrycodes: 'cn' }),
        )
        if (nomCn) return nomCn
      }

      // Auto routing: 4. Global (geoBoundaries if iso3 specified -> Nominatim)
      if (options.iso3) {
        if (options.subdivisions) return null
        const gb = await tryProvider('geoboundaries', geoBoundary)
        if (gb) return gb
      }

      if (options.subdivisions) return null
      const nom = await tryProvider('nominatim', () =>
        fetchNominatimBoundary(resolution.canonicalQuery, options, { countrycodes: resolution.regionGroup === 'us' ? 'us' : undefined }),
      )
      if (nom) return nom

      if (errors.length > 0) {
        throw new Error(`No boundary found for "${query}". Provider errors: ${errors.join(' | ')}`)
      }
      return null
    },
    options,
  )

  if (!fetched) {
    return {
      ok: false,
      status: 'error',
      command: 'fetch boundary',
      engine: 'ts-core',
      error: `Could not locate administrative boundary for "${query}".`,
    }
  }

  const extraWarnings: GisknifeWarning[] = cacheHit
    ? [{ code: 'CACHE_HIT', message: 'Served from local disk cache (~/.cache/gisknife). Pass --no-cache to refresh.' }]
    : []

  return buildResultEnvelope('fetch boundary', fetched, options.outputPath, extraWarnings)
}

export interface ResolvedOsmTarget {
  bbox: BBox
  areaKm2: number
  warnings: GisknifeWarning[]
}

export async function resolveOsmTarget(options: FetchOsmOptions): Promise<ResolvedOsmTarget> {
  const warnings: GisknifeWarning[] = []
  let bbox = options.bbox

  if (!bbox && options.polygonPath) {
    const fc = readGeoJsonFile(options.polygonPath)
    const bb = turf.bbox(fc)
    bbox = [bb[0], bb[1], bb[2], bb[3]]
  }

  if (!bbox && options.place) {
    const res = resolvePlaceIntent(options.place)
    if (res.informalMatch) {
      bbox = res.informalMatch.bbox
      warnings.push({
        code: 'INFORMAL_REGION',
        message: res.informalMatch.note,
      })
    } else {
      const boundary = await fetchNominatimBoundary(res.canonicalQuery, options)
      if (!boundary) {
        throw new Error(`Could not resolve BBox for place "${options.place}". Pass --bbox or run 'gisknife pick'.`)
      }
      const sum = summarizeGeoJson(boundary.geojson)
      if (!sum.bbox) {
        throw new Error(`Resolved boundary for "${options.place}" has no valid BBox.`)
      }
      bbox = sum.bbox
    }
  }

  if (!bbox) {
    throw new Error('OSM fetch requires --bbox, --place, --polygon, or --pick.')
  }

  return {
    bbox,
    areaKm2: estimateBBoxAreaKm2(bbox),
    warnings,
  }
}

export async function fetchOsm(options: FetchOsmOptions): Promise<ResultEnvelope> {
  const target = await resolveOsmTarget(options)
  const layers = options.layers?.length ? options.layers : (['roads', 'buildings'] as OsmLayerType[])
  if (layers.some(layer => !['roads', 'buildings', 'pois', 'landuse', 'water', 'all'].includes(layer))) throw new Error('Unsupported OSM layer')
  const [west, south, east, north] = target.bbox
  if (!(west >= -180 && west < east && east <= 180 && south >= -90 && south < north && north <= 90)) throw new Error('Expected ordered WGS84 bounds')
  const maxKm2 = options.maxOverpassKm2 ?? 600
  const sourcePref = options.source ?? 'auto'
  if (!['auto', 'overpass', 'overture'].includes(sourcePref)) throw new Error('Unknown OSM source')
  if (options.polygonPath && options.outputPath) assertDistinctOutput(options.polygonPath, options.outputPath)

  if (
    sourcePref === 'overture' ||
    (sourcePref === 'auto' && target.areaKm2 > maxKm2 && !options.forceOverpass)
  ) {
    return {
      ok: true,
      status: 'engine_required',
      command: 'fetch osm',
      engine: 'ts-core',
      bbox: target.bbox,
      source: 'overture-routing-hint',
      warnings: [
        ...target.warnings,
        {
          code: 'OVERTURE_RECOMMENDED',
          message: `Target BBox covers ~${target.areaKm2} km² (> ${maxKm2} km² Overpass-safe threshold). Route to Overture Maps S3 via Python uvx engine or pass --force-overpass / narrow with 'gisknife pick'.`,
        },
      ],
      data: {
        route: 'overture-s3',
        bbox: target.bbox,
        areaKm2: target.areaKm2,
        layers,
      },
    }
  }

  if (options.outputPath && !/\.geojson$|\.json$/i.test(options.outputPath)) throw new Error('Overpass writes GeoJSON; choose .geojson or convert the result separately.')
  const { value: fetched, cacheHit } = await getOrFetchCached(
    'osm-v2',
    { bbox: target.bbox, layers },
    () => fetchOverpassLayers({ bbox: target.bbox, layers }, options),
    options,
  )

  const extraWarnings = [...target.warnings]
  if (cacheHit) {
    extraWarnings.push({
      code: 'CACHE_HIT',
      message: 'Served from local disk cache (~/.cache/gisknife). Pass --no-cache to refresh.',
    })
  }

  return buildResultEnvelope('fetch osm', fetched, options.outputPath, extraWarnings)
}
