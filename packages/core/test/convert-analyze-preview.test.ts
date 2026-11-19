import { describe, expect, it } from 'vitest'
import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import {
  generatePreviewHtml,
  inspectGeoJson,
  parseLightVectorText,
  runGeometryQa,
  runTurfOperator,
  serializeLightVector,
} from '../src/index.js'

const SAMPLE_POLY_FC: FeatureCollection<Geometry, GeoJsonProperties> = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Park A', zone: 'Z1' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [113.9, 22.5],
            [113.91, 22.5],
            [113.91, 22.51],
            [113.9, 22.51],
            [113.9, 22.5],
          ],
        ],
      },
    },
  ],
}

describe('Format conversion, QA, Turf ops & HTML preview', () => {
  it('roundtrips GeoJSON through KML, TopoJSON, WKT, and CSV', () => {
    const kml = serializeLightVector(SAMPLE_POLY_FC, 'kml')
    const fromKml = parseLightVectorText(kml, 'kml')
    expect(fromKml.features).toHaveLength(1)
    expect(fromKml.features[0].geometry.type).toBe('Polygon')

    const topo = serializeLightVector(SAMPLE_POLY_FC, 'topojson')
    const fromTopo = parseLightVectorText(topo, 'topojson')
    expect(fromTopo.features).toHaveLength(1)

    const wkt = serializeLightVector(SAMPLE_POLY_FC, 'wkt')
    const fromWkt = parseLightVectorText(wkt, 'wkt')
    expect(fromWkt.features[0].geometry.type).toBe('Polygon')

    const pointFc: FeatureCollection<Geometry, GeoJsonProperties> = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'Station 1' },
          geometry: { type: 'Point', coordinates: [114.0, 22.55] },
        },
      ],
    }
    const csv = serializeLightVector(pointFc, 'csv')
    const fromCsv = parseLightVectorText(csv, 'csv')
    expect(fromCsv.features[0].geometry.type).toBe('Point')
  })

  it('inspects schema and runs QA + repair on unclosed and kinked polygons', () => {
    const report = inspectGeoJson(SAMPLE_POLY_FC)
    expect(report.featureCount).toBe(1)
    expect(report.schema.map((s) => s.name)).toEqual(['name', 'zone'])

    const dirty: FeatureCollection<Geometry, GeoJsonProperties> = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { id: 1 },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [0, 2],
                [2, 0],
                [2, 2],
              ],
            ],
          },
        },
      ],
    }

    const qa = runGeometryQa(dirty, { fix: true })
    expect(qa.report.issueCount).toBeGreaterThanOrEqual(1)
    expect(qa.report.fixed).toBe(true)
    expect(qa.geojson.features).toHaveLength(1)
  })

  it('runs geodesic buffer/measure and blocks projected coordinates under WGS84 ops', () => {
    const res = runTurfOperator('measure', SAMPLE_POLY_FC)
    expect(res.measure?.totalAreaSqKm).toBeGreaterThan(1)

    const buf = runTurfOperator('buffer', SAMPLE_POLY_FC, { distanceMeters: 100 })
    expect(buf.geojson?.features).toHaveLength(1)

    const projectedFc: FeatureCollection<Geometry, GeoJsonProperties> = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [500000, 2500000] },
        },
      ],
    }
    expect(() => runTurfOperator('buffer', projectedFc, { distanceMeters: 100 })).toThrow(
      /CRS guardrail/,
    )
  })

  it('generates self-contained MapLibre preview HTML', () => {
    const html = generatePreviewHtml(SAMPLE_POLY_FC, { title: 'Unit QA Map', crs: 'EPSG:4326' })
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('maplibregl.Map')
    expect(html).toContain('Park A')
  })
})
