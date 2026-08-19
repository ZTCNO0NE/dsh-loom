import type { MetaPatch, SmokeReport } from '../types.js';
/** A composition is not a bag of ordinary patches: every operation is named,
 * host-approved and linked by an explicit dependency graph. */
export interface CompositionOperation {
    id: string;
    dependsOn: string[];
    patch: MetaPatch;
}
export interface ActorCompositionProposal {
    capability: 'actor-composition';
    id: string;
    operations: CompositionOperation[];
    rationale: string;
    expectedOutcome: string;
}
export interface CompositionVerificationReport {
    proposalId: string;
    proposalHash: string;
    verdict: 'approved' | 'rejected';
    checks: Array<{
        name: string;
        passed: boolean;
        detail?: string;
    }>;
    failureSummary?: string;
}
export interface CompositionVerifierOptions {
    /** Controller-selected targets. No Builder-supplied target becomes valid by itself. */
    allowedTargets: ReadonlySet<string>;
    maxOperations?: number;
}
export declare function compositionHash(proposal: ActorCompositionProposal): string;
/** Deterministic structural verifier. Capability-specific Validators run before
 * this report is eligible for the transaction Gate. */
export declare function verifyComposition(proposal: ActorCompositionProposal, options: CompositionVerifierOptions): CompositionVerificationReport;
export interface CompositionGateOps {
    snapshot(operation: CompositionOperation): unknown | Promise<unknown>;
    apply(operation: CompositionOperation): void | Promise<void>;
    rollback(operation: CompositionOperation, before: unknown): void | Promise<void>;
    smoke(proposal: ActorCompositionProposal): SmokeReport | Promise<SmokeReport>;
}
export interface CompositionGateResult {
    applied: boolean;
    before: Record<string, unknown>;
    smoke?: SmokeReport;
    error?: string;
    rolledBack: string[];
}
export interface CompositionAdjudicationDeps {
    allowedTargets: ReadonlySet<string>;
    /** Runs the capability-specific verifier for each frozen child patch. */
    verifyOperation(operation: CompositionOperation): Promise<{
        passed: boolean;
        reason?: string;
    }>;
    gate: CompositionGateOps;
}
export interface CompositionAdjudicationResult {
    verdict: 'approved' | 'rejected';
    graph: CompositionVerificationReport;
    operationReports: Array<{
        id: string;
        passed: boolean;
        reason?: string;
    }>;
    applied?: CompositionGateResult;
    reason?: string;
}
/** Controller dispatch for the composition capability. It deliberately does
 * not invoke ordinary patch Gates: every child must independently verify, then
 * the whole graph is atomically applied by the transaction Gate. */
export declare function adjudicateComposition(proposal: ActorCompositionProposal, deps: CompositionAdjudicationDeps): Promise<CompositionAdjudicationResult>;
/** Dedicated all-or-nothing gate. It never applies a partial graph, and it
 * refuses a report whose hash does not bind the exact frozen proposal. */
export declare function applyCompositionWithRollback(proposal: ActorCompositionProposal, report: CompositionVerificationReport, ops: CompositionGateOps): Promise<CompositionGateResult>;
