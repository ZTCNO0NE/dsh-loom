import { describe, expect, it } from 'vitest'
import { BuilderCapabilityRegistry, BUILDER_BASE_TOOLS, LOOP_EVOLUTION_CAPABILITY } from '../builder/capabilities.js'

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
})
