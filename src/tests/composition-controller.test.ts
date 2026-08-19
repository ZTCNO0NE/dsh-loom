import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActorEvolutionGateway } from '../candidates/actor-gateway.js'
import { CompositionController } from '../composition/controller.js'
import { CompositionPlanRegistry } from '../composition/plan-registry.js'

describe('CompositionController', () => {
  it('materializes only a registered plan and reaches the transaction Gate after all child verifiers pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-composition-controller-'))
    const executable = join(root, 'fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi; if [ "$1" = "-c" ] && case "$2" in environment.cwd=*) true;; *) false;; esac; then work="${2#environment.cwd=}"; shift 2; continue; fi; shift; done\nprintf \'{"model":"after"}\\n\' > "$work/composition/config/config.json"\nmkdir -p "$work/composition/tool/module"; printf \'export const name = "echo"\\n\' > "$work/composition/tool/module/index.mjs"\nprintf \'{"messages":[{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const trajectory = { schemaVersion: 1 as const, patchId: 'p', events: [{ type: 'turn/start' }], coverage: { claimedBehaviors: [] } }
    const registry = new CompositionPlanRegistry([{ id: 'host-plan', rationale: 'coupled', expectedOutcome: 'ready', targets: [
      { id: 'config', targetId: 'agent-config', targetKind: 'config', before: { model: 'before' }, expectedTrajectory: trajectory },
      { id: 'tool', targetId: 'echo-tool', targetKind: 'tool', entry: 'index.mjs', dependsOn: ['config'], expectedTrajectory: trajectory },
    ] }])
    const gateway = new ActorEvolutionGateway({ root, sessionId: 's', model: 'test', miniSwe: { executable, configPath: 'x', stepLimit: 3, timeoutMs: 5_000 } })
    const applied: string[] = []
    const controller = new CompositionController(registry, gateway, () => ({
      allowedTargets: new Set(['agent-config', 'echo-tool']), verifyOperation: async () => ({ passed: true }),
      gate: { snapshot: (op) => ({ id: op.id }), apply: (op) => { applied.push(op.id) }, rollback: () => {}, smoke: (proposal) => ({ schemaVersion: 1, patchId: proposal.id, passed: true, checks: [], ranAt: new Date().toISOString() }) },
    }))
    const outcome = await controller.execute('host-plan', 'make both')
    expect(outcome.adjudication).toMatchObject({ verdict: 'approved', applied: { applied: true } })
    expect(applied).toEqual(['config', 'tool'])
  })

  it('does not touch the transaction Gate when a runtime-produced child is rejected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-composition-controller-reject-'))
    const executable = join(root, 'fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi; if [ "$1" = "-c" ] && case "$2" in environment.cwd=*) true;; *) false;; esac; then work="${2#environment.cwd=}"; shift 2; continue; fi; shift; done\nprintf \'{"model":"after"}\\n\' > "$work/composition/config/config.json"\nmkdir -p "$work/composition/tool/module"; printf \'export const name = "echo"\\n\' > "$work/composition/tool/module/index.mjs"\nprintf \'{"messages":[{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const trajectory = { schemaVersion: 1 as const, patchId: 'p', events: [{ type: 'turn/start' }], coverage: { claimedBehaviors: [] } }
    const registry = new CompositionPlanRegistry([{ id: 'host-plan', rationale: 'coupled', expectedOutcome: 'ready', targets: [
      { id: 'config', targetId: 'agent-config', targetKind: 'config', before: { model: 'before' }, expectedTrajectory: trajectory },
      { id: 'tool', targetId: 'echo-tool', targetKind: 'tool', entry: 'index.mjs', dependsOn: ['config'], expectedTrajectory: trajectory },
    ] }])
    const gateway = new ActorEvolutionGateway({ root, sessionId: 's', model: 'test', miniSwe: { executable, configPath: 'x', stepLimit: 3, timeoutMs: 5_000 } })
    let touched = false
    const controller = new CompositionController(registry, gateway, () => ({
      allowedTargets: new Set(['agent-config', 'echo-tool']), verifyOperation: async (op) => op.id === 'tool' ? { passed: false, reason: 'module probe failed' } : { passed: true },
      gate: { snapshot: () => { touched = true; return {} }, apply: () => { touched = true }, rollback: () => { touched = true }, smoke: () => ({ schemaVersion: 1, patchId: 'x', passed: true, checks: [], ranAt: new Date().toISOString() }) },
    }))
    const outcome = await controller.execute('host-plan', 'make both')
    expect(outcome.adjudication).toMatchObject({ verdict: 'rejected', reason: expect.stringContaining('tool') })
    expect(touched).toBe(false)
  })
})
