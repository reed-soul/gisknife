import path from 'node:path'
import {
  convertLightVectorFileDetailed,
  convertWithEngine,
  detectFormatFromPath,
  isLightFormat,
  summarizeGeoJson,
} from '@gisknife/core'
import type { Command } from 'commander'
import { runPythonEngine } from '../engineBridge.js'

export function registerConvertCommand(program: Command): void {
  program
    .command('convert <input>')
    .description('Convert GIS files across GeoJSON, CSV, KML, GPX, WKT, TopoJSON, Shapefile/.zip, GPKG, GeoParquet, FGB, DXF')
    .requiredOption('-o, --output <path>', 'Output file path (extension selects format)')
    .option('--to-crs <crs>', 'Optional target CRS during conversion')
    .option('--engine <engine>', 'Force engine: auto|ts|python', 'auto')
    .action(async (input: string, opts: { output: string; toCrs?: string; engine: string }) => {
      const srcFmt = detectFormatFromPath(input)
      const dstFmt = detectFormatFromPath(opts.output)

      if (opts.engine !== 'python' && !opts.toCrs && isLightFormat(srcFmt) && isLightFormat(dstFmt)) {
        const { written, inputFeatureCount } = convertLightVectorFileDetailed(input, opts.output, srcFmt, dstFmt)
        console.log(
          JSON.stringify(
            {
              ok: true,
              status: 'completed',
              command: 'convert',
              engine: 'ts-core',
              outputPath: path.resolve(opts.output),
              fromFormat: srcFmt,
              toFormat: dstFmt,
              inputFeatureCount,
              ...summarizeGeoJson(written),
            },
            null,
            2,
          ),
        )
        return
      }

      if (opts.engine === 'ts') throw new Error('This conversion requires the Python engine.')
      const res = await convertWithEngine(input, opts.output, runPythonEngine, opts.toCrs)
      console.log(JSON.stringify(res, null, 2))
    })
}
