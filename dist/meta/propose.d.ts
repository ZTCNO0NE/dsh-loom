import type { Context } from '@deepseek-ai/cordis';
import type { EvolutionSignal, MetaPatch, ValidationReport } from '../types.js';
import { type LockedTargetPolicy } from '../policy.js';
/** Minimal structural view of ctx.llm (see docs/research/02 §5 for the full contract). */
export interface LlmChunk {
    kind: string;
    type?: string;
    text?: string;
    usage?: {
        prompt?: number;
        completion?: number;
    };
}
export interface LlmCallOptions {
    provider: string;
    model: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    sessionId?: string;
}
export interface LlmStreamLike {
    stream(options: LlmCallOptions): AsyncIterable<LlmChunk>;
}
export interface ProposerOptions {
    systemPrompt: string;
    maxSignals: number;
    provider: string;
    model: string;
    root: string;
    sessionId: string;
    llm?: LlmStreamLike;
    onUsage?: (usage: {
        prompt: number;
        completion: number;
    }) => void;
    lockedTargets?: LockedTargetPolicy;
    builder?: {
        maxModelTurns?: number;
        maxToolSteps?: number;
        maxTokens?: number;
        maxWallTimeMs?: number;
    };
}
export interface ProbeResult {
    task: string;
    exit: number;
    outputTail: string;
}
export declare class Proposer {
    private ctx;
    private options;
    constructor(ctx: Context | null, options: ProposerOptions);
    propose(signals: EvolutionSignal[], currentConfig: Record<string, unknown>, userRequirements?: string, previousReport?: ValidationReport, probeResults?: ProbeResult[]): Promise<MetaPatch[]>;
    /** Only verifier/probe/gate callers invoke this: it never approves or installs. */
    reopenFromFeedback(patchId: string, feedback: Record<string, unknown>): string | null;
    private buildTaskContext;
    private streamText;
    private parseJsonObject;
    private normalizePatch;
    private normalizeProbes;
    private normalizeSelfCheck;
    private normalizePreferences;
    private normalizeTrajectory;
    private normalizeModule;
    private writeStagingFiles;
    private writeWorldModel;
}
