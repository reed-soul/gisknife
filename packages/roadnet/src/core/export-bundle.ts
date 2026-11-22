/**
 * SUMO plain XML 与 GeoJSON 导出文件的纯组装逻辑。
 */

import type { ExportPrecheck, PlainXml } from './types.js'

export interface ExportFile {
  name: string
  text: string
  blob?: Blob
  mediaType: string
}

const SUFFIXES: Record<keyof PlainXml, string> = {
  nod: '.nod.xml',
  edg: '.edg.xml',
  con: '.con.xml',
  tll: '.tll.xml',
  det: '.det.add.xml',
}

export function plainXmlFiles(projectId: string, xml: PlainXml): ExportFile[] {
  const base = safeName(projectId)
  return (Object.keys(SUFFIXES) as (keyof PlainXml)[])
    .filter((key) => key !== 'det' || Boolean(xml.det))
    .map((key) => ({
      name: `${base}${SUFFIXES[key]}`,
      text: xml[key] ?? '',
      mediaType: 'application/xml',
    }))
}

export function geoJsonFile(projectId: string, geojson: unknown): ExportFile {
  return {
    name: `${safeName(projectId)}.geojson`,
    text: JSON.stringify(geojson, null, 2),
    mediaType: 'application/geo+json',
  }
}

export interface ConversionRequestOptions {
  projectId: string
  inputDir?: string
  outputs?: { format: string; version?: string; checks?: string[] }[]
}

export function conversionRequest(options: ConversionRequestOptions): Record<string, unknown> {
  const base = safeName(options.projectId)
  const dir = (options.inputDir ?? 'input').replace(/\/$/, '')
  return {
    operation: 'convert',
    name: base,
    osmProfile: 'raw',
    input: {
      kind: 'sumo-plain',
      nodes: `${dir}/${base}.nod.xml`,
      edges: `${dir}/${base}.edg.xml`,
      connections: `${dir}/${base}.con.xml`,
      tllogic: `${dir}/${base}.tll.xml`,
    },
    outputs: options.outputs ?? [{ format: 'sumo' }],
  }
}

export function conversionPrompt(precheck: ExportPrecheck, request: Record<string, unknown>): string {
  const losses = precheck.losses.length
    ? precheck.losses.map((item) => `${item.aspect} (${item.count})`).join(', ')
    : 'none'
  const input = (request.input ?? {}) as Record<string, string>
  const names = ['nodes', 'edges', 'connections', 'tllogic']
    .map((key) => input[key])
    .filter(Boolean)
    .map((p) => p.split('/').pop())
    .join(', ')
  return [
    'Convert the attached SUMO plain XML files using raw profile.',
    `Files: ${names}.`,
    `Scale: ${precheck.links} links / ${precheck.nodes} nodes / ${precheck.junctions} junctions / ${precheck.connections} connections.`,
    `Precheck losses: ${losses}. Provenance: ${precheck.provenance}.`,
    'Request payload (keep osmProfile="raw" and all four input files):',
    '',
    '```json',
    JSON.stringify(request, null, 2),
    '```',
  ].join('\n')
}

export function safeName(projectId: string): string {
  const cleaned = (projectId || 'roadnet')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned || 'roadnet'
}

export function exportBlockers(options: {
  blockingFindings: number
  openReviewItems: number
}): string[] {
  const blockers: string[] = []
  if (options.blockingFindings > 0) {
    blockers.push(`${options.blockingFindings} blocking validation finding(s) remain; exported network may fail downstream conversion`)
  }
  if (options.openReviewItems > 0) {
    blockers.push(`${options.openReviewItems} open review item(s) remain undecided`)
  }
  return blockers
}
