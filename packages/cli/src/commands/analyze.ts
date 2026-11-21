import path from 'node:path'
import {
  detectFormatFromPath,
  assertDistinctOutput,
  readGeoJsonFile,
  runTurfOperator,
  summarizeGeoJson,
  writeGeoJsonFile,
  type TurfOpName,
} from '@gisknife/core'
import type { Command } from 'commander'
import { runPythonEngine } from '../engineBridge.js'

const TS_TURF_OPS = new Set<string>([
  'buffer',
  'simplify',
  'centroid',
  'bbox',
  'dissolve',
  'union',
  'intersect',
  'difference',
  'measure',
  'grid-square',
  'grid-hex',
])

export function registerAnalyzeCommands(program: Command): void {
  program
    .command('analyze <op> <input>')
    .description('Run spatial analysis (buffer, simplify, centroid, bbox, dissolve, union, intersect, difference, clip, spatial-join, measure, grid-square, grid-hex)')
    .option('--second <path>', 'Second vector input file (for clip/intersect/union/difference/spatial-join)')
    .option('-o, --output <path>', 'Output file path')
    .option('--distance <meters>', 'Buffer distance in meters', '500')
    .option('--tolerance <val>', 'Simplify tolerance', '0.0005')
    .option('--cell-size <meters>', 'Grid cell size in meters', '1000')
    .option('--dissolve-by <field>', 'Attribute property name for dissolve')
    .option('--engine <engine>', 'Execution engine: auto|ts|python', 'auto')
    .action(
      async (
        op: string,
        input: string,
        opts: {
          second?: string
          output?: string
          distance: string
          tolerance: string
          cellSize: string
          dissolveBy?: string
          engine: string
        },
      ) => {
        const srcFmt = detectFormatFromPath(input)
        const dstFmt = opts.output ? detectFormatFromPath(opts.output) : 'geojson'
        const needsPython =
          opts.engine === 'python' ||
          op === 'clip' ||
          op === 'spatial-join' ||
          (srcFmt && srcFmt !== 'geojson') ||
          (dstFmt && dstFmt !== 'geojson')

        if (!needsPython && TS_TURF_OPS.has(op)) {
          const fc = readGeoJsonFile(input)
          const second = opts.second ? readGeoJsonFile(opts.second) : undefined
          const res = runTurfOperator(op as TurfOpName, fc, {
            distanceMeters: Number(opts.distance),
            tolerance: Number(opts.tolerance),
            cellSizeMeters: Number(opts.cellSize),
            dissolveProperty: opts.dissolveBy,
            secondGeoJson: second,
          })

          let outPath: string | undefined
          if (res.geojson) {
            const target = opts.output ?? input.replace(/(\.geojson|\.json)?$/i, `_${op}.geojson`)
            assertDistinctOutput(input, target)
            if (opts.second) assertDistinctOutput(opts.second, target)
            outPath = writeGeoJsonFile(target, res.geojson)
          }

          console.log(
            JSON.stringify(
              {
                ok: true,
                status: 'completed',
                command: `analyze ${op}`,
                engine: 'ts-core',
                outputPath: outPath ? path.resolve(outPath) : undefined,
                measure: res.measure,
                warnings: res.warnings,
                ...(res.geojson ? summarizeGeoJson(res.geojson) : {}),
              },
              null,
              2,
            ),
          )
          return
        }

        const outFile = opts.output ?? input.replace(/(\.[^.]+)$/, `_${op}.geojson`)
        const pyRes = await runPythonEngine('analyze', {
          analysisOp: op,
          inputPath: input,
          outputPath: op === 'measure' ? undefined : outFile,
          secondInputPath: opts.second,
          distanceMeters: Number(opts.distance),
          tolerance: Number(opts.tolerance),
          dissolveBy: opts.dissolveBy,
        })
        console.log(JSON.stringify(pyRes, null, 2))
      },
    )

  program
    .command('sql <query>')
    .description('Execute DuckDB Spatial SQL over local GIS files or remote GeoParquet')
    .option('-o, --output <path>', 'Output file path (.geojson, .gpkg, .parquet, .csv)')
    .option('--result-crs <crs>', 'CRS of SQL result coordinates when the geometry has no CRS tag')
    .action(async (query: string, opts: { output?: string; resultCrs?: string }) => {
      const res = await runPythonEngine('sql', {
        sql: query,
        resultCrs: opts.resultCrs,
        outputPath: opts.output,
      })
      console.log(JSON.stringify(res, null, 2))
    })
}
