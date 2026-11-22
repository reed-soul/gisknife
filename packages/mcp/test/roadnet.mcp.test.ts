import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGisMcpServer } from '../src/index.js'

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

function parseToolJson(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const first = (result.content as Array<{ type: string; text?: string }>)[0]
  return JSON.parse(first.text ?? '{}') as Record<string, unknown>
}

describe('MCP roadnet tools', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gisknife-mcp-roadnet-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registers all roadnet tools and runs build -> command (destructive guard) -> export over InMemoryTransport', async () => {
    const server = createGisMcpServer()
    const client = new Client({ name: 'roadnet-test-client', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const list = await client.listTools()
      const names = list.tools.map((t) => t.name)
      expect(names).toContain('gis_roadnet_fetch')
      expect(names).toContain('gis_roadnet_build')
      expect(names).toContain('gis_roadnet_command')
      expect(names).toContain('gis_roadnet_export')

      const osmPath = path.join(tmpDir, 'sample.osm')
      const projectPath = path.join(tmpDir, 'sample.roadnet.json')
      fs.writeFileSync(osmPath, OSM_FIXTURE, 'utf8')

      // 1. gis_roadnet_build
      const buildRes = parseToolJson(
        await client.callTool({
          name: 'gis_roadnet_build',
          arguments: {
            inputPath: osmPath,
            outputProjectPath: projectPath,
            fillet: false,
          },
        }),
      )
      expect(buildRes.ok).toBe(true)
      expect(fs.existsSync(projectPath)).toBe(true)
      expect((buildRes.signalsReport as { synthesizedPlans: number }).synthesizedPlans).toBe(1)
      expect((buildRes.restrictionsReport as { appliedRestrictions: number }).appliedRestrictions).toBe(1)

      const snap = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as { links: Array<{ linkId: string }> }
      const targetLinkId = snap.links[0].linkId

      // 2. gis_roadnet_command destructive guard: rejected without confirmed: true
      const unconfirmedRes = await client.callTool({
        name: 'gis_roadnet_command',
        arguments: {
          projectPath,
          command: { command: 'delete_link', linkIds: [targetLinkId], withReverse: false },
        },
      })
      const unconfirmedJson = parseToolJson(unconfirmedRes)
      expect(unconfirmedJson.ok).toBe(false)
      expect(unconfirmedJson.status).toBe('confirmation_required')

      // Confirmed destructive command succeeds and writes edited project
      const editedPath = path.join(tmpDir, 'edited.roadnet.json')
      const confirmedJson = parseToolJson(
        await client.callTool({
          name: 'gis_roadnet_command',
          arguments: {
            projectPath,
            outputProjectPath: editedPath,
            confirmed: true,
            command: { command: 'delete_link', linkIds: [targetLinkId], withReverse: false },
          },
        }),
      )
      expect(confirmedJson.ok).toBe(true)
      expect(fs.existsSync(editedPath)).toBe(true)
      expect((confirmedJson.summary as { links: number }).links).toBe(snap.links.length - 1)

      // 3. gis_roadnet_export
      const plainDir = path.join(tmpDir, 'plain')
      const geojsonPath = path.join(tmpDir, 'network.geojson')
      const exportJson = parseToolJson(
        await client.callTool({
          name: 'gis_roadnet_export',
          arguments: {
            projectPath,
            plainDir,
            geojsonPath,
            layer: 'all',
          },
        }),
      )
      expect(exportJson.ok).toBe(true)
      expect(fs.existsSync(path.join(plainDir, 'sample.nod.xml'))).toBe(true)
      expect(fs.existsSync(path.join(plainDir, 'sample.tll.xml'))).toBe(true)
      expect(fs.existsSync(geojsonPath)).toBe(true)
    } finally {
      await Promise.all([client.close(), server.close()])
    }
  })
})
