/**
 * 脏区域校验结论的合并与整图规则的新鲜度判定。
 */

import type { Delta, Finding } from './types.js'

export const GLOBAL_RULES = new Set(['T05', 'S03'])

export function dirtyGlobalRules(delta?: Delta): string[] {
  const dirty = new Set<string>()
  for (const raw of delta?.operations ?? []) {
    const op = raw as { op: string; before?: Record<string, unknown>; after?: Record<string, unknown> }
    if (/^(add|remove)_(node|link)$/.test(op.op)) {
      dirty.add('T05')
      dirty.add('S03')
    }
    if (op.op === 'update_node' && op.before?.nodeId !== op.after?.nodeId) {
      dirty.add('T05')
      dirty.add('S03')
    }
    if (op.op === 'update_link') {
      if (['linkId', 'fromNodeId', 'toNodeId'].some((key) => op.before?.[key] !== op.after?.[key])) {
        dirty.add('T05')
        dirty.add('S03')
      }
      if (op.before?.oneway !== op.after?.oneway) dirty.add('S03')
    }
  }
  return [...dirty].sort()
}

export function mergeLocalFindings(
  previous: Finding[],
  targets: string[],
  scoped: Finding[],
  delta?: Delta,
): Finding[] {
  const dirty = new Set(targets)
  const stale = new Set(dirtyGlobalRules(delta))
  const kept = previous
    .filter((f) => (GLOBAL_RULES.has(f.ruleId) ? !stale.has(f.ruleId) : !dirty.has(f.targetRef)))
    .map((f) => ({ ...f }))
  for (const raw of delta?.operations ?? []) {
    const op = raw as { op: string; item?: { ruleId: string; targetRef: string } }
    if (op.op === 'add_ignored_finding' || op.op === 'remove_ignored_finding') {
      for (const f of kept) {
        if (f.ruleId === op.item?.ruleId && f.targetRef === op.item.targetRef) {
          f.ignored = op.op === 'add_ignored_finding'
        }
      }
    }
  }
  return [...kept, ...scoped.filter((f) => !GLOBAL_RULES.has(f.ruleId))]
}
