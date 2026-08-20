import { describe, expect, it } from 'vitest'
import { miniSweChildEnv } from '../builder/mini-swe-env.js'

describe('mini-SWE child environment bridge', () => {
  it('maps the host Terra route into the child-only OpenAI-compatible variables', () => {
    const child = miniSweChildEnv('gpt-5.6-terra', { LOOM_TERRA_BASE_URL: 'https://example.invalid/v1', LOOM_TERRA_API_KEY: 'test-secret' })
    expect(child).toMatchObject({ MSWEA_CONFIGURED: 'true', OPENAI_BASE_URL: 'https://example.invalid/v1', OPENAI_API_KEY: 'test-secret' })
  })

  it('maps the host official route without requiring a Terra configuration', () => {
    const child = miniSweChildEnv('deepseek-v4-flash', { DEEPSEEK_BASE_URL: 'https://official.invalid', DEEPSEEK_API_KEY: 'test-official-secret' })
    expect(child).toMatchObject({ MSWEA_CONFIGURED: 'true', OPENAI_BASE_URL: 'https://official.invalid', OPENAI_API_KEY: 'test-official-secret' })
  })

  it('forwards only the resolved credential to mini-SWE, not provider-specific parent variables', () => {
    const child = miniSweChildEnv('deepseek-official', {
      PATH: '/fixture/bin', DEEPSEEK_API_KEY: 'parent-secret', DSH_META_API_KEY: 'legacy-secret',
    }, 'resolved-secret')
    expect(child).toMatchObject({ PATH: '/fixture/bin', OPENAI_API_KEY: 'resolved-secret' })
    expect(child.DEEPSEEK_API_KEY).toBeUndefined()
    expect(child.DSH_META_API_KEY).toBeUndefined()
    expect(JSON.stringify({ configured: child.MSWEA_CONFIGURED })).not.toContain('resolved-secret')
  })
})
