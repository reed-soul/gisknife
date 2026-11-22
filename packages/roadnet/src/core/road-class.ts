/**
 * 道路等级：中文/英文叫法 ↔ `roadClass`（SUMO/OSM 的 `highway.*` 串）的映射表。
 */

export interface RoadClassOption {
  value: string
  label: string
  aliases?: string[]
}

export const ROAD_CLASSES: RoadClassOption[] = [
  { value: 'highway.motorway', label: '高速公路', aliases: ['高速'] },
  { value: 'highway.motorway_link', label: '高速公路匝道', aliases: ['高速匝道'] },
  { value: 'highway.trunk', label: '快速路', aliases: ['城市快速路', '快速干道'] },
  { value: 'highway.trunk_link', label: '快速路匝道', aliases: ['城市快速路匝道'] },
  { value: 'highway.primary', label: '主干路', aliases: ['主干道', '城市主干路', '城市主干道'] },
  { value: 'highway.primary_link', label: '主干路连接线', aliases: ['主干路匝道', '主干道连接线'] },
  { value: 'highway.secondary', label: '次干路', aliases: ['次干道', '城市次干路', '城市次干道'] },
  { value: 'highway.secondary_link', label: '次干路连接线', aliases: ['次干路匝道', '次干道连接线'] },
  { value: 'highway.tertiary', label: '支路', aliases: ['城市支路'] },
  { value: 'highway.tertiary_link', label: '支路连接线' },
  { value: 'highway.unclassified', label: '其他道路' },
  { value: 'highway.residential', label: '居住区道路', aliases: ['小区道路', '住宅区道路'] },
  { value: 'highway.living_street', label: '生活街道' },
  { value: 'highway.service', label: '服务道路' },
]

export const ROAD_CLASS_VALUES: readonly string[] = ROAD_CLASSES.map((item) => item.value)

export type RoadClassResolution = { ok: true; value: string } | { ok: false; input: string; options: string[] }

const compact = (text: string) => text.replace(/\s+/g, '')

export function normalizeRoadClass(input: string): RoadClassResolution {
  const text = compact(String(input ?? ''))
  const lower = text.toLowerCase()
  for (const item of ROAD_CLASSES) {
    if (lower === item.value || `highway.${lower}` === item.value) return { ok: true, value: item.value }
    if (text === item.label || item.aliases?.includes(text)) return { ok: true, value: item.value }
  }
  return { ok: false, input: String(input ?? ''), options: roadClassOptionsText() }
}

export function roadClassOptionsText(): string[] {
  return ROAD_CLASSES.map((item) => `${item.label}（${item.value}）`)
}
