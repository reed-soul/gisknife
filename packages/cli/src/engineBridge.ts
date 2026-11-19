import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PythonEngineProbe {
  uvInstalled: boolean
  uvVersion?: string
  engineDir: string | null
  available: boolean
  pythonVersion?: string
  capabilities?: Record<string, boolean>
  error?: string
}

export function resolvePythonEngineDir(): string | null {
  const candidates = [
    fileURLToPath(new URL('../../../python/gisknife-engine', import.meta.url)),
    fileURLToPath(new URL('../../../../python/gisknife-engine', import.meta.url)),
    path.resolve(process.cwd(), 'python/gisknife-engine'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'pyproject.toml'))) {
      return dir
    }
  }
  return null
}

export function checkUvInstalled(): { installed: boolean; version?: string } {
  const res = spawnSync('uv', ['--version'], { encoding: 'utf8', timeout: 5_000 })
  if (res.error || res.status !== 0) {
    return { installed: false }
  }
  return { installed: true, version: res.stdout.trim() }
}

export async function runPythonEngine(
  op: string,
  params: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const uv = checkUvInstalled()
  if (!uv.installed) {
    throw new Error(
      'uv is not installed or not in PATH. Install uv (https://docs.astral.sh/uv/) to use Python heavy GIS capabilities (SHP/GPKG/GeoParquet/DuckDB SQL/Overture/GeoTIFF).',
    )
  }

  const engineDir = resolvePythonEngineDir()
  const args = engineDir
    ? ['run', '--quiet', '--directory', engineDir, 'gisknife-engine', '--rpc']
    : ['tool', 'run', '--quiet', 'gisknife-engine', '--rpc']

  const timeoutMs = options.timeoutMs ?? 120_000

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn('uv', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let stdout = ''
    let stderr = ''
    let finished = false

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true
        child.kill('SIGTERM')
        reject(new Error(`gisknife-engine RPC '${op}' timed out after ${timeoutMs} ms`))
      }
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      if (!finished) {
        finished = true
        clearTimeout(timer)
        reject(err)
      }
    })

    child.on('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)

      const trimmed = stdout.trim()
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>
          if (parsed.ok === false || code !== 0) {
            reject(new Error(String(parsed.error || stderr || `Python engine exited with code ${code}`)))
            return
          }
          resolve(parsed)
          return
        } catch {
          // Fall through to raw error below
        }
      }

      reject(
        new Error(
          `Python engine failed (exit ${code ?? 'unknown'}): ${stderr.trim() || trimmed || 'no output'}`,
        ),
      )
    })

    child.stdin.write(JSON.stringify({ op, params }))
    child.stdin.end()
  })
}

export async function probePythonEngine(): Promise<PythonEngineProbe> {
  const uv = checkUvInstalled()
  const engineDir = resolvePythonEngineDir()
  if (!uv.installed) {
    return {
      uvInstalled: false,
      engineDir,
      available: false,
      error: 'uv binary not found in PATH',
    }
  }
  try {
    const caps = await runPythonEngine('capabilities', {}, { timeoutMs: 30_000 })
    return {
      uvInstalled: true,
      uvVersion: uv.version,
      engineDir,
      available: true,
      pythonVersion: String(caps.pythonVersion ?? ''),
      capabilities: (caps.capabilities as Record<string, boolean>) ?? {},
    }
  } catch (err) {
    return {
      uvInstalled: true,
      uvVersion: uv.version,
      engineDir,
      available: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
