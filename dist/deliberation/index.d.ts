import type { MetaPatch, ValidationReport } from '../types.js';
import type { ActualEvent, Validator, VerifierInput } from '../validate/index.js';
import type { ApplyOps, ApplyResult, Gate } from '../gate/index.js';
import type { BuilderGeneratedSourceRequest, CandidateImporter, ContractEvidence, LoopInstallReport } from '../candidates/index.js';
/**
 * Frozen Builder proposal accepted by the adjudicator. The builder never
 * applies anything; this is the only place a proposal becomes a target change.
 */
export type BuilderProposal = {
    capability: 'patch-evolution';
    patch: MetaPatch;
    rationale?: string;
} | {
    capability: 'loop-evolution';
    loop: LoopEvolutionProposal;
    rationale?: string;
};
export interface LoopEvolutionProposal {
    id: string;
    displayName: string;
    source: BuilderGeneratedSourceRequest;
    packageName: string;
    packagePath?: string;
    entry: string;
    config: Record<string, unknown>;
    expectedOutcome: string;
    capabilities: string[];
}
export interface PatchAdjudicationDeps {
    validator: Validator;
    gate: Gate;
    root: string;
    sessionId: string;
    collectFrames?: (patch: MetaPatch, base: VerifierInput) => Promise<VerifierInput>;
    applyOps?: ApplyOps;
    evidenceEvents?: ActualEvent[];
    onApplied?: (info: {
        patch: MetaPatch;
        report: ValidationReport;
        applied: ApplyResult;
    }) => void | Promise<void>;
}
export interface LoopAdjudicationDeps {
    root: string;
    importer: CandidateImporter;
    /** Independent contract verification (C0/C1-C8/C6). Fail-closed when absent. */
    verifyContract: (manifest: Awaited<ReturnType<CandidateImporter['acquire']>>) => Promise<{
        passed: boolean;
        evidence?: ContractEvidence;
        reason?: string;
    }>;
    /** Gate-owned cold install; omitted means "approved but not installed". */
    install?: (candidateId: string) => Promise<LoopInstallReport>;
}
export interface PatchAdjudicationResult {
    kind: 'patch';
    verdict: 'approved' | 'rejected';
    patch: MetaPatch;
    report: ValidationReport;
    applied?: ApplyResult;
    reason?: string;
}
export interface LoopAdjudicationResult {
    kind: 'loop';
    verdict: 'approved' | 'rejected';
    candidateId: string;
    evidence?: ContractEvidence;
    install?: LoopInstallReport;
    reason?: string;
}
export type AdjudicationResult = PatchAdjudicationResult | LoopAdjudicationResult;
/**
 * Adjudicate a frozen patch proposal: fixed verifier first, gate only after
 * approval. Rejection is returned to the caller, which reopens the Builder run.
 */
export declare function adjudicatePatch(proposal: Extract<BuilderProposal, {
    capability: 'patch-evolution';
}>, deps: PatchAdjudicationDeps): Promise<PatchAdjudicationResult>;
/**
 * Adjudicate a frozen loop proposal: local baseline -> builder edits ->
 * sandboxed build -> independent contract evidence -> gate cold install.
 */
export declare function adjudicateLoop(proposal: Extract<BuilderProposal, {
    capability: 'loop-evolution';
}>, deps: LoopAdjudicationDeps): Promise<LoopAdjudicationResult>;
/** Dispatch a frozen Builder proposal to its capability-specific adjudicator. */
export declare function adjudicate(proposal: BuilderProposal, deps: PatchAdjudicationDeps & LoopAdjudicationDeps): Promise<AdjudicationResult>;
