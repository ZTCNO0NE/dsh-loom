import type { UserEvolutionTargetKind } from './controller.js';
export interface EvolutionPlanningChoice {
    key: string;
    title: string;
    summary: string;
}
export interface EvolutionPlanningClarification {
    question: string;
    choices: EvolutionPlanningChoice[];
}
/** Host-owned config rows that are safe to name and freeze into a plan. */
export declare function eligibleConfigTargetIds(currentConfig: Record<string, unknown>): string[];
/**
 * Deterministic preflight before an immutable evidence pack is created. It
 * asks for missing routing intent instead of making the Actor guess tool
 * parameters or persisting an orphan plan.
 */
export declare function evolutionPlanningClarification(currentConfig: Record<string, unknown>, kind: UserEvolutionTargetKind | undefined, targetId: string | undefined): EvolutionPlanningClarification | null;
