import { describe, expect, it } from 'vitest'
import {
  bd09ToWgs84,
  convertCsvContent,
  convertPoint,
  gcj02ToWgs84,
  normalizeCrsCode,
  parseCoordinateInput,
  reprojectGeoJson,
  searchCrs,
  wgs84ToBd09,
  wgs84ToGcj02,
} from '../src/index.js'

describe('CRS catalog & transforms', () => {
  it('normalizes aliases and searches full EPSG catalog', () => {
    expect(normalizeCrsCode('84')).toBe('EPSG:4326')
    expect(normalizeCrsCode('4547')).toBe('EPSG:4547')
    expect(normalizeCrsCode('gcj-02')).toBe('GCJ02')
    const hits = searchCrs('4547', 5)
    expect(hits.some((h) => h.code === 'EPSG:4547')).toBe(true)
  })

  it('parses point strings, DMS, and WKT', () => {
    expect(parseCoordinateInput('500000,2500000')).toEqual([[500000, 2500000]])
    expect(parseCoordinateInput('POINT (500000 2500000)')).toEqual([[500000, 2500000]])
    const dms = parseCoordinateInput(`114°03'00"E, 22°30'00"N`)
    expect(dms[0][0]).toBeCloseTo(114.05, 5)
    expect(dms[0][1]).toBeCloseTo(22.5, 5)
  })

  it('converts EPSG:4547 (500000, 2500000) to WGS84 Shenzhen area accurately', () => {
    const res = convertPoint(500000, 2500000, 'EPSG:4547', 'WGS84')
    expect(res.fromCrs).toBe('EPSG:4547')
    expect(res.toCrs).toBe('EPSG:4326')
    expect(res.output[0]).toBeCloseTo(114.0, 5)
    expect(res.output[1]).toBeGreaterThan(22.5)
    expect(res.output[1]).toBeLessThan(22.7)
    expect(res.warnings).toHaveLength(0)
  })

  it('sniffs EPSG:4547 vs EPSG:4526 zone prefix mismatch and auto-fixes when requested', () => {
    const warned = convertPoint(38500000, 2500000, 'EPSG:4547', 'WGS84')
    expect(warned.warnings.some((w) => w.code === 'ZONE_PREFIX_MISMATCH')).toBe(true)
    expect(warned.warnings[0]?.suggestion).toContain('EPSG:4526')

    const fixed = convertPoint(38500000, 2500000, 'EPSG:4547', 'WGS84', { autoFixSniffed: true })
    expect(fixed.effectiveFromCrs).toBe('EPSG:4526')
    expect(fixed.output[0]).toBeCloseTo(114.0, 5)
  })

  it('sniffs China surveying X=North / Y=East axis swap', () => {
    const res = convertPoint(2500000, 500000, 'EPSG:4547', 'WGS84')
    expect(res.warnings.some((w) => w.code === 'SUSPECTED_AXIS_SWAP')).toBe(true)

    const fixed = convertPoint(2500000, 500000, 'EPSG:4547', 'WGS84', { swapInputAxes: true })
    expect(fixed.output[0]).toBeCloseTo(114.0, 5)
  })

  it('performs accurate roundtrip between WGS84, GCJ02, and BD09', () => {
    const lon = 113.9304
    const lat = 22.5333
    const gcj = wgs84ToGcj02(lon, lat)
    expect(Math.abs(gcj.lon - lon)).toBeGreaterThan(0.001)
    const backFromGcj = gcj02ToWgs84(gcj.lon, gcj.lat)
    expect(backFromGcj.lon).toBeCloseTo(lon, 6)
    expect(backFromGcj.lat).toBeCloseTo(lat, 6)

    const bd = wgs84ToBd09(lon, lat)
    const backFromBd = bd09ToWgs84(bd.lon, bd.lat)
    expect(backFromBd.lon).toBeCloseTo(lon, 5)
    expect(backFromBd.lat).toBeCloseTo(lat, 5)
  })

  it('batch-rewrites CSV in append and overwrite modes while preserving business columns', () => {
    const inputCsv = [
      'id,site_name,x,y,remark',
      '1,Nanshan Station,500000,2500000,active',
      '2,Foshan Hub,410000,2546000,planned',
    ].join('\n')

    const appended = convertCsvContent(inputCsv, {
      fromCrs: 'EPSG:4547',
      toCrs: 'WGS84',
      mode: 'append',
    })
    expect(appended.summary.transformedCount).toBe(2)
    expect(appended.summary.outputColumns).toEqual([
      'id',
      'site_name',
      'x',
      'y',
      'remark',
      'wgs84_lon',
      'wgs84_lat',
    ])
    expect(appended.csv).toContain('Nanshan Station')
    expect(appended.csv).toContain('114,')

    const overwritten = convertCsvContent(inputCsv, {
      fromCrs: 'EPSG:4547',
      toCrs: 'WGS84',
      mode: 'overwrite',
    })
    expect(overwritten.summary.outputColumns).toEqual(['id', 'site_name', 'x', 'y', 'remark'])
    expect(overwritten.csv).toContain('Nanshan Station,114,')
  })

  it('reprojects GeoJSON FeatureCollection from EPSG:4547 to EPSG:4326', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: { name: 'P1' },
          geometry: { type: 'Point' as const, coordinates: [500000, 2500000] },
        },
      ],
    }
    const res = reprojectGeoJson(fc, '4547', '4326')
    expect(res.geojson.features[0].geometry.type).toBe('Point')
    if (res.geojson.features[0].geometry.type === 'Point') {
      expect(res.geojson.features[0].geometry.coordinates[0]).toBeCloseTo(114.0, 5)
    }
  })
})
