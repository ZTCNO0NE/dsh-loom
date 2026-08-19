import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActorEvolutionGateway } from '../candidates/actor-gateway.js'
import { UserEvolutionController } from '../evolution/controller.js'
import { Gate } from '../gate/index.js'
import { Validator } from '../validate/index.js'
import { adjudicatePatch, classifyBuilderProposal } from '../deliberation/index.js'

const regressionDir = new URL('../../meta-regressions/', import.meta.url).pathname

describe('user evolution controller', () => {
  it('persists a host-resolved plan before executing a config candidate through the existing verifier and Gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-user-evolution-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\nprintf \'{"model":"after"}\\n\' > "$PWD/actor-config.json"\nprintf \'{"messages":[{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const gateway = new ActorEvolutionGateway({ root, sessionId: 'actor', model: 'test', miniSwe: { executable, configPath: 'ignored', stepLimit: 3, timeoutMs: 5_000 } })
    let live: Record<string, unknown> = { model: 'before' }
    const controller = new UserEvolutionController({
      root, sessionId: 'user', gateway,
      resolveTarget: (_requirements, kind) => {
        if (kind !== 'config') throw new Error('fixture only supports config')
        return {
          kind: 'config', plan: {
            capability: 'config-evolution', targetId: 'agent-default-model', before: live,
            expectedTrajectory: { schemaVersion: 1, patchId: 'host', events: [{ type: 'turn/start' }, { type: 'turn/end', reason: 'success' }], coverage: { claimedBehaviors: [] } },
          },
          summary: 'Change the host-selected model row.', verification: 'cold config smoke', risks: ['model route may be unavailable'],
        }
      },
      evidenceFor: () => ({ refs: ['frames.jsonl'], summary: 'Actor requested a verified model change.' }),
      adjudicate: async (proposal) => {
        const classified = classifyBuilderProposal(proposal)
        if (classified.kind !== 'known' || classified.proposal.capability !== 'patch-evolution') throw new Error('fixture requires patch proposal')
        return adjudicatePatch(classified.proposal, {
          root, sessionId: 'actor:actor-evolution',
          validator: new Validator(null, { regressionDir, maxCases: 0 }),
          gate: new Gate(null, { root, sessionId: 'actor:actor-evolution' }),
          evidenceEvents: [{ type: 'turn/start' }, { type: 'turn/end', reason: 'success' }],
          applyOps: {
            readConfig: () => live, writeConfig: (_id, config) => { live = config }, baseline: live,
            smoke: patch => ({ schemaVersion: 1, patchId: patch.id, passed: true, checks: [{ name: 'cold-config-smoke', passed: true }], ranAt: new Date().toISOString() }),
          },
        })
      },
    })
    const plan = controller.plan('switch to an available model', 'config')
    expect(controller.read(plan.id)).toMatchObject({ state: 'planned', target: { kind: 'config' }, evidence: { refs: ['frames.jsonl'] } })
    const complete = await controller.execute(plan.id)
    expect(complete).toMatchObject({ state: 'completed', result: { verdict: 'approved', applied: true, targetId: 'agent-default-model' } })
    expect(live).toEqual({ model: 'after' })
  })

  it('rejects re-execution of an immutable plan', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-user-evolution-state-'))
    const controller = new UserEvolutionController({
      root, sessionId: 'user', gateway: {} as ActorEvolutionGateway,
      resolveTarget: () => ({ kind: 'skill', plan: { capability: 'skill-evolution', targetId: 'refine', targetKind: 'skill', entry: 'refine/SKILL.md' }, summary: 'x', verification: 'x', risks: [] }),
      evidenceFor: () => ({ refs: [], summary: 'x' }), adjudicate: async () => { throw new Error('unused') },
    })
    const plan = controller.plan('add a refine skill', 'skill')
    const stored = controller.read(plan.id)
    stored.state = 'completed'
    // Simulate a terminal durable record; execute must refuse it.
    writeFileSync(join(root, 'user-evolution', 'user', `${plan.id}.json`), JSON.stringify(stored), 'utf8')
    return expect(controller.execute(plan.id)).rejects.toThrow('not executable')
  })

  it('claims a plan before background execution so it cannot be queued twice', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-user-evolution-queue-'))
    const controller = new UserEvolutionController({
      root, sessionId: 'user', gateway: {} as ActorEvolutionGateway,
      resolveTarget: () => ({ kind: 'skill', plan: { capability: 'skill-evolution', targetId: 'refine', targetKind: 'skill', entry: 'refine/SKILL.md' }, summary: 'x', verification: 'x', risks: [] }),
      evidenceFor: () => ({ refs: [], summary: 'x' }), adjudicate: async () => { throw new Error('unused') },
    })
    const plan = controller.plan('add a refine skill', 'skill')
    expect(controller.queue(plan.id)).toMatchObject({ state: 'queued' })
    expect(() => controller.queue(plan.id)).toThrow('not queueable')
  })

  it('allows cancellation only before a queued plan receives a workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-user-evolution-cancel-'))
    const controller = new UserEvolutionController({
      root, sessionId: 'user', gateway: {} as ActorEvolutionGateway,
      resolveTarget: () => ({ kind: 'skill', plan: { capability: 'skill-evolution', targetId: 'refine', targetKind: 'skill', entry: 'refine/SKILL.md' }, summary: 'x', verification: 'x', risks: [] }),
      evidenceFor: () => ({ refs: [], summary: 'x' }), adjudicate: async () => { throw new Error('unused') },
    })
    const plan = controller.plan('add a refine skill', 'skill')
    controller.queue(plan.id)
    expect(controller.cancel(plan.id)).toMatchObject({ state: 'cancelled', result: { applied: false, verdict: 'aborted' } })
    expect(() => controller.cancel(plan.id)).toThrow('not cancellable')
  })

  it('persists an independent Gate rejection as a user-visible not-applied report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-user-evolution-reject-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\nprintf \'{"model":"after"}\\n\' > "$PWD/actor-config.json"\nprintf \'{"messages":[{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const gateway = new ActorEvolutionGateway({ root, sessionId: 'actor', model: 'test', miniSwe: { executable, configPath: 'ignored', stepLimit: 3, timeoutMs: 5_000 } })
    const controller = new UserEvolutionController({
      root, sessionId: 'user', gateway,
      resolveTarget: () => ({ kind: 'config', plan: { capability: 'config-evolution', targetId: 'safe-row', before: { model: 'before' } }, summary: 'x', verification: 'x', risks: [] }),
      evidenceFor: () => ({ refs: ['frozen-evidence.json'], summary: 'frozen' }),
      adjudicate: async () => ({
        kind: 'patch', verdict: 'rejected', patch: {} as never,
        report: { patchId: 'p', verdict: 'rejected', score: 0, evidence: [], failureSummary: 'cold smoke failed', validatedAt: new Date().toISOString() },
        reason: 'cold smoke failed',
      }),
    })
    const plan = controller.plan('make it better', 'config')
    const result = await controller.execute(plan.id)
    expect(result).toMatchObject({ state: 'rejected', result: { verdict: 'rejected', applied: false, summary: 'cold smoke failed' } })
    expect(controller.read(plan.id).result?.limitations).toContain('Verifier and Gate remain independent final authorities.')
  })
})
