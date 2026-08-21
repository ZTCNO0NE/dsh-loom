import { describe, expect, it } from 'vitest'
import { eligibleConfigTargetIds, evolutionPlanningClarification } from '../evolution/planning.js'

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
})
