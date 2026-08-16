import type { EvolutionSignal, MetaPatch, ValidationReport } from '../types.js';
import type { Proposer } from './propose.js';
import type { Validator, VerifierInput } from '../validate/index.js';
import type { ApplyOps, ApplyResult, Gate } from '../gate/index.js';
export interface LoopDeps {
    proposer: Proposer;
    validator: Validator;
    gate: Gate;
    root: string;
    sessionId: string;
    maxIterations: number;
    confirm: (patch: MetaPatch, report: ValidationReport) => Promise<boolean>;
    autoConfirm?: boolean;
    /** After the builder produces a patch, collect real frames (isolation probe) before verification. */
    collectFrames?: (patch: MetaPatch, baseInput: VerifierInput) => Promise<VerifierInput>;
    /** Builder-requested isolation probes (A): executed before full verification. */
    probeRunner?: (patch: MetaPatch, task: string) => {
        exit: number;
        outputTail: string;
    } | Promise<{
        exit: number;
        outputTail: string;
    }>;
    /** Post-apply growth hook: ledger/report/preferences sedimentation. */
    onApplied?: (info: {
        patch: MetaPatch;
        report: ValidationReport;
        applied: ApplyResult;
        signals: EvolutionSignal[];
    }) => void | Promise<void>;
}
export interface LoopResult {
    patch: MetaPatch | null;
    report: ValidationReport;
    applied: ApplyResult | null;
    iterations: number;
    escalated: boolean;
}
/**
 * v1 iteration loop (08 §10/§14):
 * inner loop = builder self-check -> verifier full fixed verification;
 * rejection is a hard requirement to iterate again; maxIterations escalates to the user.
 */
export declare class IterationLoop {
    private deps;
    constructor(deps: LoopDeps);
    run(signals: EvolutionSignal[], currentConfig: Record<string, unknown>, userRequirements?: string, verifierInput?: VerifierInput, applyOps?: ApplyOps): Promise<LoopResult>;
}
