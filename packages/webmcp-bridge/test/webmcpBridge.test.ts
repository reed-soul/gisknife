import { describe, expect, it } from 'vitest'
import {
  buildWorkbenchHandoffUrl,
  decodeWorkbenchRecipeHash,
  registerGisWebMcpTools,
  WEBMCP_TOOL_CATALOG,
} from '../src/index.js'

describe('@gisknife/webmcp-bridge', () => {
  it('exposes 22 WebMCP tools (18 workbench + 4 HITL/fetch) and supports AbortController registration', async () => {
    expect(WEBMCP_TOOL_CATALOG).toHaveLength(22)
    expect(WEBMCP_TOOL_CATALOG.some((t) => t.name === 'convert_coordinates')).toBe(true)
    expect(WEBMCP_TOOL_CATALOG.some((t) => t.name === 'pick_map_bbox')).toBe(true)

    const registered: string[] = []
    let aborted = false
    const mockMc = {
      registerTool: (
        tool: { name: string },
        opts?: { signal?: AbortSignal },
      ) => {
        registered.push(tool.name)
        opts?.signal?.addEventListener('abort', () => {
          aborted = true
        })
      },
    }

    const handle = await registerGisWebMcpTools(
      WEBMCP_TOOL_CATALOG.slice(0, 2).map((t) => ({ ...t, execute: () => ({ ok: true }) })),
      mockMc,
    )
    expect(handle.registeredCount).toBe(2)
    expect(registered).toEqual(['convert_coordinates', 'batch_convert_coordinates'])
    handle.unregister()
    expect(aborted).toBe(true)
  })

  it('roundtrips gis.taoliapp.com #wf= workbench handoff URLs', () => {
    const url = buildWorkbenchHandoffUrl({
      version: 1,
      name: 'Nanshan Buffer & Layout',
      steps: [
        { id: 's1', operator: 'spatial.buffer', params: { distanceKm: 0.5 } },
        { id: 's2', operator: 'spatial.measure' },
      ],
    })
    expect(url).toContain('https://gis.taoliapp.com/tools/workflow#wf=')
    const hash = '#' + url.split('#')[1]
    const decoded = decodeWorkbenchRecipeHash(hash)
    expect(decoded?.name).toBe('Nanshan Buffer & Layout')
    expect(decoded?.steps).toHaveLength(2)
  })
})
