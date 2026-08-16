import type { Context } from '@deepseek-ai/cordis';
import type { ReviewDecision } from '../types.js';
import type { EvolutionSignal } from '../types.js';
import type { RuntimeDigest } from './digest.js';
/** Minimal structural LLM view (same vocabulary as propose.ts). */
export interface LlmChunk {
    kind: string;
    type?: string;
    text?: string;
    usage?: {
        prompt?: number;
        completion?: number;
    };
}
export interface ReviewGateOptions {
    enabled: boolean;
    prompt: string;
    root: string;
    sessionId: string;
    provider: string;
    model: string;
    onUsage?: (usage: {
        prompt: number;
        completion: number;
    }) => void;
    llm?: {
        stream(options: {
            provider: string;
            model: string;
            prompt: string;
            temperature?: number;
            maxTokens?: number;
            sessionId?: string;
        }): AsyncIterable<LlmChunk>;
    };
}
export declare class ReviewGate {
    private ctx;
    private options;
    constructor(ctx: Context | null, options: ReviewGateOptions);
    decide(signals: EvolutionSignal[], trajectorySummary: string, historySummary: string, evidenceRefs: string[]): Promise<ReviewDecision>;
    /** One-shot supervision on the compact runtime digest (route A). */
    decideOnDigest(digest: RuntimeDigest): Promise<ReviewDecision>;
    private streamText;
    private parseJson;
    private persist;
}
