import fs from 'node:fs'
import path from 'node:path'
import { gpx as gpxToGeoJson, kml as kmlToGeoJson } from '@tmcw/togeojson'
import { DOMParser } from '@xmldom/xmldom'
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, Position } from 'geojson'
import Papa from 'papaparse'
import * as topojsonClient from 'topojson-client'
import * as topojsonServer from 'topojson-server'
import { parse as parseWkt, stringify as stringifyWkt } from 'wellknown'
import { normalizeToFeatureCollection } from './inspect.js'

export type LightFormat = 'geojson' | 'csv' | 'kml' | 'gpx' | 'wkt' | 'topojson'
export type HeavyFormat = 'shapefile' | 'gpkg' | 'geoparquet' | 'flatgeobuf' | 'dxf' | 'geotiff'
export type SupportedFormat = LightFormat | HeavyFormat

const EXT_TO_FORMAT: Record<string, SupportedFormat> = {
  '.geojson': 'geojson',
  '.json': 'geojson',
  '.csv': 'csv',
  '.kml': 'kml',
  '.gpx': 'gpx',
  '.wkt': 'wkt',
  '.topojson': 'topojson',
  '.shp': 'shapefile',
  '.zip': 'shapefile',
  '.gpkg': 'gpkg',
  '.parquet': 'geoparquet',
  '.geoparquet': 'geoparquet',
  '.fgb': 'flatgeobuf',
  '.dxf': 'dxf',
  '.tif': 'geotiff',
  '.tiff': 'geotiff',
}

export function detectFormatFromPath(filePath: string): SupportedFormat | undefined {
  const ext = path.extname(filePath).toLowerCase()
  return EXT_TO_FORMAT[ext]
}

export function isLightFormat(fmt: SupportedFormat | undefined): fmt is LightFormat {
  return (
    fmt === 'geojson' ||
    fmt === 'csv' ||
    fmt === 'kml' ||
    fmt === 'gpx' ||
    fmt === 'wkt' ||
    fmt === 'topojson'
  )
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function coordsToKmlString(coords: Position[]): string {
  return coords.map((p) => `${p[0]},${p[1]}${p[2] !== undefined ? `,${p[2]}` : ''}`).join(' ')
}

function geometryToKml(geom: Geometry): string {
  switch (geom.type) {
    case 'Point':
      return `<Point><coordinates>${geom.coordinates[0]},${geom.coordinates[1]}</coordinates></Point>`
    case 'LineString':
      return `<LineString><coordinates>${coordsToKmlString(geom.coordinates)}</coordinates></LineString>`
    case 'Polygon': {
      const [outer, ...inners] = geom.coordinates
      const outerXml = `<outerBoundaryIs><LinearRing><coordinates>${coordsToKmlString(outer)}</coordinates></LinearRing></outerBoundaryIs>`
      const innerXml = inners
        .map(
          (ring) =>
            `<innerBoundaryIs><LinearRing><coordinates>${coordsToKmlString(ring)}</coordinates></LinearRing></innerBoundaryIs>`,
        )
        .join('')
      return `<Polygon>${outerXml}${innerXml}</Polygon>`
    }
    case 'MultiPoint':
      return `<MultiGeometry>${geom.coordinates.map((c) => `<Point><coordinates>${c[0]},${c[1]}</coordinates></Point>`).join('')}</MultiGeometry>`
    case 'MultiLineString':
      return `<MultiGeometry>${geom.coordinates.map((line) => `<LineString><coordinates>${coordsToKmlString(line)}</coordinates></LineString>`).join('')}</MultiGeometry>`
    case 'MultiPolygon':
      return `<MultiGeometry>${geom.coordinates
        .map((poly) => geometryToKml({ type: 'Polygon', coordinates: poly }))
        .join('')}</MultiGeometry>`
    case 'GeometryCollection':
      return `<MultiGeometry>${geom.geometries.map(geometryToKml).join('')}</MultiGeometry>`
  }
}

export function geoJsonToKml(fc: FeatureCollection<Geometry, GeoJsonProperties>): string {
  const placemarks = fc.features
    .filter((f) => f.geometry)
    .map((f, idx) => {
      const props = f.properties ?? {}
      const name = props.name ?? props.NAME ?? `Feature ${idx + 1}`
      const extData = Object.entries(props)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(
          ([k, v]) =>
            `<Data name="${escapeXml(k)}"><value>${escapeXml(typeof v === 'object' ? JSON.stringify(v) : v)}</value></Data>`,
        )
        .join('')
      return `<Placemark><name>${escapeXml(name)}</name>${extData ? `<ExtendedData>${extData}</ExtendedData>` : ''}${geometryToKml(f.geometry)}</Placemark>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n${placemarks}\n</Document>\n</kml>\n`
}

export function geoJsonToGpx(fc: FeatureCollection<Geometry, GeoJsonProperties>): string {
  const wpts: string[] = []
  const trks: string[] = []

  for (let i = 0; i < fc.features.length; i += 1) {
    const f = fc.features[i]
    if (!f.geometry) continue
    const name = escapeXml(f.properties?.name ?? f.properties?.NAME ?? `Feature ${i + 1}`)
    if (f.geometry.type === 'Point') {
      const [lon, lat] = f.geometry.coordinates
      wpts.push(`<wpt lat="${lat}" lon="${lon}"><name>${name}</name></wpt>`)
    } else if (f.geometry.type === 'LineString') {
      const pts = f.geometry.coordinates
        .map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}"/>`)
        .join('')
      trks.push(`<trk><name>${name}</name><trkseg>${pts}</trkseg></trk>`)
    } else if (f.geometry.type === 'MultiLineString') {
      const segs = f.geometry.coordinates
        .map(
          (line) =>
            `<trkseg>${line.map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}"/>`).join('')}</trkseg>`,
        )
        .join('')
      trks.push(`<trk><name>${name}</name>${segs}</trk>`)
    } else if (f.geometry.type === 'Polygon' && f.geometry.coordinates[0]) {
      const pts = f.geometry.coordinates[0]
        .map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}"/>`)
        .join('')
      trks.push(`<trk><name>${name}</name><trkseg>${pts}</trkseg></trk>`)
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="gisknife">\n${wpts.join('\n')}\n${trks.join('\n')}\n</gpx>\n`
}

export function csvTextToGeoJson(csvText: string): FeatureCollection<Geometry, GeoJsonProperties> {
  const parsed = Papa.parse<Record<string, string>>(csvText.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: true,
  })
  const fields = parsed.meta.fields ?? []
  const lower = new Map(fields.map((f) => [f.trim().toLowerCase(), f]))

  const wktField = lower.get('wkt') ?? lower.get('geometry') ?? lower.get('geom')
  const lonPairs: Array<[string, string]> = [
    ['lon', 'lat'],
    ['lng', 'lat'],
    ['longitude', 'latitude'],
    ['wgs84_lon', 'wgs84_lat'],
    ['x', 'y'],
    ['经度', '纬度'],
  ]

  let xCol: string | undefined
  let yCol: string | undefined
  for (const [cx, cy] of lonPairs) {
    if (lower.has(cx) && lower.has(cy)) {
      xCol = lower.get(cx)
      yCol = lower.get(cy)
      break
    }
  }

  if (!wktField && (!xCol || !yCol)) {
    throw new Error(
      `Cannot infer geometry columns from CSV headers [${fields.join(', ')}]. Expected lon/lat, x/y, or wkt column.`,
    )
  }

  const features: Array<Feature<Geometry, GeoJsonProperties>> = []
  for (const row of parsed.data) {
    let geometry: Geometry | null = null
    if (wktField && row[wktField]) {
      geometry = parseWkt(row[wktField]) as Geometry | null
    } else if (xCol && yCol) {
      const lon = Number(row[xCol])
      const lat = Number(row[yCol])
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        geometry = { type: 'Point', coordinates: [lon, lat] }
      }
    }
    if (geometry) {
      features.push({
        type: 'Feature',
        properties: { ...row },
        geometry,
      })
    }
  }

  return { type: 'FeatureCollection', features }
}

export function geoJsonToCsvText(fc: FeatureCollection<Geometry, GeoJsonProperties>): string {
  const allPoint = fc.features.every((f) => f.geometry?.type === 'Point')
  const rows = fc.features.map((f) => {
    const props = { ...(f.properties ?? {}) }
    if (allPoint && f.geometry?.type === 'Point') {
      return {
        ...props,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
      }
    }
    return {
      ...props,
      wkt: f.geometry ? stringifyWkt(f.geometry as unknown as Parameters<typeof stringifyWkt>[0]) : '',
    }
  })
  return Papa.unparse(rows)
}

export function parseLightVectorText(
  text: string,
  format: LightFormat,
): FeatureCollection<Geometry, GeoJsonProperties> {
  switch (format) {
    case 'geojson':
      return normalizeToFeatureCollection(JSON.parse(text))
    case 'csv':
      return csvTextToGeoJson(text)
    case 'kml': {
      const doc = new DOMParser().parseFromString(text, 'text/xml')
      return normalizeToFeatureCollection(kmlToGeoJson(doc))
    }
    case 'gpx': {
      const doc = new DOMParser().parseFromString(text, 'text/xml')
      return normalizeToFeatureCollection(gpxToGeoJson(doc))
    }
    case 'wkt': {
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      const features: Array<Feature<Geometry, GeoJsonProperties>> = []
      for (const line of lines) {
        const geom = parseWkt(line) as Geometry | null
        if (geom) {
          features.push({ type: 'Feature', properties: {}, geometry: geom })
        }
      }
      return { type: 'FeatureCollection', features }
    }
    case 'topojson': {
      const topology = JSON.parse(text) as Parameters<typeof topojsonClient.feature>[0]
      const objectNames = Object.keys((topology as { objects?: Record<string, unknown> }).objects ?? {})
      if (objectNames.length === 0) {
        return { type: 'FeatureCollection', features: [] }
      }
      const features: Array<Feature<Geometry, GeoJsonProperties>> = []
      for (const name of objectNames) {
        const obj = (topology as { objects: Record<string, Parameters<typeof topojsonClient.feature>[1]> }).objects[name]
        const extracted = topojsonClient.feature(topology, obj)
        const fc = normalizeToFeatureCollection(extracted)
        features.push(...fc.features)
      }
      return { type: 'FeatureCollection', features }
    }
  }
}

export function serializeLightVector(
  fc: FeatureCollection<Geometry, GeoJsonProperties>,
  format: LightFormat,
): string {
  switch (format) {
    case 'geojson':
      return JSON.stringify(fc, null, 2)
    case 'csv':
      return geoJsonToCsvText(fc)
    case 'kml':
      return geoJsonToKml(fc)
    case 'gpx':
      return geoJsonToGpx(fc)
    case 'wkt':
      return fc.features
        .filter((f) => f.geometry)
        .map((f) => stringifyWkt(f.geometry as unknown as Parameters<typeof stringifyWkt>[0]))
        .join('\n')
    case 'topojson': {
      const topo = topojsonServer.topology({ layer: fc })
      return JSON.stringify(topo)
    }
  }
}

export function convertLightVectorFile(
  inputPath: string,
  outputPath: string,
  fromFormat?: LightFormat,
  toFormat?: LightFormat,
): FeatureCollection<Geometry, GeoJsonProperties> {
  const srcFmt = fromFormat ?? detectFormatFromPath(inputPath)
  const dstFmt = toFormat ?? detectFormatFromPath(outputPath)
  if (!isLightFormat(srcFmt) || !isLightFormat(dstFmt)) {
    throw new Error(`convertLightVectorFile requires light formats (got ${srcFmt} -> ${dstFmt})`)
  }
  const raw = fs.readFileSync(inputPath, 'utf8')
  const fc = parseLightVectorText(raw, srcFmt)
  const out = serializeLightVector(fc, dstFmt)
  const resolvedOut = path.resolve(outputPath)
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true })
  fs.writeFileSync(resolvedOut, out, 'utf8')
  return fc
}
