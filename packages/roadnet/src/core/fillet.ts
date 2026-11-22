/**
 * 倒圆工具（拐角圆弧）的参数与结果文案。
 */

import type { RoadNetCommand } from './types.js'

export interface FilletOptions {
  auto: boolean
  radiusM: number
}

export const FILLET_RADIUS_RANGE = { min: 1, max: 500 } as const

export const DEFAULT_FILLET_OPTIONS: FilletOptions = { auto: true, radiusM: 20 }

export const FILLET_AUTO_HINT =
  'Default radii: motorway 100 m, trunk 60 m, primary 40 m, secondary 30 m, tertiary 20 m, residential 12 m, service 8 m; links step down one tier'

export function clampFilletRadius(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_FILLET_OPTIONS.radiusM
  return Math.min(FILLET_RADIUS_RANGE.max, Math.max(FILLET_RADIUS_RANGE.min, Math.round(n * 10) / 10))
}

export function filletCommand(linkId: string, options: FilletOptions): RoadNetCommand {
  return {
    command: 'geometry_op',
    linkId,
    op: { fillet: options.auto ? {} : { radiusM: clampFilletRadius(options.radiusM) } },
  }
}

export function filletAllCommand(options: FilletOptions): RoadNetCommand {
  return options.auto
    ? { command: 'fillet_links' }
    : { command: 'fillet_links', radiusM: clampFilletRadius(options.radiusM) }
}

export interface FilletTally {
  done: number
  skipped: number
  failed: number
  firstError?: string
}

/** 内核对直路给出的拒绝文案里带这几个字；这种不算失败，只是没有可做的。 */
export const NOTHING_TO_ROUND = '没有需要倒圆'

export function filletSummary(tally: FilletTally): string {
  const parts: string[] = []
  if (tally.done) parts.push(`Rounded ${tally.done} link(s)`)
  if (tally.skipped) {
    parts.push(
      tally.done
        ? `${tally.skipped} link(s) needed no rounding`
        : 'No corners needed rounding (turn angle < 5 deg or already smooth)',
    )
  }
  if (tally.failed) parts.push(`${tally.failed} failed: ${tally.firstError ?? 'unknown error'}`)
  return parts.join('; ')
}
