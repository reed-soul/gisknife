import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProgram } from '../src/index.js'

const OSM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="22.5000" lon="114.0000"/>
  <node id="2" lat="22.5000" lon="114.0010">
    <tag k="highway" v="traffic_signals"/>
  </node>
  <node id="3" lat="22.5000" lon="114.0020"/>
  <node id="4" lat="22.5010" lon="114.0010"/>
  <node id="5" lat="22.4990" lon="114.0010"/>
  <way id="100">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="primary"/><tag k="name" v="Main Ave"/>
  </way>
  <way id="200">
    <nd ref="5"/><nd ref="2"/><nd ref="4"/>
    <tag k="highway" v="secondary"/><tag k="name" v="Cross Rd"/>
  </way>
  <relation id="501">
    <member type="way" ref="100" role="from"/>
    <member type="node" ref="2" role="via"/>
    <member type="way" ref="200" role="to"/>
    <tag k="type" v="restriction"/>
    <tag k="restriction" v="no_left_turn"/>
  </relation>
</osm>`

async function runCliJson(args: string[]): Promise<Record<string, unknown>> {
  const logs: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...items: unknown[]) => {
    logs.push(items.map(String).join(' '))
  })
  try {
    const program = buildProgram()
    await program.parseAsync(['node', 'gisknife', ...args])
    const last = logs[logs.length - 1]
    return JSON.parse(last) as Record<string, unknown>
  } finally {
    spy.mockRestore()
  }
}

describe('CLI roadnet subcommands', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gisknife-cli-roadnet-'))
    process.exitCode = 0
  })

  afterEach(() => {
    process.exitCode = 0
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs build -> validate -> batch (destructive guard) -> export end-to-end', async () => {
    const osmPath = path.join(tmpDir, 'sample.osm')
    const projectPath = path.join(tmpDir, 'sample.roadnet.json')
    const plainDir1 = path.join(tmpDir, 'plain1')
    const geojsonPath1 = path.join(tmpDir, 'sample.geojson')
    fs.writeFileSync(osmPath, OSM_FIXTURE, 'utf8')

    // 1. build
    const built = await runCliJson([
      'roadnet',
      'build',
      osmPath,
      '-o',
      projectPath,
      '--plain-dir',
      plainDir1,
      '--geojson',
      geojsonPath1,
      '--no-fillet',
    ])
    expect(built.ok).toBe(true)
    expect(fs.existsSync(projectPath)).toBe(true)
    expect(fs.existsSync(geojsonPath1)).toBe(true)
    expect(fs.existsSync(path.join(plainDir1, 'sample.nod.xml'))).toBe(true)
    expect(fs.existsSync(path.join(plainDir1, 'sample.edg.xml'))).toBe(true)
    expect(fs.existsSync(path.join(plainDir1, 'sample.con.xml'))).toBe(true)
    expect(fs.existsSync(path.join(plainDir1, 'sample.tll.xml'))).toBe(true)
    expect((built.signalsReport as { synthesizedPlans: number }).synthesizedPlans).toBe(1)
    expect((built.restrictionsReport as { appliedRestrictions: number }).appliedRestrictions).toBe(1)

    // 2. validate
    const validated = await runCliJson(['roadnet', 'validate', projectPath])
    expect(validated.ok).toBe(true)
    expect(validated.exportAllowed).toBe(true)
    expect(validated.blockers).toEqual([])
    const byRule = validated.byRule as Record<string, number>
    expect(byRule.S01 ?? 0).toBe(0)
    expect(byRule.S06 ?? 0).toBe(0)

    // 3. batch destructive guard: blocked without --confirm-destructive, succeeds with it
    const snap = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as {
      links: Array<{ linkId: string }>
    }
    const initialLinkCount = snap.links.length
    const targetLinkId = snap.links[0].linkId
    const deleteCmd = JSON.stringify({
      command: 'delete_link',
      linkIds: [targetLinkId],
      withReverse: false,
    })

    const blocked = await runCliJson(['roadnet', 'batch', projectPath, '--command', deleteCmd])
    expect(blocked.ok).toBe(false)
    expect(blocked.status).toBe('confirmation_required')
    expect(process.exitCode).toBe(1)
    process.exitCode = 0

    // original project unchanged
    const afterBlocked = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as {
      links: Array<{ linkId: string }>
    }
    expect(afterBlocked.links.length).toBe(initialLinkCount)

    const editedPath = path.join(tmpDir, 'edited.roadnet.json')
    const confirmed = await runCliJson([
      'roadnet',
      'batch',
      projectPath,
      '--command',
      deleteCmd,
      '--confirm-destructive',
      '-o',
      editedPath,
    ])
    expect(confirmed.ok).toBe(true)
    expect(fs.existsSync(editedPath)).toBe(true)
    expect((confirmed.summary as { links: number }).links).toBe(initialLinkCount - 1)

    // 4. export
    const plainDir2 = path.join(tmpDir, 'plain2')
    const geojsonPath2 = path.join(tmpDir, 'out2.geojson')
    const exported = await runCliJson([
      'roadnet',
      'export',
      projectPath,
      '--plain-dir',
      plainDir2,
      '--geojson',
      geojsonPath2,
    ])
    expect(exported.ok).toBe(true)
    expect(fs.existsSync(path.join(plainDir2, 'sample.nod.xml'))).toBe(true)
    expect(fs.existsSync(geojsonPath2)).toBe(true)
  })
})
