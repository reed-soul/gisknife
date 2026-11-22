/**
 * Node.js 无头路网流水线：
 * 复用同构 `core/osm-pipeline.ts`，提供本地文件读写、OSM XML / SUMO plain XML 加载与产物落盘。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  applyOsmTurnRestrictions,
  runRoadnetBuildPipeline,
  synthesizeDefaultSignalPlans,
  type RestrictionsApplyReport,
  type RoadnetPipelineOptions,
  type SignalsSynthesizeReport,
} from '../core/osm-pipeline.js'
import { plainXmlFiles, safeName } from '../core/export-bundle.js'
import type { AsyncRoadNetCore, CoreVariant, ExportPrecheck, Finding, LoadResult } from '../core/types.js'
import { assertXmlSafe } from '../core/xml-safety.js'
import { parseOsmXml } from '../osm/osm-parse.js'
import type { OsmImportFiles } from '../osm/types.js'
import { openRoadnetFromPlainXml, type NodeRoadnetSession } from './loader.js'

export {
  applyOsmTurnRestrictions,
  clipOutsidePolygon,
  runRoadnetBuildPipeline,
  synthesizeDefaultSignalPlans,
  type RestrictionsApplyReport,
  type RoadnetPipelineOptions,
  type RoadnetPipelineResult,
  type SignalsSynthesizeReport,
} from '../core/osm-pipeline.js'

export interface BuildRoadnetOptions extends RoadnetPipelineOptions {
  projectId?: string
  variant?: CoreVariant
}

export interface BuiltRoadnetResult {
  session: NodeRoadnetSession
  parsed?: OsmImportFiles
  summary: LoadResult
  findings: Finding[]
  precheck: ExportPrecheck
  restrictionsReport: RestrictionsApplyReport
  signalsReport: SignalsSynthesizeReport
}

export async function buildRoadnetFromOsmXml(
  xml: string,
  options: BuildRoadnetOptions = {},
): Promise<BuiltRoadnetResult> {
  const projectId = options.projectId ?? 'osm-import'
  assertXmlSafe(xml, projectId)
  const parsed = await parseOsmXml(xml)
  const session = await openRoadnetFromPlainXml(projectId, parsed.files, { variant: options.variant })
  try {
    const built = await runRoadnetBuildPipeline(session, parsed.restrictions, options)
    return { session, parsed, ...built }
  } catch (err) {
    await session.dispose()
    throw err
  }
}

export async function buildRoadnetFromPlainXml(
  files: { nod: string; edg: string; con?: string; tll?: string },
  options: BuildRoadnetOptions = {},
): Promise<BuiltRoadnetResult> {
  const projectId = options.projectId ?? 'sumo-import'
  assertXmlSafe(files.nod, 'nod')
  assertXmlSafe(files.edg, 'edg')
  if (files.con) assertXmlSafe(files.con, 'con')
  if (files.tll) assertXmlSafe(files.tll, 'tll')
  const session = await openRoadnetFromPlainXml(projectId, files, { variant: options.variant })
  try {
    const built = await runRoadnetBuildPipeline(session, [], {
      ...options,
      applyRestrictions: false,
      synthesizeSignals: options.synthesizeSignals ?? false,
      fillet: options.fillet ?? false,
    })
    return { session, ...built }
  } catch (err) {
    await session.dispose()
    throw err
  }
}

export interface WriteRoadnetOutputsOptions {
  projectId: string
  projectPath?: string
  plainDir?: string
  geojsonPath?: string
  geojsonLayer?: 'links' | 'nodes' | 'junctions' | 'all'
}

export interface WrittenRoadnetOutputs {
  projectPath?: string
  plainFiles?: string[]
  geojsonPath?: string
}

export async function writeRoadnetOutputs(
  core: AsyncRoadNetCore,
  options: WriteRoadnetOutputsOptions,
): Promise<WrittenRoadnetOutputs> {
  const out: WrittenRoadnetOutputs = {}
  if (options.projectPath) {
    const resolved = path.resolve(options.projectPath)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(resolved, await core.projectJson(), 'utf8')
    out.projectPath = resolved
  }
  if (options.plainDir) {
    const dir = path.resolve(options.plainDir)
    fs.mkdirSync(dir, { recursive: true })
    const plain = await core.exportPlainXml()
    const files = plainXmlFiles(safeName(options.projectId), plain)
    out.plainFiles = []
    for (const file of files) {
      const target = path.join(dir, file.name)
      fs.writeFileSync(target, file.text, 'utf8')
      out.plainFiles.push(target)
    }
  }
  if (options.geojsonPath) {
    const resolved = path.resolve(options.geojsonPath)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    const geojson = await core.exportGeoJson(options.geojsonLayer ?? 'all')
    fs.writeFileSync(resolved, JSON.stringify(geojson, null, 2), 'utf8')
    out.geojsonPath = resolved
  }
  return out
}
