import { describe, expect, it } from 'vitest'
import {
  buildMcpAppToolMeta,
  MCP_APP_MIME_TYPE,
  MCP_APP_RESOURCES,
  MCP_APP_URIS,
  readMcpAppResourceHtml,
} from '../src/index.js'

describe('@gisknife/mcp-apps', () => {
  it('registers all 3 ui:// MCP App resources with profile=mcp-app mimeType', () => {
    expect(MCP_APP_RESOURCES).toHaveLength(3)
    for (const res of MCP_APP_RESOURCES) {
      expect(res.mimeType).toBe(MCP_APP_MIME_TYPE)
      expect(res.uri.startsWith('ui://gisknife/')).toBe(true)
      const html = readMcpAppResourceHtml(res.uri)
      expect(html).toContain('<!DOCTYPE html>')
      expect(html).toContain('gisknifeMcpHost')
    }
    const meta = buildMcpAppToolMeta(MCP_APP_URIS.picker)
    expect((meta.ui as { resourceUri: string }).resourceUri).toBe('ui://gisknife/picker')
  })
})
