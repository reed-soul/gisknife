import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildBboxRoadQuery,
  OVERPASS_MIRRORS,
  overpassFetchBbox,
  resetOverpassRotation,
  searchPlaceDetailed,
  type FetchImpl,
} from '../src/index.js'

const SAMPLE_OSM = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="35.6800" lon="139.7600"/>
  <node id="2" lat="35.6810" lon="139.7610"/>
  <way id="10">
    <nd ref="1"/>
    <nd ref="2"/>
    <tag k="highway" v="primary"/>
  </way>
</osm>`

describe('Overpass query & mirror rotation', () => {
  beforeEach(() => {
    resetOverpassRotation()
  })

  it('includes 4 public HTTPS Overpass mirrors including private.coffee', () => {
    expect(OVERPASS_MIRRORS).toHaveLength(4)
    expect(OVERPASS_MIRRORS).toContain('https://overpass.private.coffee/api/interpreter')
  })

  it('builds Overpass query with restriction relations by default and allows disabling', () => {
    const box = { west: 114.0, south: 22.5, east: 114.02, north: 22.52 }
    const withRestrictions = buildBboxRoadQuery(box)
    expect(withRestrictions).toContain('relation["type"="restriction"];')
    expect(withRestrictions).toContain('[bbox:22.5,114,22.52,114.02]')

    const withoutRestrictions = buildBboxRoadQuery(box, 60, { includeRestrictions: false })
    expect(withoutRestrictions).not.toContain('relation["type"="restriction"]')
  })

  it('rejects bounding boxes exceeding 300 km2 area cap', async () => {
    const hugeBox = { west: 114.0, south: 22.0, east: 115.0, north: 23.0 }
    await expect(overpassFetchBbox(hugeBox)).rejects.toMatchObject({ code: 'AREA_TOO_LARGE' })
  })

  it('rotates across Overpass mirrors on 429 and 502 responses until one succeeds', async () => {
    const calledUrls: string[] = []
    const fetchImpl: FetchImpl = async (url) => {
      calledUrls.push(url)
      if (calledUrls.length === 1) return new Response('rate limit', { status: 429 })
      if (calledUrls.length === 2) return new Response('bad gateway', { status: 502 })
      return new Response(SAMPLE_OSM, { status: 200 })
    }

    const res = await overpassFetchBbox(
      { west: 139.75, south: 35.67, east: 139.77, north: 35.69 },
      { fetchImpl },
    )
    expect(calledUrls).toHaveLength(3)
    expect(new Set(calledUrls).size).toBe(3)
    expect(res.stats.edges).toBe(2)
  })
})

describe('Nominatim global search', () => {
  it('does not force countrycodes=cn unless explicitly requested', async () => {
    const seenUrls: string[] = []
    const mockResults = [{ display_name: 'Tokyo Station, Chiyoda, Tokyo, Japan', lat: '35.6812', lon: '139.7671' }]
    const fetchImpl: FetchImpl = async (url) => {
      seenUrls.push(url)
      return new Response(JSON.stringify(mockResults), { status: 200 })
    }

    const globalPlaces = await searchPlaceDetailed('Tokyo Station', { fetchImpl })
    expect(globalPlaces).toHaveLength(1)
    expect(seenUrls[0]).not.toContain('countrycodes=')

    await searchPlaceDetailed('Shenzhen', { fetchImpl, countrycodes: 'cn' })
    expect(seenUrls[1]).toContain('countrycodes=cn')
  })

  it('validates empty or oversized query strings', async () => {
    await expect(searchPlaceDetailed('   ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(searchPlaceDetailed('a'.repeat(201))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})
