/**
 * The v1.2 Loop research ledger.  It deliberately records every slot, including
 * failed attempts; no evaluator may turn an absent submission into a success.
 */
export declare const LOOP_EXPERIMENT_TASKS: readonly ["scheduler-prepare-overlap", "oracle-rejection-repair", "cross-file-semantic-repair"];
export type LoopExperimentTaskId = typeof LOOP_EXPERIMENT_TASKS[number];
export type LoopFailureClass = 'task-underspecified' | 'workspace-tool-disconnect' | 'failure-untraceable' | 'hypothesis-to-edit-stall' | 'submission-or-adjudication-disconnect' | 'test-failure' | 'verification-rejected' | 'install-rollback';
export interface LoopExperimentAttempt {
    schemaVersion: 1;
    taskId: LoopExperimentTaskId;
    attempt: 1 | 2 | 3;
    runId: string;
    specification: string;
    runtime: {
        name: string;
        model: string;
        version?: string;
    };
    startedAt: string;
    finishedAt?: string;
    modelTurns: number;
    toolCalls: number;
    firstEditAt?: string;
    tests: Array<{
        name: string;
        passed: boolean;
        detail?: string;
    }>;
    submission: {
        submitted: boolean;
        id?: string;
        detail?: string;
    };
    adjudication: {
        verdict?: 'approved' | 'rejected';
        detail?: string;
    };
    coldReplay: {
        passed?: boolean;
        detail?: string;
    };
    rollback: {
        performed?: boolean;
        passed?: boolean;
        detail?: string;
    };
    wallTimeMs?: number;
    tokenCost?: {
        prompt: number;
        completion: number;
        currency?: string;
        amount?: number;
    };
    failure?: {
        classification: LoopFailureClass;
        detail: string;
    };
}
export interface LoopExperimentMatrixReport {
    schemaVersion: 1;
    generatedAt: string;
    attempts: LoopExperimentAttempt[];
    byTask: Record<LoopExperimentTaskId, {
        completed: number;
        total: number;
        thresholdMet: boolean;
    }>;
    releaseEligible: boolean;
    incompleteSlots: Array<{
        taskId: LoopExperimentTaskId;
        attempt: 1 | 2 | 3;
    }>;
}
/** A complete closed loop is intentionally stricter than a passing unit test. */
export declare function isCompleteLoopAttempt(record: LoopExperimentAttempt): boolean;
export declare function classifyLoopFailure(record: LoopExperimentAttempt): LoopFailureClass | undefined;
export declare function summarizeLoopExperimentMatrix(attempts: LoopExperimentAttempt[], generatedAt?: string): LoopExperimentMatrixReport;
