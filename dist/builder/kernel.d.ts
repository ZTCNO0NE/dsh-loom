export type BuilderRunState = 'created' | 'exploring' | 'preflighting' | 'ready_to_submit' | 'submitted' | 'aborted';
export type BuilderRunKind = 'patch' | 'loop_candidate';
export type BuilderJournalKind = 'model' | 'tool' | 'error' | 'snapshot' | 'state';
export interface BuilderRunInput {
    kind?: BuilderRunKind;
    actor: Record<string, unknown>;
    targetBefore: Record<string, unknown>;
    previousAttempt?: Record<string, unknown>;
}
export interface BuilderJournalEntry {
    schemaVersion: 1;
    seq: number;
    kind: BuilderJournalKind;
    at: string;
    action: string;
    inputHash: string;
    result?: Record<string, unknown>;
    error?: string;
}
export interface BuilderRunRecord {
    schemaVersion: 1;
    id: string;
    kind: BuilderRunKind;
    state: BuilderRunState;
    createdAt: string;
    updatedAt: string;
    inputHash: string;
}
export type BuilderDecision = {
    kind: 'continue';
    summary: string;
} | {
    kind: 'tool';
    action: BuilderToolAction;
}
/** Freeze the already-preflighted draft; no model-supplied payload is accepted here. */
 | {
    kind: 'submit';
} | {
    kind: 'abort';
    reason: string;
};
export type BuilderToolAction = {
    name: 'read_input';
    document: 'actor' | 'target_before' | 'previous_attempt' | 'world_model' | 'plan';
} | {
    name: 'read_journal';
    limit: number;
} | {
    name: 'write_world_model';
    value: Record<string, unknown>;
} | {
    name: 'write_plan';
    value: Record<string, unknown>;
}
/** Typed draft write; this is deliberately not a general filesystem tool. */
 | {
    name: 'write_candidate_draft';
    proposal: Record<string, unknown>;
} | {
    name: 'inspect_staging';
    path: string;
} | {
    name: 'preflight_staging_entry';
    entry: string;
};
export declare function builderRunPaths(root: string, sessionId: string, id: string): {
    base: string;
    record: string;
    actor: string;
    targetBefore: string;
    previousAttempt: string;
    worldModel: string;
    plan: string;
    journal: string;
    snapshots: string;
    staging: string;
    preflight: string;
    proposal: string;
};
/** Durable, builder-owned run state. The kernel—not an LLM—records every transition. */
export declare class BuilderKernel {
    private readonly root;
    private readonly sessionId;
    constructor(root: string, sessionId: string);
    create(input: BuilderRunInput): BuilderRunRecord;
    load(id: string): BuilderRunRecord;
    transition(id: string, state: BuilderRunState): BuilderRunRecord;
    append(id: string, kind: BuilderJournalKind, action: string, result?: Record<string, unknown>, error?: unknown): BuilderJournalEntry;
    /** Record the model's declared decision without trusting it to write audit data. */
    recordDecision(id: string, decision: BuilderDecision): void;
    context(id: string): {
        run: BuilderRunRecord;
        input: BuilderRunInput;
        journal: BuilderJournalEntry[];
    };
    proposal(id: string): Record<string, unknown> | null;
    /** Execute exactly one allowlisted builder action and durably return its feedback. */
    decide(id: string, decision: BuilderDecision): Record<string, unknown>;
    /** Kernel-owned verifier feedback starts a new immutable builder attempt. */
    reopenFromRejection(id: string, report: Record<string, unknown>): BuilderRunRecord;
    private executeTool;
    private snapshot;
}
