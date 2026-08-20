import type { Context } from '@deepseek-ai/cordis'
import type { AppliedMetaPatch, MetaPatch, PatchState, PatchStatus, SmokeReport } from '../types.js'
import { appendJsonl, atomicWriteJson, paths, PROTOCOL_VERSION } from '../protocol/index.js'
import { DEFAULT_LOCKED_TARGETS, isLockedTarget, type LockedTargetPolicy } from '../policy.js'

/** Injected runtime access so the gate can be tested without a live dsh context. */
export interface ApplyOps {
  readConfig(targetId: string): Record<string, unknown>
  writeConfig(targetId: string, config: Record<string, unknown>, patch: MetaPatch): string | void | Promise<string | void>
  restoreConfig?(targetId: string, before: Record<string, unknown>, patch: MetaPatch): void | Promise<void>
  smoke(patch: MetaPatch, before: Record<string, unknown>): SmokeReport | Promise<SmokeReport>
  baseline?: Record<string, unknown>
  rowExists?(id: string): boolean
  insertRow?(patch: MetaPatch): void | Promise<void>
  removeRow?(id: string): void | Promise<void>
  skillExists?(id: string): boolean
  installSkill?(patch: MetaPatch): void | Promise<void>
  removeSkill?(id: string): void | Promise<void>
}

export interface ApplyResult extends AppliedMetaPatch {
  smoke?: SmokeReport
  conflict?: string
  /** Persisted overlay path for config-update patches (cold-apply artifact). */
  overlay?: string
}

export interface ConfigRollbackReceipt {
  schemaVersion: number
  patchId: string
  targetId: string
  action: 'rollback-installed-config'
  rolledBack: boolean
  before: Record<string, unknown>
  after: Record<string, unknown>
  conflict?: string
  error?: string
  at: string
}

export class Gate {
  private pending: MetaPatch[] = []

  constructor(
    private ctx: Context | null,
    private meta: { root: string; sessionId: string } = { root: '', sessionId: '' },
    private lockedTargets: LockedTargetPolicy = DEFAULT_LOCKED_TARGETS,
  ) {}

  pendingCount(): number {
    return this.pending.length
  }

  enqueue(patch: MetaPatch): void {
    this.pending.push(patch)
  }

  async drain(ops: ApplyOps): Promise<ApplyResult[]> {
    const results: ApplyResult[] = []
    for (const patch of this.pending.splice(0)) {
      results.push(await this.applyWithRollback(patch, ops))
    }
    return results
  }

  /**
   * Prime-agent style cold apply: snapshot -> baseline conflict check ->
   * atomic write -> smoke -> rollback on failure. History is append-only.
   */
  async applyWithRollback(patch: MetaPatch, ops: ApplyOps): Promise<ApplyResult> {
    if (isLockedTarget(patch, this.lockedTargets)) {
      const result: ApplyResult = {
        patch,
        before: {},
        after: patch.config,
        applied: false,
        error: `target ${patch.targetId} is locked (loop layer)`,
      }
      this.record(patch.id, 'locked-target-reject', {}, patch.config, result.error)
      return result
    }
    if (patch.action === 'insert') {
      return this.applyInsert(patch, ops)
    }
    const before = ops.readConfig(patch.targetId)

    if (ops.baseline && JSON.stringify(ops.baseline) !== JSON.stringify(before)) {
      const result: ApplyResult = {
        patch,
        before,
        after: patch.config,
        applied: false,
        conflict: 'entry changed during planning',
      }
      this.record(patch.id, 'reject-conflict', before, patch.config, result.conflict)
      return result
    }

    let overlay: string | undefined
    try {
      overlay = (await ops.writeConfig(patch.targetId, patch.config, patch)) ?? undefined
    } catch (error) {
      const result: ApplyResult = {
        patch,
        before,
        after: patch.config,
        applied: false,
        error: `write failed: ${String(error)}`,
      }
      this.record(patch.id, 'apply-error', before, patch.config, result.error)
      return result
    }

    const smoke = await ops.smoke(patch, before)
    if (!smoke.passed) {
      let rollbackError: string | undefined
      try {
        if (ops.restoreConfig) {
          await ops.restoreConfig(patch.targetId, before, patch)
        } else {
          await ops.writeConfig(patch.targetId, before, patch)
        }
      } catch (error) {
        rollbackError = `rollback failed: ${String(error)}`
      }
      const result: ApplyResult = {
        patch,
        before,
        after: before,
        applied: false,
        smoke,
        error: rollbackError ?? `smoke failed: ${smoke.checks.filter((check) => !check.passed).map((check) => check.name).join(',')}`,
      }
      this.record(patch.id, rollbackError ? 'rollback-error' : 'rollback', before, before, result.error, { smoke })
      return result
    }

    const result: ApplyResult = {
      patch,
      before,
      after: patch.config,
      applied: true,
      smoke,
      overlay,
    }
    this.record(patch.id, 'apply', before, patch.config, undefined, { ...(overlay ? { overlay } : {}), smoke })
    return result
  }

  /** Roll back one already-installed config patch from its Gate-owned before snapshot. */
  async rollbackInstalledConfig(
    patch: MetaPatch,
    installedBefore: Record<string, unknown>,
    ops: ApplyOps,
  ): Promise<ConfigRollbackReceipt> {
    const current = ops.readConfig(patch.targetId)
    const at = new Date().toISOString()
    const finish = (receipt: ConfigRollbackReceipt): ConfigRollbackReceipt => {
      if (this.meta.root && this.meta.sessionId) {
        atomicWriteJson(paths.rollbackReceipt(this.meta.root, this.meta.sessionId, patch.id), receipt)
      }
      return receipt
    }
    if (patch.targetKind !== 'config' || patch.action === 'insert') {
      const error = 'installed config rollback requires an update config patch'
      this.record(patch.id, 'installed-rollback-error', current, current, error)
      return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: false, before: current, after: current, error, at })
    }
    if (JSON.stringify(current) !== JSON.stringify(patch.config)) {
      const conflict = 'installed config changed after Gate apply'
      this.record(patch.id, 'installed-rollback-conflict', current, current, conflict)
      return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: false, before: current, after: current, conflict, at })
    }
    if (!ops.restoreConfig) {
      const error = 'restoreConfig is unavailable'
      this.record(patch.id, 'installed-rollback-error', current, current, error)
      return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: false, before: current, after: current, error, at })
    }
    try {
      await ops.restoreConfig(patch.targetId, installedBefore, patch)
      const restored = ops.readConfig(patch.targetId)
      if (JSON.stringify(restored) !== JSON.stringify(installedBefore)) {
        const error = 'rollback readback does not match the Gate before snapshot'
        this.record(patch.id, 'installed-rollback-error', current, restored, error)
        return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: false, before: current, after: restored, error, at })
      }
      this.record(patch.id, 'installed-rollback', current, restored)
      return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: true, before: current, after: restored, at })
    } catch (caught) {
      const error = `rollback failed: ${String(caught)}`
      this.record(patch.id, 'installed-rollback-error', current, ops.readConfig(patch.targetId), error)
      return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: false, before: current, after: ops.readConfig(patch.targetId), error, at })
    }
  }

  private async applyInsert(patch: MetaPatch, ops: ApplyOps): Promise<ApplyResult> {
    const before: Record<string, unknown> = {}
    if (patch.targetKind === 'skill') {
      return this.applyInsertSkill(patch, ops, before)
    }
    if (!ops.insertRow || !ops.removeRow) {
      const result: ApplyResult = { patch, before, after: patch.config, applied: false, error: 'insert ops not available' }
      this.record(patch.id, 'insert-error', before, patch.config, result.error)
      return result
    }
    if (ops.rowExists && ops.rowExists(patch.targetId)) {
      const result: ApplyResult = { patch, before, after: patch.config, applied: false, conflict: 'row already exists' }
      this.record(patch.id, 'insert-conflict', before, patch.config, result.conflict)
      return result
    }
    try {
      await ops.insertRow(patch)
    } catch (error) {
      const result: ApplyResult = { patch, before, after: patch.config, applied: false, error: `insert failed: ${String(error)}` }
      this.record(patch.id, 'insert-error', before, patch.config, result.error)
      return result
    }
    const smoke = await ops.smoke(patch, before)
    if (!smoke.passed) {
      let rollbackError: string | undefined
      try {
        await ops.removeRow(patch.targetId)
      } catch (error) {
        rollbackError = `insert rollback failed: ${String(error)}`
      }
      const result: ApplyResult = {
        patch,
        before,
        after: {},
        applied: false,
        smoke,
        error: rollbackError ?? `smoke failed: ${smoke.checks.filter((check) => !check.passed).map((check) => check.name).join(',')}`,
      }
      this.record(patch.id, rollbackError ? 'insert-rollback-error' : 'insert-rollback', before, {}, result.error, { smoke })
      return result
    }
    const result: ApplyResult = { patch, before, after: patch.config, applied: true, smoke }
    this.record(patch.id, 'insert', before, patch.config, undefined, { smoke })
    return result
  }

  /** M4: skill patches install SKILL.md files into a skill root (no loader row). */
  private async applyInsertSkill(patch: MetaPatch, ops: ApplyOps, before: Record<string, unknown>): Promise<ApplyResult> {
    if (!ops.installSkill || !ops.removeSkill) {
      const result: ApplyResult = { patch, before, after: patch.config, applied: false, error: 'skill ops not available' }
      this.record(patch.id, 'skill-insert-error', before, patch.config, result.error)
      return result
    }
    if (ops.skillExists && ops.skillExists(patch.targetId)) {
      const result: ApplyResult = { patch, before, after: patch.config, applied: false, conflict: 'skill already exists' }
      this.record(patch.id, 'skill-conflict', before, patch.config, result.conflict)
      return result
    }
    try {
      await ops.installSkill(patch)
    } catch (error) {
      const result: ApplyResult = { patch, before, after: patch.config, applied: false, error: `skill install failed: ${String(error)}` }
      this.record(patch.id, 'skill-insert-error', before, patch.config, result.error)
      return result
    }
    const smoke = await ops.smoke(patch, before)
    if (!smoke.passed) {
      let rollbackError: string | undefined
      try {
        await ops.removeSkill(patch.targetId)
      } catch (error) {
        rollbackError = `skill rollback failed: ${String(error)}`
      }
      const result: ApplyResult = {
        patch,
        before,
        after: {},
        applied: false,
        smoke,
        error: rollbackError ?? `smoke failed: ${smoke.checks.filter((check) => !check.passed).map((check) => check.name).join(',')}`,
      }
      this.record(patch.id, rollbackError ? 'skill-insert-rollback-error' : 'skill-insert-rollback', before, {}, result.error, { smoke })
      return result
    }
    const result: ApplyResult = { patch, before, after: patch.config, applied: true, smoke }
    this.record(patch.id, 'skill-insert', before, patch.config, undefined, { smoke })
    return result
  }

  /** Persist the patch state machine (I11). */
  markStatus(
    root: string,
    sessionId: string,
    patchId: string,
    state: PatchState,
    operator: string,
    iteration: number,
    error?: string,
  ): void {
    const status: PatchStatus = {
      schemaVersion: PROTOCOL_VERSION,
      patchId,
      state,
      updatedAt: new Date().toISOString(),
      operator,
      iteration,
      error,
    }
    atomicWriteJson(paths.status(root, sessionId, patchId), status)
  }

  private record(
    patchId: string,
    action: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    error?: string,
    extra?: Record<string, unknown>,
  ): void {
    if (!this.meta.root || !this.meta.sessionId) return
    appendJsonl(paths.history(this.meta.root, this.meta.sessionId), {
      schemaVersion: PROTOCOL_VERSION,
      patchId,
      action,
      before,
      after,
      error,
      ...extra,
      at: new Date().toISOString(),
    })
  }
}
