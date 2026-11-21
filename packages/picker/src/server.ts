import { spawn } from 'node:child_process'
import http from 'node:http'
import type { Geometry } from 'geojson'
import { renderPickerHtml, type PickerMode } from './template.js'

export interface PickerUploadedFile {
  name: string
  content: string
}

export interface PickerResult {
  cancelled: boolean
  mode: PickerMode
  bbox: [number, number, number, number] | null
  geometry: Geometry | null
  uploadedFile: PickerUploadedFile | null
}

export interface PickerServerOptions {
  mode?: PickerMode
  title?: string
  initialCenter?: [number, number]
  initialZoom?: number
  initialBbox?: [number, number, number, number]
  timeoutMs?: number
}

function validResult(value: PickerResult): boolean {
  if (!value || typeof value.cancelled !== 'boolean' || !['bbox', 'polygon', 'file'].includes(value.mode)) return false
  if (value.cancelled) return true
  if (value.uploadedFile) return value.mode === 'file' && typeof value.uploadedFile.name === 'string' && typeof value.uploadedFile.content === 'string'
  const box = value.bbox
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) || !(box[0] >= -180 && box[0] < box[2] && box[2] <= 180 && box[1] >= -90 && box[1] < box[3] && box[3] <= 90)) return false
  if (value.mode === 'file' || value.geometry?.type !== 'Polygon') return false
  const rings = value.geometry.coordinates
  return Array.isArray(rings) && rings.length === 1 && rings.every(ring => Array.isArray(ring) && ring.length >= 4 && ring.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3]) && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1])
}

export interface RunningPickerServer {
  url: string
  port: number
  resultPromise: Promise<PickerResult>
  close: () => Promise<void>
}

export function openUrlInBrowser(url: string): void {
  const platform = process.platform
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.unref()
}

export async function startPickerServer(
  options: PickerServerOptions = {},
): Promise<RunningPickerServer> {
  const mode: PickerMode = options.mode ?? 'bbox'
  const html = renderPickerHtml({
    mode,
    title: options.title,
    initialCenter: options.initialCenter,
    initialZoom: options.initialZoom,
    initialBbox: options.initialBbox,
  })

  let settled = false
  let resolveResult!: (value: PickerResult) => void
  let rejectResult!: (err: Error) => void
  let timeoutHandle: NodeJS.Timeout | undefined

  const resultPromise = new Promise<PickerResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server = http.createServer((req, res) => {
    const host = `127.0.0.1:${req.socket.localPort}`
    if (req.headers.host !== host) { res.writeHead(403).end(); return }
    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    if (req.method === 'POST' && req.url === '/submit') {
      if (req.headers.origin !== `http://${host}`) { res.writeHead(403).end(); return }
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(415).end(); return }
      const chunks: Buffer[] = []
      let bytes = 0
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes <= 16 * 1024 * 1024) chunks.push(chunk)
        else if (!res.writableEnded) { chunks.length = 0; res.writeHead(413).end() }
      })
      req.on('end', () => {
        if (res.writableEnded) return
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          const parsed = JSON.parse(raw) as PickerResult
          if (!validResult(parsed)) throw new Error('Invalid selection')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))

          if (!settled) {
            settled = true
            if (timeoutHandle) clearTimeout(timeoutHandle)
            resolveResult(parsed)
          }
          server.close()
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid selection' }))
        }
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    server.close()
    throw new Error('Failed to bind ephemeral picker server on 127.0.0.1')
  }

  const url = `http://127.0.0.1:${addr.port}`

  const close = () =>
    new Promise<void>((resolve) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      server.close(() => resolve())
    })

  if (options.timeoutMs && options.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true
        void close().then(() =>
          rejectResult(new Error(`Ephemeral picker timed out after ${options.timeoutMs} ms`)),
        )
      }
    }, options.timeoutMs)
  }

  return {
    url,
    port: addr.port,
    resultPromise,
    close,
  }
}

export async function startEphemeralPicker(
  options: PickerServerOptions & { openBrowser?: boolean } = {},
): Promise<PickerResult> {
  const running = await startPickerServer(options)
  if (options.openBrowser !== false) {
    openUrlInBrowser(running.url)
  }
  try {
    return await running.resultPromise
  } finally {
    await running.close()
  }
}
