/**
 * 示意层的分帧字节（内核 `baselayers.rs` 的输出）。
 */

import { RoadNetError } from './types.js'

export interface BaseFrameMeta {
  revision: number
  minRank: number
  complete: boolean
  truncated: boolean
  usedInner: boolean
  links: number
  nodes: number
  junctions: number
  layers: Record<'links' | 'nodes' | 'junctions', { offset: number; length: number }>
}

export type BaseLayerName = 'links' | 'nodes' | 'junctions'

export interface BaseFrame {
  meta: BaseFrameMeta
  layers: Record<BaseLayerName, Uint8Array>
}

const MAGIC = [0x52, 0x4e, 0x42, 0x31] // "RNB1"
const decoder = new TextDecoder()

function bad(message: string): never {
  throw new RoadNetError({ code: 'CORE_FAILED', message: `Invalid base layer frame: ${message}` })
}

export function parseBaseFrame(buffer: ArrayBuffer | Uint8Array): BaseFrame {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) bad('missing RNB1 header')
  const metaLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)
  const metaEnd = 8 + metaLength
  if (metaEnd > bytes.length) bad('metadata exceeds frame bounds')
  let meta: BaseFrameMeta
  try {
    meta = JSON.parse(decoder.decode(bytes.subarray(8, metaEnd))) as BaseFrameMeta
  } catch {
    return bad('metadata is not valid JSON')
  }
  const body = bytes.subarray(metaEnd)
  const slice = (name: BaseLayerName): Uint8Array => {
    const span = meta.layers?.[name]
    if (!span || span.offset < 0 || span.length < 0 || span.offset + span.length > body.length) {
      bad(`${name} layer exceeds frame bounds`)
    }
    return body.subarray(span.offset, span.offset + span.length)
  }
  return { meta, layers: { links: slice('links'), nodes: slice('nodes'), junctions: slice('junctions') } }
}

export function layerBlobUrl(layer: Uint8Array): string {
  return URL.createObjectURL(new Blob([layer as BlobPart], { type: 'application/geo+json' }))
}

export function buildBaseFrame(
  layers: Record<BaseLayerName, string>,
  meta: Partial<Omit<BaseFrameMeta, 'layers'>> = {},
): ArrayBuffer {
  const encoder = new TextEncoder()
  const parts = (['links', 'nodes', 'junctions'] as const).map((name) => encoder.encode(layers[name]))
  const count = (text: string) => (text.match(/"id":/g) ?? []).length
  const full: BaseFrameMeta = {
    revision: 0,
    minRank: 0,
    complete: true,
    truncated: false,
    usedInner: false,
    links: count(layers.links),
    nodes: count(layers.nodes),
    junctions: count(layers.junctions),
    ...meta,
    layers: {
      links: { offset: 0, length: parts[0]!.length },
      nodes: { offset: parts[0]!.length, length: parts[1]!.length },
      junctions: { offset: parts[0]!.length + parts[1]!.length, length: parts[2]!.length },
    },
  }
  const metaBytes = encoder.encode(JSON.stringify(full))
  const out = new Uint8Array(8 + metaBytes.length + parts.reduce((n, p) => n + p.length, 0))
  out.set(MAGIC, 0)
  new DataView(out.buffer).setUint32(4, metaBytes.length, true)
  out.set(metaBytes, 8)
  let at = 8 + metaBytes.length
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out.buffer
}

export const EMPTY_COLLECTION = '{"type":"FeatureCollection","features":[]}'
