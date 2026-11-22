/**
 * `gisknife roadnet` 子命令组：
 * fetch | build | validate | batch | export
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
import { startEphemeralPicker } from '@gisknife/picker'
import {
  bboxAreaKm2,
  exportBlockers,
  fetchOsmBboxXml,
  isDestructive,
  RoadNetError,
  safeName,
  searchPlaceDetailed,
  type AttributePatch,
  type BoundingBox,
  type CoreVariant,
  type Finding,
  type LinkFilter,
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
import type { Command } from 'commander'
import type { MultiPolygon, Polygon, Position } from 'geojson'
import { runPythonEngine } from '../engineBridge.js'

const ODBL_COMPLIANCE_NOTE =
  'Data © OpenStreetMap contributors (ODbL 1.0): https://www.openstreetmap.org/copyright'

type GeoJsonLayerName = 'links' | 'nodes' | 'junctions' | 'all'

function toRoadnetBoundingBox(bbox: BBox): BoundingBox {
  return { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] }
}

function parseBboxArg(raw: string): BBox {
  const parts = raw.split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new RoadNetError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid --bbox "${raw}". Expected "west,south,east,north" numeric WGS84 bounds.`,
    })
  }
  return parts as BBox
}

function collectCoords(geom: Polygon | MultiPolygon, out: Position[]): void {
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) {
      for (const pos of ring) out.push(pos)
    }
  } else {
    for (const poly of geom.coordinates) {
      for (const ring of poly) {
        for (const pos of ring) out.push(pos)
      }
    }
  }
}

function extractClipAndBboxFromGeoJson(raw: unknown): { bbox: BBox; clipPolygon: Polygon | MultiPolygon } {
  const polygons: Polygon[] = []
  const visitGeom = (geom: unknown): void => {
    if (!geom || typeof geom !== 'object') return
    const g = geom as { type?: string; coordinates?: unknown; geometries?: unknown[] }
    if (g.type === 'Polygon') {
      polygons.push(g as Polygon)
    } else if (g.type === 'MultiPolygon') {
      const mp = g as MultiPolygon
      for (const coords of mp.coordinates) {
        polygons.push({ type: 'Polygon', coordinates: coords })
      }
    } else if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) {
      for (const child of g.geometries) visitGeom(child)
    }
  }

  const obj = raw as { type?: string; geometry?: unknown; features?: Array<{ geometry?: unknown }> }
  if (obj?.type === 'FeatureCollection' && Array.isArray(obj.features)) {
    for (const feat of obj.features) visitGeom(feat.geometry)
  } else if (obj?.type === 'Feature') {
    visitGeom(obj.geometry)
  } else {
    visitGeom(obj)
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

  const pts: Position[] = []
  collectCoords(clipPolygon, pts)
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [lon, lat] of pts) {
    if (lon < west) west = lon
    if (lon > east) east = lon
    if (lat < south) south = lat
    if (lat > north) north = lat
  }

  return { bbox: [west, south, east, north], clipPolygon }
}

function loadClipPolygonFile(polygonPath: string): Polygon | MultiPolygon {
  const fmt = detectFormatFromPath(polygonPath)
  const rawText = fs.readFileSync(polygonPath, 'utf8')
  const parsed =
    fmt && isLightFormat(fmt) && fmt !== 'geojson'
      ? parseLightVectorText(rawText, fmt)
      : (JSON.parse(rawText) as unknown)
  return extractClipAndBboxFromGeoJson(parsed).clipPolygon
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
    throw new RoadNetError({
      code: 'INVALID_ARGUMENT',
      message: `Missing companion edge file: ${edgPath}`,
    })
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

async function openRoadnetInput(
  inputPath: string,
  options: { variant?: CoreVariant; projectId?: string } = {},
): Promise<{ session: NodeRoadnetSession; projectId: string; isProjectFile: boolean }> {
  const resolved = path.resolve(inputPath)
  const stat = fs.statSync(resolved)
  if (stat.isFile() && resolved.endsWith('.json')) {
    const raw = fs.readFileSync(resolved, 'utf8')
    const parsed = JSON.parse(raw) as { projectId?: string }
    const projectId = options.projectId ?? parsed.projectId ?? (path.basename(resolved).replace(/\.roadnet\.json$/i, '') || 'roadnet')
    const session = await openRoadnetFromProjectJson(raw, { variant: options.variant })
    return { session, projectId, isProjectFile: true }
  }
  const { files, defaultProjectId } = loadPlainXmlFiles(resolved)
  const projectId = options.projectId ?? defaultProjectId
  const session = await openRoadnetFromPlainXml(projectId, files, { variant: options.variant })
  return { session, projectId, isProjectFile: false }
}

async function exportWithOptionalConvert(
  session: NodeRoadnetSession,
  projectId: string,
  opts: {
    outputPath?: string
    plainDir?: string
    geojsonPath?: string
    layer?: GeoJsonLayerName
    convertPath?: string
    toCrs?: string
    defaultProjectOutput?: boolean
  },
): Promise<{
  projectPath?: string
  plainFiles?: string[]
  geojsonPath?: string
  convertedPath?: string
}> {
  let effectiveProjectPath = opts.outputPath
  if (opts.defaultProjectOutput && !effectiveProjectPath && !opts.plainDir && !opts.geojsonPath && !opts.convertPath) {
    effectiveProjectPath = `${safeName(projectId)}.roadnet.json`
  }

  let tempGeojsonDir: string | null = null
  let effectiveGeojsonPath = opts.geojsonPath
  if (opts.convertPath && !effectiveGeojsonPath) {
    tempGeojsonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gisknife-roadnet-'))
    effectiveGeojsonPath = path.join(tempGeojsonDir, `${safeName(projectId)}.geojson`)
  }

  try {
    const written = await writeRoadnetOutputs(session.core, {
      projectId,
      projectPath: effectiveProjectPath,
      plainDir: opts.plainDir,
      geojsonPath: effectiveGeojsonPath,
      geojsonLayer: opts.layer ?? 'all',
    })

    let convertedPath: string | undefined
    if (opts.convertPath && written.geojsonPath) {
      assertDistinctOutput(written.geojsonPath, opts.convertPath)
      const targetFmt = detectFormatFromPath(opts.convertPath)
      if (!opts.toCrs && isLightFormat(targetFmt)) {
        convertLightVectorFileDetailed(written.geojsonPath, opts.convertPath, 'geojson', targetFmt)
      } else {
        await convertWithEngine(written.geojsonPath, opts.convertPath, runPythonEngine, opts.toCrs)
      }
      convertedPath = path.resolve(opts.convertPath)
    }

    return {
      projectPath: written.projectPath,
      plainFiles: written.plainFiles,
      geojsonPath: opts.geojsonPath ? written.geojsonPath : undefined,
      convertedPath,
    }
  } finally {
    if (tempGeojsonDir) {
      fs.rmSync(tempGeojsonDir, { recursive: true, force: true })
    }
  }
}

function summarizeFindings(findings: Finding[], maxFindings: number): {
  total: number
  bySeverity: Record<string, number>
  byRule: Record<string, number>
  findings: Finding[]
  truncated: boolean
} {
  const bySeverity: Record<string, number> = {}
  const byRule: Record<string, number> = {}
  for (const f of findings) {
    if (f.ignored) continue
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1
  }
  const active = findings.filter((f) => !f.ignored)
  const cap = Math.max(0, maxFindings)
  return {
    total: active.length,
    bySeverity,
    byRule,
    findings: active.slice(0, cap),
    truncated: active.length > cap,
  }
}

function parseJsonArg<T>(raw: string, flagName: string): T {
  const text = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new RoadNetError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid JSON for ${flagName}: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

function printFailure(command: string, err: unknown): void {
  const code = err instanceof RoadNetError ? err.code : 'ROADNET_ERROR'
  const message = err instanceof Error ? err.message : String(err)
  console.log(JSON.stringify({ ok: false, status: 'error', command, code, error: message }, null, 2))
  process.exitCode = 1
}

export function registerRoadnetCommand(program: Command): void {
  const roadnet = program
    .command('roadnet')
    .description(
      'Drivable road network build, OSM traffic-signal & turn-restriction parsing, headless editing, validation, and SUMO/GIS export',
    )

  roadnet
    .command('fetch')
    .description(
      'Beta: Fetch OSM roads, traffic signals & turn restrictions via Overpass and build a roadnet project (<= 300 km2)',
    )
    .option('--place <query>', 'Place name or region to resolve and fetch')
    .option('--boundary <query>', 'Administrative boundary name to fetch and clip the road network')
    .option('--bbox <w,s,e,n>', 'Explicit WGS84 bounding box west,south,east,north')
    .option('--polygon <path>', 'GeoJSON Polygon/MultiPolygon file for area selection & clipping')
    .option('--pick', 'Launch interactive browser map box picker', false)
    .option('--countrycodes <codes>', 'Optional ISO 3166-1 alpha-2 filter for place lookup (global by default)')
    .option('--max-area-km2 <km2>', 'Override Overpass bbox area cap in km2 (default 300)')
    .option('--pick-first', 'Auto-pick top boundary candidate on disambiguation', false)
    .option('--no-restrictions', 'Skip OSM turn restriction relations')
    .option('--no-signals', 'Skip default traffic signal plan synthesis')
    .option('--no-fillet', 'Skip corner filleting')
    .option('--no-rebuild', 'Skip initial topology rebuild')
    .option('-o, --output <path>', 'Output .roadnet.json project path')
    .option('--plain-dir <dir>', 'Output directory for SUMO plain XML (.nod/.edg/.con/.tll)')
    .option('--geojson <path>', 'Output GeoJSON file path')
    .option('--layer <layer>', 'GeoJSON export layer (links|nodes|junctions|all)', 'all')
    .option('--convert <path>', 'Also convert exported GeoJSON to another GIS format (.gpkg/.shp/.fgb/.dxf/...)')
    .option('--to-crs <crs>', 'Target CRS when converting output (e.g. EPSG:4547)')
    .option('--project-id <id>', 'Project ID override')
    .option('--variant <variant>', 'roadnet-core WASM variant (wasm32|memory64)')
    .action(async (opts: {
      place?: string
      boundary?: string
      bbox?: string
      polygon?: string
      pick: boolean
      countrycodes?: string
      maxAreaKm2?: string
      pickFirst: boolean
      restrictions: boolean
      signals: boolean
      fillet: boolean
      rebuild: boolean
      output?: string
      plainDir?: string
      geojson?: string
      layer: GeoJsonLayerName
      convert?: string
      toCrs?: string
      projectId?: string
      variant?: CoreVariant
    }) => {
      try {
        let bbox: BBox | undefined
        let clipPolygon: Polygon | MultiPolygon | undefined
        let inferredId = opts.projectId

        if (opts.bbox) {
          bbox = parseBboxArg(opts.bbox)
        } else if (opts.polygon) {
          const fmt = detectFormatFromPath(opts.polygon)
          const rawText = fs.readFileSync(opts.polygon, 'utf8')
          const parsed =
            fmt && isLightFormat(fmt) && fmt !== 'geojson'
              ? parseLightVectorText(rawText, fmt)
              : (JSON.parse(rawText) as unknown)
          const extracted = extractClipAndBboxFromGeoJson(parsed)
          bbox = extracted.bbox
          clipPolygon = extracted.clipPolygon
          inferredId = inferredId ?? path.basename(opts.polygon, path.extname(opts.polygon))
        } else if (opts.boundary) {
          const res = await fetchBoundary(opts.boundary, { pickFirst: opts.pickFirst })
          if (res.status === 'disambiguation_required') {
            console.log(JSON.stringify(res, null, 2))
            process.exitCode = 1
            return
          }
          const extracted = extractClipAndBboxFromGeoJson(res.data)
          bbox = extracted.bbox
          clipPolygon = extracted.clipPolygon
          inferredId = inferredId ?? safeName(opts.boundary)
        } else if (opts.pick) {
          const picked = await startEphemeralPicker({
            mode: 'bbox',
            title: 'Select Road Network Area (<= 300 km2)',
            openBrowser: true,
          })
          if (picked.cancelled || !picked.bbox) {
            console.log(JSON.stringify({ ok: false, status: 'cancelled', command: 'roadnet fetch' }, null, 2))
            process.exitCode = 1
            return
          }
          bbox = picked.bbox
        } else if (opts.place) {
          if (opts.countrycodes) {
            const places = await searchPlaceDetailed(opts.place, { countrycodes: opts.countrycodes })
            if (places.length > 0) {
              const pad = 0.008
              bbox = [places[0].lon - pad, places[0].lat - pad, places[0].lon + pad, places[0].lat + pad]
            } else {
              const resolvedTarget = await resolveOsmTarget({ place: opts.place })
              bbox = resolvedTarget.bbox
            }
          } else {
            const resolvedTarget = await resolveOsmTarget({ place: opts.place })
            bbox = resolvedTarget.bbox
          }
          inferredId = inferredId ?? safeName(opts.place)
        } else {
          throw new RoadNetError({
            code: 'INVALID_ARGUMENT',
            message: 'Specify one target: --place, --boundary, --bbox, --polygon, or --pick.',
          })
        }

        const box = toRoadnetBoundingBox(bbox)
        const maxAreaKm2 = opts.maxAreaKm2 ? Number(opts.maxAreaKm2) : undefined
        const xml = await fetchOsmBboxXml(box, {
          maxAreaKm2,
          includeRestrictions: opts.restrictions,
        })

        const projectId = safeName(inferredId ?? 'osm-roadnet') || 'osm-roadnet'
        const built: BuiltRoadnetResult = await buildRoadnetFromOsmXml(xml, {
          projectId,
          variant: opts.variant,
          rebuildTopology: opts.rebuild,
          applyRestrictions: opts.restrictions,
          synthesizeSignals: opts.signals,
          fillet: opts.fillet,
          clipPolygon,
        })
        try {
          const outputs = await exportWithOptionalConvert(built.session, projectId, {
            outputPath: opts.output,
            plainDir: opts.plainDir,
            geojsonPath: opts.geojson,
            layer: opts.layer,
            convertPath: opts.convert,
            toCrs: opts.toCrs,
            defaultProjectOutput: true,
          })
          console.log(
            JSON.stringify(
              {
                ok: true,
                status: 'completed',
                command: 'roadnet fetch',
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
              },
              null,
              2,
            ),
          )
        } finally {
          await built.session.dispose()
        }
      } catch (err) {
        printFailure('roadnet fetch', err)
      }
    })

  roadnet
    .command('build <input>')
    .description('Build, validate, and normalize a road network from an OSM XML file or SUMO plain XML directory/prefix')
    .option('-o, --output <path>', 'Output .roadnet.json project path')
    .option('--plain-dir <dir>', 'Output directory for SUMO plain XML')
    .option('--geojson <path>', 'Output GeoJSON file path')
    .option('--layer <layer>', 'GeoJSON export layer (links|nodes|junctions|all)', 'all')
    .option('--convert <path>', 'Convert exported GeoJSON to another GIS format')
    .option('--to-crs <crs>', 'Target CRS when converting output')
    .option('--polygon <path>', 'Optional clip polygon GeoJSON file')
    .option('--project-id <id>', 'Project ID override')
    .option('--no-restrictions', 'Skip applying OSM turn restrictions')
    .option('--no-signals', 'Skip default signal plan synthesis')
    .option('--no-fillet', 'Skip corner filleting')
    .option('--no-rebuild', 'Skip topology rebuild')
    .option('--variant <variant>', 'roadnet-core WASM variant (wasm32|memory64)')
    .action(async (input: string, opts: {
      output?: string
      plainDir?: string
      geojson?: string
      layer: GeoJsonLayerName
      convert?: string
      toCrs?: string
      polygon?: string
      projectId?: string
      restrictions: boolean
      signals: boolean
      fillet: boolean
      rebuild: boolean
      variant?: CoreVariant
    }) => {
      try {
        const resolved = path.resolve(input)
        const stat = fs.statSync(resolved)
        const clipPolygon = opts.polygon ? loadClipPolygonFile(opts.polygon) : undefined

        let built: BuiltRoadnetResult
        let projectId: string
        if (stat.isDirectory() || resolved.endsWith('.nod.xml')) {
          const { files, defaultProjectId } = loadPlainXmlFiles(resolved)
          projectId = safeName(opts.projectId ?? defaultProjectId) || 'sumo-import'
          built = await buildRoadnetFromPlainXml(files, {
            projectId,
            variant: opts.variant,
            rebuildTopology: opts.rebuild,
            synthesizeSignals: opts.signals,
            fillet: opts.fillet,
            clipPolygon,
          })
        } else {
          const xml = fs.readFileSync(resolved, 'utf8')
          const stem = path.basename(resolved).replace(/\.(osm\.xml|osm|xml)$/i, '')
          projectId = safeName(opts.projectId ?? stem) || 'osm-import'
          built = await buildRoadnetFromOsmXml(xml, {
            projectId,
            variant: opts.variant,
            rebuildTopology: opts.rebuild,
            applyRestrictions: opts.restrictions,
            synthesizeSignals: opts.signals,
            fillet: opts.fillet,
            clipPolygon,
          })
        }

        try {
          const outputs = await exportWithOptionalConvert(built.session, projectId, {
            outputPath: opts.output,
            plainDir: opts.plainDir,
            geojsonPath: opts.geojson,
            layer: opts.layer,
            convertPath: opts.convert,
            toCrs: opts.toCrs,
            defaultProjectOutput: true,
          })
          console.log(
            JSON.stringify(
              {
                ok: true,
                status: 'completed',
                command: 'roadnet build',
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
              },
              null,
              2,
            ),
          )
        } finally {
          await built.session.dispose()
        }
      } catch (err) {
        printFailure('roadnet build', err)
      }
    })

  roadnet
    .command('validate <project>')
    .description('Validate a .roadnet.json project or SUMO plain XML and summarize findings and export precheck')
    .option('--target <target>', 'Export check target (sumo|opendrive)', 'sumo')
    .option('--version <ver>', 'Target simulator version', '1.27')
    .option('--max-findings <n>', 'Maximum finding entries to include in output', '50')
    .option('--variant <variant>', 'roadnet-core WASM variant (wasm32|memory64)')
    .action(async (project: string, opts: {
      target: string
      version: string
      maxFindings: string
      variant?: CoreVariant
    }) => {
      try {
        const opened = await openRoadnetInput(project, { variant: opts.variant })
        try {
          const [findings, exportFindings, precheck, summary] = await Promise.all([
            opened.session.core.validate(),
            opened.session.core.checkExport(opts.target, opts.version),
            opened.session.bus.precheckExport(opts.target, opts.version),
            opened.session.core.summary(),
          ])
          const blockers = exportBlockers({
            blockingFindings: exportFindings.filter((f) => !f.ignored && f.severity === 'blocking').length,
            openReviewItems: precheck.openReviewItems,
          })
          const report = summarizeFindings(findings, Number(opts.maxFindings) || 50)
          console.log(
            JSON.stringify(
              {
                ok: true,
                status: 'completed',
                command: 'roadnet validate',
                engine: 'roadnet-core',
                projectId: opened.projectId,
                summary,
                precheck,
                exportAllowed: blockers.length === 0,
                blockers,
                ...report,
              },
              null,
              2,
            ),
          )
        } finally {
          await opened.session.dispose()
        }
      } catch (err) {
        printFailure('roadnet validate', err)
      }
    })

  roadnet
    .command('batch <project>')
    .description('Execute headless roadnet commands, filtered attribute patches, or fillet on a .roadnet.json project')
    .option('--command <json...>', 'One or more RoadNetCommand JSON strings (or @file.json)')
    .option('--filter <json>', 'LinkFilter JSON for set_attributes')
    .option('--patch <json>', 'AttributePatch JSON for set_attributes')
    .option('--fillet', 'Append fillet_links command', false)
    .option('--dry-run', 'Preview deltas only without committing or writing output', false)
    .option('--confirm-destructive', 'Explicitly confirm destructive commands', false)
    .option('-o, --output <path>', 'Output .roadnet.json path')
    .option('--in-place', 'Overwrite the input .roadnet.json file', false)
    .option('--variant <variant>', 'roadnet-core WASM variant (wasm32|memory64)')
    .action(async (project: string, opts: {
      command?: string[]
      filter?: string
      patch?: string
      fillet: boolean
      dryRun: boolean
      confirmDestructive: boolean
      output?: string
      inPlace: boolean
      variant?: CoreVariant
    }) => {
      try {
        const commands: RoadNetCommand[] = []
        for (const item of opts.command ?? []) {
          const parsed = parseJsonArg<RoadNetCommand | RoadNetCommand[]>(item, '--command')
          if (Array.isArray(parsed)) commands.push(...parsed)
          else commands.push(parsed)
        }
        if (opts.filter || opts.patch) {
          if (!opts.patch) {
            throw new RoadNetError({ code: 'INVALID_ARGUMENT', message: '--filter requires --patch.' })
          }
          const filter = opts.filter ? parseJsonArg<LinkFilter>(opts.filter, '--filter') : undefined
          const patch = parseJsonArg<AttributePatch>(opts.patch, '--patch')
          commands.push({ command: 'set_attributes', ...(filter ? { filter } : {}), patch })
        }
        if (opts.fillet) {
          commands.push({ command: 'fillet_links' })
        }
        if (commands.length === 0) {
          throw new RoadNetError({
            code: 'INVALID_ARGUMENT',
            message: 'Provide at least one --command, --patch, or --fillet operation.',
          })
        }

        const opened = await openRoadnetInput(project, { variant: opts.variant })
        try {
          const { bus, core } = opened.session
          const destructiveCommands = commands.filter((cmd) => isDestructive(cmd))

          if (opts.dryRun || (destructiveCommands.length > 0 && !opts.confirmDestructive)) {
            const previews = []
            for (const cmd of commands) {
              const preview = await bus.preview(cmd, 'agent')
              previews.push({
                command: cmd.command,
                destructive: preview.destructive,
                touched: preview.touched,
                operationCount: preview.delta.operations.length,
              })
            }
            if (!opts.dryRun) {
              console.log(
                JSON.stringify(
                  {
                    ok: false,
                    status: 'confirmation_required',
                    command: 'roadnet batch',
                    engine: 'roadnet-core',
                    message:
                      'Destructive command(s) require --confirm-destructive after reviewing affected targets.',
                    previews,
                  },
                  null,
                  2,
                ),
              )
              process.exitCode = 1
              return
            }
            console.log(
              JSON.stringify(
                {
                  ok: true,
                  status: 'dry_run',
                  command: 'roadnet batch',
                  engine: 'roadnet-core',
                  previews,
                },
                null,
                2,
              ),
            )
            return
          }

          const results = []
          for (const cmd of commands) {
            if (isDestructive(cmd)) {
              const preview = await bus.preview(cmd, 'user')
              bus.confirmPreview(preview.previewRef)
              const run = bus.execute.bind(bus)
              const res = await run(cmd, { previewRef: preview.previewRef })
              results.push({ command: cmd.command, revision: res.revision, touched: res.touched.length })
            } else {
              const run = bus.execute.bind(bus)
              const res = await run(cmd, { origin: 'agent' })
              results.push({ command: cmd.command, revision: res.revision, touched: res.touched.length })
            }
          }

          const targetPath = opts.inPlace
            ? path.resolve(project)
            : opts.output
              ? path.resolve(opts.output)
              : path.resolve(project.replace(/(\.roadnet\.json|\.json)$/i, '') + '.edited.roadnet.json')

          const written = await writeRoadnetOutputs(core, {
            projectId: opened.projectId,
            projectPath: targetPath,
          })
          const summary = await core.summary()
          console.log(
            JSON.stringify(
              {
                ok: true,
                status: 'completed',
                command: 'roadnet batch',
                engine: 'roadnet-core',
                projectId: opened.projectId,
                outputPath: written.projectPath,
                applied: results,
                summary,
              },
              null,
              2,
            ),
          )
        } finally {
          await opened.session.dispose()
        }
      } catch (err) {
        printFailure('roadnet batch', err)
      }
    })

  roadnet
    .command('export <project>')
    .description('Export a .roadnet.json project to SUMO plain XML, GeoJSON, and/or other GIS formats')
    .option('--plain-dir <dir>', 'Output directory for SUMO plain XML')
    .option('--geojson <path>', 'Output GeoJSON file path')
    .option('--layer <layer>', 'GeoJSON export layer (links|nodes|junctions|all)', 'all')
    .option('--convert <path>', 'Export & convert GeoJSON to another GIS format (.gpkg/.shp/.fgb/.dxf/...)')
    .option('--to-crs <crs>', 'Target CRS when converting output')
    .option('--target <target>', 'Export check target (sumo|opendrive)', 'sumo')
    .option('--version <ver>', 'Target simulator version', '1.27')
    .option('--force', 'Export even if precheck reports blockers', false)
    .option('--variant <variant>', 'roadnet-core WASM variant (wasm32|memory64)')
    .action(async (project: string, opts: {
      plainDir?: string
      geojson?: string
      layer: GeoJsonLayerName
      convert?: string
      toCrs?: string
      target: string
      version: string
      force: boolean
      variant?: CoreVariant
    }) => {
      try {
        if (!opts.plainDir && !opts.geojson && !opts.convert) {
          throw new RoadNetError({
            code: 'INVALID_ARGUMENT',
            message: 'Specify at least one output: --plain-dir, --geojson, or --convert.',
          })
        }

        const opened = await openRoadnetInput(project, { variant: opts.variant })
        try {
          const [exportFindings, precheck] = await Promise.all([
            opened.session.core.checkExport(opts.target, opts.version),
            opened.session.bus.precheckExport(opts.target, opts.version),
          ])
          const blockers = exportBlockers({
            blockingFindings: exportFindings.filter((f) => !f.ignored && f.severity === 'blocking').length,
            openReviewItems: precheck.openReviewItems,
          })
          if (blockers.length > 0 && !opts.force) {
            console.log(
              JSON.stringify(
                {
                  ok: false,
                  status: 'blocked',
                  command: 'roadnet export',
                  engine: 'roadnet-core',
                  precheck,
                  blockers,
                  error: 'Export precheck reported blocking findings; pass --force to override.',
                },
                null,
                2,
              ),
            )
            process.exitCode = 1
            return
          }

          const outputs = await exportWithOptionalConvert(opened.session, opened.projectId, {
            plainDir: opts.plainDir,
            geojsonPath: opts.geojson,
            layer: opts.layer,
            convertPath: opts.convert,
            toCrs: opts.toCrs,
          })
          console.log(
            JSON.stringify(
              {
                ok: true,
                status: 'completed',
                command: 'roadnet export',
                engine: 'roadnet-core',
                projectId: opened.projectId,
                precheck,
                outputs,
              },
              null,
              2,
            ),
          )
        } finally {
          await opened.session.dispose()
        }
      } catch (err) {
        printFailure('roadnet export', err)
      }
    })
}
