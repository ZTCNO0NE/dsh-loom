import type { LlmStreamLike } from '../meta/propose.js';
import { type BuilderCapabilityPlugin } from './capabilities.js';
import { BuilderKernel } from './kernel.js';
export interface BuilderDriverOptions {
    llm: LlmStreamLike;
    provider: string;
    model: string;
    systemPrompt: string;
    taskContext: string;
    draftKind?: 'patch' | 'loop_candidate';
    maxModelTurns?: number;
    maxToolSteps?: number;
    maxTokens?: number;
    maxWallTimeMs?: number;
    /** Experimental text-only intervention; Kernel permissions remain unchanged. */
    progressBanner?: boolean;
    /** Replace repeated full prompt exemplars with a durable context-index map. */
    compactPrompt?: boolean;
    capabilities?: readonly BuilderCapabilityPlugin[];
    /** Expose only observation/dialogue/report tools during a diagnosis pass. */
    readOnlyDiagnosis?: boolean;
    onUsage?: (usage: {
        prompt: number;
        completion: number;
    }) => void;
    /** Deterministic terminal signal: a run_workspace_command whose stdout/stderr
     * contains this marker with exit 0 marks the run ready_to_submit. */
    successMarker?: string;
}
export interface BuilderDriverOutcome {
    state: 'submitted' | 'aborted' | 'paused' | 'cancelled' | 'waiting_for_input';
    runId: string;
    proposal?: Record<string, unknown>;
    modelTurns: number;
    toolSteps: number;
    reason?: string;
}
/**
 * Bounded, file-backed builder micro-loop. The LLM selects a decision, while
 * the kernel alone executes tools, records outcomes, and owns terminal state.
 */
export declare class BuilderDriver {
    private readonly options;
    constructor(options: BuilderDriverOptions);
    run(kernel: BuilderKernel, runId: string): Promise<BuilderDriverOutcome>;
    private prompt;
    private compactPrompt;
    private stream;
    private parseDecision;
    private parseTool;
}
