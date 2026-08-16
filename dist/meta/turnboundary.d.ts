import type { Context } from '@deepseek-ai/cordis';
import type { Observer } from '../observer/index.js';
import type { SignalThresholds } from '../types.js';
export interface TurnBoundaryDeps {
    observer: Observer;
    thresholds: SignalThresholds;
    onTrigger: (turn: number) => Promise<void>;
    /** Active pause: abort a turn that exceeds time/step limits so the invoker can run. */
    stallAbort?: {
        enabled: boolean;
        maxTurnSeconds: number;
        maxStepsPerTurn: number;
        checkIntervalMs: number;
    };
    /** True while the refine loop is running (skip stall abort during our own work). */
    refineRunning?: () => boolean;
    root: string;
    sessionId: string;
}
/**
 * M3.6: hooks the host hard trigger onto dsh's real turn boundary.
 *
 * - `agent/turn-stopping` (serial, turn about to close): cheap deterministic
 *   hard-trigger check; if fired, mark pending. Never blocks the boundary.
 * - `agent/status -> idle`: safe window (no driver active) to run the
 *   AutoPilot loop asynchronously, guarded by a busy flag.
 */
export declare class TurnBoundaryHook {
    private ctx;
    private deps;
    private lastTurn;
    private pending;
    private busy;
    private timer;
    private lastAbortAt;
    constructor(ctx: Context, deps: TurnBoundaryDeps);
    attach(): void;
    /** Public check for tests: abort the active turn when time/step limits are exceeded. */
    checkStall(): boolean;
    dispose(): void;
    /** Direct injection point for tests and manual turn simulation. */
    simulateTurnEnd(turn: number): boolean;
    /** Direct injection point for tests: pretend the agent became idle. */
    simulateIdle(): boolean;
    get isBusy(): boolean;
}
