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

  it('distinguishes a verified config overlay awaiting restart from an effective skill install', () => {
    const config = plan('completed')
    config.target.kind = 'config'
    config.result = {
      runId: 'config-run', targetKind: 'config', targetId: 'agent-default-model', verdict: 'approved',
      applied: true, effective: false, restartRequired: true,
      summary: '配置 overlay 已通过冷启动验证，宿主重启后生效', limitations: [],
    }
    expect(userEvolutionTaskCard(config)).toMatchObject({
      phase: 'completed',
      result: { outcome: '待重启生效' },
      timeline: expect.arrayContaining([{ event: 'finished', label: '裁决完成，待重启生效' }]),
    })

    const skill = plan('completed')
    skill.result = {
      runId: 'skill-run', targetKind: 'skill', targetId: 'refine', verdict: 'approved',
      applied: true, effective: true, restartRequired: false, summary: '技能已冷加载', limitations: [],
    }
    expect(userEvolutionTaskCard(skill)).toMatchObject({ phase: 'completed', result: { outcome: '已生效' } })
  })

  it('keeps legacy stored reports without the new effectiveness fields readable', () => {
    const legacy = plan('completed')
    legacy.result = {
      runId: 'legacy-run', targetKind: 'skill', targetId: 'refine', verdict: 'approved',
      applied: true, summary: 'legacy success', limitations: [],
    }
    expect(userEvolutionTaskCard(legacy)).toMatchObject({ phase: 'completed', result: { outcome: '已生效' } })
  })

  it('shows a Gate-owned rollback without exposing its receipt path', () => {
    const rolledBack = plan('completed')
    rolledBack.result = {
      runId: 'config-run', targetKind: 'config', targetId: 'agent-default-model', verdict: 'approved',
      applied: false, effective: false, restartRequired: false, rolledBack: true,
      rollbackReceipt: 'C:/secret/internal/rollback.json', summary: '已通过 Gate 回滚', limitations: [],
    }
    const card = userEvolutionTaskCard(rolledBack)
    expect(card).toMatchObject({ phase: 'completed', result: { outcome: '已回滚' } })
    expect(JSON.stringify(card)).not.toContain('rollback.json')
  })
})
