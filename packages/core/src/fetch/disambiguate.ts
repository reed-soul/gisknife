import type { BBox, DisambiguationCandidate } from '../types.js'
import { lookupChinaAdmin, type ChinaAdminEntry } from './chinaAdcodes.js'

export interface UsRegionMatch {
  fips: string
  name: string
  kind: 'state' | 'dc'
}

export interface InformalRegionMatch {
  name: string
  bbox: BBox
  note: string
}

export interface PlaceResolution {
  status: 'resolved' | 'disambiguation_required'
  regionGroup: 'us' | 'china' | 'global'
  canonicalQuery: string
  usMatch?: UsRegionMatch
  chinaMatch?: ChinaAdminEntry
  informalMatch?: InformalRegionMatch
  candidates?: DisambiguationCandidate[]
}

const US_STATES: Array<{ fips: string; name: string; abbr: string; aliases: string[] }> = [
  { fips: '11', name: 'District of Columbia', abbr: 'DC', aliases: ['washington, d.c.', 'washington d.c.', 'washington dc', 'district of columbia', 'dc', '华盛顿特区', '华盛顿哥伦比亚特区'] },
  { fips: '53', name: 'Washington', abbr: 'WA', aliases: ['washington state', 'state of washington', 'wa', '华盛顿州'] },
  { fips: '06', name: 'California', abbr: 'CA', aliases: ['california', 'ca', '加利福尼亚', '加州'] },
  { fips: '36', name: 'New York', abbr: 'NY', aliases: ['new york state', 'ny', '纽约州'] },
  { fips: '48', name: 'Texas', abbr: 'TX', aliases: ['texas', 'tx', '德克萨斯', '得州'] },
  { fips: '12', name: 'Florida', abbr: 'FL', aliases: ['florida', 'fl', '佛罗里达'] },
  { fips: '25', name: 'Massachusetts', abbr: 'MA', aliases: ['massachusetts', 'ma', '麻省'] },
  { fips: '17', name: 'Illinois', abbr: 'IL', aliases: ['illinois', 'il', '伊利诺伊'] },
  { fips: '41', name: 'Oregon', abbr: 'OR', aliases: ['oregon', '俄勒冈'] },
  { fips: '04', name: 'Arizona', abbr: 'AZ', aliases: ['arizona', 'az', '亚利桑那'] },
  { fips: '08', name: 'Colorado', abbr: 'CO', aliases: ['colorado', 'co', '科罗拉多'] },
  { fips: '13', name: 'Georgia', abbr: 'GA', aliases: ['georgia us', 'georgia, usa'] },
  { fips: '37', name: 'North Carolina', abbr: 'NC', aliases: ['north carolina', 'nc'] },
  { fips: '51', name: 'Virginia', abbr: 'VA', aliases: ['virginia', 'va', '弗吉尼亚'] },
  { fips: '24', name: 'Maryland', abbr: 'MD', aliases: ['maryland', 'md', '马里兰'] },
]

const AMBIGUOUS_RULES: Array<{
  patterns: string[]
  candidates: DisambiguationCandidate[]
}> = [
  {
    patterns: ['washington', 'washington, usa', 'washington us', '华盛顿', '美国华盛顿'],
    candidates: [
      {
        id: 'us-dc',
        label: 'Washington, D.C. (District of Columbia)',
        description: 'US Federal Capital District (FIPS 11)',
        queryHint: 'Washington, D.C.',
        country: 'US',
        level: 'district',
        bbox: [-77.1198, 38.7916, -76.9094, 38.9955],
        providerHint: 'census-tiger',
      },
      {
        id: 'us-wa',
        label: 'Washington State',
        description: 'US Pacific Northwest State (FIPS 53)',
        queryHint: 'Washington State',
        country: 'US',
        level: 'state',
        bbox: [-124.8489, 45.5435, -116.9159, 49.0024],
        providerHint: 'census-tiger',
      },
    ],
  },
  {
    patterns: ['new york', '纽约'],
    candidates: [
      {
        id: 'us-nyc',
        label: 'New York City',
        description: 'City of New York (5 boroughs)',
        queryHint: 'New York City, USA',
        country: 'US',
        level: 'city',
        providerHint: 'nominatim',
      },
      {
        id: 'us-ny-state',
        label: 'New York State',
        description: 'US State of New York (FIPS 36)',
        queryHint: 'New York State',
        country: 'US',
        level: 'state',
        providerHint: 'census-tiger',
      },
    ],
  },
]

const INFORMAL_REGIONS: Array<{
  patterns: string[]
  match: InformalRegionMatch
}> = [
  {
    patterns: ['silicon valley', 'silicon valley, ca', 'silicon valley, usa', '硅谷', '美国硅谷'],
    match: {
      name: 'Silicon Valley (Core Santa Clara + Southern San Mateo)',
      bbox: [-122.52, 37.12, -121.58, 37.60],
      note: 'Silicon Valley is an informal tech corridor without a strict legal boundary. Using canonical core BBox [-122.52, 37.12, -121.58, 37.60]; run `gisknife pick` if you want a custom polygon.',
    },
  },
  {
    patterns: ['palo alto', '帕洛阿尔托'],
    match: {
      name: 'Palo Alto, CA',
      bbox: [-122.19, 37.39, -122.09, 37.47],
      note: 'Using Palo Alto city core BBox [-122.19, 37.39, -122.09, 37.47].',
    },
  },
]

export function resolvePlaceIntent(
  rawQuery: string,
  options: { pickFirst?: boolean; level?: string } = {},
): PlaceResolution {
  const cleaned = rawQuery.trim()
  const norm = cleaned.toLowerCase().replace(/\s+/g, ' ')

  // 1. Informal regions (Silicon Valley, etc.)
  for (const inf of INFORMAL_REGIONS) {
    if (inf.patterns.includes(norm)) {
      return {
        status: 'resolved',
        regionGroup: 'us',
        canonicalQuery: inf.match.name,
        informalMatch: inf.match,
      }
    }
  }

  // 2. Explicit ambiguity check unless caller specified level or --pick-first
  if (!options.pickFirst && options.level !== 'state') {
    for (const rule of AMBIGUOUS_RULES) {
      if (rule.patterns.includes(norm)) {
        return {
          status: 'disambiguation_required',
          regionGroup: 'us',
          canonicalQuery: cleaned,
          candidates: rule.candidates,
        }
      }
    }
  }

  // If user asked for Washington + --level state -> resolve directly to WA state
  if (
    (norm === 'washington' || norm === '华盛顿' || norm === '美国华盛顿') &&
    (options.level === 'state' || options.pickFirst)
  ) {
    return {
      status: 'resolved',
      regionGroup: 'us',
      canonicalQuery: options.level === 'state' ? 'Washington State' : 'Washington, D.C.',
      usMatch:
        options.level === 'state'
          ? { fips: '53', name: 'Washington', kind: 'state' }
          : { fips: '11', name: 'District of Columbia', kind: 'dc' },
    }
  }

  // 3. Explicit US State / D.C. match
  for (const st of US_STATES) {
    if (
      st.name.toLowerCase() === norm ||
      st.aliases.includes(norm)
    ) {
      return {
        status: 'resolved',
        regionGroup: 'us',
        canonicalQuery: st.name,
        usMatch: {
          fips: st.fips,
          name: st.name,
          kind: st.fips === '11' ? 'dc' : 'state',
        },
      }
    }
  }

  // 4. China administrative division match or CJK heuristic
  const china = lookupChinaAdmin(cleaned)
  if (china || /[\u4e00-\u9fff]/.test(cleaned)) {
    return {
      status: 'resolved',
      regionGroup: 'china',
      canonicalQuery: china ? china.name : cleaned,
      chinaMatch: china,
    }
  }

  // 5. Fallback to global routing
  return {
    status: 'resolved',
    regionGroup: 'global',
    canonicalQuery: cleaned,
  }
}
