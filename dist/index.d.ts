import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type LockedTargetPolicy } from './policy.js';
export declare const name = "dsh-meta-validate";
export declare const inject: readonly ["tools", "agents", "loader"];
export interface MetaValidateConfig {
    mode: 'observe' | 'propose' | 'apply';
    /** Scheduled background refine: meta tools return immediately, completion is injected. */
    scheduled: boolean;
    regressionDir: string;
    maxPendingPatches: number;
    maxSignalsPerCycle: number;
    maxIterations: number;
    sessionId: string;
    workspaceRoot?: string;
    skillRoot: string;
    skillStagingRoot: string;
    thresholds: {
        repeatedFailureCount: number;
        regressionFailureCount: number;
    };
    llm: {
        provider: string;
        model: string;
    };
    builder: {
        maxModelTurns: number;
        maxToolSteps: number;
        maxTokens: number;
        maxWallTimeMs: number;
    };
    isolation: {
        enabled: boolean;
        dshCommand: string[];
        cwd: string;
        profile: string;
        baseOverlays: string[];
        probe: string;
        probeTimeoutMs: number;
    };
    reviewGate: {
        enabled: boolean;
        minIntervalTurns: number;
        maxIterationsPerEpoch: number;
        prompt: string;
        postLoopMaxRounds: number;
        autoIngestUserMessages: boolean;
        stallAbort: {
            enabled: boolean;
            maxTurnSeconds: number;
            maxStepsPerTurn: number;
            checkIntervalMs: number;
        };
    };
    notify: {
        start: boolean;
        progress: boolean;
        progressAfterMs: number;
        completion: boolean;
    };
    allowLoopCandidates: {
        enabled: boolean;
        allowedGitHosts: string[];
        runtimeRoot: string;
        maxTokens: number;
        buildDependencyRoot: string;
    };
    lockedTargets: LockedTargetPolicy;
}
export declare const Config: Schema<MetaValidateConfig>;
export declare function apply(ctx: Context, config: MetaValidateConfig): void;
