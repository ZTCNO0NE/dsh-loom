import { describe, expect, it } from 'vitest'
import { CompositionPlanRegistry } from '../composition/plan-registry.js'

const trajectory = { schemaVersion: 1, patchId: 'p', events: [{ type: 'turn/start' }], coverage: { claimedBehaviors: [] } }
const plan = () => ({ id: 'host-plan', rationale: 'coupled change', expectedOutcome: 'both available', targets: [
  { id: 'config', targetId: 'agent-config', targetKind: 'config' as const, before: { model: 'before' }, expectedTrajectory: trajectory },
  { id: 'tool', dependsOn: ['config'], targetId: 'echo-tool', targetKind: 'tool' as const, entry: 'index.mjs', expectedTrajectory: trajectory },
] })

describe('CompositionPlanRegistry', () => {
  it('only resolves a cloned controller-owned plan by id', () => {
    const registry = new CompositionPlanRegistry([plan()])
    const resolved = registry.resolve('host-plan')
    resolved.targets[0]!.targetId = 'mutated'
    expect(registry.resolve('host-plan').targets[0]!.targetId).toBe('agent-config')
    expect(registry.ids()).toEqual(['host-plan'])
  })

  it('rejects malformed plans before they can materialize a Builder workspace', () => {
    const bad = plan(); bad.targets[1]!.dependsOn = ['missing']
    expect(() => new CompositionPlanRegistry([bad])).toThrow('invalid dependency')
    expect(() => new CompositionPlanRegistry([plan()]).resolve('unknown')).toThrow('unknown controller')
  })
})
