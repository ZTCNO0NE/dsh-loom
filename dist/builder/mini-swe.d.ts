/** Explicit host-owned configuration for the optional mini-SWE execution runtime. */
export interface MiniSweRuntimeOptions {
    executable: string;
    configPath: string;
    baselineRoot: string;
    dependencySnapshot: string;
    model: string;
    stepLimit: number;
    timeoutMs: number;
    /** Host-owned runtime environment (for example an OpenAI-compatible route). */
    env?: NodeJS.ProcessEnv;
    /** Resolves a fresh host-only environment immediately before spawning. */
    resolveEnv?: () => Promise<NodeJS.ProcessEnv>;
    runnerPath?: string;
}
export interface MiniSweExecution {
    submitted: boolean;
    trajectoryPath: string;
    modelTurns: number;
    toolSteps: number;
    error?: string;
}
/** Resolve the exact audited commit before a Builder workspace is materialized. */
export declare function miniSweBaselineCommit(baselineRoot: string): string;
/** Materialize a complete immutable source workspace owned by this Builder run. */
export declare function materializeMiniSweWorkspace(options: Pick<MiniSweRuntimeOptions, 'baselineRoot' | 'dependencySnapshot'> & {
    commit: string;
    workspace: string;
}): void;
/** Run mini-SWE in the Builder workspace and read only its durable trajectory. */
export declare function runMiniSwe(options: Omit<MiniSweRuntimeOptions, 'baselineRoot' | 'dependencySnapshot'> & Partial<Pick<MiniSweRuntimeOptions, 'baselineRoot' | 'dependencySnapshot'>> & {
    workspace: string;
    task: string;
    trajectoryPath: string;
}): Promise<MiniSweExecution>;
