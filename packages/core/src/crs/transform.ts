import fs from 'node:fs'
import path from 'node:path'
import Papa from 'papaparse'
import { assertDistinctOutput, coordinateNumber } from '../files.js'
import proj4 from 'proj4'
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, Position } from 'geojson'
import type { GisknifeWarning } from '../types.js'
import { ensureCatalogLoaded, getCrsEntry, isSupportedCrs, normalizeCrsCode } from './catalog.js'
import {
  bd09ToWgs84,
  gcj02ToWgs84,
  wgs84ToBd09,
  wgs84ToGcj02,
} from './chinaOffset.js'
import { checkPostTransformBounds, sniffCoordinates, type SniffPoint } from './sniffer.js'

export interface TransformOptions {
  swapInputAxes?: boolean
  autoFixSniffed?: boolean
  precision?: number
}

export interface PointTransformResult {
  input: [number, number]
  output: [number, number]
  fromCrs: string
  effectiveFromCrs: string
  toCrs: string
  warnings: GisknifeWarning[]
}

export interface BatchPointsTransformResult {
  points: Array<{ input: [number, number]; output: [number, number] }>
  fromCrs: string
  effectiveFromCrs: string
  toCrs: string
  warnings: GisknifeWarning[]
}

export interface CsvTransformOptions extends TransformOptions {
  fromCrs: string
  toCrs: string
  xCol?: string
  yCol?: string
  mode?: 'append' | 'overwrite'
}

export interface CsvTransformSummary {
  rowCount: number
  transformedCount: number
  skippedCount: number
  detectedXCol: string
  detectedYCol: string
  outputColumns: string[]
  fromCrs: string
  effectiveFromCrs: string
  toCrs: string
  mode: 'append' | 'overwrite'
  warnings: GisknifeWarning[]
  sampleRows: Array<Record<string, unknown>>
}

const KNOWN_COLUMN_PAIRS: Array<[string, string]> = [
  ['lon', 'lat'],
  ['lng', 'lat'],
  ['longitude', 'latitude'],
  ['x', 'y'],
  ['coord_x', 'coord_y'],
  ['easting', 'northing'],
  ['east', 'north'],
  ['经度', '纬度'],
  ['东坐标', '北坐标'],
]

function parseDmsToken(token: string): number | null {
  const cleaned = token.trim().replace(/[′’']/g, "'").replace(/[″”"]/g, '"')
  const match = /^([+-]?\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*'\s*)?(?:(\d+(?:\.\d+)?)\s*"\s*)?([NSEW])?$/i.exec(
    cleaned,
  )
  if (!match) return null
  const deg = Number(match[1])
  const min = match[2] ? Number(match[2]) : 0
  const sec = match[3] ? Number(match[3]) : 0
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) {
    return null
  }
  const absVal = Math.abs(deg) + min / 60 + sec / 3600
  const hemi = match[4]?.toUpperCase()
  if (hemi === 'S' || hemi === 'W' || deg < 0) {
    return -absVal
  }
  return absVal
}

/**
 * Parses coordinate strings in multiple formats:
 * - "x,y" or "x y"
 * - Semicolon/newline-separated pairs: "x1,y1; x2,y2"
 * - DMS: "114°03'12.5\"E, 22°32'40.2\"N"
 * - WKT: "POINT (500000 2500000)"
 * - GeoJSON Point JSON
 */
export function parseCoordinateInput(input: string): Array<[number, number]> {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Empty coordinate input')
  }

  // GeoJSON Point
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as { type?: string; coordinates?: unknown }
      if (obj.type === 'Point' && Array.isArray(obj.coordinates) && obj.coordinates.length >= 2) {
        const x = Number(obj.coordinates[0])
        const y = Number(obj.coordinates[1])
        if (Number.isFinite(x) && Number.isFinite(y)) {
          return [[x, y]]
        }
      }
    } catch {
      // Fall through to text parsers
    }
  }

  // WKT POINT(...)
  const wktMatch = /^POINT\s*(?:Z|M|ZM)?\s*\(\s*([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(
    trimmed,
  )
  if (wktMatch) {
    return [[Number(wktMatch[1]), Number(wktMatch[2])]]
  }

  const lines = trimmed
    .split(/[;\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const results: Array<[number, number]> = []
  for (const line of lines) {
    const parts = line.includes(',')
      ? line.split(',').map((s) => s.trim()).filter(Boolean)
      : line.split(/\s+/).map((s) => s.trim()).filter(Boolean)

    if (parts.length < 2) {
      throw new Error(`Cannot parse coordinate pair from "${line}"`)
    }

    const dms0 = parseDmsToken(parts[0])
    const dms1 = parseDmsToken(parts[1])
    if (dms0 !== null && dms1 !== null) {
      const hasLatHemi0 = /[NS]$/i.test(parts[0])
      const hasLonHemi1 = /[EW]$/i.test(parts[1])
      results.push(hasLatHemi0 && hasLonHemi1 ? [dms1, dms0] : [dms0, dms1])
      continue
    }

    const x = Number(parts[0])
    const y = Number(parts[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid numeric coordinates in "${line}"`)
    }
    results.push([x, y])
  }

  return results
}

function roundCoord(value: number, precision?: number): number {
  if (precision === undefined) return value
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function convertRawTuple(x: number, y: number, fromCrs: string, toCrs: string): {
  output: [number, number]
  wgs84: [number, number]
} {
  ensureCatalogLoaded()
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid coordinate values: [${x}, ${y}]`)
  }
  if (!isSupportedCrs(fromCrs)) {
    throw new Error(`Unsupported source CRS: ${fromCrs}`)
  }
  if (!isSupportedCrs(toCrs)) {
    throw new Error(`Unsupported target CRS: ${toCrs}`)
  }

  const from = normalizeCrsCode(fromCrs)
  const to = normalizeCrsCode(toCrs)

  let wgsLon: number
  let wgsLat: number

  if (from === 'EPSG:4326') {
    wgsLon = x
    wgsLat = y
  } else if (from === 'GCJ02') {
    const w = gcj02ToWgs84(x, y)
    wgsLon = w.lon
    wgsLat = w.lat
  } else if (from === 'BD09') {
    const w = bd09ToWgs84(x, y)
    wgsLon = w.lon
    wgsLat = w.lat
  } else {
    const [wx, wy] = proj4(from, 'EPSG:4326', [x, y])
    wgsLon = wx
    wgsLat = wy
  }

  if (from === to) {
    return { output: [x, y], wgs84: [wgsLon, wgsLat] }
  }

  if (to === 'EPSG:4326') {
    return { output: [wgsLon, wgsLat], wgs84: [wgsLon, wgsLat] }
  }
  if (to === 'GCJ02') {
    const g = wgs84ToGcj02(wgsLon, wgsLat)
    return { output: [g.lon, g.lat], wgs84: [wgsLon, wgsLat] }
  }
  if (to === 'BD09') {
    const b = wgs84ToBd09(wgsLon, wgsLat)
    return { output: [b.lon, b.lat], wgs84: [wgsLon, wgsLat] }
  }

  // For proj4-to-proj4 without China offset, direct proj4 avoids redundant datum hops
  if (from !== 'GCJ02' && from !== 'BD09') {
    const [tx, ty] = proj4(from, to, [x, y])
    return { output: [tx, ty], wgs84: [wgsLon, wgsLat] }
  }

  const [tx, ty] = proj4('EPSG:4326', to, [wgsLon, wgsLat])
  return { output: [tx, ty], wgs84: [wgsLon, wgsLat] }
}

export function convertPoints(
  points: Array<[number, number]>,
  fromCrsInput: string,
  toCrsInput: string,
  options: TransformOptions = {},
): BatchPointsTransformResult {
  ensureCatalogLoaded()
  const declaredFrom = normalizeCrsCode(fromCrsInput)
  const toCrs = normalizeCrsCode(toCrsInput)

  const preppedPoints: SniffPoint[] = points.map(([x, y]) =>
    options.swapInputAxes ? { x: y, y: x } : { x, y },
  )

  const sniff = sniffCoordinates(preppedPoints, declaredFrom)
  const warnings: GisknifeWarning[] = [...sniff.warnings]

  let effectiveFrom = declaredFrom
  let applyAutoSwap = false
  if (options.autoFixSniffed) {
    if (sniff.suggestedSwapAxes && !options.swapInputAxes) {
      applyAutoSwap = true
    }
    if (sniff.suggestedFromCrs) {
      effectiveFrom = sniff.suggestedFromCrs
    }
  }

  const defaultPrecision = getCrsEntry(toCrs)?.kind === 'projected' ? 3 : 7
  const precision = options.precision ?? defaultPrecision

  const wgs84CheckPoints: SniffPoint[] = []
  const converted = points.map(([origX, origY]) => {
    const shouldSwap = Boolean(options.swapInputAxes) !== applyAutoSwap
    const inX = shouldSwap ? origY : origX
    const inY = shouldSwap ? origX : origY
    const { output, wgs84 } = convertRawTuple(inX, inY, effectiveFrom, toCrs)
    wgs84CheckPoints.push({ x: wgs84[0], y: wgs84[1] })
    return {
      input: [origX, origY] as [number, number],
      output: [roundCoord(output[0], precision), roundCoord(output[1], precision)] as [
        number,
        number,
      ],
    }
  })

  warnings.push(...checkPostTransformBounds(wgs84CheckPoints, effectiveFrom))

  return {
    points: converted,
    fromCrs: declaredFrom,
    effectiveFromCrs: effectiveFrom,
    toCrs,
    warnings,
  }
}

export function convertPoint(
  x: number,
  y: number,
  fromCrsInput: string,
  toCrsInput: string,
  options: TransformOptions = {},
): PointTransformResult {
  const batch = convertPoints([[x, y]], fromCrsInput, toCrsInput, options)
  return {
    input: batch.points[0].input,
    output: batch.points[0].output,
    fromCrs: batch.fromCrs,
    effectiveFromCrs: batch.effectiveFromCrs,
    toCrs: batch.toCrs,
    warnings: batch.warnings,
  }
}

function transformPositionArray(
  coords: Position[],
  from: string,
  to: string,
  swapAxes: boolean,
  precision?: number,
): Position[] {
  return coords.map((pos) => {
    const x = swapAxes ? pos[1] : pos[0]
    const y = swapAxes ? pos[0] : pos[1]
    const { output } = convertRawTuple(x, y, from, to)
    if (!output.every(Number.isFinite)) throw new Error('Non-finite projected coordinate; check CRS, zone prefix and axis order')
    const nx = roundCoord(output[0], precision)
    const ny = roundCoord(output[1], precision)
    return pos.length > 2 ? [nx, ny, ...pos.slice(2)] : [nx, ny]
  })
}

function transformGeometry(
  geometry: Geometry,
  from: string,
  to: string,
  swapAxes: boolean,
  precision?: number,
): Geometry {
  switch (geometry.type) {
    case 'Point': {
      const [pos] = transformPositionArray([geometry.coordinates], from, to, swapAxes, precision)
      return { type: 'Point', coordinates: pos }
    }
    case 'MultiPoint':
      return {
        type: 'MultiPoint',
        coordinates: transformPositionArray(geometry.coordinates, from, to, swapAxes, precision),
      }
    case 'LineString':
      return {
        type: 'LineString',
        coordinates: transformPositionArray(geometry.coordinates, from, to, swapAxes, precision),
      }
    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: geometry.coordinates.map((ring) =>
          transformPositionArray(ring, from, to, swapAxes, precision),
        ),
      }
    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: geometry.coordinates.map((ring) =>
          transformPositionArray(ring, from, to, swapAxes, precision),
        ),
      }
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((poly) =>
          poly.map((ring) => transformPositionArray(ring, from, to, swapAxes, precision)),
        ),
      }
    case 'GeometryCollection':
      return {
        type: 'GeometryCollection',
        geometries: geometry.geometries.map((g) =>
          transformGeometry(g, from, to, swapAxes, precision),
        ),
      }
  }
}

function extractSamplePointsFromGeoJson(fc: FeatureCollection): SniffPoint[] {
  const sample: SniffPoint[] = []
  const pushPos = (pos: Position) => {
    if (sample.length < 50 && pos.length >= 2 && Number.isFinite(pos[0]) && Number.isFinite(pos[1])) {
      sample.push({ x: pos[0], y: pos[1] })
    }
  }
  const walkGeom = (geom: Geometry | null) => {
    if (!geom || sample.length >= 50) return
    switch (geom.type) {
      case 'Point':
        pushPos(geom.coordinates)
        break
      case 'MultiPoint':
      case 'LineString':
        geom.coordinates.forEach(pushPos)
        break
      case 'MultiLineString':
      case 'Polygon':
        geom.coordinates.forEach((ring) => ring.forEach(pushPos))
        break
      case 'MultiPolygon':
        geom.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach(pushPos)))
        break
      case 'GeometryCollection':
        geom.geometries.forEach(walkGeom)
        break
    }
  }
  for (const feat of fc.features) {
    if (sample.length >= 50) break
    walkGeom(feat.geometry)
  }
  return sample
}

export function reprojectGeoJson(
  fc: FeatureCollection<Geometry, GeoJsonProperties>,
  fromCrsInput: string,
  toCrsInput: string,
  options: TransformOptions = {},
): {
  geojson: FeatureCollection<Geometry, GeoJsonProperties>
  fromCrs: string
  effectiveFromCrs: string
  toCrs: string
  warnings: GisknifeWarning[]
} {
  ensureCatalogLoaded()
  const declaredFrom = normalizeCrsCode(fromCrsInput)
  const toCrs = normalizeCrsCode(toCrsInput)
  const sample = extractSamplePointsFromGeoJson(fc).map((p) =>
    options.swapInputAxes ? { x: p.y, y: p.x } : p,
  )
  const sniff = sniffCoordinates(sample, declaredFrom)
  const warnings: GisknifeWarning[] = [...sniff.warnings]

  let effectiveFrom = declaredFrom
  let autoSwap = false
  if (options.autoFixSniffed) {
    if (sniff.suggestedSwapAxes && !options.swapInputAxes) {
      autoSwap = true
    }
    if (sniff.suggestedFromCrs) {
      effectiveFrom = sniff.suggestedFromCrs
    }
  }

  const swapAxes = Boolean(options.swapInputAxes) !== autoSwap
  const precision =
    options.precision ?? (getCrsEntry(toCrs)?.kind === 'projected' ? 3 : 7)

  const features: Array<Feature<Geometry, GeoJsonProperties>> = fc.features.map((feat) => ({
    ...feat,
    geometry: feat.geometry
      ? transformGeometry(feat.geometry, effectiveFrom, toCrs, swapAxes, precision)
      : feat.geometry,
  }))

  const reprojected: FeatureCollection<Geometry, GeoJsonProperties> = {
    type: 'FeatureCollection',
    features,
  }

  if (toCrs === 'GCJ02' || toCrs === 'BD09') {
    warnings.push({
      code: 'CRS_GCJ02_OFFSET',
      message: `Output GeoJSON coordinates are in ${toCrs}, not standard WGS84 (RFC 7946).`,
    })
  }

  return {
    geojson: reprojected,
    fromCrs: declaredFrom,
    effectiveFromCrs: effectiveFrom,
    toCrs,
    warnings,
  }
}

function detectCsvColumns(
  fields: string[],
  xCol?: string,
  yCol?: string,
): { xCol: string; yCol: string } {
  if (xCol && yCol) {
    if (!fields.includes(xCol) || !fields.includes(yCol)) {
      throw new Error(
        `Specified coordinate columns (${xCol}, ${yCol}) not found in CSV headers: ${fields.join(', ')}`,
      )
    }
    return { xCol, yCol }
  }

  const lowerMap = new Map<string, string>()
  for (const field of fields) {
    lowerMap.set(field.trim().toLowerCase(), field)
  }

  for (const [cx, cy] of KNOWN_COLUMN_PAIRS) {
    const foundX = lowerMap.get(cx)
    const foundY = lowerMap.get(cy)
    if (foundX && foundY) {
      return { xCol: foundX, yCol: foundY }
    }
  }

  throw new Error(
    `Could not auto-detect coordinate columns in headers [${fields.join(', ')}]. Pass --x-col and --y-col explicitly.`,
  )
}

function buildTargetColNames(toCrs: string): { outX: string; outY: string } {
  const slug = toCrs.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  const entry = getCrsEntry(toCrs)
  const isGeo =
    toCrs === 'EPSG:4326' ||
    toCrs === 'EPSG:4490' ||
    toCrs === 'GCJ02' ||
    toCrs === 'BD09' ||
    entry?.kind === 'geographic'
  const shortSlug = toCrs === 'EPSG:4326' ? 'wgs84' : slug
  return isGeo
    ? { outX: `${shortSlug}_lon`, outY: `${shortSlug}_lat` }
    : { outX: `${shortSlug}_x`, outY: `${shortSlug}_y` }
}

export function convertCsvContent(
  csvText: string,
  options: CsvTransformOptions,
): { csv: string; summary: CsvTransformSummary } {
  ensureCatalogLoaded()
  const cleanText = csvText.replace(/^\uFEFF/, '')
  const parsed = Papa.parse<Record<string, string>>(cleanText, {
    header: true,
    skipEmptyLines: true,
  })

  const fields = parsed.meta.fields ?? []
  if (fields.length === 0) {
    throw new Error('CSV contains no header columns')
  }

  const { xCol, yCol } = detectCsvColumns(fields, options.xCol, options.yCol)
  const declaredFrom = normalizeCrsCode(options.fromCrs)
  const toCrs = normalizeCrsCode(options.toCrs)
  const mode = options.mode ?? 'append'

  const validPoints: SniffPoint[] = []
  for (const row of parsed.data) {
    if (validPoints.length >= 50) break
    const rx = coordinateNumber(row[xCol])
    const ry = coordinateNumber(row[yCol])
    if (Number.isFinite(rx) && Number.isFinite(ry)) {
      validPoints.push(options.swapInputAxes ? { x: ry, y: rx } : { x: rx, y: ry })
    }
  }

  const sniff = sniffCoordinates(validPoints, declaredFrom)
  const warnings: GisknifeWarning[] = [...sniff.warnings]

  let effectiveFrom = declaredFrom
  let autoSwap = false
  if (options.autoFixSniffed) {
    if (sniff.suggestedSwapAxes && !options.swapInputAxes) {
      autoSwap = true
    }
    if (sniff.suggestedFromCrs) {
      effectiveFrom = sniff.suggestedFromCrs
    }
  }

  const swapAxes = Boolean(options.swapInputAxes) !== autoSwap
  const precision =
    options.precision ?? (getCrsEntry(toCrs)?.kind === 'projected' ? 3 : 7)
  const { outX, outY } =
    mode === 'overwrite' ? { outX: xCol, outY: yCol } : buildTargetColNames(toCrs)

  let transformedCount = 0
  let skippedCount = 0
  const wgs84Sample: SniffPoint[] = []

  const outputRows = parsed.data.map((row) => {
    const rawX = coordinateNumber(row[xCol])
    const rawY = coordinateNumber(row[yCol])
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      skippedCount += 1
      if (mode === 'overwrite') return { ...row }
      return { ...row, [outX]: '', [outY]: '' }
    }
    const inX = swapAxes ? rawY : rawX
    const inY = swapAxes ? rawX : rawY
    const { output, wgs84 } = convertRawTuple(inX, inY, effectiveFrom, toCrs)
    if (wgs84Sample.length < 50) {
      wgs84Sample.push({ x: wgs84[0], y: wgs84[1] })
    }
    if (!output.every(Number.isFinite)) throw new Error('Non-finite projected CSV coordinate; check source CRS before writing')
    transformedCount += 1
    return {
      ...row,
      [outX]: roundCoord(output[0], precision),
      [outY]: roundCoord(output[1], precision),
    }
  })

  warnings.push(...checkPostTransformBounds(wgs84Sample, effectiveFrom))

  const outputColumns =
    mode === 'overwrite'
      ? [...fields]
      : [...fields, ...(fields.includes(outX) ? [] : [outX]), ...(fields.includes(outY) ? [] : [outY])]

  const csvOut = Papa.unparse(outputRows, { columns: outputColumns })

  return {
    csv: csvOut,
    summary: {
      rowCount: parsed.data.length,
      transformedCount,
      skippedCount,
      detectedXCol: xCol,
      detectedYCol: yCol,
      outputColumns,
      fromCrs: declaredFrom,
      effectiveFromCrs: effectiveFrom,
      toCrs,
      mode,
      warnings,
      sampleRows: outputRows.slice(0, 3),
    },
  }
}

export function convertCsvFile(
  inputPath: string,
  outputPath: string,
  options: CsvTransformOptions,
): CsvTransformSummary {
  assertDistinctOutput(inputPath, outputPath)
  const raw = fs.readFileSync(inputPath, 'utf8')
  const { csv, summary } = convertCsvContent(raw, options)
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })
  fs.writeFileSync(outputPath, csv, 'utf8')
  return summary
}
