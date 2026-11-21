import fs from 'node:fs'
import path from 'node:path'
import {
  detectFormatFromPath,
  assertDistinctOutput,
  inspectGeoJson,
  isLightFormat,
  parseLightVectorText,
  runGeometryQa,
  writeGeoJsonFile,
} from '@gisknife/core'
import type { Command } from 'commander'
import { runPythonEngine } from '../engineBridge.js'

export function registerInspectCommands(program: Command): void {
  program
    .command('inspect <file>')
    .description('Inspect vector/raster schema, CRS hint, BBox, geometry types, and feature count')
    .action(async (file: string) => {
      const fmt = detectFormatFromPath(file)
      if (fmt === 'geotiff') {
        const res = await runPythonEngine('raster_inspect', { inputPath: file })
        console.log(JSON.stringify(res, null, 2))
        return
      }
      if (isLightFormat(fmt)) {
        const raw = fs.readFileSync(file, 'utf8')
        const fc = parseLightVectorText(raw, fmt)
        const stat = fs.statSync(file)
        const report = inspectGeoJson(fc, {
          filePath: file,
          fileSizeBytes: stat.size,
          format: fmt,
        })
        console.log(JSON.stringify({ ok: true, command: 'inspect', engine: 'ts-core', ...report }, null, 2))
        return
      }
      const res = await runPythonEngine('qa', { inputPath: file, fix: false })
      console.log(JSON.stringify({ ...res, command: 'inspect' }, null, 2))
    })

  program
    .command('qa <file>')
    .description('Run topology & CRS quality checks on a vector dataset and optionally repair geometries')
    .option('--fix', 'Repair unclosed rings, winding order, and self-intersections', false)
    .option('-o, --output <path>', 'Output file path when --fix is enabled')
    .option('--projected', 'Disable WGS84 [-180..180, -90..90] coordinate bounds check', false)
    .action(async (file: string, opts: { fix: boolean; output?: string; projected: boolean }) => {
      const fmt = detectFormatFromPath(file)
      if (fmt === 'geojson' || fmt === undefined) {
        const raw = fs.readFileSync(file, 'utf8')
        const fc = parseLightVectorText(raw, 'geojson')
        const { report, geojson } = runGeometryQa(fc, {
          fix: opts.fix,
          expectWgs84: !opts.projected,
        })
        let outPath: string | undefined
        if (opts.fix) {
          const target = opts.output ?? file.replace(/(\.geojson|\.json)?$/i, '_fixed.geojson')
          assertDistinctOutput(file, target)
          outPath = writeGeoJsonFile(target, geojson)
        }
        console.log(
          JSON.stringify(
            {
              ok: true,
              status: 'completed',
              command: 'qa',
              engine: 'ts-core',
              outputPath: outPath ? path.resolve(outPath) : undefined,
              ...report,
            },
            null,
            2,
          ),
        )
        return
      }

      const res = await runPythonEngine('qa', {
        inputPath: file,
        outputPath: opts.output,
        fix: opts.fix,
      })
      console.log(JSON.stringify(res, null, 2))
    })
}
