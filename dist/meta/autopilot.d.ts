import type { SignalThresholds } from '../types.js';
import type { ReviewDecision } from '../types.js';
import type { Observer } from '../observer/index.js';
import type { ReviewGate } from './review.js';
import type { IterationLoop, LoopResult } from './loop.js';
import type { ApplyOps } from '../gate/index.js';
import type { VerifierInput } from '../validate/index.js';
export interface AutoPilotDeps {
    gate: Pick<ReviewGate, 'decide'> & Partial<Pick<ReviewGate, 'decideOnDigest'>>;
    loop: IterationLoop;
    observer: Observer;
    root: string;
    sessionId: string;
    thresholds: SignalThresholds;
    minIntervalTurns: number;
    maxIterationsPerEpoch: number;
    /** Post-loop re-invocation rounds: after an apply, the supervisor is woken again. */
    postLoopMaxRounds?: number;
}
export type AutoPilotOutcome = {
    fired: false;
    reason: 'no_hard_trigger' | 'cooldown' | 'epoch_budget' | 'gate_declined';
    decision?: ReviewDecision;
} | {
    fired: true;
    reason: 'gate_approved';
    decision: ReviewDecision;
    result: LoopResult;
};
/**
 * Two-stage frequency control (08 §15):
 * stage 0 = free deterministic hard triggers; stage 1 = independent LLM review gate;
 * stage 2 = builder+verifier loop. Cooldown + per-epoch budget cap the frequency.
 */
export declare class AutoPilot {
    private deps;
    constructor(deps: AutoPilotDeps);
    step(turn: number, currentConfig: Record<string, unknown>, requirements?: string, verifierInput?: VerifierInput, applyOps?: ApplyOps): Promise<AutoPilotOutcome>;
}
