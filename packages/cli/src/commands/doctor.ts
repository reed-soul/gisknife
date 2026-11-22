import { ensureCatalogLoaded, resolveCacheDir } from '@gisknife/core'
import { probeRoadnetWasmNode } from '@gisknife/roadnet/node'
import type { Command } from 'commander'
import { probePythonEngine } from '../engineBridge.js'

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check Node/TS core engine, Python uvx heavy compute engine, cache, and BYOK config')
    .action(async () => {
      const catalog = ensureCatalogLoaded()
      const py = await probePythonEngine()
      const report = {
        ok: true,
        command: 'doctor',
        nodeVersion: process.version,
        tsCore: {
          available: true,
          epsgCount: catalog.size,
        },
        pythonEngine: py,
        roadnetWasm: probeRoadnetWasmNode(),
        cacheDir: resolveCacheDir(),
        env: {
          GISKNIFE_INDEX_URL: Boolean(process.env.GISKNIFE_INDEX_URL),
          TIANDITU_TOKEN: Boolean(process.env.TIANDITU_TOKEN),
          AMAP_KEY: Boolean(process.env.AMAP_KEY),
        },
      }
      console.log(JSON.stringify(report, null, 2))
    })
}
