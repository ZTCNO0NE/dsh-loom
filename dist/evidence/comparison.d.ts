/** A replay sample is an observation, not a verifier verdict. */
export interface ReplaySample {
    label: 'baseline' | 'installed';
    task: string;
    command: string[];
    cwd: string;
    exitCode: number;
    durationMs: number;
    outputPath: string;
    outputSha256: string;
    outputTail: string;
    taskSuccess: boolean;
    error?: string;
}
export interface ComparisonOptions {
    root: string;
    sessionId: string;
    id: string;
    task: string;
    baseline: ReplaySample;
    installed: ReplaySample;
    contractPass: boolean;
    regressionPass: boolean;
    gatePass: boolean;
    rollbackPass?: boolean;
    beforeSnapshot?: unknown;
    afterSnapshot?: unknown;
    extra?: Record<string, unknown>;
}
export interface ActorComparison {
    schemaVersion: 1;
    id: string;
    task: string;
    baseline: ReplaySample;
    installed: ReplaySample;
    delta: {
        durationMs: number;
        durationRatio: number | null;
    };
    admissible: boolean;
    claimLevel: 'not-established' | 'causal-workload';
    contractPass: boolean;
    regressionPass: boolean;
    gatePass: boolean;
    rollbackPass?: boolean;
    beforeSnapshot?: unknown;
    afterSnapshot?: unknown;
    extra?: Record<string, unknown>;
    createdAt: string;
}
/** Execute exactly one isolated actor task and persist stdout/stderr as evidence. */
export declare function runActorReplay(options: {
    label: ReplaySample['label'];
    command: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    task: string;
    outputPath: string;
    timeoutMs?: number;
}): ReplaySample;
/** Persist the same-task comparison without turning a single exit code into a performance claim. */
export declare function writeActorComparison(options: ComparisonOptions): ActorComparison;
