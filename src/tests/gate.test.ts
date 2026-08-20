import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Gate, type ApplyOps } from '../gate/index.js'
import { paths, readJsonl } from '../protocol/index.js'
import type { MetaPatch, SmokeReport } from '../types.js'

function patch(overrides: Partial<MetaPatch> = {}): MetaPatch {
  return {
    id: 'p1',
    targetId: 'row-a',
    targetKind: 'config',
    config: { timeoutMs: 30000 },
    dependencies: [],
    rationale: 'x',
    expectedOutcome: 'ok',
    version: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function setup(overrides: Partial<ApplyOps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mv-gate-'))
  const sessionId = 's1'
  let stored: Record<string, unknown> = { timeoutMs: 5000 }
  const writes: Record<string, unknown>[] = []
  const ops: ApplyOps = {
    readConfig: () => stored,
    writeConfig: (_id, config) => {
      writes.push(config)
      stored = config
    },
    smoke: (): SmokeReport => ({ schemaVersion: 1, patchId: 'p1', passed: true, checks: [], ranAt: new Date().toISOString() }),
    ...overrides,
  }
  const gate = new Gate(null, { root, sessionId })
  return { root, sessionId, gate, ops, writes, get stored() { return stored } }
}

describe('gate A4', () => {
  it('applies on success and records history', async () => {
    const { root, sessionId, gate, ops, writes } = setup()
    const result = await gate.applyWithRollback(patch(), ops)
    expect(result.applied).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({ timeoutMs: 30000 })
    const history = readJsonl<{ action: string }>(paths.history(root, sessionId))
    expect(history.some((record) => record.action === 'apply')).toBe(true)
  })

  it('rolls back to the before snapshot when smoke fails', async () => {
    const { root, sessionId, gate, ops, writes, stored } = setup({
      smoke: () => ({
        schemaVersion: 1,
        patchId: 'p1',
        passed: false,
        checks: [{ name: 'smoke-hello', passed: false, detail: 'mismatch' }],
        ranAt: new Date().toISOString(),
      }),
    })
    const result = await gate.applyWithRollback(patch(), ops)
    expect(result.applied).toBe(false)
    expect(result.error).toContain('smoke failed')
    expect(writes).toHaveLength(2)
    expect(stored).toEqual({ timeoutMs: 5000 })
    const history = readJsonl<{ action: string }>(paths.history(root, sessionId))
    expect(history.some((record) => record.action === 'rollback')).toBe(true)
  })

  it('surfaces a write failure without applying', async () => {
    const { gate, ops, writes } = setup({
      writeConfig: () => { throw new Error('disk full') },
    })
    const result = await gate.applyWithRollback(patch(), ops)
    expect(result.applied).toBe(false)
    expect(result.error).toContain('write failed')
    expect(writes).toHaveLength(0)
  })

  it('awaits async write failures and records apply-error instead of apply', async () => {
    const { root, sessionId, gate, ops } = setup({
      writeConfig: async () => { throw new Error('async write failed') },
    })
    const result = await gate.applyWithRollback(patch(), ops)
    expect(result.applied).toBe(false)
    expect(result.error).toContain('async write failed')
    const history = readJsonl<{ action: string }>(paths.history(root, sessionId))
    expect(history.some((record) => record.action === 'apply-error')).toBe(true)
    expect(history.some((record) => record.action === 'apply')).toBe(false)
  })

  it('carries the persisted overlay path from writeConfig into apply records', async () => {
    const { root, sessionId, gate, ops } = setup({
      writeConfig: () => '/tmp/meta-validate/overlays/s1/p1.yml',
    })
    const result = await gate.applyWithRollback(patch(), ops)
    expect(result.applied).toBe(true)
    expect(result.overlay).toBe('/tmp/meta-validate/overlays/s1/p1.yml')
    const history = readJsonl<{ action: string; overlay?: string }>(paths.history(root, sessionId))
    expect(history.find((record) => record.action === 'apply')?.overlay).toBe('/tmp/meta-validate/overlays/s1/p1.yml')
  })

  it('calls restoreConfig when smoke fails after a write', async () => {
    const restored: string[] = []
    const { gate, ops } = setup({
      smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: false, checks: [{ name: 'x', passed: false }], ranAt: new Date().toISOString() }),
      restoreConfig: (id) => { restored.push(id) },
    })
    const result = await gate.applyWithRollback(patch(), ops)
    expect(result.applied).toBe(false)
    expect(restored).toEqual(['row-a'])
  })

  it('rolls back an installed config only when the current value still matches the Gate after snapshot', async () => {
    const { root, sessionId, gate, ops } = setup()
    const candidate = patch()
    const applied = await gate.applyWithRollback(candidate, ops)
    expect(applied.applied).toBe(true)
    ops.restoreConfig = async (id, value, source) => { await ops.writeConfig(id, value, source) }
    const receipt = await gate.rollbackInstalledConfig(candidate, applied.before, ops)
    expect(receipt).toMatchObject({ rolledBack: true, before: { timeoutMs: 30000 }, after: { timeoutMs: 5000 } })
    expect(readJsonl<{ action: string }>(paths.history(root, sessionId)).some((entry) => entry.action === 'installed-rollback')).toBe(true)
    expect(readJsonl(paths.history(root, sessionId))).not.toHaveLength(0)
  })

  it('refuses installed rollback after the config has drifted', async () => {
    let stored: Record<string, unknown> = { timeoutMs: 99999 }
    const { root, sessionId, gate } = setup()
    const candidate = patch()
    const receipt = await gate.rollbackInstalledConfig(candidate, { timeoutMs: 5000 }, {
      readConfig: () => stored,
      writeConfig: (_id, value) => { stored = value },
      restoreConfig: (_id, value) => { stored = value },
      smoke: () => ({ schemaVersion: 1, patchId: candidate.id, passed: true, checks: [], ranAt: new Date().toISOString() }),
    })
    expect(receipt).toMatchObject({ rolledBack: false, conflict: 'installed config changed after Gate apply' })
    expect(stored).toEqual({ timeoutMs: 99999 })
    expect(readJsonl<{ action: string }>(paths.history(root, sessionId)).some((entry) => entry.action === 'installed-rollback-conflict')).toBe(true)
  })

  it('rejects on baseline conflict without writing', async () => {
    const { gate, ops, writes } = setup({ baseline: { timeoutMs: 9999 } })
    const result = await gate.applyWithRollback(patch(), ops)
    expect(result.applied).toBe(false)
    expect(result.conflict).toBe('entry changed during planning')
    expect(writes).toHaveLength(0)
  })

  it('rejects loop-layer targets even when targetKind is config', async () => {
    const { root, sessionId, gate, ops, writes } = setup()
    const result = await gate.applyWithRollback(
      patch({ targetId: 'agent-loop', targetName: '@deepseek-ai/dsh-agent-loop' }),
      ops,
    )
    expect(result.applied).toBe(false)
    expect(result.error).toContain('locked')
    expect(writes).toHaveLength(0)
    const history = readJsonl<{ action: string }>(paths.history(root, sessionId))
    expect(history.some((record) => record.action === 'locked-target-reject')).toBe(true)
  })

  it('inserts a new row on success and records history (M4)', async () => {
    const { root, sessionId, gate } = setup()
    const inserted: string[] = []
    const removed: string[] = []
    const ops: ApplyOps = {
      readConfig: () => ({}),
      writeConfig: () => {},
      smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: true, checks: [], ranAt: new Date().toISOString() }),
      rowExists: () => false,
      insertRow: (p) => { inserted.push(p.targetId) },
      removeRow: (id) => { removed.push(id) },
    }
    const result = await gate.applyWithRollback(patch({ action: 'insert', targetName: 'new-tool' }), ops)
    expect(result.applied).toBe(true)
    expect(inserted).toEqual(['row-a'])
    const history = readJsonl<{ action: string }>(paths.history(root, sessionId))
    expect(history.some((record) => record.action === 'insert')).toBe(true)
  })

  it('rolls back an inserted row when smoke fails (M4)', async () => {
    const { root, sessionId, gate } = setup()
    const removed: string[] = []
    const ops: ApplyOps = {
      readConfig: () => ({}),
      writeConfig: () => {},
      smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: false, checks: [{ name: 'x', passed: false }], ranAt: new Date().toISOString() }),
      rowExists: () => false,
      insertRow: () => {},
      removeRow: (id) => { removed.push(id) },
    }
    const result = await gate.applyWithRollback(patch({ action: 'insert', targetName: 'new-tool' }), ops)
    expect(result.applied).toBe(false)
    expect(removed).toEqual(['row-a'])
    const history = readJsonl<{ action: string }>(paths.history(root, sessionId))
    expect(history.some((record) => record.action === 'insert-rollback')).toBe(true)
  })

  it('rejects insert when the row already exists (M4)', async () => {
    const { gate } = setup()
    let inserted = false
    const ops: ApplyOps = {
      readConfig: () => ({}),
      writeConfig: () => {},
      smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: true, checks: [], ranAt: new Date().toISOString() }),
      rowExists: () => true,
      insertRow: () => { inserted = true },
      removeRow: () => {},
    }
    const result = await gate.applyWithRollback(patch({ action: 'insert', targetName: 'new-tool' }), ops)
    expect(result.applied).toBe(false)
    expect(result.conflict).toBe('row already exists')
    expect(inserted).toBe(false)
  })

  it('installs a skill file and records history (M4 skill)', async () => {
    const { root, sessionId, gate } = setup()
    const installed: string[] = []
    const removed: string[] = []
    const skillPatch = patch({ action: 'insert', targetName: 'edit-verify', targetKind: 'skill' })
    skillPatch.module = { files: [{ path: 'edit-verify/SKILL.md', content: '---\nname: edit-verify\n---\nbody' }], entry: 'edit-verify/SKILL.md' }
    const ops: ApplyOps = {
      readConfig: () => ({}),
      writeConfig: () => {},
      smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: true, checks: [], ranAt: new Date().toISOString() }),
      skillExists: () => false,
      installSkill: (p) => { installed.push(p.targetId) },
      removeSkill: (id) => { removed.push(id) },
    }
    const result = await gate.applyWithRollback(skillPatch, ops)
    expect(result.applied).toBe(true)
    expect(installed).toEqual(['row-a'])
    const history = readJsonl<{ action: string; smoke?: SmokeReport }>(paths.history(root, sessionId))
    const receipt = history.find((record) => record.action === 'skill-insert')
    expect(receipt?.smoke?.passed).toBe(true)
  })

  it('rolls back a skill when smoke fails (M4 skill)', async () => {
    const { root, sessionId, gate } = setup()
    const removed: string[] = []
    const skillPatch = patch({ action: 'insert', targetName: 'edit-verify', targetKind: 'skill' })
    skillPatch.module = { files: [{ path: 'edit-verify/SKILL.md', content: 'body' }], entry: 'edit-verify/SKILL.md' }
    const ops: ApplyOps = {
      readConfig: () => ({}),
      writeConfig: () => {},
      smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: false, checks: [{ name: 'x', passed: false }], ranAt: new Date().toISOString() }),
      skillExists: () => false,
      installSkill: () => {},
      removeSkill: (id) => { removed.push(id) },
    }
    const result = await gate.applyWithRollback(skillPatch, ops)
    expect(result.applied).toBe(false)
    expect(removed).toEqual(['row-a'])
    const history = readJsonl<{ action: string; smoke?: SmokeReport }>(paths.history(root, sessionId))
    const receipt = history.find((record) => record.action === 'skill-insert-rollback')
    expect(receipt?.smoke?.checks[0]?.name).toBe('x')
  })

  it('rejects skill install when the skill already exists (M4 skill)', async () => {
    const { gate } = setup()
    let installed = false
    const skillPatch = patch({ action: 'insert', targetName: 'edit-verify', targetKind: 'skill' })
    skillPatch.module = { files: [{ path: 'edit-verify/SKILL.md', content: 'body' }], entry: 'edit-verify/SKILL.md' }
    const ops: ApplyOps = {
      readConfig: () => ({}),
      writeConfig: () => {},
      smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: true, checks: [], ranAt: new Date().toISOString() }),
      skillExists: () => true,
      installSkill: () => { installed = true },
      removeSkill: () => {},
    }
    const result = await gate.applyWithRollback(skillPatch, ops)
    expect(result.applied).toBe(false)
    expect(result.conflict).toBe('skill already exists')
    expect(installed).toBe(false)
  })
})
