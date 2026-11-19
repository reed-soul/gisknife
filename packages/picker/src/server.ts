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
    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    if (req.method === 'POST' && req.url === '/submit') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          const parsed = JSON.parse(raw) as PickerResult
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))

          if (!settled) {
            settled = true
            if (timeoutHandle) clearTimeout(timeoutHandle)
            resolveResult(parsed)
          }
          server.close()
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }))
          if (!settled) {
            settled = true
            if (timeoutHandle) clearTimeout(timeoutHandle)
            rejectResult(err instanceof Error ? err : new Error(String(err)))
          }
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
