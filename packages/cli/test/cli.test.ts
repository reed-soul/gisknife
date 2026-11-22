import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildProgram } from '../src/index.js'
import { checkUvInstalled, resolvePythonEngineDir as findEngine } from '../src/engineBridge.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('gisknife CLI', () => {
  it('registers all expected top-level commands', () => {
    const prog = buildProgram()
    const names = prog.commands.map((c) => c.name())
    expect(names).toEqual([
      'doctor',
      'crs',
      'fetch',
      'convert',
      'inspect',
      'qa',
      'analyze',
      'sql',
      'preview',
      'pick',
      'roadnet',
      'mcp',
      'handoff',
    ])
  })

  it('labels online data fetching as Beta in CLI help', () => {
    const program = buildProgram()
    const fetchCommand = program.commands.find(command => command.name() === 'fetch')!
    expect(program.helpInformation()).toContain('Online Fetch (Beta)')
    expect(fetchCommand.description()).toContain('coverage depend on providers')
    expect(fetchCommand.commands.map(command => command.name())).toEqual(['boundary', 'osm'])
    for (const command of fetchCommand.commands) {
      expect(command.helpInformation()).toContain('Beta; verify coverage')
    }
  })

  it('locates local python/gisknife-engine directory and uv binary', () => {
    const dir = findEngine()
    expect(dir).not.toBeNull()
    expect(fs.existsSync(path.join(dir!, 'pyproject.toml'))).toBe(true)
    const uv = checkUvInstalled()
    expect(uv.installed).toBe(true)
  })

  it('executes CRS string, CSV batch rewrite, QA, and preview end-to-end via compiled CLI', () => {
    const cliDist = path.resolve(__dirname, '../dist/index.js')
    expect(fs.existsSync(cliDist), 'Build the CLI before running its integration tests').toBe(true)

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-cli-test-'))
    tempDirs.push(tmp)

    // 1. Point conversion with EPSG:4547 -> WGS84
    const ptOut = execFileSync(
      'node',
      [cliDist, 'crs', 'convert', '500000,2500000', '--from', 'EPSG:4547', '--to', 'WGS84'],
      { encoding: 'utf8' },
    )
    const ptJson = JSON.parse(ptOut) as { ok: boolean; points: Array<{ output: [number, number] }> }
    expect(ptJson.ok).toBe(true)
    expect(ptJson.points[0].output[0]).toBeCloseTo(114.0, 5)

    // 2. CSV batch rewrite preserving columns
    const inCsv = path.join(tmp, 'in.csv')
    const outCsv = path.join(tmp, 'out.csv')
    fs.writeFileSync(inCsv, 'id,name,x,y,note\n1,SiteA,500000,2500000,keepme\n', 'utf8')
    const csvOut = execFileSync(
      'node',
      [cliDist, 'crs', 'convert', '--csv', inCsv, '-o', outCsv, '--from', '4547', '--to', '84'],
      { encoding: 'utf8' },
    )
    const csvJson = JSON.parse(csvOut) as { ok: boolean; transformedCount: number }
    expect(csvJson.ok).toBe(true)
    expect(csvJson.transformedCount).toBe(1)
    const rewritten = fs.readFileSync(outCsv, 'utf8')
    expect(rewritten).toContain('keepme')
    expect(rewritten).toContain('wgs84_lon')

    // 3. Light convert CSV -> GeoJSON & HTML preview
    const gjOut = path.join(tmp, 'sites.geojson')
    const htmlOut = path.join(tmp, 'sites.html')
    execFileSync('node', [cliDist, 'convert', outCsv, '-o', gjOut], { encoding: 'utf8' })
    expect(fs.existsSync(gjOut)).toBe(true)

    const prevRes = JSON.parse(
      execFileSync('node', [cliDist, 'preview', gjOut, '-o', htmlOut], { encoding: 'utf8' }),
    ) as { ok: boolean; featureCount: number }
    expect(prevRes.ok).toBe(true)
    expect(prevRes.featureCount).toBe(1)
    expect(fs.readFileSync(htmlOut, 'utf8')).toContain('maplibregl.Map')
  })
})
