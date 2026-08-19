import { CandidateRegistry } from './index.js';
import type { LlmStreamLike } from '../meta/propose.js';
import { type BuilderKernelOptions, type BuilderMessageInput, type BuilderProgressState, type BuilderRunMode, type BuilderRunState } from '../builder/kernel.js';
import { BuilderCapabilityRuntimeRegistry } from '../builder/capabilities.js';
import { type MiniSweRuntimeOptions } from '../builder/mini-swe.js';
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
    /** Broad user requests begin with an evidence-backed direction-selection pass. */
    diagnosisFirst?: boolean;
    /** Optional no-progress experiment; omitted keeps free exploration unchanged. */
    builderKernelOptions?: BuilderKernelOptions;
    onUsage?: (usage: {
        prompt: number;
        completion: number;
    }) => void;
    capabilityRuntimes?: BuilderCapabilityRuntimeRegistry;
    /**
     * v1.2 implementation runtime. Loom-native remains available only for
     * durable diagnosis/clarification when a run is explicitly in diagnosis
     * mode; it is not the production complex-source implementation path.
     */
    executionRuntime?: 'loom-native' | 'mini-swe';
    miniSwe?: Omit<MiniSweRuntimeOptions, 'model'>;
}
export interface LoopExplorationResult {
    accepted: boolean;
    mode: 'exploration';
    runId: string;
    passMode: BuilderRunMode;
    state: 'submitted' | 'aborted' | 'paused' | 'cancelled' | 'waiting_for_input';
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
    passMode: BuilderRunMode;
} | {
    accepted: false;
    mode: 'exploration';
    state: 'disabled';
    reason: string;
};
/** A bounded projection of durable Builder state suitable for actor tools. */
export interface LoopExplorationStatus {
    runId: string;
    lineageId: string;
    state: BuilderRunState;
    passMode: BuilderRunMode;
    modelTurns: number;
    toolSteps: number;
    inboxMessages: number;
    pendingMessageIds: string[];
    progressState: BuilderProgressState;
    proposal: {
        available: boolean;
        hash?: string;
        keys?: string[];
    };
    diagnosisReport: {
        available: boolean;
        hash?: string;
        directions?: Array<{
            id?: string;
            goal?: string;
            evidenceRefs?: string[];
            unknowns?: string[];
            cost?: string;
        }>;
        question?: {
            question?: string;
            whyNow?: string;
            options?: Array<{
                id?: string;
                label?: string;
                description?: string;
            }>;
            evidenceRefs?: string[];
        };
    };
    journalTail: Array<{
        seq: number;
        at: string;
        kind: string;
        action: string;
        result?: Record<string, unknown>;
        error?: string;
    }>;
    eventTail: Array<{
        seq: number;
        at: string;
        kind: string;
        payload: Record<string, unknown>;
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
    private readonly runtimes;
    constructor(options: LoopCandidateGatewayOptions);
    private kernel;
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
    events(runId: string, cursor?: {
        lineageId?: string;
        runId?: string;
        seq?: number;
    }, limit?: number): {
        runId: string;
        lineageId: string;
        events: Array<{
            seq: number;
            at: string;
            kind: string;
            lineageId: string;
            runId: string;
            payload: Record<string, unknown>;
        }>;
        cursor: string;
        reset: boolean;
    };
    messageExploration(runId: string, input: string | BuilderMessageInput): {
        accepted: true;
        runId: string;
        messageId: string;
        deduplicated: boolean;
        state: BuilderRunState;
        queuedAt: string;
    };
    /** Pause/cancel are deterministic kernel transitions; resume is a new run. */
    controlExploration(runId: string, action: 'pause' | 'cancel'): {
        runId: string;
        lineageId: string;
        state: BuilderRunState;
    };
    /**
     * Never replays a possibly in-flight command. The new attempt inherits the
     * old assets by hash and copies prior actor messages for independent review.
     */
    resumeExploration(runId: string): LoopExplorationStart;
    /**
     * Verifier/gate rejection reopens an immutable Builder run with the report
     * as previous-attempt input; the actor inbox carries over so follow-up
     * observations remain visible to the next attempt.
     */
    reopenExploration(runId: string, report: Record<string, unknown>): string;
    private materializeMiniWorkspace;
    status(): ReturnType<CandidateRegistry['list']>;
    private persist;
}
