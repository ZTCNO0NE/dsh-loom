export type MetaPatchTargetKind = 'config' | 'tool' | 'skill' | 'loop';
export type ValidationVerdict = 'approved' | 'rejected' | 'needs_changes';
/** Builder self-assessment (declared, advisory only — never part of the verdict). */
export interface SelfCheck {
    confidence: number;
    completeness: number;
    summary?: string;
}
/** One predicted frame of a candidate patch (I9). */
export interface ExpectedTrajectoryEvent {
    type: string;
    turn?: number;
    step?: number;
    name?: string;
    argsHash?: string;
    resultHash?: string;
    error?: string | null;
    reason?: string;
    [key: string]: unknown;
}
/** The expected trajectory a candidate carries for verifier alignment (I9). */
export interface ExpectedTrajectory {
    schemaVersion: number;
    patchId: string;
    events: ExpectedTrajectoryEvent[];
    configBeforeHash?: string;
    configAfterHash?: string;
    coverage?: {
        claimedBehaviors: string[];
        note?: string;
    };
}
/** One module file drafted by the builder (staging, not live). */
export interface ModuleFile {
    path: string;
    content: string;
}
/** Module bundle for insert patches (tool/skill/prompt rows). */
export interface MetaModule {
    files: ModuleFile[];
    entry: string;
}
/** Builder-requested isolation probes (A): verifier executes these before full validation. */
export interface ProbeRequest {
    task: string;
    description?: string;
}
export interface MetaPatch {
    id: string;
    /** update = override existing row config; insert = add a new row (M4). */
    action?: 'update' | 'insert';
    targetId: string;
    /** Row name for insert rows (package name or module path). */
    targetName?: string;
    targetKind: MetaPatchTargetKind;
    config: Record<string, unknown>;
    module?: MetaModule;
    probes?: ProbeRequest[];
    dependencies: string[];
    rationale: string;
    expectedOutcome: string;
    expectedTrajectory?: ExpectedTrajectory;
    selfCheck?: SelfCheck;
    version: number;
    createdAt: string;
}
/** Persistent world model maintained by the builder (I6). */
export interface WorldModel {
    schemaVersion: number;
    target: {
        id: string;
        kind: MetaPatchTargetKind;
        targetId: string;
    };
    behavior: {
        invariants: string[];
        expectedEventPatterns: Array<Record<string, unknown>>;
        configDependencies: string[];
    };
    version: number;
    updatedAt: string;
    hash: string;
}
/** User requirements projected by the observer for the builder (I1). */
export interface RequirementsDoc {
    schemaVersion: number;
    sessionId: string;
    text: string;
    goalRefs: string[];
    feedbackRefs: string[];
    createdAt: string;
}
/** Persisted trigger record (I2). */
export interface TriggerRecord {
    schemaVersion: number;
    sessionId: string;
    kind: 'user' | 'host_rule' | 'external';
    rule?: string;
    evidenceRefs: string[];
    createdAt: string;
}
/** Patch lifecycle status (I11). */
export type PatchState = 'draft' | 'self-check' | 'submitted' | 'verifying' | 'approved' | 'rejected';
export interface PatchStatus {
    schemaVersion: number;
    patchId: string;
    state: PatchState;
    updatedAt: string;
    operator: string;
    iteration: number;
    error?: string;
}
/** Post-apply smoke result (I15). */
export interface SmokeReport {
    schemaVersion: number;
    patchId: string;
    passed: boolean;
    checks: Array<{
        name: string;
        passed: boolean;
        detail?: string;
    }>;
    ranAt: string;
}
/** Review gate decision (08 §15): independent LLM, can veto startup, never approves a patch. */
export interface ReviewDecision {
    schemaVersion: number;
    shouldRefine: boolean;
    rationale: string;
    focus?: string;
    evidenceRefs: string[];
    createdAt: string;
}
/** Autopilot frequency state (epoch lock / cooldown / per-epoch budget). */
export interface AutopilotState {
    schemaVersion: number;
    epoch: number;
    iterationsThisEpoch: number;
    lastIterationTurn: number;
    lastApplyTurn: number;
}
export interface ValidationReport {
    patchId: string;
    verdict: ValidationVerdict;
    score: number;
    evidence: string[];
    failureSummary?: string;
    suggestions?: string[];
    alignment?: {
        accuracy: number | null;
        strictAccuracy: number | null;
        coverage: number | null;
        nGraded: number;
        nMatched: number;
        firstDivergence: {
            index: number;
            expected: Record<string, unknown>;
            actual: Record<string, unknown>;
            fields: string[];
        } | null;
    };
    regressionResults?: Array<{
        id: string;
        passed: boolean;
        detail?: string;
    }>;
    beforeAfterHashes?: {
        before?: string;
        after?: string;
        actual?: string;
    };
    /** Exact dsh commands used for isolation replay (dump baseline/patched + probe). */
    replay?: {
        baselineDump: string[];
        patchedDump: string[];
        probe: string[];
    };
    validatedAt: string;
}
export interface AppliedMetaPatch {
    patch: MetaPatch;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    applied: boolean;
    error?: string;
    rollbackOf?: string;
}
export interface EvolutionSignal {
    kind: 'repeated_failure' | 'user_correction' | 'regression_failure' | 'reusable_tactic';
    evidence: string[];
    actorTurnIds: string[];
    severity: number;
}
export interface SignalThresholds {
    repeatedFailureCount: number;
    regressionFailureCount: number;
}
export interface RegressionCase {
    id: string;
    title: string;
    taskPrompt: string;
    expected: string;
    assert?: (output: string) => boolean;
}
