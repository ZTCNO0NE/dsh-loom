import type { LlmStreamLike } from '../meta/propose.js';
export interface OfficialLlmOptions {
    baseURL?: string;
    apiKey?: string;
    model?: string;
}
/**
 * OpenAI-compatible SSE adapter for the official DeepSeek API.
 * Used for the BUILDER and REVIEW GATE (independent role), while the actor
 * keeps its own profile route (local 27B). Reads DEEPSEEK_BASE_URL /
 * DEEPSEEK_API_KEY unless overridden.
 */
export declare function officialDeepSeekLlm(options?: OfficialLlmOptions): LlmStreamLike;
