import type { UserEvolutionPlan } from './controller.js';
export interface RecoveredJobTerminal {
    status: 'finished' | 'failed' | 'cancelled' | 'interrupted';
    summary: string;
}
/** Project an immutable terminal plan back onto a stale process-owned job. */
export declare function terminalJobFromPlan(plan: UserEvolutionPlan): RecoveredJobTerminal | null;
