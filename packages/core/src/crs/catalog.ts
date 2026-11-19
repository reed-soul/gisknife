import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import proj4 from 'proj4'

export interface CrsEntry {
  code: string
  name: string
  proj4def?: string
  kind: 'geographic' | 'projected' | 'china-encrypted'
}

interface CompactCatalogFile {
  version: number
  generatedAt: string
  entries: Array<{ c: string; n: string; p: string }>
}

const BUILTIN_CRS: CrsEntry[] = [
  {
    code: 'EPSG:4326',
    name: 'WGS 84',
    proj4def: '+proj=longlat +datum=WGS84 +no_defs +type=crs',
    kind: 'geographic',
  },
  {
    code: 'EPSG:3857',
    name: 'WGS 84 / Pseudo-Mercator',
    proj4def:
      '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs',
    kind: 'projected',
  },
  {
    code: 'EPSG:4490',
    name: 'China Geodetic Coordinate System 2000 (CGCS2000)',
    proj4def: '+proj=longlat +ellps=GRS80 +no_defs +type=crs',
    kind: 'geographic',
  },
  {
    code: 'EPSG:4526',
    name: 'CGCS2000 / 3-degree Gauss-Kruger zone 38',
    proj4def: '+proj=tmerc +lat_0=0 +lon_0=114 +k=1 +x_0=38500000 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs',
    kind: 'projected',
  },
  {
    code: 'EPSG:4547',
    name: 'CGCS2000 / 3-degree Gauss-Kruger CM 114E',
    proj4def: '+proj=tmerc +lat_0=0 +lon_0=114 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs',
    kind: 'projected',
  },
  {
    code: 'GCJ02',
    name: 'GCJ-02 (China Encrypted Mars Coordinate System)',
    kind: 'china-encrypted',
  },
  {
    code: 'BD09',
    name: 'BD-09 (Baidu Coordinate System)',
    kind: 'china-encrypted',
  },
]

let catalogCache: Map<string, CrsEntry> | null = null
let allEntriesCache: CrsEntry[] | null = null

function resolveCatalogPath(): string | null {
  const candidates = [
    new URL('../../data/epsgCatalog.generated.json', import.meta.url),
    new URL('../../../data/epsgCatalog.generated.json', import.meta.url),
  ]
  for (const url of candidates) {
    const fsPath = fileURLToPath(url)
    if (fs.existsSync(fsPath)) {
      return fsPath
    }
  }
  const cwdCandidate = path.resolve(process.cwd(), 'packages/core/data/epsgCatalog.generated.json')
  return fs.existsSync(cwdCandidate) ? cwdCandidate : null
}

function inferKind(proj4def: string): 'geographic' | 'projected' {
  return proj4def.includes('+proj=longlat') ? 'geographic' : 'projected'
}

export function ensureCatalogLoaded(): Map<string, CrsEntry> {
  if (catalogCache) {
    return catalogCache
  }

  const map = new Map<string, CrsEntry>()
  for (const entry of BUILTIN_CRS) {
    map.set(entry.code, entry)
    if (entry.proj4def) {
      proj4.defs(entry.code, entry.proj4def)
    }
  }

  const catalogPath = resolveCatalogPath()
  if (catalogPath) {
    const raw = fs.readFileSync(catalogPath, 'utf8')
    const parsed = JSON.parse(raw) as CompactCatalogFile
    for (const item of parsed.entries) {
      const entry: CrsEntry = {
        code: item.c,
        name: item.n,
        proj4def: item.p,
        kind: inferKind(item.p),
      }
      if (!map.has(item.c)) {
        map.set(item.c, entry)
      }
      proj4.defs(item.c, item.p)
    }
  }

  // Register WGS84 alias as EPSG:4326 in proj4
  proj4.defs('WGS84', proj4.defs('EPSG:4326'))

  catalogCache = map
  allEntriesCache = Array.from(map.values())
  return map
}

/**
 * Normalizes human/agent CRS shorthand into canonical identifiers:
 * - "84" / "wgs84" / "4326" -> "EPSG:4326"
 * - "4547" / "epsg4547" -> "EPSG:4547"
 * - "cgcs2000" -> "EPSG:4490"
 * - "gcj-02" / "gcj02" -> "GCJ02"
 * - "bd-09" / "bd09" -> "BD09"
 */
export function normalizeCrsCode(raw: string): string {
  const trimmed = raw.trim().toUpperCase()
  if (trimmed === 'WGS84' || trimmed === 'WGS-84' || trimmed === '84' || trimmed === '4326') {
    return 'EPSG:4326'
  }
  if (trimmed === 'CGCS2000' || trimmed === '2000' || trimmed === '4490') {
    return 'EPSG:4490'
  }
  if (trimmed === 'WEBMERCATOR' || trimmed === 'WEB_MERCATOR' || trimmed === '900913' || trimmed === '3857') {
    return 'EPSG:3857'
  }
  if (trimmed === 'GCJ02' || trimmed === 'GCJ-02' || trimmed === 'GCJ') {
    return 'GCJ02'
  }
  if (trimmed === 'BD09' || trimmed === 'BD-09' || trimmed === 'BD') {
    return 'BD09'
  }
  if (/^\d{4,6}$/.test(trimmed)) {
    return `EPSG:${trimmed}`
  }
  if (/^EPSG[-_\s]?(\d{4,6})$/.test(trimmed)) {
    const code = trimmed.replace(/^EPSG[-_\s]?/, '')
    return `EPSG:${code}`
  }
  return trimmed
}

export function getCrsEntry(codeOrAlias: string): CrsEntry | undefined {
  const map = ensureCatalogLoaded()
  const canonical = normalizeCrsCode(codeOrAlias)
  return map.get(canonical)
}

export function isSupportedCrs(codeOrAlias: string): boolean {
  const canonical = normalizeCrsCode(codeOrAlias)
  if (canonical === 'GCJ02' || canonical === 'BD09') {
    return true
  }
  const map = ensureCatalogLoaded()
  return map.has(canonical) || Boolean(proj4.defs(canonical))
}

export function searchCrs(query: string, limit = 20): CrsEntry[] {
  ensureCatalogLoaded()
  const entries = allEntriesCache ?? []
  const q = query.trim().toLowerCase()
  if (!q) {
    return entries.slice(0, limit)
  }
  const normalized = normalizeCrsCode(query).toLowerCase()
  const exact: CrsEntry[] = []
  const partial: CrsEntry[] = []

  for (const entry of entries) {
    const codeLower = entry.code.toLowerCase()
    const nameLower = entry.name.toLowerCase()
    if (codeLower === q || codeLower === normalized) {
      exact.push(entry)
    } else if (codeLower.includes(q) || nameLower.includes(q)) {
      partial.push(entry)
    }
  }

  return [...exact, ...partial].slice(0, limit)
}
