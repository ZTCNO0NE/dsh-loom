import { describe, expect, it } from 'vitest'
import { officialDeepSeekLlm, terraLlm } from '../llm/official.js'

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

  it('allows an isolated caller to explicitly enable DeepSeek thinking', async () => {
    const originalFetch = globalThis.fetch
    let request: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response('data: {"choices":[{"delta":{"reasoning_content":"inspect failure"}}]}\n\ndata: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    }
    try {
      const chunks = []
      for await (const chunk of officialDeepSeekLlm({ baseURL: 'https://example.test', apiKey: 'test', thinking: 'enabled' }).stream({
        provider: 'deepseek-official', model: 'deepseek-v4-flash', prompt: 'return JSON', maxTokens: 256,
      })) chunks.push(chunk)
      expect(request).toMatchObject({ thinking: { type: 'enabled' } })
      expect(chunks).toContainEqual({ kind: 'text-delta', text: '{}' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses the OpenAI-compatible Terra transport without DeepSeek thinking fields', async () => {
    const originalFetch = globalThis.fetch
    let request: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'abort', arguments: '{"reason":"test"}' } }] } }] }), { status: 200 })
    }
    try {
      const chunks = []
      for await (const chunk of terraLlm({ baseURL: 'https://example.test/v1', apiKey: 'test' }).stream({
        provider: 'gpt-5.6-terra', model: 'openai/gpt-5.6-terra', prompt: 'return JSON', maxTokens: 256,
        nativeTools: [{ name: 'abort', description: 'abort', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } }],
      })) chunks.push(chunk)
      expect(request).toMatchObject({ model: 'openai/gpt-5.6-terra' })
      expect(request).not.toHaveProperty('response_format')
      expect(request).not.toHaveProperty('thinking')
      expect(request).toMatchObject({ stream: false })
      expect(request).toMatchObject({ tools: [expect.objectContaining({ function: expect.objectContaining({ name: 'abort' }) })] })
      expect(chunks).toContainEqual({ kind: 'text-delta', text: '{"kind":"abort","reason":"test"}' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('accepts the Loom-scoped Terra environment aliases without persisting credentials', async () => {
    const originalFetch = globalThis.fetch
    const originalKey = process.env.LOOM_TERRA_API_KEY
    const originalBase = process.env.LOOM_TERRA_BASE_URL
    let authorization = ''
    globalThis.fetch = async (_input, init) => {
      authorization = String(new Headers(init?.headers).get('Authorization'))
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"abort","reason":"fixture"}' } }] }), { status: 200 })
    }
    process.env.LOOM_TERRA_API_KEY = 'fixture-only'
    process.env.LOOM_TERRA_BASE_URL = 'https://loom-fixture.test/v1'
    try {
      const chunks = []
      for await (const chunk of terraLlm().stream({ provider: 'gpt-5.6-terra', model: 'gpt-5.6-terra', prompt: 'abort', maxTokens: 32 })) chunks.push(chunk)
      expect(authorization).toBe('Bearer fixture-only')
      expect(chunks).toContainEqual({ kind: 'text-delta', text: '{"kind":"abort","reason":"fixture"}' })
    } finally {
      globalThis.fetch = originalFetch
      if (originalKey === undefined) delete process.env.LOOM_TERRA_API_KEY; else process.env.LOOM_TERRA_API_KEY = originalKey
      if (originalBase === undefined) delete process.env.LOOM_TERRA_BASE_URL; else process.env.LOOM_TERRA_BASE_URL = originalBase
    }
  })
})
