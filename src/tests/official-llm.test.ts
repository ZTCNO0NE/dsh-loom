import { describe, expect, it } from 'vitest'
import { officialDeepSeekLlm } from '../llm/official.js'

describe('official DeepSeek LLM adapter', () => {
  it('disables DeepSeek thinking so bounded JSON calls reserve tokens for content', async () => {
    const originalFetch = globalThis.fetch
    let request: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response('data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    }
    try {
      const chunks = []
      for await (const chunk of officialDeepSeekLlm({ baseURL: 'https://example.test', apiKey: 'test' }).stream({
        provider: 'deepseek-official', model: 'deepseek-v4-flash', prompt: 'return JSON', maxTokens: 256,
      })) chunks.push(chunk)
      expect(request).toMatchObject({
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
      })
      expect(request).not.toHaveProperty('reasoning')
      expect(chunks).toContainEqual({ kind: 'text-delta', text: '{}' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
