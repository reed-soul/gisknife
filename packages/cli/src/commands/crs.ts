import path from 'node:path'
import {
  convertCsvFile,
  assertDistinctOutput,
  convertPoints,
  parseCoordinateInput,
  readGeoJsonFile,
  reprojectGeoJson,
  searchCrs,
  summarizeGeoJson,
  writeGeoJsonFile,
} from '@gisknife/core'
import type { Command } from 'commander'

export function registerCrsCommand(program: Command): void {
  const crs = program.command('crs').description('CRS search, coordinate string conversion, CSV batch rewrite & GeoJSON reprojection')

  crs
    .command('search <query>')
    .description('Search EPSG and regional CRS definitions')
    .option('-l, --limit <n>', 'Max results', '15')
    .action((query: string, opts: { limit: string }) => {
      const hits = searchCrs(query, Number(opts.limit) || 15)
      console.log(JSON.stringify({ ok: true, command: 'crs search', count: hits.length, results: hits }, null, 2))
    })

  crs
    .command('convert [coordinates]')
    .description('Convert coordinate string, CSV file, or GeoJSON between CRS (WGS84, EPSG:4547/4526, GCJ02, BD09)')
    .requiredOption('-f, --from <crs>', 'Source CRS (e.g., EPSG:4547, WGS84, GCJ02)')
    .requiredOption('-t, --to <crs>', 'Target CRS (e.g., WGS84, EPSG:4326, EPSG:3857)')
    .option('--csv <path>', 'Batch-rewrite a CSV file preserving all non-coordinate columns')
    .option('--file <path>', 'Reproject a GeoJSON file')
    .option('-o, --output <path>', 'Output file path (for --csv or --file)')
    .option('--x-col <name>', 'Explicit CSV X/longitude column name')
    .option('--y-col <name>', 'Explicit CSV Y/latitude column name')
    .option('--mode <mode>', 'CSV rewrite mode: append or overwrite', 'append')
    .option('--swap-axes', 'Swap input X/Y axes before transforming', false)
    .option('--auto-fix', 'Automatically apply sniffer-suggested zone prefix / axis swap', false)
    .option('--precision <digits>', 'Output decimal precision')
    .action(
      (
        coordinates: string | undefined,
        opts: {
          from: string
          to: string
          csv?: string
          file?: string
          output?: string
          xCol?: string
          yCol?: string
          mode: 'append' | 'overwrite'
          swapAxes: boolean
          autoFix: boolean
          precision?: string
        },
      ) => {
        const precision = opts.precision !== undefined ? Number(opts.precision) : undefined

        if (opts.csv) {
          const outPath = opts.output ?? opts.csv.replace(/(\.csv)?$/i, '_converted.csv')
          const summary = convertCsvFile(opts.csv, outPath, {
            fromCrs: opts.from,
            toCrs: opts.to,
            xCol: opts.xCol,
            yCol: opts.yCol,
            mode: opts.mode,
            swapInputAxes: opts.swapAxes,
            autoFixSniffed: opts.autoFix,
            precision,
          })
          console.log(
            JSON.stringify(
              {
                ok: true,
                status: 'completed',
                command: 'crs convert --csv',
                engine: 'ts-core',
                outputPath: path.resolve(outPath),
                ...summary,
              },
              null,
              2,
            ),
          )
          return
        }

        if (opts.file) {
          const outPath = opts.output ?? opts.file.replace(/(\.geojson|\.json)?$/i, '_reprojected.geojson')
          assertDistinctOutput(opts.file, outPath)
          const fc = readGeoJsonFile(opts.file)
          const res = reprojectGeoJson(fc, opts.from, opts.to, {
            swapInputAxes: opts.swapAxes,
            autoFixSniffed: opts.autoFix,
            precision,
          })
          const written = writeGeoJsonFile(outPath, res.geojson)
          console.log(
            JSON.stringify(
              {
                ok: true,
                status: 'completed',
                command: 'crs convert --file',
                engine: 'ts-core',
                outputPath: written,
                crs: res.toCrs,
                fromCrs: res.fromCrs,
                effectiveFromCrs: res.effectiveFromCrs,
                warnings: res.warnings,
                ...summarizeGeoJson(res.geojson),
              },
              null,
              2,
            ),
          )
          return
        }

        if (!coordinates) {
          throw new Error('Provide coordinate string, --csv <path>, or --file <path>.')
        }
        const pts = parseCoordinateInput(coordinates)
        const result = convertPoints(pts, opts.from, opts.to, {
          swapInputAxes: opts.swapAxes,
          autoFixSniffed: opts.autoFix,
          precision,
        })
        if (result.points.some(point => !point.output.every(Number.isFinite))) {
          throw new Error(result.warnings.map(warning => warning.message).join(' ') || 'Invalid projection result')
        }
        console.log(
          JSON.stringify(
            {
              ok: true,
              status: 'completed',
              command: 'crs convert',
              engine: 'ts-core',
              ...result,
            },
            null,
            2,
          ),
        )
      },
    )
}
