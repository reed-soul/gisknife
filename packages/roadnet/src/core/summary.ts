/**
 * 项目摘要（表头的规模与阻断、警告数）由"规模 + 校验结论"拼出来。
 */

import type { Finding, LoadResult, ProjectExtent } from './types.js'

export const LARGE_PROJECT_LINKS = 25_000

type Scale = Pick<ProjectExtent, 'projectId' | 'revision' | 'nodes' | 'links' | 'junctions' | 'signalPlans' | 'computeCrs'>

export function countFindings(findings: readonly Finding[]): { blockingFindings: number; warningFindings: number } {
  let blockingFindings = 0
  let warningFindings = 0
  for (const finding of findings) {
    if (finding.ignored) continue
    if (finding.severity === 'blocking') blockingFindings += 1
    else if (finding.severity === 'warning') warningFindings += 1
  }
  return { blockingFindings, warningFindings }
}

export function composeSummary(scale: Scale, findings: readonly Finding[]): LoadResult {
  return {
    projectId: scale.projectId,
    revision: scale.revision,
    nodes: scale.nodes,
    links: scale.links,
    junctions: scale.junctions,
    signalPlans: scale.signalPlans,
    computeCrs: scale.computeCrs,
    ...countFindings(findings),
  }
}
