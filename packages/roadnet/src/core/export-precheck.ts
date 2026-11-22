import type { RoadNetCommandBus } from './command-bus.js'
import type { AsyncRoadNetCore, ExportPrecheck } from './types.js'

export type PrecheckSource = { core: AsyncRoadNetCore; bus: RoadNetCommandBus }
export type CheckedPrecheck = { owner: PrecheckSource; revision: number; value: ExportPrecheck }

const revision = async (source: PrecheckSource) =>
  source.core.revision ? await source.core.revision() : (await source.bus.stats()).revision

export async function checkedPrecheck(
  source: PrecheckSource,
  target: string,
  version: string,
  current: () => boolean,
): Promise<CheckedPrecheck> {
  const before = await revision(source)
  const value = await source.bus.precheckExport(target, version)
  if (!current() || (await revision(source)) !== before || !current()) {
    throw new Error('Project changed during export precheck; please precheck again.')
  }
  return { owner: source, revision: before, value }
}

export async function assertPrecheckCurrent(
  check: CheckedPrecheck | null,
  source: PrecheckSource,
  current: () => boolean,
  files?: File[],
): Promise<void> {
  if (!check || check.owner !== source || !current() || (await revision(source)) !== check.revision || !current()) {
    throw new Error('Project changed since precheck; please precheck again.')
  }
  if (files && (!files.length || files.some((file) => source.core.exportRevision?.(file) !== check.revision))) {
    throw new Error('Exported files do not match the prechecked revision.')
  }
}
