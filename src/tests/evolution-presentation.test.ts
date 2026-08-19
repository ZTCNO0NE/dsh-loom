import { describe, expect, it } from 'vitest'
import { userEvolutionTaskCard } from '../evolution/presentation.js'
import type { UserEvolutionPlan } from '../evolution/controller.js'

const plan = (state: UserEvolutionPlan['state']): UserEvolutionPlan => ({
  schemaVersion: 1, id: 'evolution-test', createdAt: '2026-08-20T00:00:00.000Z', requirements: 'add refine', state,
  target: { kind: 'skill', plan: { capability: 'skill-evolution', targetId: 'refine', targetKind: 'skill', entry: 'refine/SKILL.md' }, summary: '添加 refine 技能', verification: 'cold load and rollback', risks: ['instruction adherence'] },
  evidence: { refs: ['/secret/internal/path', '/another/internal/path'], summary: 'frozen evidence' },
})

describe('user evolution task card', () => {
  it('gives a confirmation card without exposing the plan workspace or before snapshot', () => {
    const card = userEvolutionTaskCard(plan('planned'))
    expect(card).toMatchObject({ phase: 'waiting_for_confirmation', actions: ['confirm_execute', 'view_evidence'], controls: ['confirm', 'view_evidence'], evidence: { artifactCount: 2 }, confirmation: expect.any(String) })
    expect(JSON.stringify(card)).not.toContain('/secret/internal/path')
    expect(JSON.stringify(card)).not.toContain('refine/SKILL.md')
    expect(JSON.stringify(card)).not.toContain('targetKind')
  })

  it('shows independent non-application as a user-visible terminal state', () => {
    const rejected = plan('rejected')
    rejected.result = { runId: 'r', targetKind: 'skill', targetId: 'refine', verdict: 'rejected', applied: false, summary: 'cold smoke failed', limitations: ['Gate remains final'] }
    expect(userEvolutionTaskCard(rejected)).toMatchObject({ phase: 'not_applied', result: { outcome: '未生效', summary: 'cold smoke failed' } })
  })
})
