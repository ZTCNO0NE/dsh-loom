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
/** An inbound observation from the actor, delivered between Builder turns. */
export interface BuilderMessage {
    schemaVersion: 1;
    at: string;
    from: 'actor';
    text: string;
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
/** Read-only host exploration. Deployment decides the readable scope. */
 | {
    name: 'read_file';
    path: string;
} | {
    name: 'list_directory';
    path: string;
}
/** Builder-owned, persistent multi-file scratch space. */
 | {
    name: 'write_workspace_file';
    path: string;
    content: string;
} | {
    name: 'read_workspace_file';
    path: string;
}
/** Trusted-development command tool; stdout/stderr are durable feedback. */
 | {
    name: 'run_workspace_command';
    command: string;
    args: string[];
    timeoutMs?: number;
}
/** Generic frozen proposal for a capability; it never applies a target change. */
 | {
    name: 'write_submission';
    proposal: Record<string, unknown>;
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
    messages: string;
    targetBefore: string;
    previousAttempt: string;
    worldModel: string;
    plan: string;
    journal: string;
    snapshots: string;
    workspace: string;
    staging: string;
    preflight: string;
    proposal: string;
    submissionDraft: string;
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
        messages: BuilderMessage[];
        journal: BuilderJournalEntry[];
    };
    /**
     * Accept a new actor observation without changing the immutable initial
     * snapshot. The next driver turn reads this durable inbox in its prompt.
     */
    receiveActorMessage(id: string, text: string): BuilderMessage;
    proposal(id: string): Record<string, unknown> | null;
    /** Execute exactly one allowlisted builder action and durably return its feedback. */
    decide(id: string, decision: BuilderDecision): Record<string, unknown>;
    /** Kernel-owned verifier feedback starts a new immutable builder attempt. */
    reopenFromRejection(id: string, report: Record<string, unknown>): BuilderRunRecord;
    private executeTool;
    private snapshot;
    private submissionDraft;
    private workspacePath;
}
