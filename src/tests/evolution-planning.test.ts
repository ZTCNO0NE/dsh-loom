import { describe, expect, it } from 'vitest'
import { directionDiagnosisCard, eligibleConfigTargetIds, evolutionPlanningClarification, resolveEvolutionDirectionSelection, routeEvolutionDirection } from '../evolution/planning.js'

const config = {
  'agent-default-model': { config: { model: 'deepseek-chat' } },
  'safe-timeout': { config: { timeoutMs: 30_000 } },
  credentials: { config: { apiKey: '***', model: 'x' } },
  malformed: { value: true },
}

describe('user evolution planning preflight', () => {
  it('lists only host-owned editable rows without credential fields', () => {
    expect(eligibleConfigTargetIds(config)).toEqual(['agent-default-model', 'safe-timeout'])
  })

  it('asks a user-level direction question before freezing evidence', () => {
    expect(evolutionPlanningClarification(config, undefined, undefined)).toMatchObject({
      question: expect.stringContaining('新技能'),
      choices: [{ key: 'new_skill' }, { key: 'existing_config' }],
    })
  })

  it('gives concrete safe config choices and rejects secret-bearing targets', () => {
    expect(evolutionPlanningClarification(config, 'config', undefined)?.choices.map((choice) => choice.key)).toEqual(['agent-default-model', 'safe-timeout'])
    expect(evolutionPlanningClarification(config, 'config', 'credentials')).not.toBeNull()
    expect(evolutionPlanningClarification(config, 'config', 'agent-default-model')).toBeNull()
  })

  it('asks for a valid skill name without exposing a workspace path', () => {
    const clarification = evolutionPlanningClarification(config, 'skill', '失败复盘')
    expect(clarification?.question).toContain('kebab-case')
    expect(JSON.stringify(clarification)).not.toContain('workspace')
    expect(evolutionPlanningClarification(config, 'skill', 'refine-failure-evidence')).toBeNull()
  })

  it('routes bounded targets direct and ambiguous or failed work to Builder diagnosis', () => {
    expect(routeEvolutionDirection({ requirements: '新增复盘技能', targetKind: 'skill', targetId: 'failure-review' }).route).toBe('direct')
    expect(routeEvolutionDirection({ requirements: '最近越来越不聪明' }).route).toBe('diagnose')
    expect(routeEvolutionDirection({ mode: 'diagnose', requirements: '换 loop' }).route).toBe('diagnose')
    expect(routeEvolutionDirection({ requirements: '再试一次', targetKind: 'skill', targetId: 'failure-review', priorFailed: true }).route).toBe('diagnose')
  })

  it('projects a safe cross-layer Builder report into an Actor choice card', () => {
    const card = directionDiagnosisCard({ state: 'waiting_for_input', diagnosisReport: {
      available: true,
      directions: [
        { id: 'skill', layer: 'skill', goal: '补充失败复盘能力', unknowns: ['模型遵循率'], cost: 'low' },
        { id: 'loop', layer: 'loop', goal: '修复结构性调度问题', unknowns: ['契约影响'], cost: 'high' },
      ],
      question: { question: '优先哪层？', whyNow: '证据支持两种解释', options: [{ id: 'skill', label: 'Skill' }, { id: 'loop', label: 'Loop' }] },
    } })
    expect(card).toMatchObject({ phase: 'waiting_for_choice', directions: [{ key: 'skill', layer: 'skill' }, { key: 'loop', layer: 'loop' }], controls: ['view_status', 'choose_direction', 'cancel_diagnosis'] })
    expect(JSON.stringify(card)).not.toContain('evidenceRefs')
  })

  it('never exposes an unroutable question option as a selectable direction', () => {
    const card = directionDiagnosisCard({ state: 'waiting_for_input', diagnosisReport: {
      available: true,
      directions: [{ id: 'safe-skill', layer: 'skill', goal: '增加受控复盘技能', unknowns: [], cost: 'low' }],
      question: { question: '请选择。', options: [{ id: 'invented-target', label: '直接修改未知目标' }] },
    } })
    expect(card.question?.options).toEqual([{ key: 'safe-skill', label: '增加受控复盘技能' }])
  })

  it('routes a frozen Builder choice without letting diagnosis invent a host target', () => {
    const directions = [
      { id: 'skill', layer: 'skill' as const, goal: '补充复盘技能' },
      { id: 'loop', layer: 'loop' as const, goal: '修复调度语义', unknowns: ['契约影响'], cost: 'high' },
      { id: 'none', layer: 'no_change' as const, goal: '证据不足，保持现状' },
    ]
    expect(resolveEvolutionDirectionSelection(directions, 'skill')).toMatchObject({ kind: 'product', targetKind: 'skill' })
    expect(resolveEvolutionDirectionSelection(directions, 'loop')).toMatchObject({ kind: 'loop_confirmation', direction: { cost: 'high' } })
    expect(resolveEvolutionDirectionSelection(directions, 'none')).toMatchObject({ kind: 'no_change' })
    expect(resolveEvolutionDirectionSelection(directions, 'missing')).toMatchObject({ kind: 'invalid' })
    expect(JSON.stringify(resolveEvolutionDirectionSelection(directions, 'skill'))).not.toContain('targetId')
  })
})
