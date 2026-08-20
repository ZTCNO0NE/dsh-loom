import { ActorEvolutionGateway, type ConfigEvolutionPlan, type ModuleEvolutionPlan } from '../candidates/actor-gateway.js';
import { type PatchAdjudicationResult } from '../deliberation/index.js';
export type UserEvolutionTargetKind = 'config' | 'skill';
export type UserEvolutionMode = 'plan' | 'execute';
export type UserEvolutionTarget = {
    kind: 'config';
    plan: ConfigEvolutionPlan;
    summary: string;
    verification: string;
    risks: string[];
} | {
    kind: 'skill';
    plan: ModuleEvolutionPlan;
    summary: string;
    verification: string;
    risks: string[];
};
export interface UserEvolutionPlan {
    schemaVersion: 1;
    id: string;
    createdAt: string;
    requirements: string;
    target: UserEvolutionTarget;
    evidence: {
        refs: string[];
        summary: string;
    };
    state: 'planned' | 'queued' | 'executing' | 'verifying' | 'completed' | 'rejected' | 'aborted' | 'cancelled' | 'interrupted';
    execution?: {
        runId: string;
        at: string;
    };
    result?: UserEvolutionReport;
}
export interface UserEvolutionReport {
    runId: string;
    targetKind: UserEvolutionTargetKind;
    targetId: string;
    verdict: 'approved' | 'rejected' | 'aborted';
    /** Gate artifact was installed. Config artifacts may still await a cold host restart. */
    applied: boolean;
    /** The change is visible to the running Actor process. */
    effective?: boolean;
    /** A verified config overlay is installed but requires a cold host restart. */
    restartRequired?: boolean;
    /** A later Gate-owned receipt restored the original before snapshot. */
    rolledBack?: boolean;
    /** Internal evidence location; presentation must not expose this path. */
    rollbackReceipt?: string;
    summary: string;
    limitations: string[];
}
export interface UserEvolutionControllerOptions {
    root: string;
    sessionId: string;
    gateway: ActorEvolutionGateway;
    /** Host resolves identities/before snapshots; user text never supplies them directly. */
    resolveTarget(requirements: string, kind: UserEvolutionTargetKind): UserEvolutionTarget;
    adjudicate(proposal: Record<string, unknown>, plan: UserEvolutionPlan): Promise<PatchAdjudicationResult>;
    evidenceFor(requirements: string): {
        refs: string[];
        summary: string;
    };
}
/**
 * Product-facing Plan/Execute controller. It does not perform diagnosis by
 * model prompt: the Actor/host supplies an evidence-backed target and the
 * controller persists it before a runtime gets any writable workspace.
 */
export declare class UserEvolutionController {
    private readonly options;
    constructor(options: UserEvolutionControllerOptions);
    plan(requirements: string, kind: UserEvolutionTargetKind): UserEvolutionPlan;
    read(planId: string): UserEvolutionPlan;
    /** Claim a plan synchronously before a background job is queued. */
    queue(planId: string): UserEvolutionPlan;
    /** Queued work has not acquired a writable workspace yet and is safe to cancel. */
    cancel(planId: string): UserEvolutionPlan;
    /** A process reload cannot safely resume a pass whose worker no longer exists. */
    interrupt(planId: string): UserEvolutionPlan;
    execute(planId: string): Promise<UserEvolutionPlan>;
    private report;
    private file;
    private write;
}
