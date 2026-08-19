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
    beginActive(planId: string, jobId: string): EvolutionTaskSession;
    setCursor(planId: string, cursor: EvolutionTaskSession['active'] extends infer T ? T extends {
        cursor: infer C;
    } ? C : never : never): EvolutionTaskSession;
    finish(planId: string, stateName: NonNullable<EvolutionTaskSession['recent']>['state']): EvolutionTaskSession;
    currentPlanId(): string | undefined;
    private file;
    private write;
}
