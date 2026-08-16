import type { Observer } from '../observer/index.js';
import type { AutopilotState, EvolutionSignal } from '../types.js';
/**
 * Compact actor-runtime digest for the one-shot supervision detector (route A):
 * key metrics only (model, latency, errors, stall signals) — NOT the full
 * frames. The builder receives full perception only after the detector says so.
 */
export interface StallIndicators {
    noFrameSeconds: number;
    turnOlderThanSeconds: number;
    repeatedTextCount: number;
    noToolProgress: boolean;
}
export interface RuntimeDigest {
    schemaVersion: number;
    at: string;
    model?: string;
    turns: number;
    avgTurnMs: number | null;
    maxTurnMs: number | null;
    lastFrameAgeMs: number | null;
    turnAgeMs: number | null;
    toolCalls: number;
    toolErrors: number;
    toolErrorRate: number | null;
    topTools: Array<{
        name: string;
        calls: number;
        errors: number;
        avgMs: number | null;
    }>;
    stall: StallIndicators;
    signals: Array<{
        kind: string;
        evidence: string[];
    }>;
    epoch: number;
    iterationsThisEpoch: number;
    lastApplyTurn: number;
}
export declare function buildRuntimeDigest(options: {
    observer: Observer;
    root: string;
    sessionId: string;
    currentConfig: Record<string, unknown>;
    signals: EvolutionSignal[];
    state: AutopilotState;
    now?: number;
}): RuntimeDigest;
