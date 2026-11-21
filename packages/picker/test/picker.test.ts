import { describe, expect, it } from 'vitest'
import { startPickerServer } from '../src/index.js'

describe('@gisknife/picker', () => {
  it('serves interactive MapLibre picker on 127.0.0.1:0 and resolves POST /submit cleanly', async () => {
    const running = await startPickerServer({
      mode: 'bbox',
      initialBbox: [-122.2, 37.4, -122.1, 37.45],
      timeoutMs: 5_000,
    })

    expect(running.port).toBeGreaterThan(0)
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const pageRes = await fetch(running.url)
    expect(pageRes.status).toBe(200)
    const html = await pageRes.text()
    expect(html).toContain('maplibregl.Map')
    expect(html).toContain('Confirm Selection')

    const payload = {
      cancelled: false,
      mode: 'bbox',
      bbox: [-122.18, 37.41, -122.14, 37.44],
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-122.18, 37.41],
            [-122.14, 37.41],
            [-122.14, 37.44],
            [-122.18, 37.44],
            [-122.18, 37.41],
          ],
        ],
      },
      uploadedFile: null,
    }

    const submitRes = await fetch(`${running.url}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: running.url },
      body: JSON.stringify(payload),
    })
    expect(submitRes.status).toBe(200)

    const resolved = await running.resultPromise
    expect(resolved.cancelled).toBe(false)
    expect(resolved.bbox).toEqual([-122.18, 37.41, -122.14, 37.44])
  })
})
