import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { convertCsvContent, csvTextToGeoJson, resolvePlaceIntent } from '@gisknife/core'

const cli = path.resolve(__dirname, '../dist/index.js')
let cwd: string
const input = JSON.stringify({ type: 'Feature', properties: { name: '<sample> 中文' }, geometry: { type: 'MultiPoint', coordinates: [[114, 22], [115, 23]] } })
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-release-'))
  fs.writeFileSync(path.join(cwd, 'source.json'), input)
})
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }))
function run(args: string[], env = process.env) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' })
}

it('refuses a conversion through an alias of the original', () => {
  fs.symlinkSync('source.json', path.join(cwd, 'alias.geojson'))
  expect(run(['crs', 'convert', '--file', 'source.json', '--from', '84', '--to', '3857', '-o', 'alias.geojson']).status).toBe(1)
  expect(fs.readFileSync(path.join(cwd, 'source.json'), 'utf8')).toBe(input)
})

it('never resolves a qualified district to its parent or a namesake', () => {
  expect(resolvePlaceIntent('长春市朝阳区').chinaMatch?.adcode).not.toBe('110105')
  expect(resolvePlaceIntent('深圳市盐田区').chinaMatch?.adcode).not.toBe('440300')
  expect(resolvePlaceIntent('深圳市南山区').chinaMatch?.adcode).toBe('440305')
})

it('preserves zero and skips missing CSV coordinates', () => {
  const csv = 'id,lon,lat\nA, ,22\nB,0,22\nC,bad,22'
  const { summary } = convertCsvContent(csv, { fromCrs: '84', toCrs: '84' })
  expect(summary).toMatchObject({ rowCount: 3, skippedCount: 2, transformedCount: 1 })
  expect(csvTextToGeoJson(csv).features.map(feature => feature.properties?.id)).toEqual(['B'])
})

it('writes two actual GPX waypoints and counts the output', () => {
  const res = run(['convert', 'source.json', '-o', 'points.gpx'])
  expect(JSON.parse(res.stdout)).toMatchObject({ featureCount: 2, inputFeatureCount: 1 })
  const read = run(['inspect', 'points.gpx'])
  expect(JSON.parse(read.stdout)).toMatchObject({ featureCount: 2, bbox: [114, 22, 115, 23] })
})

it('leaves the Python RPC working directory unchanged', () => {
  const res = run(['convert', 'source.json', '-o', 'out.gpkg'])
  expect(res.status, res.stderr).toBe(0)
  expect(JSON.parse(run(['inspect', 'out.gpkg']).stdout)).toMatchObject({ featureCount: 1, bbox: [114, 22, 115, 23] })
})

it('fails without creating an Overture artifact when uv is unavailable', () => {
  const res = run(['fetch', 'osm', '--source', 'overture', '--place', 'Silicon Valley', '-o', 'out.parquet'], { ...process.env, PATH: cwd })
  expect(res.status).toBe(1)
  expect(JSON.parse(res.stderr).ok).toBe(false)
  expect(fs.existsSync(path.join(cwd, 'out.parquet'))).toBe(false)
})

it('renders external properties as text in preview popups', () => {
  expect(run(['preview', 'source.json', '-o', 'map.html']).status).toBe(0)
  expect(fs.readFileSync(path.join(cwd, 'map.html'), 'utf8')).toContain('.setDOMContent(')
})

it('preserves an existing delivery when GPX cannot represent a polygon', () => {
  fs.writeFileSync(path.join(cwd, 'polygon.json'), JSON.stringify({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] }))
  fs.writeFileSync(path.join(cwd, 'delivery.gpx'), 'previous delivery')
  expect(run(['convert', 'polygon.json', '-o', 'delivery.gpx']).status).toBe(1)
  expect(fs.readFileSync(path.join(cwd, 'delivery.gpx'), 'utf8')).toBe('previous delivery')
})

it('reads the actual coordinates back through CSV, GeoPackage, FlatGeobuf and GPX', () => {
  fs.writeFileSync(path.join(cwd, 'start.csv'), 'name,lon,lat,wgs84_lon,wgs84_lat\n样点,500000,2500000,114,22')
  for (const [inputPath, outputPath] of [['start.csv', 'sample.gpkg'], ['sample.gpkg', 'sample.fgb'], ['sample.fgb', 'sample.gpx']]) {
    const converted = run(['convert', inputPath, '-o', outputPath])
    expect(converted.status, converted.stderr).toBe(0)
    expect(JSON.parse(run(['inspect', outputPath]).stdout)).toMatchObject({ featureCount: 1, bbox: [114, 22, 114, 22] })
  }
}, 30_000)
