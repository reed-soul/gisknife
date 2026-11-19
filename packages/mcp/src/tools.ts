import fs from 'node:fs'
import path from 'node:path'
import {
  convertCsvFile,
  convertLightVectorFile,
  convertPoints,
  detectFormatFromPath,
  fetchBoundary,
  fetchOsm,
  inspectGeoJson,
  isLightFormat,
  parseCoordinateInput,
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

export type HeavyEngineRunner = (
  op: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>

export interface RegisterMcpToolsOptions {
  heavyRunner?: HeavyEngineRunner
}

function jsonToolResponse(payload: unknown) {
  return {
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
        const out = args.outputPath ?? args.csvInputPath.replace(/\.csv$/i, `_${args.toCrs}.csv`)
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
        const out = args.outputPath ?? args.geojsonInputPath.replace(/\.geojson$/i, `_${args.toCrs}.geojson`)
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
        return jsonToolResponse({ ok: true, ...res })
      }
      throw new Error('Provide one of coordinates, csvInputPath, or geojsonInputPath.')
    },
  )

  server.registerTool(
    'gis_fetch_boundary',
    {
      title: 'Fetch Administrative Boundary',
      description:
        'Fetch administrative boundary GeoJSON (Global, US Census TIGER, China province/city/district via DataV, China street/subdistrict via Overpass/Index) and write to disk.',
      inputSchema: {
        query: z.string().describe('Place name, e.g., "Washington", "Washington, D.C.", "佛山", "深圳南山区"'),
        outputPath: z.string().describe('Target GeoJSON path on disk'),
        level: z.enum(['country', 'state', 'province', 'city', 'district', 'street', 'county']).optional(),
        subdivisions: z.boolean().optional().default(false),
        toWgs84: z.boolean().optional().default(true),
        pickFirst: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      const res = await fetchBoundary(args.query, {
        level: args.level,
        subdivisions: args.subdivisions,
        toWgs84: args.toWgs84,
        pickFirst: args.pickFirst,
        outputPath: args.outputPath,
      })
      return jsonToolResponse(res)
    },
  )

  server.registerTool(
    'gis_fetch_osm',
    {
      title: 'Fetch OSM / Overture Vector Data',
      description:
        'Fetch OpenStreetMap roads, buildings, POIs, water, or landuse by place or BBox; routes large metro areas to Overture Maps S3 if Python engine is configured.',
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
      if (routeData?.route === 'overture-s3' && options.heavyRunner) {
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
      const fc = readGeoJsonFile(args.inputPath)
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
        const fc = convertLightVectorFile(args.inputPath, args.outputPath, src, dst)
        return jsonToolResponse({
          ok: true,
          engine: 'ts-core',
          outputPath: path.resolve(args.outputPath),
          ...summarizeGeoJson(fc),
        })
      }
      if (!options.heavyRunner) {
        throw new Error('Heavy format conversion requires the Python uvx engine runner.')
      }
      const res = await options.heavyRunner('convert', {
        inputPath: args.inputPath,
        outputPath: args.outputPath,
      })
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
        outputPath: z.string(),
      },
    },
    async (args) => {
      if (!options.heavyRunner) {
        throw new Error('DuckDB Spatial SQL requires the Python uvx engine runner.')
      }
      const res = await options.heavyRunner('sql', {
        sql: args.sql,
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
      if (args.useLocalFallback) {
        const picked = await startEphemeralPicker({
          mode: args.mode,
          initialBbox: args.initialBbox,
          openBrowser: true,
        })
        return jsonToolResponse({ ok: true, source: 'ephemeral-picker', ...picked })
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
      const resolvedHtml = writePreviewHtmlFile(args.outputHtmlPath, fc, { title: args.title })
      return jsonToolResponse({
        ok: true,
        outputPath: resolvedHtml,
        ...summarizeGeoJson(fc),
      })
    },
  )
}
