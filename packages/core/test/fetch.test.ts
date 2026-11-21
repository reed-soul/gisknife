import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  estimateBBoxAreaKm2,
  fetchBoundary,
  fetchOsm,
  overpassToGeoJson,
  resolvePlaceIntent,
} from '../src/index.js'

const tempFiles: string[] = []

afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    fs.rmSync(f, { recursive: true, force: true })
  }
})

describe('Fetch disambiguation, Overpass stitching & multi-source router', () => {
  it('does not silently replace the requested source or parent a district lookup', async () => {
    const calls: string[] = []
    const config = { noCache: true, fetchImpl: async (url: URL | string | Request) => { calls.push(String(url)); return new Response('{}', { status: 404 }) } }
    expect((await fetchBoundary('佛山', { ...config, source: 'geoboundaries' })).ok).toBe(false)
    expect((await fetchBoundary('Paris', { ...config, source: 'datav' })).ok).toBe(false)
    await expect(fetchBoundary('深圳市未知区', config)).rejects.toThrow('parent district')
    expect(calls).toEqual([])
  })

  it('rejects the parent returned instead of requested children', async () => {
    const fetchImpl = async () => Response.json({ features: [{ properties: { adcode: '440600' } }] })
    expect((await fetchBoundary('佛山', { source: 'datav', subdivisions: true, noCache: true, fetchImpl })).ok).toBe(false)
  })
  it('disambiguates ambiguous Washington and resolves informal Silicon Valley & China adcodes', () => {
    const ambig = resolvePlaceIntent('Washington')
    expect(ambig.status).toBe('disambiguation_required')
    expect(ambig.candidates?.map((c) => c.id)).toEqual(['us-dc', 'us-wa'])

    const dc = resolvePlaceIntent('Washington, D.C.')
    expect(dc.status).toBe('resolved')
    expect(dc.usMatch?.fips).toBe('11')

    const sv = resolvePlaceIntent('美国硅谷')
    expect(sv.status).toBe('resolved')
    expect(sv.informalMatch?.bbox).toEqual([-122.52, 37.12, -121.58, 37.6])

    const nanshan = resolvePlaceIntent('深圳南山区')
    expect(nanshan.regionGroup).toBe('china')
    expect(nanshan.chinaMatch?.adcode).toBe('440305')

    const foshan = resolvePlaceIntent('中国佛山')
    expect(foshan.chinaMatch?.adcode).toBe('440600')
  })

  it('stitches unordered and reversed Overpass relation ways into a closed MultiPolygon/Polygon', () => {
    const resp = {
      elements: [
        {
          type: 'relation' as const,
          id: 9001,
          tags: { name: '南头街道', admin_level: '8', boundary: 'administrative' },
          members: [
            {
              type: 'way' as const,
              ref: 1,
              role: 'outer',
              geometry: [
                { lat: 22.5, lon: 113.9 },
                { lat: 22.5, lon: 113.95 },
              ],
            },
            // Intentionally out-of-order and reversed direction
            {
              type: 'way' as const,
              ref: 3,
              role: 'outer',
              geometry: [
                { lat: 22.55, lon: 113.9 },
                { lat: 22.55, lon: 113.95 },
              ],
            },
            {
              type: 'way' as const,
              ref: 2,
              role: 'outer',
              geometry: [
                { lat: 22.5, lon: 113.95 },
                { lat: 22.55, lon: 113.95 },
              ],
            },
            {
              type: 'way' as const,
              ref: 4,
              role: 'outer',
              geometry: [
                { lat: 22.55, lon: 113.9 },
                { lat: 22.5, lon: 113.9 },
              ],
            },
          ],
        },
      ],
    }

    const fc = overpassToGeoJson(resp)
    expect(fc.features).toHaveLength(1)
    expect(fc.features[0].geometry.type).toBe('Polygon')
    if (fc.features[0].geometry.type === 'Polygon') {
      const ring = fc.features[0].geometry.coordinates[0]
      expect(ring[0]).toEqual(ring[ring.length - 1])
      expect(ring.length).toBeGreaterThanOrEqual(5)
    }
  })

  it('routes Foshan to DataV and optionally converts GCJ02 -> WGS84', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-fetch-'))
    tempFiles.push(tmpDir)
    const outPath = path.join(tmpDir, 'foshan.geojson')

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('440600_full.json')) {
        return new Response(
          JSON.stringify({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: { name: '禅城区', adcode: 440604 },
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [113.08, 22.98],
                      [113.15, 22.98],
                      [113.15, 23.05],
                      [113.08, 23.05],
                      [113.08, 22.98],
                    ],
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('Not Found', { status: 404 })
    }

    const res = await fetchBoundary('佛山', {
      subdivisions: true,
      toWgs84: true,
      noCache: true,
      fetchImpl: mockFetch,
      outputPath: outPath,
    })

    expect(res.ok).toBe(true)
    expect(res.source).toBe('aliyun-datav-geoatlas')
    expect(res.crs).toBe('EPSG:4326')
    expect(res.featureCount).toBe(1)
    expect(fs.existsSync(outPath)).toBe(true)
  })

  it('routes Silicon Valley OSM large area to Overture recommendation and small bbox to Overpass', async () => {
    expect(estimateBBoxAreaKm2([-122.52, 37.12, -121.58, 37.6])).toBeGreaterThan(600)

    const largeRes = await fetchOsm({
      place: 'Silicon Valley',
      layers: ['roads'],
      noCache: true,
    })
    expect(largeRes.source).toBe('overture-routing-hint')
    expect((largeRes.data as { route: string }).route).toBe('overture-s3')

    const mockOverpass: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          elements: [
            {
              type: 'way',
              id: 501,
              tags: { highway: 'residential', name: 'University Ave' },
              geometry: [
                { lat: 37.44, lon: -122.16 },
                { lat: 37.445, lon: -122.155 },
              ],
            },
          ],
        }),
        { status: 200 },
      )

    const smallRes = await fetchOsm({
      bbox: [-122.18, 37.42, -122.14, 37.45],
      layers: ['roads'],
      noCache: true,
      fetchImpl: mockOverpass,
    })
    expect(smallRes.source).toBe('osm-overpass')
    expect(smallRes.featureCount).toBe(1)
  })
})
