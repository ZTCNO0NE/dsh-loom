import { describe, expect, it } from 'vitest'
import { BuilderCredentialResolver, type CredentialServiceLike } from '../llm/credentials.js'

function credentials(entries: Record<string, { value: string; source: string }>): CredentialServiceLike {
  return {
    async resolve(ref) { return entries[ref] },
    async describe(ref) {
      const entry = entries[ref]
      return entry ? { configured: true, source: entry.source } : { configured: false }
    },
  }
}

describe('BuilderCredentialResolver', () => {
  it('uses the user DSH DeepSeek credential by default and exposes only health facts', async () => {
    const resolver = new BuilderCredentialResolver(credentials({
      DEEPSEEK_API_KEY: { value: 'secret-from-file', source: 'file' },
    }), 'deepseek-official')
    await expect(resolver.resolve()).resolves.toEqual({ ref: 'DEEPSEEK_API_KEY', value: 'secret-from-file', source: 'file' })
    await expect(resolver.describe()).resolves.toEqual({ ref: 'DEEPSEEK_API_KEY', configured: true, source: 'file' })
    expect(JSON.stringify(await resolver.describe())).not.toContain('secret-from-file')
  })

  it('re-resolves on every call so a credentials file update reaches the next Builder request', async () => {
    const entries: Record<string, { value: string; source: string }> = {
      DEEPSEEK_API_KEY: { value: 'first-secret', source: 'file' },
    }
    const resolver = new BuilderCredentialResolver(credentials(entries), 'deepseek-official')
    await expect(resolver.resolve()).resolves.toMatchObject({ value: 'first-secret' })
    entries.DEEPSEEK_API_KEY = { value: 'second-secret', source: 'file' }
    await expect(resolver.resolve()).resolves.toMatchObject({ value: 'second-secret' })
  })

  it('uses an explicit Loom reference instead of the default reference', async () => {
    const resolver = new BuilderCredentialResolver(credentials({
      DEEPSEEK_API_KEY: { value: 'default-secret', source: 'file' },
      DSH_META_API_KEY: { value: 'override-secret', source: 'env' },
    }), 'deepseek-official', 'DSH_META_API_KEY')
    await expect(resolver.resolve()).resolves.toEqual({ ref: 'DSH_META_API_KEY', value: 'override-secret', source: 'env' })
  })

  it('uses the OpenAI credential only for the explicit GPT/Terra route, then preserves migration fallbacks', async () => {
    const service = credentials({ OPENAI_API_KEY: { value: 'gpt-secret', source: 'file' }, DSH_TERRA_API_KEY: { value: 'terra-secret', source: 'env' } })
    await expect(new BuilderCredentialResolver(service, 'gpt-5.6-terra').describe()).resolves.toEqual({ ref: 'OPENAI_API_KEY', configured: true, source: 'file' })
    await expect(new BuilderCredentialResolver(service, 'deepseek-official').describe()).resolves.toEqual({ ref: 'DEEPSEEK_API_KEY', configured: false })
  })

  it('reports an unconfigured reference without including a value', async () => {
    const resolver = new BuilderCredentialResolver(credentials({}), 'deepseek-official')
    await expect(resolver.describe()).resolves.toEqual({ ref: 'DEEPSEEK_API_KEY', configured: false })
    await expect(resolver.require()).rejects.toThrow('DEEPSEEK_API_KEY')
  })
})
