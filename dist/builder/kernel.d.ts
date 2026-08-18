export type BuilderRunState = 'created' | 'exploring' | 'preflighting' | 'ready_to_submit' | 'waiting_for_input' | 'paused' | 'cancelled' | 'submitted' | 'aborted';
export type BuilderRunKind = 'patch' | 'loop_candidate';
export type BuilderJournalKind = 'model' | 'tool' | 'error' | 'snapshot' | 'state';
export type BuilderEventKind = 'run_created' | 'state_changed' | 'actor_message_received' | 'tool_completed' | 'tool_failed' | 'message_ack' | 'builder_update' | 'needs_input' | 'proposal_drafted';
/** Actor-provided context is open natural language; only its transport is structured. */
export interface BuilderMessageInput {
    rawUserText: string;
    actorMemo?: string;
    evidenceRefs?: string[];
    /** Actor-provided retry key; the same key may not create a second message. */
    idempotencyKey?: string;
}
export interface BuilderRunInput {
    kind?: BuilderRunKind;
    actor: Record<string, unknown>;
    targetBefore: Record<string, unknown>;
    previousAttempt?: Record<string, unknown>;
    previousRun?: BuilderPreviousRunRef;
    lineageId?: string;
    parentRunId?: string;
}
/** Immutable references to a prior attempt, available for read-only reuse. */
export interface BuilderPreviousRunRef {
    runId: string;
    lineageId: string;
    workspacePath: string;
    assets: Array<{
        name: string;
        path: string;
        exists: boolean;
        hash?: string;
    }>;
    createdAt: string;
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
    id: string;
    at: string;
    from: 'actor';
    rawUserText: string;
    actorMemo?: string;
    evidenceRefs?: string[];
    idempotencyKey?: string;
    deduplicated?: boolean;
    /** Compatibility projection for old readers; never substitutes the raw user text. */
    text: string;
}
/** Durable actor-facing events, deliberately summaries rather than model reasoning. */
export interface BuilderEvent {
    schemaVersion: 1;
    seq: number;
    at: string;
    kind: BuilderEventKind;
    lineageId: string;
    runId: string;
    payload: Record<string, unknown>;
}
/** Hash-bound handoff from Builder exploration to verifier/gate. */
export interface BuilderSubmissionManifest {
    schemaVersion: 1;
    runId: string;
    lineageId: string;
    proposalHash: string;
    inputHash: string;
    targetBeforeHash: string;
    evidenceRefs: Array<{
        path: string;
        exists: boolean;
        hash?: string;
    }>;
    artifactRefs: Array<{
        path: string;
        exists: boolean;
        hash?: string;
    }>;
    createdAt: string;
}
export interface BuilderRunRecord {
    schemaVersion: 1;
    id: string;
    kind: BuilderRunKind;
    state: BuilderRunState;
    createdAt: string;
    updatedAt: string;
    inputHash: string;
    lineageId: string;
    parentRunId?: string;
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
    document: 'actor' | 'target_before' | 'previous_attempt' | 'previous_run' | 'world_model' | 'plan';
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
/** A receipt or clarification request for an Actor-delivered message. */
 | {
    name: 'acknowledge_message';
    messageId: string;
    status: string;
    understanding: string;
    nextAction?: string;
    question?: string;
}
/** Actor-visible progress summary; never a hidden model-reasoning trace. */
 | {
    name: 'publish_progress';
    summary: string;
    phase?: string;
    question?: string;
}
/** A typed, durable question. The Actor owns asking the user and resuming work. */
 | {
    name: 'request_input';
    question: string;
    context?: string;
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
    previousRun: string;
    worldModel: string;
    plan: string;
    journal: string;
    events: string;
    snapshots: string;
    workspace: string;
    staging: string;
    preflight: string;
    proposal: string;
    submissionDraft: string;
    submissionManifest: string;
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
        events: BuilderEvent[];
    };
    messages(id: string): BuilderMessage[];
    events(id: string, afterSeq?: number, limit?: number): BuilderEvent[];
    /**
     * Accept a new actor observation without changing the immutable initial
     * snapshot. The next driver turn reads this durable inbox in its prompt.
     */
    receiveActorMessage(id: string, input: string | BuilderMessageInput): BuilderMessage;
    /** Kernel-owned lifecycle boundary. A paused/cancelled run never submits. */
    control(id: string, action: 'pause' | 'cancel'): BuilderRunRecord;
    proposal(id: string): Record<string, unknown> | null;
    /** Execute exactly one allowlisted builder action and durably return its feedback. */
    decide(id: string, decision: BuilderDecision): Record<string, unknown>;
    /** Kernel-owned verifier feedback starts a new immutable builder attempt. */
    reopenFromRejection(id: string, report: Record<string, unknown>): BuilderRunRecord;
    private executeTool;
    private snapshot;
    private unacknowledgedMessageIds;
    private freezeSubmissionManifest;
    /** Create a hash-bound, read-only reference for a fresh immutable attempt. */
    previousRunReference(id: string): BuilderPreviousRunRef;
    private emit;
    private submissionDraft;
    private workspacePath;
}
