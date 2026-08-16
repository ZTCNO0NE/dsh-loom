import type { MetaPatch } from './types.js'

/** Loop-layer rows that must never be modified, even through targetKind=config. */
export interface LockedTargetPolicy {
  ids: string[]
  names: string[]
}

export const DEFAULT_LOCKED_TARGETS: LockedTargetPolicy = {
  ids: ['agent', 'agent-loop', 'meta-validate'],
  names: ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop'],
}

export function isLockedTarget(
  patch: Pick<MetaPatch, 'targetKind' | 'targetId' | 'targetName'>,
  policy: LockedTargetPolicy = DEFAULT_LOCKED_TARGETS,
): boolean {
  if (patch.targetKind === 'loop') return true
  if (policy.ids.includes(patch.targetId)) return true
  const name = patch.targetName ?? ''
  if (policy.names.includes(name)) return true
  return false
}
