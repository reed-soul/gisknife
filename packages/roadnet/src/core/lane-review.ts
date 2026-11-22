/**
 * 车道数校核报告 → 待确认项的纯映射函数。
 */

import type { ReviewItem } from './types.js'

export interface LaneDecision {
  edgeId: string
  direction: 'up' | 'down'
  decision: 'auto' | 'confirmed' | 'pending' | 'unresolved'
  reason: string
  value: number | null
  defaultLanes: number | null
  samples: number
  validSamples: number
  agreement: number
  minConfidence: number
  votes: Record<string, number>
  chips?: string[]
  evidence?: Record<string, unknown>
}

export interface LaneVerificationReport {
  schemaVersion: string
  status?: string
  name?: string
  engine?: string
  decisions: LaneDecision[]
}

export class LaneReportError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'LaneReportError'
  }
}

const SUPPORTED = new Set(['sutpc.lane-verification.v1', 'sutpc.lane-verification.v2'])
const NEEDS_REVIEW = new Set(['pending', 'unresolved'])
const EVIDENCE_SCALARS = ['score', 'widthM', 'markings', 'sections', 'method'] as const

export function parseLaneReport(text: string): LaneVerificationReport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new LaneReportError('INVALID_REPORT', `Invalid JSON report: ${(error as Error).message}`)
  }
  const report = raw as LaneVerificationReport
  if (!report || typeof report !== 'object') {
    throw new LaneReportError('INVALID_REPORT', 'Report must be a JSON object')
  }
  if (!SUPPORTED.has(report.schemaVersion)) {
    throw new LaneReportError(
      'UNSUPPORTED_SCHEMA',
      `Unsupported report schema '${report.schemaVersion ?? '(missing)'}'; expected one of ${[...SUPPORTED].join(', ')}`,
    )
  }
  if (!Array.isArray(report.decisions)) {
    throw new LaneReportError('INVALID_REPORT', 'Report is missing decisions array')
  }
  return report
}

export function toReviewItems(report: LaneVerificationReport): ReviewItem[] {
  return report.decisions
    .filter((decision) => NEEDS_REVIEW.has(decision.decision))
    .map((decision) => ({
      itemId: `${decision.edgeId}:${decision.direction}`,
      targetRef: `link:${decision.edgeId}`,
      kind: 'lane_count' as const,
      ...(decision.value === null ? {} : { proposal: String(decision.value) }),
      evidence: evidenceOf(decision),
    }))
}

function evidenceOf(decision: LaneDecision): string[] {
  const out = [
    `reason ${decision.reason}`,
    `direction ${decision.direction}`,
    `samples ${decision.validSamples}/${decision.samples}`,
    `agreement ${decision.agreement.toFixed(2)}`,
    `confidence ${decision.minConfidence.toFixed(2)}`,
  ]
  if (decision.defaultLanes !== null) out.push(`default ${decision.defaultLanes}`)
  const votes = Object.entries(decision.votes ?? {})
    .map(([lanes, count]) => `${lanes} lanes x ${count}`)
    .join(', ')
  if (votes) out.push(`votes ${votes}`)
  for (const chip of decision.chips ?? []) out.push(chip)
  for (const key of EVIDENCE_SCALARS) {
    const value = decision.evidence?.[key]
    if (typeof value === 'number' || typeof value === 'string') out.push(`${key} ${value}`)
  }
  return out
}

export function summarizeLaneReport(report: LaneVerificationReport): {
  total: number
  byDecision: Record<string, number>
  needsReview: number
} {
  const byDecision: Record<string, number> = {}
  for (const decision of report.decisions) {
    byDecision[decision.decision] = (byDecision[decision.decision] ?? 0) + 1
  }
  return {
    total: report.decisions.length,
    byDecision,
    needsReview: report.decisions.filter((d) => NEEDS_REVIEW.has(d.decision)).length,
  }
}
