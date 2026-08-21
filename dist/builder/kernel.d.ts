import { BuilderCapabilityRuntimeRegistry } from './capabilities.js';
import { type BuilderProvenanceGraph } from './provenance.js';
export type BuilderRunState = 'created' | 'exploring' | 'preflighting' | 'ready_to_submit' | 'waiting_for_input' | 'paused' | 'cancelled' | 'submitted' | 'aborted';
/**
 * Observable evidence-production phase. This is deliberately not an allow
 * list: the Kernel records meaningful milestones and only rejects explicit
 * illegal requests (for example malformed clarification/verification).
 */
export type BuilderPhase = 'observing' | 'hypothesizing' | 'baseline_simulating' | 'exploring' | 'candidate_simulating' | 'ready_to_submit' | 'waiting_for_actor' | 'waiting_for_verification' | 'submitted' | 'aborted';
export type BuilderRunKind = 'patch' | 'loop_candidate';
export type BuilderRunMode = 'diagnosis' | 'implementation';
export type BuilderJournalKind = 'model' | 'tool' | 'error' | 'snapshot' | 'state';
export type BuilderEventKind = 'run_created' | 'state_changed' | 'actor_message_received' | 'tool_completed' | 'tool_failed' | 'message_ack' | 'builder_update' | 'needs_input' | 'proposal_drafted' | 'diagnosis_report';
/** A public checkpoint owed after the Builder has stopped producing evidence. */
export type BuilderProgressRequirement = 'none' | 'declare_direction' | 'produce_evidence' | 'write_submission';
/** Actor-provided context is open natural language; only its transport is structured. */
export interface BuilderMessageInput {
    rawUserText: string;
    actorMemo?: string;
    evidenceRefs?: string[];
    /** Actor-provided retry key; the same key may not create a second message. */
    idempotencyKey?: string;
}
export interface BuilderRunInput {
    /** Host-assigned id for a pre-materialized immutable workspace. Never model supplied. */
    id?: string;
    kind?: BuilderRunKind;
    mode?: BuilderRunMode;
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
/**
 * The exact model input is an auditable input artifact, not a reasoning trace.
 * The prompt body is stored after secret-like value redaction; promptHash and
 * promptBytes still bind the redacted view to the exact bytes sent.
 */
export interface BuilderPromptVisibleEntry {
    schemaVersion: 1;
    seq: number;
    at: string;
    promptHash: string;
    promptBytes: number;
    visibleState: BuilderRunState;
    phase: BuilderPhase;
    progressStateVersion?: number;
    progressStateHash?: string;
    lastJournalAction?: string;
    lastToolResultHash?: string;
    pendingMessageIds: string[];
    prompt: string;
    redacted: boolean;
}
/**
 * Small, public working memory for one Builder run.
 * This is not a chain-of-thought field: it contains only declared direction,
 * durable facts and kernel-observed progress signals for the next turn.
 */
export interface BuilderProgressState {
    schemaVersion: 1;
    version: number;
    state: BuilderRunState;
    phase: BuilderPhase;
    objective?: string;
    hypothesis?: string;
    known: string[];
    unknowns: string[];
    nextIntent?: string;
    lastAction?: string;
    lastObservationHash?: string;
    unchangedReadStreak: number;
    /**
     * A deterministic, temporary obligation raised only by the experimental
     * no-progress guard. It is public state, not a hidden reasoning signal.
     */
    progressRequirement: BuilderProgressRequirement;
    pendingMessageIds: string[];
    updatedAt: string;
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
    mode: BuilderRunMode;
    state: BuilderRunState;
    phase: BuilderPhase;
    createdAt: string;
    updatedAt: string;
    inputHash: string;
    lineageId: string;
    parentRunId?: string;
}
/** Optional experimental progress guard; omitted means legacy free exploration. */
export interface BuilderKernelOptions {
    /** Reject an unchanged repeated read at this streak instead of waiting for the abort guard. */
    repeatReadRejectAfter?: number;
    /**
     * When enabled, a rejected unchanged read also creates a two-step progress
     * checkpoint: declare a direction, then produce fresh evidence. Defaults to
     * false so existing free exploration remains unchanged.
     */
    enforceProgressCheckpoints?: boolean;
    /** Diagnosis may inspect host facts but cannot mutate a candidate workspace or execute commands. */
    readOnlyDiagnosis?: boolean;
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
    document: 'actor' | 'target_before' | 'previous_attempt' | 'previous_run' | 'world_model' | 'plan' | 'progress_state' | 'context_index' | 'provenance';
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
/** Diagnosis-first pass output; this never changes a live target. */
 | {
    name: 'write_diagnosis_report';
    report: Record<string, unknown>;
}
/** Read-only host exploration. Deployment decides the readable scope. */
 | {
    name: 'read_file';
    path: string;
} | {
    name: 'list_directory';
    path: string;
}
/** Search text across explicit read-only roots without invoking a shell. */
 | {
    name: 'search_text';
    query: string;
    roots?: string[];
    maxResults?: number;
}
/** Inspect a source artifact's interface, imports/exports, hash and bounded preview. */
 | {
    name: 'inspect_file';
    path: string;
}
/** Follow factual producer/consumer/test/report edges; never returns a repair recommendation. */
 | {
    name: 'trace_artifact';
    artifact: string;
}
/** Builder-owned, persistent multi-file scratch space. */
 | {
    name: 'write_workspace_file';
    path: string;
    content: string;
}
/** Apply a standard unified diff within the Builder workspace. */
 | {
    name: 'apply_workspace_patch';
    patch: string;
} | {
    name: 'read_workspace_file';
    path: string;
}
/** Trusted-development command tool; stdout/stderr are durable feedback. */
 | {
    name: 'run_workspace_command';
    command: string;
    args?: string[];
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
    kind?: 'clarification' | 'choice' | 'verification';
    options?: Array<{
        id: string;
        label: string;
        description?: string;
    }>;
    whyNow?: string;
    evidenceRefs?: string[];
    blocking?: boolean;
}
/** Capability-owned execution. The kernel records the call but does not interpret its meaning. */
 | {
    name: 'invoke_capability';
    capability: string;
    tool: string;
    input: Record<string, unknown>;
}
/** Generic frozen proposal for a capability; it never applies a target change. */
 | {
    name: 'write_submission';
    proposal: Record<string, unknown>;
}
/** Compile a loop proposal from Kernel-captured workspace edits. */
 | {
    name: 'compile_loop_submission';
    rationale: string;
    expectedOutcome?: string;
}
/** Compile one host-materialized config update from its workspace diff. */
 | {
    name: 'compile_config_submission';
    rationale: string;
    expectedOutcome?: string;
}
/** Compile a host-materialized tool or skill bundle from actor-module/. */
 | {
    name: 'compile_module_submission';
    rationale: string;
    expectedOutcome?: string;
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
    diagnosisReport: string;
    contextIndex: string;
    provenance: string;
    worldModel: string;
    plan: string;
    progressState: string;
    journal: string;
    promptVisible: string;
    events: string;
    snapshots: string;
    workspaceBaseline: string;
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
    private readonly capabilityRuntimes;
    private readonly options;
    constructor(root: string, sessionId: string, capabilityRuntimes?: BuilderCapabilityRuntimeRegistry, options?: BuilderKernelOptions);
    create(input: BuilderRunInput): BuilderRunRecord;
    /** Host/runtime adapter captures an immutable source baseline after it has
     * materialized a workspace, before an external coding runtime can edit it. */
    captureWorkspaceBaseline(id: string, sourceRoot?: string): {
        path: string;
        captured: boolean;
    };
    load(id: string): BuilderRunRecord;
    transition(id: string, state: BuilderRunState): BuilderRunRecord;
    append(id: string, kind: BuilderJournalKind, action: string, result?: Record<string, unknown>, error?: unknown): BuilderJournalEntry;
    /** Persist the visible prompt input separately from the journal/decision log. */
    recordPromptVisible(id: string, input: {
        prompt: string;
        promptHash: string;
        promptBytes: number;
        visibleState: BuilderRunState;
        lastJournalAction?: string;
        lastToolResultHash?: string;
        pendingMessageIds: string[];
        progressStateVersion?: number;
        progressStateHash?: string;
    }): BuilderPromptVisibleEntry;
    /** Read the compact working memory used to recover a fresh model turn. */
    progressState(id: string): BuilderProgressState;
    /** Record the model's declared decision without trusting it to write audit data. */
    recordDecision(id: string, decision: BuilderDecision): void;
    context(id: string): {
        run: BuilderRunRecord;
        input: BuilderRunInput;
        messages: BuilderMessage[];
        journal: BuilderJournalEntry[];
        events: BuilderEvent[];
        progressState: BuilderProgressState;
        diagnosisReport: Record<string, unknown> | null;
        contextIndex: Record<string, unknown>;
        provenance: BuilderProvenanceGraph;
    };
    private contextWithoutProgress;
    messages(id: string): BuilderMessage[];
    events(id: string, afterSeq?: number, limit?: number): BuilderEvent[];
    /**
     * Accept a new actor observation without changing the immutable initial
     * snapshot. The next driver turn reads this durable inbox in its prompt.
     */
    receiveActorMessage(id: string, input: string | BuilderMessageInput): BuilderMessage;
    /** Kernel-owned lifecycle boundary. A paused/cancelled run never submits. */
    control(id: string, action: 'pause' | 'cancel'): BuilderRunRecord;
    /** Make a missing proposal draft an explicit, durable next-step obligation. */
    requireSubmissionDraft(id: string): BuilderProgressState;
    /** After a candidate edit, require one fresh executable observation before
     * the model can continue editing or hand off the proposal. */
    requireEvidence(id: string): BuilderProgressState;
    proposal(id: string): Record<string, unknown> | null;
    /** Execute exactly one allowlisted builder action and durably return its feedback. */
    decide(id: string, decision: BuilderDecision): Record<string, unknown>;
    /** Kernel-owned verifier feedback starts a new immutable builder attempt. */
    reopenFromRejection(id: string, report: Record<string, unknown>): BuilderRunRecord;
    /** Add machine-readable progress feedback without preventing repeated reads. */
    private annotateReadFeedback;
    private executeTool;
    private provenance;
    private observeArtifact;
    private snapshot;
    private setPhase;
    private updateProgressAfterTool;
    private updateProgress;
    private unacknowledgedMessageIds;
    private freezeSubmissionManifest;
    /** Preserve original bytes on the first workspace mutation only. */
    private captureWorkspaceBaselineFile;
    /**
     * Turn captured workspace bytes into the audited builder-generated envelope.
     * The model supplies only intent; exact hashes and replacement text come from
     * Kernel-owned before/after files and remain independently revalidated by
     * CandidateImporter.
     */
    private compileLoopWorkspaceProposal;
    /**
     * Compile a single host-materialized config target. The external runtime
     * edits only actor-config.json; target identity, action and frozen envelope
     * remain Kernel-owned and feed the existing patch-evolution verifier/gate.
     */
    private compileConfigWorkspaceProposal;
    /** Compile an insert bundle while keeping identity and allowed target kind
     * out of the external runtime's control. */
    private compileModuleWorkspaceProposal;
    /** Create a hash-bound, read-only reference for a fresh immutable attempt. */
    previousRunReference(id: string): BuilderPreviousRunRef;
    private emit;
    private submissionDraft;
    private workspacePath;
    /** Relative read paths are Builder-workspace paths; absolute paths retain the
     * Builder's global read capability.  This matches command cwd and prevents
     * a model's normal package-relative path from accidentally resolving to the
     * host process checkout. */
    private readablePath;
    /**
     * A read/write addressed at a prior run's workspace (absolute path from a
     * rejection) means the same relative file in this run's workspace during a
     * repair. Prior assets stay read-only; only the current workspace is writable.
     */
    private mapPriorWorkspacePath;
}
