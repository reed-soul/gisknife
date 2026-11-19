import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createGisMcpServer } from '../src/index.js'

describe('@gisknife/mcp', () => {
  it('lists GIS tools and MCP Apps ui:// resources and executes EPSG:4547 conversion', async () => {
    const server = createGisMcpServer()
    const client = new Client({ name: 'gisknife-test-client', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const toolsList = await client.listTools()
    const toolNames = toolsList.tools.map((t) => t.name)
    expect(toolNames).toContain('gis_crs_convert')
    expect(toolNames).toContain('gis_fetch_boundary')
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
    expect(parsed.ok).toBe(true)
    expect(parsed.warnings.some((w) => w.code === 'ZONE_PREFIX_MISMATCH')).toBe(true)

    await Promise.all([client.close(), server.close()])
  })
})
