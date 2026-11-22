/**
 * 极简流式 XML 元素扫描器：供 OSM XML 解析使用，先拒绝 DOCTYPE/ENTITY 并跳过 CDATA。
 */

export interface ScannedElement {
  tag: string
  attrs: Record<string, string>
  selfClosing: boolean
}

export function rejectEntityDeclarations(xml: string): void {
  if (/<!\s*(DOCTYPE|ENTITY)\s/i.test(xml)) {
    throw new Error('XML_INPUT_HAS_ENTITY_DECL')
  }
}

export function scanXmlElements(text: string, onElement: (element: ScannedElement) => void): void {
  const length = text.length
  let i = 0

  const codeAt = (at: number): number => (at < length ? text.charCodeAt(at) : -1)

  while (i < length) {
    if (text.charCodeAt(i) !== 0x3c /* < */) {
      i += 1
      continue
    }
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4)
      if (close < 0) break
      i = close + 3
      continue
    }
    if (text.startsWith('<![CDATA[', i)) {
      const close = text.indexOf(']]>', i + 9)
      if (close < 0) break
      i = close + 3
      continue
    }
    if (codeAt(i + 1) === 0x2f /* / */) {
      const end = text.indexOf('>', i + 2)
      if (end < 0) break
      const tag = text.slice(i + 2, end).trim()
      if (tag) onElement({ tag: `/${tag}`, attrs: {}, selfClosing: false })
      i = end + 1
      continue
    }
    if (codeAt(i + 1) === 0x3f /* ? */ || codeAt(i + 1) === 0x21 /* ! */) {
      const end = text.indexOf('>', i + 2)
      if (end < 0) break
      i = end + 1
      continue
    }

    let end = i + 1
    let inQuote = false
    while (end < length) {
      const ch = text.charCodeAt(end)
      if (ch === 0x22 /* " */) inQuote = !inQuote
      else if (ch === 0x3e /* > */ && !inQuote) break
      end += 1
    }
    if (end >= length) break

    let raw = text.slice(i + 1, end).trim()
    let selfClosing = false
    if (raw.endsWith('/')) {
      selfClosing = true
      raw = raw.slice(0, -1).trimEnd()
    }
    const spaceAt = firstWhitespace(raw)
    const tag = spaceAt < 0 ? raw : raw.slice(0, spaceAt)
    const attrText = spaceAt < 0 ? '' : raw.slice(spaceAt + 1)
    if (tag) onElement({ tag, attrs: parseXmlAttributes(attrText), selfClosing })
    i = end + 1
  }
}

function firstWhitespace(text: string): number {
  for (let k = 0; k < text.length; k += 1) {
    const code = text.charCodeAt(k)
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) return k
  }
  return -1
}

export function parseXmlAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const length = text.length
  let i = 0
  while (i < length) {
    while (i < length && isXmlWhitespace(text.charCodeAt(i))) i += 1
    const keyStart = i
    while (i < length && !isXmlWhitespace(text.charCodeAt(i)) && text.charCodeAt(i) !== 0x3d /* = */) i += 1
    const key = text.slice(keyStart, i)
    while (i < length && (isXmlWhitespace(text.charCodeAt(i)) || text.charCodeAt(i) === 0x3d)) i += 1
    if (!key || text.charCodeAt(i) !== 0x22 /* " */) continue
    const valueStart = i + 1
    const valueEnd = text.indexOf('"', valueStart)
    if (valueEnd < 0) break
    attrs[key] = decodeXmlEntities(text.slice(valueStart, valueEnd))
    i = valueEnd + 1
  }
  return attrs
}

function isXmlWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value
  let out = ''
  let i = 0
  while (i < value.length) {
    const amp = value.indexOf('&', i)
    if (amp < 0) {
      out += value.slice(i)
      break
    }
    out += value.slice(i, amp)
    const semi = value.indexOf(';', amp + 1)
    if (semi < 0 || semi - amp > 12) {
      out += '&'
      i = amp + 1
      continue
    }
    const name = value.slice(amp + 1, semi)
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16)
      out += Number.isNaN(code) ? value.slice(amp, semi + 1) : String.fromCodePoint(code)
    } else if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10)
      out += Number.isNaN(code) ? value.slice(amp, semi + 1) : String.fromCodePoint(code)
    } else {
      const named = NAMED_ENTITIES[name]
      out += named ?? value.slice(amp, semi + 1)
    }
    i = semi + 1
  }
  return out
}

export function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function inspectOsmRoads(xml: string): { hasWay: boolean; remark: string | null } {
  const hasWay = /<way\b/.test(xml)
  const matched = xml.match(/<remark>([\s\S]*?)<\/remark>/)
  const remark = matched ? normalizeSpace(matched[1] ?? '') : null
  return { hasWay, remark }
}

export function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
