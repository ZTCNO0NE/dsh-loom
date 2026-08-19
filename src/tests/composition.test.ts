import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { adjudicateComposition, applyCompositionWithRollback, verifyComposition, type ActorCompositionProposal } from '../composition/index.js'
import { compileCompositionWorkspace } from '../composition/compiler.js'
import type { MetaPatch } from '../types.js'

function patch(id: string, targetId: string): MetaPatch {
  return {
    id, action: 'update', targetId, targetKind: 'config', config: { value: id }, dependencies: [], rationale: 'fixture', expectedOutcome: 'fixture', version: 1, createdAt: new Date().toISOString(),
    expectedTrajectory: { schemaVersion: 1, patchId: id, events: [{ type: 'turn/start' }], coverage: { claimedBehaviors: [] } },
  }
}

function proposal(): ActorCompositionProposal {
  return {
    capability: 'actor-composition', id: 'composition-fixture', rationale: 'install a config and its dependent tool', expectedOutcome: 'both available',
    operations: [
      { id: 'config', dependsOn: [], patch: patch('patch-config', 'agent-config') },
      { id: 'tool', dependsOn: ['config'], patch: { ...patch('patch-tool', 'echo-tool'), action: 'insert', targetKind: 'tool' } },
    ],
  }
}

describe('actor composition verifier and transactional Gate', () => {
  it('compiles only controller-planned config/module artifacts from an isolated workspace', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-loom-composition-'))
    mkdirSync(join(workspace, 'composition', 'config'), { recursive: true })
    mkdirSync(join(workspace, 'composition', 'tool', 'module'), { recursive: true })
    writeFileSync(join(workspace, 'composition', 'config', 'config.json'), '{"model":"after"}\n')
    writeFileSync(join(workspace, 'composition', 'tool', 'module', 'index.mjs'), 'export const name = "echo"\n')
    const trajectory = { schemaVersion: 1, patchId: 'controller', events: [{ type: 'turn/start' }], coverage: { claimedBehaviors: [] } }
    const compiled = compileCompositionWorkspace(workspace, {
      id: 'composition-fixture', rationale: 'tune and install', expectedOutcome: 'both available',
      targets: [
        { id: 'config', targetId: 'agent-config', targetKind: 'config', before: { model: 'before' }, expectedTrajectory: trajectory },
        { id: 'tool', dependsOn: ['config'], targetId: 'echo-tool', targetKind: 'tool', entry: 'index.mjs', expectedTrajectory: trajectory },
      ],
    })
    expect(compiled.operations).toMatchObject([
      { id: 'config', patch: { targetId: 'agent-config', action: 'update', config: { model: 'after' } } },
      { id: 'tool', dependsOn: ['config'], patch: { targetId: 'echo-tool', action: 'insert', module: { entry: 'index.mjs' } } },
    ])
  })

  it('rejects unknown targets and dependency cycles before any Gate operation', () => {
    const value = proposal()
    value.operations[0]!.dependsOn = ['tool']
    const report = verifyComposition(value, { allowedTargets: new Set(['agent-config']) })
    expect(report.verdict).toBe('rejected')
    expect(report.failureSummary).toContain('controller-allowed-targets')
    expect(report.failureSummary).toContain('acyclic-dependencies')
  })

  it('applies graph in dependency order then rolls all applied nodes back when cold smoke fails', async () => {
    const value = proposal()
    const report = verifyComposition(value, { allowedTargets: new Set(['agent-config', 'echo-tool']) })
    const state: string[] = []
    const result = await applyCompositionWithRollback(value, report, {
      snapshot: (operation) => ({ state: [...state], id: operation.id }),
      apply: (operation) => { state.push(`apply:${operation.id}`) },
      rollback: (operation) => { state.push(`rollback:${operation.id}`) },
      smoke: () => ({ schemaVersion: 1, patchId: 'composition-fixture', passed: false, checks: [{ name: 'cold-load', passed: false }], ranAt: new Date().toISOString() }),
    })
    expect(result).toMatchObject({ applied: false, rolledBack: ['tool', 'config'] })
    expect(state).toEqual(['apply:config', 'apply:tool', 'rollback:tool', 'rollback:config'])
  })

  it('rejects a stale verifier report without touching any target', async () => {
    const value = proposal()
    const report = verifyComposition(value, { allowedTargets: new Set(['agent-config', 'echo-tool']) })
    value.rationale = 'mutated after verifier'
    let touched = false
    const result = await applyCompositionWithRollback(value, report, {
      snapshot: () => { touched = true; return {} }, apply: () => { touched = true }, rollback: () => { touched = true },
      smoke: () => ({ schemaVersion: 1, patchId: 'x', passed: true, checks: [], ranAt: new Date().toISOString() }),
    })
    expect(result).toMatchObject({ applied: false, error: expect.stringContaining('stale') })
    expect(touched).toBe(false)
  })

  it('requires every component verifier before the transaction Gate can touch targets', async () => {
    const value = proposal()
    let touched = false
    const result = await adjudicateComposition(value, {
      allowedTargets: new Set(['agent-config', 'echo-tool']),
      verifyOperation: async (operation) => operation.id === 'tool' ? { passed: false, reason: 'module load failed' } : { passed: true },
      gate: {
        snapshot: () => { touched = true; return {} }, apply: () => { touched = true }, rollback: () => { touched = true },
        smoke: () => ({ schemaVersion: 1, patchId: 'x', passed: true, checks: [], ranAt: new Date().toISOString() }),
      },
    })
    expect(result).toMatchObject({ verdict: 'rejected', reason: expect.stringContaining('tool') })
    expect(touched).toBe(false)
  })
})
