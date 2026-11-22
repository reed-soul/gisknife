import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  convertCsvFile,
  convertLightVectorFileDetailed,
  convertWithEngine,
  assertDistinctOutput,
  crsOutputPath,
  convertPoints,
  detectFormatFromPath,
  fetchBoundary,
  fetchOsm,
  inspectGeoJson,
  isLightFormat,
  parseCoordinateInput,
  parseLightVectorText,
  readGeoJsonFile,
  reprojectGeoJson,
  runGeometryQa,
  runTurfOperator,
  summarizeGeoJson,
  writeGeoJsonFile,
  writePreviewHtmlFile,
  type OsmLayerType,
  type TurfOpName,
} from '@gisknife/core'
import {
  buildMcpAppToolMeta,
  MCP_APP_RESOURCES,
  MCP_APP_URIS,
  readMcpAppResourceHtml,
} from '@gisknife/mcp-apps'
import { startEphemeralPicker } from '@gisknife/picker'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { registerRoadnetMcpTools } from './roadnetTools.js'

export type HeavyEngineRunner = (
  op: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>

export interface RegisterMcpToolsOptions {
  heavyRunner?: HeavyEngineRunner
}

function jsonToolResponse(payload: unknown) {
  return {
    isError: Boolean(payload && typeof payload === 'object' && 'ok' in payload && payload.ok === false),
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  }
}

export function registerGisMcpCapabilities(
  server: McpServer,
  options: RegisterMcpToolsOptions = {},
): void {
  // 1. Register MCP Apps (io.modelcontextprotocol/ui) sandboxed ui:// resources
  for (const res of MCP_APP_RESOURCES) {
    server.registerResource(
      res.name,
      res.uri,
      {
        title: res.title,
        description: res.description,
        mimeType: res.mimeType,
      },
      async () => {
        const html = readMcpAppResourceHtml(res.uri)
        if (!html) {
          throw new Error(`Unknown MCP App resource URI: ${res.uri}`)
        }
        return {
          contents: [
            {
              uri: res.uri,
              mimeType: res.mimeType,
              text: html,
              _meta: { ui: { csp: { resourceDomains: ['https://unpkg.com', 'https://tile.openstreetmap.org'], connectDomains: ['https://tile.openstreetmap.org', 'https://unpkg.com'] } } },
            },
          ],
        }
      },
    )
  }

  // 2. Concise, high-leverage GIS tools (compact JSON envelope outputs)
  server.registerTool(
    'gis_crs_convert',
    {
      _meta: buildMcpAppToolMeta(MCP_APP_URIS.crsDisambiguator),
      title: 'CRS Coordinate / CSV / GeoJSON Converter',
      description:
        'Convert coordinate strings, CSV files (preserving all business columns), or GeoJSON across WGS84, EPSG, CGCS2000 (4547/4526), GCJ-02, and BD-09 with automatic zone-prefix and XY-swap sniffing.',
      inputSchema: {
        fromCrs: z.string().describe('Source CRS (e.g., EPSG:4547, EPSG:4526, WGS84, GCJ02, BD09)'),
        toCrs: z.string().describe('Target CRS (e.g., WGS84, EPSG:4326, EPSG:3857, GCJ02)'),
        coordinates: z.string().optional().describe('Coordinate string (e.g. "500000,2500000" or WKT/DMS)'),
        csvInputPath: z.string().optional().describe('Input CSV file path for batch coordinate rewriting'),
        geojsonInputPath: z.string().optional().describe('Input GeoJSON file path for reprojection'),
        outputPath: z.string().optional().describe('Output file path (required for CSV/GeoJSON)'),
        mode: z.enum(['append', 'overwrite']).optional().default('append'),
        swapAxes: z.boolean().optional().default(false),
        autoFix: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      if (args.csvInputPath) {
        const out = args.outputPath ?? crsOutputPath(args.csvInputPath, args.toCrs, 'csv')
        const summary = convertCsvFile(args.csvInputPath, out, {
          fromCrs: args.fromCrs,
          toCrs: args.toCrs,
          mode: args.mode,
          swapInputAxes: args.swapAxes,
          autoFixSniffed: args.autoFix,
        })
        return jsonToolResponse({ ok: true, outputPath: path.resolve(out), ...summary })
      }
      if (args.geojsonInputPath) {
        const out = args.outputPath ?? crsOutputPath(args.geojsonInputPath, args.toCrs, 'geojson')
        assertDistinctOutput(args.geojsonInputPath, out)
        const fc = readGeoJsonFile(args.geojsonInputPath)
        const res = reprojectGeoJson(fc, args.fromCrs, args.toCrs, {
          swapInputAxes: args.swapAxes,
          autoFixSniffed: args.autoFix,
        })
        writeGeoJsonFile(out, res.geojson)
        return jsonToolResponse({
          ok: true,
          outputPath: path.resolve(out),
          crs: res.toCrs,
          warnings: res.warnings,
          ...summarizeGeoJson(res.geojson),
        })
      }
      if (args.coordinates) {
        const pts = parseCoordinateInput(args.coordinates)
        const res = convertPoints(pts, args.fromCrs, args.toCrs, {
          swapInputAxes: args.swapAxes,
          autoFixSniffed: args.autoFix,
        })
        const valid = res.points.every(point => point.output.every(Number.isFinite))
        return { ...jsonToolResponse(valid ? { ok: true, ...res } : { ok: false, status: 'disambiguation_required', warnings: res.warnings }), structuredContent: { declaredCrs: res.fromCrs, warnings: res.warnings } }
      }
      throw new Error('Provide one of coordinates, csvInputPath, or geojsonInputPath.')
    },
  )

  server.registerTool(
    'gis_fetch_boundary',
    {
      title: 'Fetch Administrative Boundary (Beta)',
      description:
        'Beta: Fetch administrative boundary GeoJSON from online providers and write to disk. Availability and coverage vary, especially for street-level boundaries. Verify the result before use.',
      inputSchema: {
        query: z.string().describe('Place name, e.g., "Washington", "Washington, D.C.", "佛山", "深圳南山区"'),
        outputPath: z.string().describe('Target GeoJSON path on disk'),
        level: z.enum(['country', 'state', 'province', 'city', 'district', 'street', 'county']).optional(),
        subdivisions: z.boolean().optional().default(false),
        toWgs84: z.boolean().optional().default(true),
        pickFirst: z.boolean().optional().default(false),
        source: z.enum(['auto', 'datav', 'overpass', 'nominatim', 'tiger', 'geoboundaries', 'index', 'amap', 'tianditu']).optional(),
        iso3: z.string().optional(),
        noCache: z.boolean().optional(),
      },
    },
    async (args) => {
      const res = await fetchBoundary(args.query, {
        level: args.level,
        subdivisions: args.subdivisions,
        toWgs84: args.toWgs84,
        pickFirst: args.pickFirst,
        source: args.source,
        iso3: args.iso3,
        noCache: args.noCache,
        outputPath: args.outputPath,
      })
      return jsonToolResponse(res)
    },
  )

  server.registerTool(
    'gis_fetch_osm',
    {
      title: 'Fetch OSM / Overture Vector Data (Beta)',
      description:
        'Beta: Fetch roads, buildings, POIs, water, or land use by place or BBox; large areas can use Overture Maps with the Python engine. Availability and coverage depend on the provider.',
      inputSchema: {
        outputPath: z.string().describe('Target output file path (.geojson or .parquet)'),
        place: z.string().optional(),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
        layers: z.array(z.enum(['roads', 'buildings', 'pois', 'water', 'landuse', 'all'])).optional(),
        source: z.enum(['auto', 'overpass', 'overture']).optional().default('auto'),
        forceOverpass: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      const res = await fetchOsm({
        place: args.place,
        bbox: args.bbox,
        layers: args.layers as OsmLayerType[] | undefined,
        source: args.source,
        forceOverpass: args.forceOverpass,
        outputPath: args.outputPath,
      })
      const routeData = res.data as { route?: string; bbox?: number[]; layers?: string[] } | undefined
      if (routeData?.route === 'overture-s3') {
        if (!options.heavyRunner) throw new Error('Overture requires the Python engine; start gisknife mcp with uv installed')
        const heavy = await options.heavyRunner('overture_fetch', {
          bbox: routeData.bbox,
          layers: routeData.layers,
          outputPath: args.outputPath,
        })
        return jsonToolResponse(heavy)
      }
      return jsonToolResponse(res)
    },
  )

  server.registerTool(
    'gis_inspect',
    {
      title: 'Inspect & QA Spatial Layer',
      description: 'Inspect schema, CRS hint, BBox, and optionally run topology QA/repair on a vector file.',
      inputSchema: {
        inputPath: z.string(),
        qa: z.boolean().optional().default(false),
        fix: z.boolean().optional().default(false),
        outputPath: z.string().optional(),
      },
    },
    async (args) => {
      const format = detectFormatFromPath(args.inputPath)
      if (!format) throw new Error('Unsupported input format')
      if (!isLightFormat(format)) {
        if (!options.heavyRunner) throw new Error('Use gisknife mcp with uv to inspect this format')
        if (format === 'geotiff' && (args.qa || args.fix)) throw new Error('GeoTIFF supports metadata inspection only')
        return jsonToolResponse(await options.heavyRunner(format === 'geotiff' ? 'raster_inspect' : 'qa', { inputPath: args.inputPath, fix: args.fix, outputPath: args.fix ? args.outputPath : undefined }))
      }
      const fc = parseLightVectorText(fs.readFileSync(args.inputPath, 'utf8'), format)
      const stat = fs.statSync(args.inputPath)
      const inspect = inspectGeoJson(fc, {
        filePath: args.inputPath,
        fileSizeBytes: stat.size,
        format: detectFormatFromPath(args.inputPath) ?? 'geojson',
      })
      if (!args.qa && !args.fix) {
        return jsonToolResponse({ ok: true, inspect })
      }
      const qa = runGeometryQa(fc, { fix: args.fix })
      let writtenPath: string | undefined
      if (args.fix && args.outputPath) {
        if (!/\.(geojson|json)$/i.test(args.outputPath)) throw new Error('Choose a .geojson output for the repaired layer')
        assertDistinctOutput(args.inputPath, args.outputPath)
        writtenPath = writeGeoJsonFile(args.outputPath, qa.geojson)
      }
      return jsonToolResponse({ ok: true, inspect, qa: qa.report, outputPath: writtenPath })
    },
  )

  server.registerTool(
    'gis_convert',
    {
      title: 'Convert Vector / Heavy GIS Format',
      description:
        'Convert between GeoJSON, CSV, KML, GPX, WKT, TopoJSON (TS fast-path) or Shapefile/.zip, GeoPackage, GeoParquet, FlatGeobuf, DXF (Python uvx engine).',
      inputSchema: {
        inputPath: z.string(),
        outputPath: z.string(),
      },
    },
    async (args) => {
      const src = detectFormatFromPath(args.inputPath)
      const dst = detectFormatFromPath(args.outputPath)
      if (isLightFormat(src) && isLightFormat(dst)) {
        const { written: fc, inputFeatureCount } = convertLightVectorFileDetailed(args.inputPath, args.outputPath, src, dst)
        return jsonToolResponse({
          ok: true,
          engine: 'ts-core',
          outputPath: path.resolve(args.outputPath),
          inputFeatureCount,
          ...summarizeGeoJson(fc),
        })
      }
      if (!options.heavyRunner) {
        throw new Error('Heavy format conversion requires the Python uvx engine runner.')
      }
      const res = await convertWithEngine(args.inputPath, args.outputPath, options.heavyRunner)
      return jsonToolResponse(res)
    },
  )

  server.registerTool(
    'gis_analyze',
    {
      title: 'Spatial Analysis Operator',
      description: 'Run unit-safe Turf operations (buffer, simplify, centroid, bbox, dissolve, measure, grid-hex, grid-square).',
      inputSchema: {
        op: z.enum([
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
        ]),
        inputPath: z.string(),
        secondInputPath: z.string().optional(),
        outputPath: z.string().optional(),
        distanceMeters: z.number().optional(),
        tolerance: z.number().optional(),
        cellSizeMeters: z.number().optional(),
      },
    },
    async (args) => {
      const fc = readGeoJsonFile(args.inputPath)
      const second = args.secondInputPath ? readGeoJsonFile(args.secondInputPath) : undefined
      const result = runTurfOperator(args.op as TurfOpName, fc, {
        distanceMeters: args.distanceMeters,
        tolerance: args.tolerance,
        cellSizeMeters: args.cellSizeMeters,
        secondGeoJson: second,
      })
      let outPath: string | undefined
      if (result.geojson && args.outputPath) {
        assertDistinctOutput(args.inputPath, args.outputPath)
        if (args.secondInputPath) assertDistinctOutput(args.secondInputPath, args.outputPath)
        outPath = writeGeoJsonFile(args.outputPath, result.geojson)
      }
      return jsonToolResponse({
        ok: true,
        engine: 'ts-core',
        outputPath: outPath,
        measure: result.measure,
        warnings: result.warnings,
        ...(result.geojson ? summarizeGeoJson(result.geojson) : {}),
      })
    },
  )

  server.registerTool(
    'gis_spatial_sql',
    {
      title: 'DuckDB Spatial SQL',
      description: 'Execute DuckDB Spatial SQL over local GIS files or remote GeoParquet and write results to disk.',
      inputSchema: {
        sql: z.string(),
        resultCrs: z.string().optional(),
        outputPath: z.string(),
      },
    },
    async (args) => {
      if (!options.heavyRunner) {
        throw new Error('DuckDB Spatial SQL requires the Python uvx engine runner.')
      }
      const res = await options.heavyRunner('sql', {
        sql: args.sql,
        resultCrs: args.resultCrs,
        outputPath: args.outputPath,
      })
      return jsonToolResponse(res)
    },
  )

  server.registerTool(
    'gis_pick_area',
    {
      title: 'Interactive Map Area / File Picker',
      description:
        'Open an interactive map picker (via MCP Apps ui://gisknife/picker when supported, or ephemeral localhost fallback) to draw a BBox/Polygon or drop a local file.',
      inputSchema: {
        mode: z.enum(['bbox', 'polygon', 'file']).optional().default('bbox'),
        initialBbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
        useLocalFallback: z.boolean().optional().default(false),
      },
      _meta: buildMcpAppToolMeta(MCP_APP_URIS.picker),
    },
    async (args) => {
      const capabilities = server.server.getClientCapabilities()
      if (args.useLocalFallback || args.mode !== 'bbox' || !capabilities?.extensions?.['io.modelcontextprotocol/ui']) {
        const picked = await startEphemeralPicker({
          mode: args.mode,
          initialBbox: args.initialBbox,
          openBrowser: true,
          timeoutMs: 300_000,
        })
        if (picked.uploadedFile && !picked.cancelled) {
          const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gisknife-picked-'))
          const outputPath = path.join(directory, path.basename(picked.uploadedFile.name))
          fs.writeFileSync(outputPath, picked.uploadedFile.content, { flag: 'wx', mode: 0o600 })
          return jsonToolResponse({ ok: true, source: 'ephemeral-picker', outputPath })
        }
        return jsonToolResponse({ ok: !picked.cancelled, source: 'ephemeral-picker', ...picked, uploadedFile: undefined })
      }
      return jsonToolResponse({
        ok: true,
        status: 'picker_ready',
        resourceUri: MCP_APP_URIS.picker,
        message: 'Render the linked MCP App resource ui://gisknife/picker or re-run with useLocalFallback=true.',
      })
    },
  )

  server.registerTool(
    'gis_preview',
    {
      title: 'Generate Visual QA HTML Map',
      description: 'Generate a standalone interactive HTML MapLibre QA preview for a GeoJSON file.',
      inputSchema: {
        inputPath: z.string(),
        outputHtmlPath: z.string(),
        title: z.string().optional(),
      },
      _meta: buildMcpAppToolMeta(MCP_APP_URIS.preview),
    },
    async (args) => {
      const fc = readGeoJsonFile(args.inputPath)
      assertDistinctOutput(args.inputPath, args.outputHtmlPath)
      const resolvedHtml = writePreviewHtmlFile(args.outputHtmlPath, fc, { title: args.title })
      const summary = { ...summarizeGeoJson(fc), crs: inspectGeoJson(fc).crsHint }
      return { ...jsonToolResponse({
        ok: true,
        outputPath: resolvedHtml,
        ...summary,
      }), structuredContent: summary, _meta: { geojson: fc } }
    },
  )

  registerRoadnetMcpTools(server, options.heavyRunner)
}
