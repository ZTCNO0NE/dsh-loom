export interface EvolutionTaskSuggestion {
    key: string;
    title: string;
    summary: string;
    /** Actor-only routing information; never returned in a task card. */
    target: {
        kind: 'config' | 'skill';
        id: string;
    };
}
export interface EvolutionTaskSession {
    schemaVersion: 1;
    sessionId: string;
    updatedAt: string;
    pending?: {
        planId: string;
        userRequest: string;
        actorExplanation: string;
        suggestions: EvolutionTaskSuggestion[];
    };
    active?: {
        planId: string;
        jobId: string;
        cursor: 'queued' | 'implementing' | 'verifying';
    };
    recent?: {
        planId: string;
        jobId?: string;
        state: 'completed' | 'rejected' | 'aborted' | 'cancelled' | 'interrupted';
    };
    diagnosis?: {
        runId: string;
        jobId: string;
        userRequest: string;
        state: 'queued' | 'diagnosing' | 'waiting_for_choice' | 'aborted';
        evidenceManifest: string;
    };
}
/**
 * A deliberately small, durable projection of a conversation's evolution
 * task. Plans/runs remain immutable records; this file only says which one is
 * currently being discussed so a new request cannot silently replace it.
 */
export declare class EvolutionTaskSessionStore {
    private readonly root;
    private readonly sessionId;
    constructor(root: string, sessionId: string);
    read(): EvolutionTaskSession;
    beginPending(value: NonNullable<EvolutionTaskSession['pending']>): EvolutionTaskSession;
    beginDiagnosis(value: NonNullable<EvolutionTaskSession['diagnosis']>): EvolutionTaskSession;
    setDiagnosisState(runId: string, next: NonNullable<EvolutionTaskSession['diagnosis']>['state']): EvolutionTaskSession;
    consumeDiagnosis(runId: string): EvolutionTaskSession;
    replaceDiagnosisWithPending(runId: string, value: NonNullable<EvolutionTaskSession['pending']>): EvolutionTaskSession;
    beginActive(planId: string, jobId: string): EvolutionTaskSession;
    setCursor(planId: string, cursor: EvolutionTaskSession['active'] extends infer T ? T extends {
        cursor: infer C;
    } ? C : never : never): EvolutionTaskSession;
    finish(planId: string, stateName: NonNullable<EvolutionTaskSession['recent']>['state']): EvolutionTaskSession;
    currentPlanId(): string | undefined;
    private file;
    private write;
}
