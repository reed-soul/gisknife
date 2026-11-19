import fs from 'node:fs'
import path from 'node:path'
import { writeGeoJsonFile, type BBox } from '@gisknife/core'
import { startEphemeralPicker, type PickerMode } from '@gisknife/picker'
import type { Command } from 'commander'

export function registerPickCommand(program: Command): void {
  program
    .command('pick')
    .description('Launch an ephemeral localhost MapLibre picker to draw a BBox/Polygon or drop a local file')
    .option('-m, --mode <mode>', 'Picker mode: bbox|polygon|file', 'bbox')
    .option('--bbox <minLon,minLat,maxLon,maxLat>', 'Initial bounding box')
    .option('--center <lon,lat>', 'Initial map center')
    .option('--no-open', 'Do not auto-open browser')
    .option('-o, --output <path>', 'Write picked GeoJSON or dropped file to disk')
    .option('--timeout <ms>', 'Server timeout in ms', '300000')
    .action(
      async (opts: {
        mode: PickerMode
        bbox?: string
        center?: string
        open: boolean
        output?: string
        timeout: string
      }) => {
        const initialBbox = opts.bbox
          ? (opts.bbox.split(',').map(Number) as BBox)
          : undefined
        const initialCenter = opts.center
          ? (opts.center.split(',').map(Number) as [number, number])
          : undefined

        const result = await startEphemeralPicker({
          mode: opts.mode,
          initialBbox,
          initialCenter,
          openBrowser: opts.open,
          timeoutMs: Number(opts.timeout) || 300_000,
        })

        let writtenPath: string | undefined
        if (!result.cancelled && opts.output) {
          if (result.uploadedFile) {
            const resolved = path.resolve(opts.output)
            fs.mkdirSync(path.dirname(resolved), { recursive: true })
            fs.writeFileSync(resolved, result.uploadedFile.content, 'utf8')
            writtenPath = resolved
          } else if (result.geometry) {
            writtenPath = writeGeoJsonFile(opts.output, {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  properties: { mode: result.mode, bbox: result.bbox },
                  geometry: result.geometry,
                },
              ],
            })
          }
        }

        console.log(
          JSON.stringify(
            {
              ok: !result.cancelled,
              status: result.cancelled ? 'cancelled' : 'completed',
              command: 'pick',
              engine: 'ts-core',
              mode: result.mode,
              bbox: result.bbox,
              outputPath: writtenPath,
              uploadedFileName: result.uploadedFile?.name,
            },
            null,
            2,
          ),
        )
      },
    )
}
