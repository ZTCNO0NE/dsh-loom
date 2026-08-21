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
export type EvolutionDirectionMode = 'auto' | 'direct' | 'diagnose';
export interface EvolutionRouteDecision {
    route: 'direct' | 'diagnose';
    reason: string;
}
export interface DirectionDiagnosisCard {
    phase: 'diagnosing' | 'waiting_for_choice' | 'not_completed';
    headline: string;
    progress: {
        current: string;
        next: string;
    };
    directions: Array<{
        key: string;
        layer: 'config' | 'skill' | 'loop' | 'no_change';
        goal: string;
        unknowns: string[];
        cost: string;
    }>;
    question?: {
        text: string;
        whyNow: string;
        options: Array<{
            key: string;
            label: string;
            description?: string;
        }>;
    };
    controls: Array<'view_status' | 'choose_direction' | 'cancel_diagnosis'>;
}
export type EvolutionDirection = {
    id?: string;
    goal?: string;
    layer?: 'config' | 'skill' | 'loop' | 'no_change';
    unknowns?: string[];
    cost?: string;
};
export type EvolutionDirectionSelection = {
    kind: 'invalid';
    error: string;
} | {
    kind: 'no_change';
    direction: Required<Pick<EvolutionDirection, 'id' | 'goal' | 'layer'>>;
} | {
    kind: 'loop_confirmation';
    direction: Required<Pick<EvolutionDirection, 'id' | 'goal' | 'layer'>> & Pick<EvolutionDirection, 'unknowns' | 'cost'>;
} | {
    kind: 'product';
    targetKind: 'config' | 'skill';
    direction: Required<Pick<EvolutionDirection, 'id' | 'goal' | 'layer'>>;
};
/** Actor triage: explicit bounded targets go direct; ambiguity and structural work get Builder diagnosis. */
export declare function routeEvolutionDirection(input: {
    mode?: EvolutionDirectionMode;
    requirements: string;
    targetKind?: UserEvolutionTargetKind;
    targetId?: string;
    priorFailed?: boolean;
}): EvolutionRouteDecision;
/** Interpret one frozen Builder direction without allowing it to invent a host target identity. */
export declare function resolveEvolutionDirectionSelection(directions: EvolutionDirection[], selectedId: string): EvolutionDirectionSelection;
export declare function directionDiagnosisCard(status: {
    state: string;
    diagnosisReport: {
        available: boolean;
        directions?: Array<{
            id?: string;
            goal?: string;
            layer?: 'config' | 'skill' | 'loop' | 'no_change';
            unknowns?: string[];
            cost?: string;
        }>;
        question?: {
            question?: string;
            whyNow?: string;
            options?: Array<{
                id?: string;
                label?: string;
                description?: string;
            }>;
        };
    };
}): DirectionDiagnosisCard;
/** Host-owned config rows that are safe to name and freeze into a plan. */
export declare function eligibleConfigTargetIds(currentConfig: Record<string, unknown>): string[];
/**
 * Deterministic preflight before an immutable evidence pack is created. It
 * asks for missing routing intent instead of making the Actor guess tool
 * parameters or persisting an orphan plan.
 */
export declare function evolutionPlanningClarification(currentConfig: Record<string, unknown>, kind: UserEvolutionTargetKind | undefined, targetId: string | undefined): EvolutionPlanningClarification | null;
