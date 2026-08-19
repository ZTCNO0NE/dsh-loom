import { describe, expect, it } from 'vitest'
import { ACTOR_COMPOSITION_CAPABILITY, BuilderCapabilityRegistry, BUILDER_BASE_TOOLS, CONFIG_EVOLUTION_CAPABILITY, LOOP_EVOLUTION_CAPABILITY, SKILL_EVOLUTION_CAPABILITY, TOOL_EVOLUTION_CAPABILITY } from '../builder/capabilities.js'

describe('Builder capabilities', () => {
  it('registers loop evolution without narrowing the base tool set', () => {
    const registry = new BuilderCapabilityRegistry().register(LOOP_EVOLUTION_CAPABILITY)
    expect(BUILDER_BASE_TOOLS).toContain('run_workspace_command')
    expect(BUILDER_BASE_TOOLS).toContain('write_workspace_file')
    expect(registry.list()).toEqual([expect.objectContaining({ id: 'loop-evolution', version: '0.1.0' })])
    expect(registry.describe()).toContain('Choose your own exploration path')
  })

  it('rejects duplicate capability ids instead of silently replacing one', () => {
    const registry = new BuilderCapabilityRegistry().register(LOOP_EVOLUTION_CAPABILITY)
    expect(() => registry.register(LOOP_EVOLUTION_CAPABILITY)).toThrow(/already registered/)
  })

  it('declares config/tool/skill as compiler-and-gate capabilities while composition stays draft-only', () => {
    const registry = new BuilderCapabilityRegistry().registerAll([
      CONFIG_EVOLUTION_CAPABILITY, TOOL_EVOLUTION_CAPABILITY, SKILL_EVOLUTION_CAPABILITY, ACTOR_COMPOSITION_CAPABILITY,
    ])
    const declared = registry.list()
    expect(declared.map((item) => item.id)).toEqual(['config-evolution', 'tool-evolution', 'skill-evolution', 'actor-composition'])
    expect(declared.find((item) => item.id === 'config-evolution')).toMatchObject({ proposalSchema: 'patch-evolution-v1', gateId: 'patch-cold-apply-v1' })
    expect(declared.find((item) => item.id === 'actor-composition')).toMatchObject({ proposalSchema: 'actor-composition-v1', gateId: 'composition-transaction-v1', tools: [] })
  })
})
