import path from 'node:path'
import {
  fetchBoundary,
  fetchOsm,
  type BBox,
  type BoundarySourcePreference,
  type OsmLayerType,
} from '@gisknife/core'
import { startEphemeralPicker } from '@gisknife/picker'
import type { Command } from 'commander'
import { runPythonEngine } from '../engineBridge.js'

function parseBBoxArg(raw: string): BBox {
  const nums = raw.split(',').map((s) => Number(s.trim()))
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid bbox "${raw}". Expected "minLon,minLat,maxLon,maxLat".`)
  }
  return [nums[0], nums[1], nums[2], nums[3]]
}

function defaultOutPath(prefix: string, ext = 'geojson'): string {
  const safe = prefix.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '_').replace(/^_|_$/g, '') || 'output'
  return path.resolve(process.cwd(), 'gisknife-out', `${safe}.${ext}`)
}

export function registerFetchCommand(program: Command): void {
  const fetchCmd = program
    .command('fetch')
    .description('Fetch online boundaries and OSM / Overture data (Beta; availability and coverage depend on providers)')

  fetchCmd
    .command('boundary <place>')
    .description('Fetch administrative boundary GeoJSON by place name (Beta; verify coverage)')
    .option('-o, --output <path>', 'Output GeoJSON file path')
    .option('-l, --level <level>', 'Admin level: country|state|province|city|district|street|county')
    .option('--subdivisions', 'Fetch child subdivisions (e.g., districts of Foshan)', false)
    .option('--to-wgs84', 'Convert GCJ-02 results (e.g., DataV) to WGS84', true)
    .option('--no-to-wgs84', 'Keep native GCJ-02 coordinates when fetched from DataV')
    .option('--source <source>', 'Provider: auto|datav|overpass|nominatim|tiger|geoboundaries|index|amap|tianditu', 'auto')
    .option('--iso3 <code>', 'ISO3 country code hint for geoBoundaries (e.g. USA, CHN, FRA)')
    .option('--pick-first', 'Auto-select first candidate if place name is ambiguous', false)
    .option('--no-cache', 'Bypass local disk cache')
    .option('--stdout', 'Print full GeoJSON to stdout instead of compact envelope', false)
    .action(
      async (
        place: string,
        opts: {
          output?: string
          level?: 'country' | 'state' | 'province' | 'city' | 'district' | 'street' | 'county'
          subdivisions: boolean
          toWgs84: boolean
          source: BoundarySourcePreference
          iso3?: string
          pickFirst: boolean
          cache: boolean
          stdout: boolean
        },
      ) => {
        const targetPath = opts.stdout
          ? undefined
          : opts.output ?? defaultOutPath(`boundary_${place}`)

        const res = await fetchBoundary(place, {
          level: opts.level,
          subdivisions: opts.subdivisions,
          toWgs84: opts.toWgs84,
          source: opts.source,
          iso3: opts.iso3,
          pickFirst: opts.pickFirst,
          noCache: opts.cache === false,
          outputPath: targetPath,
        })

        if (!res.ok) throw new Error(res.error ?? 'Boundary fetch failed')
        if (opts.stdout && res.data) {
          console.log(JSON.stringify(res.data, null, 2))
          return
        }
        console.log(JSON.stringify(res, null, 2))
      },
    )

  fetchCmd
    .command('osm')
    .description('Fetch OpenStreetMap / Overture features by place, BBox, polygon, or map pick (Beta; verify coverage)')
    .option('--place <name>', 'Place or informal region name (e.g. "Silicon Valley")')
    .option('--bbox <minLon,minLat,maxLon,maxLat>', 'Bounding box in WGS84')
    .option('--polygon <path>', 'Path to GeoJSON polygon used to derive bounding box')
    .option('--pick', 'Launch interactive localhost map picker to draw BBox', false)
    .option('--layers <list>', 'Comma-separated layers: roads,buildings,pois,water,landuse,all', 'roads,buildings')
    .option('--source <source>', 'Source: auto|overpass|overture', 'auto')
    .option('--force-overpass', 'Force Overpass even if area exceeds safe threshold', false)
    .option('-o, --output <path>', 'Output file path (.geojson or .parquet)')
    .option('--no-cache', 'Bypass local disk cache')
    .option('--stdout', 'Print full GeoJSON to stdout', false)
    .action(
      async (opts: {
        place?: string
        bbox?: string
        polygon?: string
        pick: boolean
        layers: string
        source: 'auto' | 'overpass' | 'overture'
        forceOverpass: boolean
        output?: string
        cache: boolean
        stdout: boolean
      }) => {
        let bbox = opts.bbox ? parseBBoxArg(opts.bbox) : undefined
        if (opts.pick) {
          const picked = await startEphemeralPicker({
            mode: 'bbox',
            title: 'Pick OSM Extraction Area',
            initialBbox: bbox,
          })
          if (picked.cancelled || !picked.bbox) {
            console.log(JSON.stringify({ ok: false, status: 'cancelled', command: 'fetch osm' }))
            return
          }
          bbox = picked.bbox
        }

        const layers = opts.layers
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean) as OsmLayerType[]

        const targetPath = opts.stdout
          ? undefined
          : opts.output ?? defaultOutPath(`osm_${opts.place ?? 'bbox'}`, opts.source === 'overture' ? 'parquet' : 'geojson')

        const res = await fetchOsm({
          place: opts.place,
          bbox,
          polygonPath: opts.polygon,
          layers,
          source: opts.source,
          forceOverpass: opts.forceOverpass,
          noCache: opts.cache === false,
          outputPath: targetPath,
        })

        const routeData = res.data as { route?: string; bbox?: BBox; layers?: string[] } | undefined
        if (routeData?.route === 'overture-s3') {
          if (opts.stdout) throw new Error('Overture requires a file output; omit --stdout.')
          const outFile = targetPath ?? defaultOutPath(`overture_${opts.place ?? 'area'}`, 'parquet')
          const heavy = await runPythonEngine('overture_fetch', {
            bbox: routeData.bbox,
            layers: routeData.layers,
            outputPath: outFile,
          })
          console.log(JSON.stringify(heavy, null, 2))
          return
        }

        if (opts.stdout && res.data) {
          console.log(JSON.stringify(res.data, null, 2))
          return
        }
        console.log(JSON.stringify(res, null, 2))
      },
    )
}
