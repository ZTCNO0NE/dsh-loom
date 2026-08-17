import { CandidateRegistry, type CandidateManifest } from './index.js';
import type { LlmStreamLike } from '../meta/propose.js';
export interface LoopCandidateGatewayOptions {
    enabled: boolean;
    root: string;
    sessionId: string;
    allowedGitHosts: string[];
    llm?: LlmStreamLike;
    provider: string;
    model: string;
    maxTokens: number;
    buildDependencyRoot?: string;
    onUsage?: (usage: {
        prompt: number;
        completion: number;
    }) => void;
}
export type LoopCandidateDiscovery = {
    accepted: false;
    reason: 'disabled' | 'no_candidate' | 'acquisition_failed';
    rationale: string;
    runId?: string;
} | {
    accepted: true;
    rationale: string;
    manifest: CandidateManifest;
    runId: string;
};
/**
 * The sole loop-candidate ingress for meta.auto. Discovery uses the same
 * bounded BuilderKernel as patch design; after a frozen draft is submitted,
 * core (not the model) performs the allowlisted HTTPS acquisition into staging.
 * It has no transition API: verifier/gate own every later state.
 */
export declare class LoopCandidateGateway {
    private readonly options;
    constructor(options: LoopCandidateGatewayOptions);
    discover(requirements: string, context?: Record<string, unknown>): Promise<LoopCandidateDiscovery>;
    status(): ReturnType<CandidateRegistry['list']>;
    private prompt;
    private parse;
    private normalize;
    private persist;
}
