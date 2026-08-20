import { describe, expect, it } from 'vitest'
import { terminalJobFromPlan } from '../evolution/job-recovery.js'
import type { UserEvolutionPlan } from '../evolution/controller.js'

function plan(state: UserEvolutionPlan['state']): UserEvolutionPlan {
  return {
    schemaVersion: 1,
    id: 'evolution-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    requirements: 'change model',
    state,
    target: {
      kind: 'config',
      plan: { capability: 'config-evolution', targetId: 'agent-default-model', before: {} },
      summary: 'change model', verification: 'gate', risks: [],
    },
    evidence: { refs: [], summary: 'frozen' },
  }
}

describe('user evolution job recovery', () => {
  it('repairs a stale running job from an already completed immutable plan', () => {
    const completed = plan('completed')
    completed.result = {
      runId: 'builder-1', targetKind: 'config', targetId: 'agent-default-model',
      verdict: 'approved', applied: true, effective: false, restartRequired: true,
      summary: 'approved', limitations: [],
    }
    expect(terminalJobFromPlan(completed)).toEqual({
      status: 'finished',
      summary: '用户委托 config/agent-default-model：待重启生效',
    })
  })

  it('does not invent a terminal job while the immutable plan still needs a worker', () => {
    expect(terminalJobFromPlan(plan('executing'))).toBeNull()
    expect(terminalJobFromPlan(plan('verifying'))).toBeNull()
  })

  it('projects rollback above an obsolete restart-required flag', () => {
    const rolledBack = plan('completed')
    rolledBack.result = {
      runId: 'builder-1', targetKind: 'config', targetId: 'agent-default-model', verdict: 'approved',
      applied: false, effective: false, restartRequired: true, rolledBack: true,
      summary: 'restored before snapshot', limitations: [],
    }
    expect(terminalJobFromPlan(rolledBack)).toEqual({
      status: 'finished',
      summary: '用户委托 config/agent-default-model：已回滚',
    })
  })
})
