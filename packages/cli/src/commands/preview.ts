import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  detectFormatFromPath,
  assertDistinctOutput,
  isLightFormat,
  parseLightVectorText,
  summarizeGeoJson,
  writePreviewHtmlFile,
} from '@gisknife/core'
import { openUrlInBrowser } from '@gisknife/picker'
import type { Command } from 'commander'
import { runPythonEngine } from '../engineBridge.js'

export function registerPreviewCommand(program: Command): void {
  program
    .command('preview <file>')
    .description('Generate a self-contained single-file MapLibre GL HTML visual QA preview')
    .option('-o, --output <path>', 'Output HTML path')
    .option('--title <title>', 'Map header title')
    .option('--crs <crs>', 'CRS badge label', 'EPSG:4326')
    .option('--open', 'Open the generated HTML preview in default browser', false)
    .action(
      async (
        file: string,
        opts: { output?: string; title?: string; crs: string; open: boolean },
      ) => {
        const fmt = detectFormatFromPath(file)
        let fc
        if (isLightFormat(fmt)) {
          fc = parseLightVectorText(fs.readFileSync(file, 'utf8'), fmt)
        } else {
          const tmpGeoJson = path.join(os.tmpdir(), `gisknife-preview-${Date.now()}.geojson`)
          await runPythonEngine('convert', {
            inputPath: file,
            outputPath: tmpGeoJson,
            targetCrs: 'EPSG:4326',
          })
          fc = parseLightVectorText(fs.readFileSync(tmpGeoJson, 'utf8'), 'geojson')
          fs.rmSync(tmpGeoJson, { force: true })
        }

        const outHtml =
          opts.output ??
          path.resolve(path.dirname(file), `${path.basename(file, path.extname(file))}_preview.html`)
        assertDistinctOutput(file, outHtml)
        const written = writePreviewHtmlFile(outHtml, fc, {
          title: opts.title ?? path.basename(file),
          crs: opts.crs,
        })

        if (opts.open) {
          openUrlInBrowser(`file://${written}`)
        }

        console.log(
          JSON.stringify(
            {
              ok: true,
              status: 'completed',
              command: 'preview',
              engine: 'ts-core',
              outputPath: written,
              ...summarizeGeoJson(fc),
            },
            null,
            2,
          ),
        )
      },
    )
}
