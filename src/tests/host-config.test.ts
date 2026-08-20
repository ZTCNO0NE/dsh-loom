import { describe, expect, it, vi } from 'vitest'
import {
  agentDefaultModelServiceOf,
  effectiveHostConfig,
  writeEffectiveHostConfig,
  type AgentDefaultModelServiceLike,
} from '../evolution/host-config.js'

describe('settings-backed host config adapter', () => {
  it('projects and writes the effective agent default model through the DSH service', async () => {
    const saveSelection = vi.fn<AgentDefaultModelServiceLike['saveSelection']>().mockResolvedValue(undefined)
    const service: AgentDefaultModelServiceLike = {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' }),
      saveSelection,
    }
    const resolved = agentDefaultModelServiceOf({ agentDefaultModel: service })
    expect(effectiveHostConfig('agent-default-model', { model: 'loader-default' }, resolved)).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low',
    })
    await expect(writeEffectiveHostConfig('agent-default-model', {
      provider: 'deepseek-official', model: 'deepseek-chat',
    }, resolved)).resolves.toBe(true)
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(agentDefaultModelServiceOf({ get: (name: string) => name === 'agentDefaultModel' ? service : undefined })).toBe(service)
  })

  it('leaves ordinary loader config unchanged and rejects malformed model selections', async () => {
    const service: AgentDefaultModelServiceLike = {
      currentSelection: () => ({ provider: 'p', model: 'm' }),
      saveSelection: vi.fn().mockResolvedValue(undefined),
    }
    expect(effectiveHostConfig('bash-sandbox', { timeoutMs: 10 }, service)).toEqual({ timeoutMs: 10 })
    await expect(writeEffectiveHostConfig('bash-sandbox', { timeoutMs: 20 }, service)).resolves.toBe(false)
    await expect(writeEffectiveHostConfig('agent-default-model', { model: 'deepseek-chat' }, service)).rejects.toThrow('requires string provider and model')
  })
})
