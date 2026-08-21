import { describe, expect, it } from 'vitest'
import { officialDeepSeekLlm, openAiCompatibleLlm, terraLlm } from '../llm/official.js'

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

  it('normalizes a streamed native function call into one Kernel decision', async () => {
    const originalFetch = globalThis.fetch
    let request: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response([
        'data: {"choices":[{"delta":{"content":"  ","tool_calls":[{"index":0,"id":"call-1","function":{"name":"builder_decision","arguments":"{\\"decision\\":{\\"kind\\":\\"tool\\",\\"action\\":{\\"name\\":\\"write_plan\\",\\"value\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"hypothesis\\":\\"route\\"}}}}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
        '',
      ].join('\n\n'), { status: 200 })
    }
    try {
      const chunks = []
      for await (const chunk of officialDeepSeekLlm({ baseURL: 'https://example.test', apiKey: 'test' }).stream({
        provider: 'deepseek-official', model: 'deepseek-v4-flash', prompt: 'choose one tool', maxTokens: 256,
        nativeTools: [{ name: 'write_plan', description: 'write plan', parameters: { type: 'object', properties: { value: { type: 'object' } }, required: ['value'] } }],
      })) chunks.push(chunk)
      expect(request).toMatchObject({
        tools: [expect.objectContaining({ function: expect.objectContaining({ name: 'builder_decision' }) })],
        parallel_tool_calls: false,
      })
      expect(chunks).toContainEqual({ kind: 'text-delta', text: '{"decision":{"kind":"tool","action":{"name":"write_plan","value":{"hypothesis":"route"}}}}' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fails closed when a streamed response asks for multiple native actions', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"write_plan","arguments":"{\\"value\\":{}}"}},{"index":1,"function":{"name":"abort","arguments":"{\\"reason\\":\\"stop\\"}"}}]}}]}',
      'data: [DONE]',
      '',
    ].join('\n\n'), { status: 200 })
    try {
      const consume = async () => {
        for await (const _chunk of openAiCompatibleLlm({ baseURL: 'https://example.test', apiKey: 'test', apiKeyEnv: 'TEST_KEY', nativeToolMode: 'expanded' }).stream({
          provider: 'deepseek-official', model: 'deepseek-v4-flash', prompt: 'choose one tool', maxTokens: 256,
          nativeTools: [
            { name: 'write_plan', description: 'write plan', parameters: { type: 'object' } },
            { name: 'abort', description: 'abort', parameters: { type: 'object' } },
          ],
        })) { /* consume */ }
      }
      await expect(consume()).rejects.toThrow('expected one Builder decision')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('serializes repeated decision-envelope calls by exposing only the first action', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"builder_decision","arguments":"{\\"decision\\":{\\"kind\\":\\"tool\\",\\"action\\":{\\"name\\":\\"write_plan\\",\\"value\\":{}}}}"}},{"index":1,"function":{"name":"builder_decision","arguments":"{\\"decision\\":{\\"kind\\":\\"abort\\",\\"reason\\":\\"speculative\\"}}"}}]}}]}',
      'data: [DONE]',
      '',
    ].join('\n\n'), { status: 200 })
    try {
      const text: string[] = []
      for await (const chunk of officialDeepSeekLlm({ baseURL: 'https://example.test', apiKey: 'test' }).stream({
        provider: 'deepseek-official', model: 'deepseek-v4-flash', prompt: 'choose one tool', maxTokens: 256,
        nativeTools: [{ name: 'write_plan', description: 'write plan', parameters: { type: 'object' } }],
      })) if (chunk.kind === 'text-delta' && chunk.text) text.push(chunk.text)
      expect(text.join('')).toBe('{"decision":{"kind":"tool","action":{"name":"write_plan","value":{}}}}')
      expect(text.join('')).not.toContain('speculative')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('resolves a fresh host-only credential for every request', async () => {
    const originalFetch = globalThis.fetch
    const secrets = ['first-secret', 'second-secret']
    const authorizations: string[] = []
    globalThis.fetch = async (_input, init) => {
      authorizations.push(String(new Headers(init?.headers).get('Authorization')))
      return new Response('data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    }
    try {
      const llm = officialDeepSeekLlm({ baseURL: 'https://example.test', resolveApiKey: async () => secrets.shift() })
      for await (const _chunk of llm.stream({ provider: 'deepseek-official', model: 'deepseek-v4-flash', prompt: 'first', maxTokens: 8 })) { /* consume */ }
      for await (const _chunk of llm.stream({ provider: 'deepseek-official', model: 'deepseek-v4-flash', prompt: 'second', maxTokens: 8 })) { /* consume */ }
      expect(authorizations).toEqual(['Bearer first-secret', 'Bearer second-secret'])
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
