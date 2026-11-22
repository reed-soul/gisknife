import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createGisMcpServer } from '../src/index.js'

describe('@gisknife/mcp', () => {
  it('preserves .json originals over stdio and rejects same-file output including hard links', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-stdio-'))
    const client = new Client({ name: 'release', version: '1' })
    const source = path.join(directory, 'layer.json')
    const original = JSON.stringify({ type: 'Point', coordinates: [114, 22] })
    fs.writeFileSync(source, original)
    const alias = path.join(directory, 'existing.geojson')
    fs.linkSync(source, alias)
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../../cli/dist/index.js'), 'mcp'], cwd: directory }))
      const args = { geojsonInputPath: 'layer.json', fromCrs: '84', toCrs: '3857' }
      const ok = await client.callTool({ name: 'gis_crs_convert', arguments: args })
      expect(ok.isError).not.toBe(true)
      expect(fs.existsSync(path.join(directory, 'layer_3857.geojson'))).toBe(true)
      const rejected = await client.callTool({ name: 'gis_crs_convert', arguments: { ...args, outputPath: alias } })
      expect(rejected.isError).toBe(true)
      expect(fs.readFileSync(source, 'utf8')).toBe(original)
      const heavy = await client.callTool({ name: 'gis_convert', arguments: { inputPath: 'layer.json', outputPath: 'point.gpkg' } })
      expect(heavy.isError).not.toBe(true)
      const inspected = await client.callTool({ name: 'gis_inspect', arguments: { inputPath: 'point.gpkg' } })
      expect(JSON.parse((inspected.content[0] as { text: string }).text)).toMatchObject({ ok: true, featureCount: 1, bbox: [114, 22, 114, 22] })
    } finally { await client.close(); fs.rmSync(directory, { recursive: true, force: true }) }
  }, 30_000)
  it('lists GIS tools and MCP Apps ui:// resources and executes EPSG:4547 conversion', async () => {
    const server = createGisMcpServer()
    const client = new Client({ name: 'gisknife-test-client', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const toolsList = await client.listTools()
    const toolNames = toolsList.tools.map((t) => t.name)
    expect(toolNames).toContain('gis_crs_convert')
    for (const name of ['gis_fetch_boundary', 'gis_fetch_osm', 'gis_roadnet_fetch']) {
      expect(toolsList.tools.find(tool => tool.name === name)?.description).toMatch(/^Beta:/)
    }
    expect(toolNames).toContain('gis_pick_area')
    expect(toolNames).toContain('gis_preview')

    const resourcesList = await client.listResources()
    const uris = resourcesList.resources.map((r) => r.uri)
    expect(uris).toContain('ui://gisknife/picker')
    expect(uris).toContain('ui://gisknife/preview')
    expect(uris).toContain('ui://gisknife/crs-disambiguator')

    const readRes = await client.readResource({ uri: 'ui://gisknife/picker' })
    expect(readRes.contents[0].mimeType).toBe('text/html;profile=mcp-app')

    const callRes = await client.callTool({
      name: 'gis_crs_convert',
      arguments: {
        coordinates: '38500000,2500000',
        fromCrs: 'EPSG:4547',
        toCrs: 'WGS84',
      },
    })
    const parsed = JSON.parse((callRes.content[0] as { text: string }).text) as {
      ok: boolean
      warnings: Array<{ code: string }>
    }
    expect(parsed.ok).toBe(false)
    expect(parsed.warnings.some((w) => w.code === 'ZONE_PREFIX_MISMATCH')).toBe(true)

    await Promise.all([client.close(), server.close()])
  })
})
