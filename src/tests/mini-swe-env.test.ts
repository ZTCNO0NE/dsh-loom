import { describe, expect, it } from 'vitest'
import { miniSweChildEnv, miniSweModelName } from '../builder/mini-swe-env.js'

describe('mini-SWE child environment bridge', () => {
  it('maps the host Terra route into the child-only OpenAI-compatible variables', () => {
    const child = miniSweChildEnv('gpt-5.6-terra', { LOOM_TERRA_BASE_URL: 'https://example.invalid/v1', OPENAI_API_KEY: 'parent-secret' }, 'resolved-secret')
    expect(child).toMatchObject({ MSWEA_CONFIGURED: 'true', OPENAI_API_BASE: 'https://example.invalid/v1', OPENAI_BASE_URL: 'https://example.invalid/v1', OPENAI_API_KEY: 'resolved-secret' })
  })

  it('maps the host official route without requiring a Terra configuration', () => {
    const child = miniSweChildEnv('deepseek-v4-flash', { DEEPSEEK_BASE_URL: 'https://official.invalid', DEEPSEEK_API_KEY: 'parent-secret' }, 'test-official-secret')
    expect(child).toMatchObject({ MSWEA_CONFIGURED: 'true', OPENAI_API_BASE: 'https://official.invalid', OPENAI_BASE_URL: 'https://official.invalid', DEEPSEEK_API_KEY: 'test-official-secret' })
  })

  it('uses the official DeepSeek endpoint when the host leaves its default implicit', () => {
    const child = miniSweChildEnv('deepseek-official', { DEEPSEEK_API_KEY: 'test-official-secret' })
    expect(child.OPENAI_API_BASE).toBe('https://api.deepseek.com/v1')
    expect(child.MSWEA_COST_TRACKING).toBe('ignore_errors')
  })

  it('preserves an explicit mini-SWE cost tracking policy', () => {
    const child = miniSweChildEnv('deepseek-official', { MSWEA_COST_TRACKING: 'default' })
    expect(child.MSWEA_COST_TRACKING).toBe('default')
  })

  it('forwards only the resolved credential to mini-SWE, not provider-specific parent variables', () => {
    const child = miniSweChildEnv('deepseek-official', {
      PATH: '/fixture/bin', DEEPSEEK_API_KEY: 'parent-secret', DSH_META_API_KEY: 'legacy-secret',
    }, 'resolved-secret')
    expect(child).toMatchObject({ PATH: '/fixture/bin', DEEPSEEK_API_KEY: 'resolved-secret' })
    expect(child.DEEPSEEK_API_KEY).toBe('resolved-secret')
    expect(child.DSH_META_API_KEY).toBeUndefined()
    expect(child.OPENAI_API_KEY).toBeUndefined()
    expect(JSON.stringify({ configured: child.MSWEA_CONFIGURED })).not.toContain('resolved-secret')
  })

  it('uses native DeepSeek only for DeepSeek and OpenAI-compatible routing for Terra', () => {
    expect(miniSweModelName('deepseek-official', 'deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash')
    expect(miniSweModelName('gpt-5.6-terra', 'gpt-5.6-terra')).toBe('openai/gpt-5.6-terra')
  })
})
