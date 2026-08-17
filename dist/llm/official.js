/**
 * OpenAI-compatible SSE adapter for the official DeepSeek API.
 * Used for the BUILDER and REVIEW GATE (independent role), while the actor
 * keeps its own profile route (local 27B). Reads DEEPSEEK_BASE_URL /
 * DEEPSEEK_API_KEY unless overridden.
 */
export function officialDeepSeekLlm(options = {}) {
    return {
        async *stream(call) {
            const baseURL = options.baseURL ?? process.env.DSH_META_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
            const apiKey = options.apiKey ?? process.env.DSH_META_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '';
            if (!apiKey) {
                throw new Error('officialDeepSeekLlm: DEEPSEEK_API_KEY missing');
            }
            const model = options.model ?? call.model;
            const res = await fetch(`${baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    stream: true,
                    stream_options: { include_usage: true },
                    temperature: call.temperature ?? 0,
                    max_tokens: call.maxTokens ?? 4000,
                    response_format: { type: 'json_object' },
                    // Gateway/proposer consumers require the final JSON `content` field.
                    // DeepSeek returns thinking separately as `reasoning_content`, so
                    // disable it rather than spending this bounded response budget on it.
                    thinking: { type: 'disabled' },
                    messages: [{ role: 'user', content: call.prompt }],
                }),
            });
            if (!res.ok || !res.body) {
                throw new Error(`officialDeepSeekLlm: ${res.status} ${await res.text()}`);
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let usageYielded = false;
            let sawContent = false;
            yield { kind: 'block-start', type: 'text' };
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:'))
                        continue;
                    const payload = trimmed.slice(5).trim();
                    if (payload === '[DONE]')
                        continue;
                    try {
                        const chunk = JSON.parse(payload);
                        const delta = chunk.choices?.[0]?.delta;
                        if (delta?.content) {
                            sawContent = true;
                            yield { kind: 'text-delta', text: delta.content };
                        }
                        if (chunk.usage && !usageYielded) {
                            usageYielded = true;
                            yield {
                                kind: 'usage',
                                usage: {
                                    prompt: chunk.usage.prompt_tokens ?? 0,
                                    completion: chunk.usage.completion_tokens ?? 0,
                                },
                            };
                        }
                    }
                    catch {
                        // skip malformed SSE lines
                    }
                }
            }
            if (!sawContent) {
                throw new Error('officialDeepSeekLlm: stream ended without content');
            }
            yield { kind: 'block-end', type: 'text' };
        },
    };
}
