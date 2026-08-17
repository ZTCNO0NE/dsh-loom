import { CandidateRegistry } from './index.js';
import type { LlmStreamLike } from '../meta/propose.js';
import { type BuilderRunState } from '../builder/kernel.js';
export interface LoopCandidateGatewayOptions {
    enabled: boolean;
    root: string;
    sessionId: string;
    llm?: LlmStreamLike;
    provider: string;
    model: string;
    maxTokens: number;
    buildDependencyRoot?: string;
    builderMaxModelTurns?: number;
    builderMaxToolSteps?: number;
    builderMaxWallTimeMs?: number;
    onUsage?: (usage: {
        prompt: number;
        completion: number;
    }) => void;
}
export interface LoopExplorationResult {
    accepted: boolean;
    mode: 'exploration';
    runId: string;
    state: 'submitted' | 'aborted';
    proposal?: Record<string, unknown>;
    modelTurns: number;
    toolSteps: number;
    reason?: string;
}
/** Returned immediately to an actor that delegates an exploration. */
export type LoopExplorationStart = {
    accepted: true;
    mode: 'exploration';
    runId: string;
    state: 'created';
} | {
    accepted: false;
    mode: 'exploration';
    state: 'disabled';
    reason: string;
};
/** A bounded projection of durable Builder state suitable for actor tools. */
export interface LoopExplorationStatus {
    runId: string;
    state: BuilderRunState;
    modelTurns: number;
    toolSteps: number;
    inboxMessages: number;
    proposal: {
        available: boolean;
        hash?: string;
        keys?: string[];
    };
    journalTail: Array<{
        seq: number;
        at: string;
        kind: string;
        action: string;
        result?: Record<string, unknown>;
        error?: string;
    }>;
}
/**
 * The sole loop-candidate ingress for meta.auto. Discovery uses the same
 * bounded BuilderKernel as patch design; after a frozen draft is submitted,
 * core (not the model) performs the allowlisted HTTPS acquisition into staging.
 * It has no transition API: verifier/gate own every later state.
 */
export declare class LoopCandidateGateway {
    private readonly options;
    constructor(options: LoopCandidateGatewayOptions);
    /** Create a durable run before it enters the background queue. */
    startExploration(requirements: string, context?: Record<string, unknown>): LoopExplorationStart;
    /**
     * Execute an already-created actor exploration. It deliberately stops after
     * Builder submit: no importer, registry transition, verifier, or gate runs.
     */
    runExploration(runId: string): Promise<LoopExplorationResult>;
    /** Compatibility helper for callers that intentionally want to wait. */
    explore(requirements: string, context?: Record<string, unknown>): Promise<LoopExplorationResult>;
    explorationStatus(runId: string): LoopExplorationStatus;
    messageExploration(runId: string, text: string): {
        accepted: true;
        runId: string;
        state: BuilderRunState;
        queuedAt: string;
    };
    /**
     * Verifier/gate rejection reopens an immutable Builder run with the report
     * as previous-attempt input; the actor inbox carries over so follow-up
     * observations remain visible to the next attempt.
     */
    reopenExploration(runId: string, report: Record<string, unknown>): string;
    status(): ReturnType<CandidateRegistry['list']>;
    private persist;
}
