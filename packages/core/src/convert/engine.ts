import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertDistinctOutput } from '../files.js'
import { convertLightVectorFileDetailed, detectFormatFromPath, isLightFormat } from './formats.js'
import { summarizeGeoJson } from './inspect.js'

export async function convertWithEngine(input: string, output: string, run: (op: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>, targetCrs?: string) {
  assertDistinctOutput(input, output)
  const source = detectFormatFromPath(input), target = detectFormatFromPath(output)
  if (!source || !target || source === 'geotiff' || target === 'geotiff') throw new Error('Expected supported vector formats. Use inspect for GeoTIFF.')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gisknife-convert-'))
  try {
    const stagedInput = isLightFormat(source) && source !== 'geojson' ? path.join(work, 'input.geojson') : input
    if (stagedInput !== input) convertLightVectorFileDetailed(input, stagedInput)
    const stagedOutput = isLightFormat(target) && target !== 'geojson' ? path.join(work, 'output.geojson') : output
    const result = await run('convert', { inputPath: stagedInput, outputPath: stagedOutput, targetCrs })
    if (stagedOutput === output) return result
    if (['gpx', 'kml'].includes(target) && !/^(EPSG:4326|OGC:CRS84)$/i.test(String(result.crs))) throw new Error('GPX and KML require WGS84 coordinates; specify --to-crs EPSG:4326.')
    const { written, inputFeatureCount } = convertLightVectorFileDetailed(stagedOutput, output)
    return { ...result, outputPath: path.resolve(output), inputFeatureCount, ...summarizeGeoJson(written) }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}
