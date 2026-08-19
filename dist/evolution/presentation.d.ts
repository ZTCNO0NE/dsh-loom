import type { UserEvolutionPlan, UserEvolutionReport } from './controller.js';
export type EvolutionTaskPhase = 'waiting_for_confirmation' | 'queued' | 'implementing' | 'verifying' | 'completed' | 'not_applied' | 'not_completed' | 'cancelled';
export interface EvolutionTaskCard {
    schemaVersion: 1;
    /** Stable display id, intentionally not the immutable plan id. */
    id: 'current-evolution-task';
    phase: EvolutionTaskPhase;
    headline: string;
    target: {
        summary: string;
    };
    progress: {
        current: string;
        next: string;
    };
    verification: string;
    risks: string[];
    evidence: {
        summary: string;
        artifactCount: number;
    };
    suggestions?: Array<{
        key: string;
        title: string;
        summary: string;
    }>;
    confirmation?: string;
    controls: Array<'confirm' | 'cancel_queued' | 'view_status' | 'view_evidence' | 'redo'>;
    /** Compatibility alias for earlier Actor integrations. */
    actions: Array<'confirm_execute' | 'view_status' | 'view_evidence'>;
    timeline: Array<{
        event: 'planned' | 'started' | 'verifying' | 'finished';
        at?: string;
        label: string;
    }>;
    retryable: boolean;
    result?: {
        outcome: '已生效' | '未生效' | '未完成' | '已取消';
        verdict: UserEvolutionReport['verdict'];
        summary: string;
        limitations: string[];
    };
}
export interface EvolutionTaskCardExtras {
    suggestions?: Array<{
        key: string;
        title: string;
        summary: string;
    }>;
    confirmation?: string;
}
/** Stable Actor-facing task card; it deliberately excludes before snapshots and raw paths. */
export declare function userEvolutionTaskCard(plan: UserEvolutionPlan, jobStatus?: string, extras?: EvolutionTaskCardExtras): EvolutionTaskCard;
