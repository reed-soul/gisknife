/**
 * `@gisknife/mcp` 的路网（Roadnet）工具集：
 * - `gis_roadnet_fetch`（Beta）
 * - `gis_roadnet_build`
 * - `gis_roadnet_command`（含破坏性操作 confirmed 门禁）
 * - `gis_roadnet_export`
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertDistinctOutput,
  convertLightVectorFileDetailed,
  convertWithEngine,
  detectFormatFromPath,
  fetchBoundary,
  isLightFormat,
  parseLightVectorText,
  resolveOsmTarget,
  type BBox,
} from '@gisknife/core'
import {
  bboxAreaKm2,
  exportBlockers,
  fetchOsmBboxXml,
  isDestructive,
  RoadNetError,
  safeName,
  searchPlaceDetailed,
  type BoundingBox,
  type RoadNetCommand,
} from '@gisknife/roadnet'
import {
  buildRoadnetFromOsmXml,
  buildRoadnetFromPlainXml,
  openRoadnetFromPlainXml,
  openRoadnetFromProjectJson,
  writeRoadnetOutputs,
  type BuiltRoadnetResult,
  type NodeRoadnetSession,
} from '@gisknife/roadnet/node'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MultiPolygon, Polygon, Position } from 'geojson'
import { z } from 'zod'
import type { HeavyEngineRunner } from './tools.js'

const ODBL_COMPLIANCE_NOTE =
  'Data © OpenStreetMap contributors (ODbL 1.0): https://www.openstreetmap.org/copyright'

function jsonToolResponse(payload: unknown) {
  return {
    isError: Boolean(payload && typeof payload === 'object' && 'ok' in payload && payload.ok === false),
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  }
}

function errorResponse(command: string, err: unknown) {
  const code = err instanceof RoadNetError ? err.code : 'ROADNET_ERROR'
  const error = err instanceof Error ? err.message : String(err)
  return jsonToolResponse({ ok: false, status: 'error', command, code, error })
}

function toBoundingBox(bbox: BBox): BoundingBox {
  return { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] }
}

function extractClipAndBboxFromGeoJson(raw: unknown): { bbox: BBox; clipPolygon: Polygon | MultiPolygon } {
  const polygons: Polygon[] = []
  const visit = (geom: unknown): void => {
    if (!geom || typeof geom !== 'object') return
    const g = geom as { type?: string; coordinates?: unknown; geometries?: unknown[] }
    if (g.type === 'Polygon') polygons.push(g as Polygon)
    else if (g.type === 'MultiPolygon') {
      for (const coords of (g as MultiPolygon).coordinates) {
        polygons.push({ type: 'Polygon', coordinates: coords })
      }
    } else if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) {
      for (const child of g.geometries) visit(child)
    }
  }

  const obj = raw as { type?: string; geometry?: unknown; features?: Array<{ geometry?: unknown }> }
  if (obj?.type === 'FeatureCollection' && Array.isArray(obj.features)) {
    for (const f of obj.features) visit(f.geometry)
  } else if (obj?.type === 'Feature') {
    visit(obj.geometry)
  } else {
    visit(obj)
  }

  if (polygons.length === 0) {
    throw new RoadNetError({
      code: 'INVALID_ARGUMENT',
      message: 'Boundary/polygon GeoJSON does not contain any Polygon or MultiPolygon geometry.',
    })
  }

  const clipPolygon: Polygon | MultiPolygon =
    polygons.length === 1
      ? polygons[0]
      : { type: 'MultiPolygon', coordinates: polygons.map((p) => p.coordinates) }

  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  const walk = (pos: Position) => {
    if (pos[0] < west) west = pos[0]
    if (pos[0] > east) east = pos[0]
    if (pos[1] < south) south = pos[1]
    if (pos[1] > north) north = pos[1]
  }
  const ringSource = clipPolygon.type === 'Polygon' ? [clipPolygon.coordinates] : clipPolygon.coordinates
  for (const poly of ringSource) {
    for (const ring of poly) {
      for (const pos of ring) walk(pos)
    }
  }

  return { bbox: [west, south, east, north], clipPolygon }
}

function loadPolygonFile(polygonPath: string): { bbox: BBox; clipPolygon: Polygon | MultiPolygon } {
  const fmt = detectFormatFromPath(polygonPath)
  const text = fs.readFileSync(polygonPath, 'utf8')
  const parsed =
    fmt && isLightFormat(fmt) && fmt !== 'geojson'
      ? parseLightVectorText(text, fmt)
      : (JSON.parse(text) as unknown)
  return extractClipAndBboxFromGeoJson(parsed)
}

function loadPlainXmlFiles(inputPath: string): {
  files: { nod: string; edg: string; con?: string; tll?: string }
  defaultProjectId: string
} {
  const resolved = path.resolve(inputPath)
  const stat = fs.statSync(resolved)
  let nodPath: string
  let prefix: string
  if (stat.isDirectory()) {
    const nodFiles = fs.readdirSync(resolved).filter((f) => f.endsWith('.nod.xml')).sort()
    if (nodFiles.length === 0) {
      throw new RoadNetError({
        code: 'INVALID_ARGUMENT',
        message: `Directory does not contain a *.nod.xml file: ${resolved}`,
      })
    }
    nodPath = path.join(resolved, nodFiles[0])
    prefix = nodPath.slice(0, -'.nod.xml'.length)
  } else if (resolved.endsWith('.nod.xml')) {
    nodPath = resolved
    prefix = resolved.slice(0, -'.nod.xml'.length)
  } else {
    throw new RoadNetError({
      code: 'INVALID_ARGUMENT',
      message: `Expected directory or *.nod.xml file, got ${resolved}`,
    })
  }

  const edgPath = `${prefix}.edg.xml`
  if (!fs.existsSync(edgPath)) {
    throw new RoadNetError({ code: 'INVALID_ARGUMENT', message: `Missing companion edge file: ${edgPath}` })
  }
  const conPath = `${prefix}.con.xml`
  const tllPath = `${prefix}.tll.xml`
  return {
    files: {
      nod: fs.readFileSync(nodPath, 'utf8'),
      edg: fs.readFileSync(edgPath, 'utf8'),
      con: fs.existsSync(conPath) ? fs.readFileSync(conPath, 'utf8') : undefined,
      tll: fs.existsSync(tllPath) ? fs.readFileSync(tllPath, 'utf8') : undefined,
    },
    defaultProjectId: path.basename(prefix) || 'sumo-import',
  }
}

async function openProjectOrPlain(inputPath: string): Promise<{ session: NodeRoadnetSession; projectId: string }> {
  const resolved = path.resolve(inputPath)
  if (fs.statSync(resolved).isFile() && resolved.endsWith('.json')) {
    const raw = fs.readFileSync(resolved, 'utf8')
    const parsed = JSON.parse(raw) as { projectId?: string }
    const projectId = parsed.projectId ?? (path.basename(resolved).replace(/\.roadnet\.json$/i, '') || 'roadnet')
    const session = await openRoadnetFromProjectJson(raw)
    return { session, projectId }
  }
  const { files, defaultProjectId } = loadPlainXmlFiles(resolved)
  const session = await openRoadnetFromPlainXml(defaultProjectId, files)
  return { session, projectId: defaultProjectId }
}

export function registerRoadnetMcpTools(server: McpServer, heavyRunner?: HeavyEngineRunner): void {
  server.registerTool(
    'gis_roadnet_fetch',
    {
      description:
        'Beta: Fetch OSM roads, traffic signals & turn restrictions via Overpass (<= 300 km2) and write a .roadnet.json project plus optional SUMO plain XML / GeoJSON.',
      inputSchema: {
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
        place: z.string().optional(),
        boundary: z.string().optional(),
        polygonPath: z.string().optional(),
        outputProjectPath: z.string().describe('Output path for .roadnet.json project'),
        plainDir: z.string().optional(),
        geojsonPath: z.string().optional(),
        layer: z.enum(['links', 'nodes', 'junctions', 'all']).optional(),
        maxAreaKm2: z.number().positive().optional(),
        includeRestrictions: z.boolean().optional(),
        synthesizeSignals: z.boolean().optional(),
        fillet: z.boolean().optional(),
        projectId: z.string().optional(),
        countrycodes: z.string().optional(),
      },
    },
    async (args) => {
      try {
        let bbox: BBox | undefined
        let clipPolygon: Polygon | MultiPolygon | undefined
        let inferredId = args.projectId

        if (args.bbox) {
          bbox = args.bbox
        } else if (args.polygonPath) {
          const extracted = loadPolygonFile(args.polygonPath)
          bbox = extracted.bbox
          clipPolygon = extracted.clipPolygon
          inferredId = inferredId ?? path.basename(args.polygonPath, path.extname(args.polygonPath))
        } else if (args.boundary) {
          const res = await fetchBoundary(args.boundary)
          if (res.status === 'disambiguation_required') {
            return jsonToolResponse(res)
          }
          const extracted = extractClipAndBboxFromGeoJson(res.data)
          bbox = extracted.bbox
          clipPolygon = extracted.clipPolygon
          inferredId = inferredId ?? safeName(args.boundary)
        } else if (args.place) {
          if (args.countrycodes) {
            const hits = await searchPlaceDetailed(args.place, { countrycodes: args.countrycodes })
            if (hits.length > 0) {
              const pad = 0.008
              bbox = [hits[0].lon - pad, hits[0].lat - pad, hits[0].lon + pad, hits[0].lat + pad]
            }
          }
          if (!bbox) {
            const resolvedTarget = await resolveOsmTarget({ place: args.place })
            bbox = resolvedTarget.bbox
          }
          inferredId = inferredId ?? safeName(args.place)
        } else {
          throw new RoadNetError({
            code: 'INVALID_ARGUMENT',
            message: 'Specify one target: bbox, place, boundary, or polygonPath.',
          })
        }

        const box = toBoundingBox(bbox)
        const includeRestrictions = args.includeRestrictions ?? true
        const xml = await fetchOsmBboxXml(box, {
          maxAreaKm2: args.maxAreaKm2,
          includeRestrictions,
        })

        const projectId = safeName(inferredId ?? 'osm-roadnet') || 'osm-roadnet'
        const built = await buildRoadnetFromOsmXml(xml, {
          projectId,
          applyRestrictions: includeRestrictions,
          synthesizeSignals: args.synthesizeSignals ?? true,
          fillet: args.fillet ?? true,
          clipPolygon,
        })
        try {
          const outputs = await writeRoadnetOutputs(built.session.core, {
            projectId,
            projectPath: args.outputProjectPath,
            plainDir: args.plainDir,
            geojsonPath: args.geojsonPath,
            geojsonLayer: args.layer ?? 'all',
          })
          return jsonToolResponse({
            ok: true,
            status: 'completed',
            command: 'gis_roadnet_fetch',
            engine: 'roadnet-core',
            projectId,
            bbox,
            areaKm2: Math.round(bboxAreaKm2(box) * 100) / 100,
            outputs,
            osmStats: built.parsed?.stats,
            summary: built.summary,
            restrictionsReport: built.restrictionsReport,
            signalsReport: built.signalsReport,
            precheck: built.precheck,
            findingCount: built.findings.filter((f) => !f.ignored).length,
            complianceNote: ODBL_COMPLIANCE_NOTE,
          })
        } finally {
          await built.session.dispose()
        }
      } catch (err) {
        return errorResponse('gis_roadnet_fetch', err)
      }
    },
  )

  server.registerTool(
    'gis_roadnet_build',
    {
      description:
        'Build, validate, and normalize a drivable road network from an OSM XML file or SUMO plain XML directory/.nod.xml file.',
      inputSchema: {
        inputPath: z.string().describe('Path to .osm/.osm.xml file, SUMO plain directory, or *.nod.xml'),
        outputProjectPath: z.string().describe('Output path for .roadnet.json project'),
        plainDir: z.string().optional(),
        geojsonPath: z.string().optional(),
        layer: z.enum(['links', 'nodes', 'junctions', 'all']).optional(),
        polygonPath: z.string().optional(),
        projectId: z.string().optional(),
        rebuildTopology: z.boolean().optional(),
        applyRestrictions: z.boolean().optional(),
        synthesizeSignals: z.boolean().optional(),
        fillet: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const resolved = path.resolve(args.inputPath)
        const stat = fs.statSync(resolved)
        const clipPolygon = args.polygonPath ? loadPolygonFile(args.polygonPath).clipPolygon : undefined

        let built: BuiltRoadnetResult
        let projectId: string
        if (stat.isDirectory() || resolved.endsWith('.nod.xml')) {
          const { files, defaultProjectId } = loadPlainXmlFiles(resolved)
          projectId = safeName(args.projectId ?? defaultProjectId) || 'sumo-import'
          built = await buildRoadnetFromPlainXml(files, {
            projectId,
            rebuildTopology: args.rebuildTopology,
            synthesizeSignals: args.synthesizeSignals,
            fillet: args.fillet,
            clipPolygon,
          })
        } else {
          const xml = fs.readFileSync(resolved, 'utf8')
          const stem = path.basename(resolved).replace(/\.(osm\.xml|osm|xml)$/i, '')
          projectId = safeName(args.projectId ?? stem) || 'osm-import'
          built = await buildRoadnetFromOsmXml(xml, {
            projectId,
            rebuildTopology: args.rebuildTopology,
            applyRestrictions: args.applyRestrictions,
            synthesizeSignals: args.synthesizeSignals,
            fillet: args.fillet,
            clipPolygon,
          })
        }

        try {
          const outputs = await writeRoadnetOutputs(built.session.core, {
            projectId,
            projectPath: args.outputProjectPath,
            plainDir: args.plainDir,
            geojsonPath: args.geojsonPath,
            geojsonLayer: args.layer ?? 'all',
          })
          return jsonToolResponse({
            ok: true,
            status: 'completed',
            command: 'gis_roadnet_build',
            engine: 'roadnet-core',
            projectId,
            outputs,
            osmStats: built.parsed?.stats,
            summary: built.summary,
            restrictionsReport: built.restrictionsReport,
            signalsReport: built.signalsReport,
            precheck: built.precheck,
            findingCount: built.findings.filter((f) => !f.ignored).length,
            ...(built.parsed ? { complianceNote: ODBL_COMPLIANCE_NOTE } : {}),
          })
        } finally {
          await built.session.dispose()
        }
      } catch (err) {
        return errorResponse('gis_roadnet_build', err)
      }
    },
  )

  server.registerTool(
    'gis_roadnet_command',
    {
      description:
        'Preview or execute a RoadNetCommand on a .roadnet.json project. Destructive commands require confirmed: true after reviewing preview deltas.',
      inputSchema: {
        projectPath: z.string(),
        command: z.record(z.string(), z.unknown()).describe('RoadNetCommand JSON object'),
        outputProjectPath: z.string().optional(),
        dryRun: z.boolean().optional(),
        confirmed: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const cmd = args.command as unknown as RoadNetCommand
        if (!cmd || typeof cmd.command !== 'string') {
          throw new RoadNetError({ code: 'INVALID_ARGUMENT', message: 'command.command string is required.' })
        }

        const opened = await openProjectOrPlain(args.projectPath)
        try {
          const { bus, core } = opened.session
          const destructive = isDestructive(cmd)

          if (args.dryRun || (destructive && !args.confirmed)) {
            const preview = await bus.preview(cmd, 'agent')
            const previewSummary = {
              command: cmd.command,
              destructive: preview.destructive,
              touched: preview.touched,
              operationCount: preview.delta.operations.length,
            }
            if (!args.dryRun) {
              return jsonToolResponse({
                ok: false,
                status: 'confirmation_required',
                command: 'gis_roadnet_command',
                message:
                  'Destructive roadnet command requires confirmed: true after reviewing affected targets.',
                preview: previewSummary,
              })
            }
            return jsonToolResponse({
              ok: true,
              status: 'dry_run',
              command: 'gis_roadnet_command',
              preview: previewSummary,
            })
          }

          let res
          if (destructive) {
            const preview = await bus.preview(cmd, 'user')
            bus.confirmPreview(preview.previewRef)
            const run = bus.execute.bind(bus)
            res = await run(cmd, { previewRef: preview.previewRef })
          } else {
            const run = bus.execute.bind(bus)
            res = await run(cmd, { origin: 'agent' })
          }

          const targetPath = args.outputProjectPath
            ? path.resolve(args.outputProjectPath)
            : path.resolve(args.projectPath.replace(/(\.roadnet\.json|\.json)$/i, '') + '.edited.roadnet.json')

          const written = await writeRoadnetOutputs(core, {
            projectId: opened.projectId,
            projectPath: targetPath,
          })
          const summary = await core.summary()

          return jsonToolResponse({
            ok: true,
            status: 'completed',
            command: 'gis_roadnet_command',
            engine: 'roadnet-core',
            projectId: opened.projectId,
            outputPath: written.projectPath,
            revision: res.revision,
            touched: res.touched.length,
            summary,
          })
        } finally {
          await opened.session.dispose()
        }
      } catch (err) {
        return errorResponse('gis_roadnet_command', err)
      }
    },
  )

  server.registerTool(
    'gis_roadnet_export',
    {
      description:
        'Run export precheck and export a .roadnet.json project to SUMO plain XML, GeoJSON, and/or converted GIS formats.',
      inputSchema: {
        projectPath: z.string(),
        plainDir: z.string().optional(),
        geojsonPath: z.string().optional(),
        layer: z.enum(['links', 'nodes', 'junctions', 'all']).optional(),
        convertPath: z.string().optional(),
        toCrs: z.string().optional(),
        target: z.enum(['sumo', 'opendrive']).optional(),
        version: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    async (args) => {
      let tempGeojsonDir: string | null = null
      try {
        if (!args.plainDir && !args.geojsonPath && !args.convertPath) {
          throw new RoadNetError({
            code: 'INVALID_ARGUMENT',
            message: 'Specify at least one output: plainDir, geojsonPath, or convertPath.',
          })
        }

        const opened = await openProjectOrPlain(args.projectPath)
        try {
          const target = args.target ?? 'sumo'
          const version = args.version ?? '1.27'
          const [exportFindings, precheck] = await Promise.all([
            opened.session.core.checkExport(target, version),
            opened.session.bus.precheckExport(target, version),
          ])
          const blockers = exportBlockers({
            blockingFindings: exportFindings.filter((f) => !f.ignored && f.severity === 'blocking').length,
            openReviewItems: precheck.openReviewItems,
          })
          if (blockers.length > 0 && !args.force) {
            return jsonToolResponse({
              ok: false,
              status: 'blocked',
              command: 'gis_roadnet_export',
              precheck,
              blockers,
              error: 'Export precheck reported blocking findings; pass force: true to override.',
            })
          }

          let effectiveGeojsonPath = args.geojsonPath
          if (args.convertPath && !effectiveGeojsonPath) {
            tempGeojsonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gisknife-mcp-roadnet-'))
            effectiveGeojsonPath = path.join(tempGeojsonDir, `${safeName(opened.projectId)}.geojson`)
          }

          const written = await writeRoadnetOutputs(opened.session.core, {
            projectId: opened.projectId,
            plainDir: args.plainDir,
            geojsonPath: effectiveGeojsonPath,
            geojsonLayer: args.layer ?? 'all',
          })

          let convertedPath: string | undefined
          if (args.convertPath && written.geojsonPath) {
            assertDistinctOutput(written.geojsonPath, args.convertPath)
            const targetFmt = detectFormatFromPath(args.convertPath)
            if (!args.toCrs && isLightFormat(targetFmt)) {
              convertLightVectorFileDetailed(written.geojsonPath, args.convertPath, 'geojson', targetFmt)
            } else if (heavyRunner) {
              await convertWithEngine(written.geojsonPath, args.convertPath, heavyRunner, args.toCrs)
            } else {
              throw new RoadNetError({
                code: 'ENGINE_REQUIRED',
                message: 'Heavy GIS conversion or CRS reprojection requires Python engine runner.',
              })
            }
            convertedPath = path.resolve(args.convertPath)
          }

          return jsonToolResponse({
            ok: true,
            status: 'completed',
            command: 'gis_roadnet_export',
            engine: 'roadnet-core',
            projectId: opened.projectId,
            precheck,
            outputs: {
              plainFiles: written.plainFiles,
              geojsonPath: args.geojsonPath ? written.geojsonPath : undefined,
              convertedPath,
            },
          })
        } finally {
          await opened.session.dispose()
        }
      } catch (err) {
        return errorResponse('gis_roadnet_export', err)
      } finally {
        if (tempGeojsonDir) {
          fs.rmSync(tempGeojsonDir, { recursive: true, force: true })
        }
      }
    },
  )
}
