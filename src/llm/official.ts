import type { LlmCallOptions, LlmChunk, LlmStreamLike } from '../meta/propose.js'

export interface OfficialLlmOptions {
  baseURL?: string
  apiKey?: string
  model?: string
  /** Default stays disabled; evaluation callers may explicitly assess reasoning mode. */
  thinking?: 'enabled' | 'disabled'
  /** Host-only dynamic secret lookup; evaluated once per real request. */
  resolveApiKey?: () => Promise<string | undefined>
}

export interface OpenAiCompatibleLlmOptions {
  baseURL: string
  apiKey?: string
  apiKeyEnv: string
  /** Host-only dynamic secret lookup; evaluated once per real request. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Some compatible APIs reject DeepSeek's non-standard thinking field. */
  includeThinking?: boolean
  /** Some proxy gateways buffer SSE until completion; use their JSON response. */
  stream?: boolean
  /** Disable only when a compatible proxy's constrained JSON decoding stalls. */
  responseFormat?: boolean
  /** Expose one transport-level decision function for providers that need a
   * native tool surface to recognize Builder tools as callable. */
  nativeDecisionTool?: boolean
}

/**
 * OpenAI-compatible SSE adapter for the official DeepSeek API.
 * Used for the BUILDER and REVIEW GATE (independent role), while the actor
 * keeps its own profile route (local 27B). Reads DEEPSEEK_BASE_URL /
 * DEEPSEEK_API_KEY unless overridden.
 */
export function officialDeepSeekLlm(options: OfficialLlmOptions = {}): LlmStreamLike {
  return openAiCompatibleLlm({
    baseURL: options.baseURL ?? process.env.DSH_META_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: options.apiKey ?? process.env.DSH_META_API_KEY ?? process.env.DEEPSEEK_API_KEY,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    resolveApiKey: options.resolveApiKey,
    includeThinking: true,
  }, options)
}

/**
 * Small OpenAI-compatible JSON/SSE transport.  It deliberately owns no agent
 * policy: BuilderDriver/Kernel still provide the tool protocol and every
 * proposal remains subject to the independent verifier and gate.
 */
export function openAiCompatibleLlm(options: OpenAiCompatibleLlmOptions, deepSeekOptions: Pick<OfficialLlmOptions, 'model' | 'thinking'> = {}): LlmStreamLike {
  return {
    async *stream(call: LlmCallOptions): AsyncIterable<LlmChunk> {
      const baseURL = options.baseURL.replace(/\/$/, '')
      // When the host supplied a resolver, credential service is authoritative:
      // do not silently fall through to an inherited shell variable.
      const resolved = options.resolveApiKey ? await options.resolveApiKey() : undefined
      const apiKey = options.resolveApiKey ? resolved ?? '' : options.apiKey ?? process.env[options.apiKeyEnv] ?? ''
      if (!apiKey) {
        throw new Error(`openAiCompatibleLlm: ${options.apiKeyEnv} missing`)
      }
      const model = deepSeekOptions.model ?? call.model
      const body: Record<string, unknown> = {
        model,
        stream: options.stream ?? true,
        temperature: call.temperature ?? 0,
        max_tokens: call.maxTokens ?? 4000,
        messages: [{ role: 'user', content: call.prompt }],
      }
      if (options.stream ?? true) body.stream_options = { include_usage: true }
      if (options.responseFormat ?? true) body.response_format = { type: 'json_object' }
      if (options.includeThinking) body.thinking = { type: deepSeekOptions.thinking ?? 'disabled' }
      if (call.nativeTools?.length) {
        body.tools = call.nativeTools.map((tool) => ({ type: 'function', function: tool }))
        body.tool_choice = 'auto'
      } else if (options.nativeDecisionTool) {
        body.tools = [{
          type: 'function',
          function: {
            name: 'builder_decision',
            description: 'Return exactly one Builder decision from the protocol in the user prompt. Use this function when choosing an action.',
            parameters: {
              type: 'object',
              properties: { decision: { type: 'object', description: 'One Builder decision object.' } },
              required: ['decision'],
              additionalProperties: false,
            },
          },
        }]
        body.tool_choice = 'auto'
      }
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      })
      if (!res.ok || !res.body) {
        throw new Error(`openAiCompatibleLlm: ${res.status} ${await res.text()}`)
      }
      if (!(options.stream ?? true)) {
        const payload = await res.json() as {
          choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const message = payload.choices?.[0]?.message
        const nativeCall = message?.tool_calls?.[0]?.function
        const nativeDecision = nativeCall?.name === 'builder_decision'
          ? nativeCall.arguments
          : nativeCall?.name && nativeCall.arguments
            ? nativeToolDecision(nativeCall.name, nativeCall.arguments)
            : undefined
        const content = nativeDecision ?? message?.content
        if (!content) throw new Error('openAiCompatibleLlm: response ended without content')
        yield { kind: 'block-start', type: 'text' }
        yield { kind: 'text-delta', text: content }
        if (payload.usage) yield { kind: 'usage', usage: { prompt: payload.usage.prompt_tokens ?? 0, completion: payload.usage.completion_tokens ?? 0 } }
        yield { kind: 'block-end', type: 'text' }
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let usageYielded = false
      let sawContent = false
      yield { kind: 'block-start', type: 'text' }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>
              usage?: { prompt_tokens?: number; completion_tokens?: number }
            }
            const delta = chunk.choices?.[0]?.delta
            if (delta?.content) {
              sawContent = true
              yield { kind: 'text-delta', text: delta.content }
            }
            if (chunk.usage && !usageYielded) {
              usageYielded = true
              yield {
                kind: 'usage',
                usage: {
                  prompt: chunk.usage.prompt_tokens ?? 0,
                  completion: chunk.usage.completion_tokens ?? 0,
                },
              }
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
      if (!sawContent) {
        throw new Error('openAiCompatibleLlm: stream ended without content')
      }
      yield { kind: 'block-end', type: 'text' }
    },
  }
}

function nativeToolDecision(name: string, argumentsText: string): string {
  const input = JSON.parse(argumentsText) as Record<string, unknown>
  if (name === 'submit') return JSON.stringify({ kind: 'submit' })
  if (name === 'abort') return JSON.stringify({ kind: 'abort', ...input })
  if (name === 'continue') return JSON.stringify({ kind: 'continue', ...input })
  return JSON.stringify({ kind: 'tool', action: { name, ...input } })
}

/** Isolated evaluation adapter. Key remains process-local and never persisted. */
export function terraLlm(options: { baseURL?: string; apiKey?: string; resolveApiKey?: () => Promise<string | undefined> } = {}): LlmStreamLike {
  return openAiCompatibleLlm({
    baseURL: options.baseURL ?? process.env.LOOM_TERRA_BASE_URL ?? process.env.DSH_TERRA_BASE_URL ?? 'https://api.nwafu-ai.cn/v1',
    // LOOM_* is the public runtime-facing name; retain DSH_* for existing
    // evaluation shells. Both are process-local only and never persisted.
    apiKey: options.apiKey ?? process.env.LOOM_TERRA_API_KEY,
    apiKeyEnv: 'DSH_TERRA_API_KEY',
    resolveApiKey: options.resolveApiKey,
    includeThinking: false,
    stream: false,
    responseFormat: false,
    nativeDecisionTool: true,
  })
}
