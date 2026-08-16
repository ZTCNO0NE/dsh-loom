import type { Context } from '@deepseek-ai/cordis';
import type { ExpectedTrajectory, MetaPatch, RegressionCase, SmokeReport, ValidationReport } from '../types.js';
import { type IsolationOptions, type IsolationResult } from '../isolation/runner.js';
export interface ValidatorOptions {
    regressionDir: string;
    maxCases: number;
    coverageThreshold?: number;
    /** M2.6: isolation executor belongs to the verifier. Optional; when set it runs before alignment. */
    isolation?: IsolationOptions;
    /** M4: workspace root + session for locating builder staging module files. */
    workspaceRoot?: string;
    sessionId?: string;
    /** M4: skill patches must pass a staging skill-root + catalog probe. */
    skillIsolation?: SkillIsolationOptions;
}
/** Actual run frames (I13) normalized for alignment. */
export interface ActualEvent {
    type: string;
    name?: string;
    error?: string | null;
    argsHash?: string;
    resultHash?: string;
    reason?: string;
    [key: string]: unknown;
}
export interface VerifierInput {
    actualEvents: ActualEvent[];
    configBeforeHash?: string;
    configAfterHash?: string;
    actualConfigHash?: string;
    /** Extra names that count as covered when they match claimed behaviors (e.g. targetId). */
    nameAliases?: string[];
}
export interface SkillIsolationOptions {
    dshCommand: string[];
    cwd: string;
    profile: string;
    baseOverlays: string[];
    stagingRoot: string;
    probeTimeoutMs?: number;
    dumpRunner?: (overlays: string[]) => string;
    probeRunner?: (overlays: string[], task: string) => {
        out: string;
        exit: number;
    };
}
export interface AlignmentResult {
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
}
export declare class Validator {
    private ctx;
    private options;
    constructor(ctx: Context | null, options: ValidatorOptions);
    /** Tycho-style deterministic alignment: expected trajectory vs real frames. */
    align(expected: ExpectedTrajectory, input: VerifierInput): AlignmentResult;
    /** Full fixed verification: alignment + regression + config invariance. */
    run(patch: MetaPatch, cases: RegressionCase[], input: VerifierInput): Promise<ValidationReport>;
    /** Append a traceable verdict record (ledger) and attach replay commands to the report. */
    private finish;
    private persistLedger;
    private reject;
    /** M2.6 belongs to the verifier: candidate composition/load check before behavior alignment. */
    runIsolationCheck(patch: MetaPatch): IsolationResult | null;
    /** M4: deterministic load check for builder-drafted modules (fresh `node --check`). */
    runModuleLoadCheck(patch: MetaPatch): {
        passed: boolean;
        file: string;
        error?: string;
    } | null;
    /** M4: generic skill isolation — staging skill root + real catalog probe. */
    runSkillIsolationCheck(patch: MetaPatch): {
        passed: boolean;
        file: string;
        error?: string;
        changedRows?: string[];
        probeExit?: number;
        probeTail?: string;
    } | null;
    /** Public frame probe for skill patches: true when the staged skill loads in a real catalog. */
    probeSkillForFrames(patch: MetaPatch): {
        passed: boolean;
        name?: string;
    };
    /** Load regression scenarios from regressionDir: each subdir has task.md + expected.json + optional run.sh. */
    loadRegressionCases(): Promise<RegressionCase[]>;
    /** Deterministic keyless runner: executes <scenario>/run.sh and checks expected.json rules. */
    private runRegressionCase;
    /** M3 post-apply smoke (I15): keyless regression subset + expectedOutcome presence. */
    runSmoke(patch: MetaPatch, cases: RegressionCase[]): Promise<SmokeReport>;
    /** Persist I10 report + write run events if provided. */
    persistReport(root: string, sessionId: string, patchId: string, report: ValidationReport, actualEvents?: ActualEvent[]): void;
    /** Hash a config tree snapshot for invariance checks. */
    hashConfig(config: Record<string, unknown>): string;
}
