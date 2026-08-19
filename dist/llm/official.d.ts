import type { LlmStreamLike } from '../meta/propose.js';
export interface OfficialLlmOptions {
    baseURL?: string;
    apiKey?: string;
    model?: string;
    /** Default stays disabled; evaluation callers may explicitly assess reasoning mode. */
    thinking?: 'enabled' | 'disabled';
}
export interface OpenAiCompatibleLlmOptions {
    baseURL: string;
    apiKey?: string;
    apiKeyEnv: string;
    /** Some compatible APIs reject DeepSeek's non-standard thinking field. */
    includeThinking?: boolean;
    /** Some proxy gateways buffer SSE until completion; use their JSON response. */
    stream?: boolean;
    /** Disable only when a compatible proxy's constrained JSON decoding stalls. */
    responseFormat?: boolean;
    /** Expose one transport-level decision function for providers that need a
     * native tool surface to recognize Builder tools as callable. */
    nativeDecisionTool?: boolean;
}
/**
 * OpenAI-compatible SSE adapter for the official DeepSeek API.
 * Used for the BUILDER and REVIEW GATE (independent role), while the actor
 * keeps its own profile route (local 27B). Reads DEEPSEEK_BASE_URL /
 * DEEPSEEK_API_KEY unless overridden.
 */
export declare function officialDeepSeekLlm(options?: OfficialLlmOptions): LlmStreamLike;
/**
 * Small OpenAI-compatible JSON/SSE transport.  It deliberately owns no agent
 * policy: BuilderDriver/Kernel still provide the tool protocol and every
 * proposal remains subject to the independent verifier and gate.
 */
export declare function openAiCompatibleLlm(options: OpenAiCompatibleLlmOptions, deepSeekOptions?: Pick<OfficialLlmOptions, 'model' | 'thinking'>): LlmStreamLike;
/** Isolated evaluation adapter. Key remains process-local and never persisted. */
export declare function terraLlm(options?: {
    baseURL?: string;
    apiKey?: string;
}): LlmStreamLike;
