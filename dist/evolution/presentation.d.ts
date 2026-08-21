import type { UserEvolutionPlan, UserEvolutionReport } from './controller.js';
import type { ActorEvidencePack } from '../evidence/index.js';
import type { EvolutionTaskSession } from './task-session.js';
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
    controls: Array<'confirm' | 'cancel_pending' | 'cancel_queued' | 'view_status' | 'view_evidence' | 'redo'>;
    /** Compatibility alias for earlier Actor integrations. */
    actions: Array<'confirm_execute' | 'view_status' | 'view_evidence'>;
    timeline: Array<{
        event: 'planned' | 'started' | 'verifying' | 'finished';
        at?: string;
        label: string;
    }>;
    retryable: boolean;
    result?: {
        outcome: '已生效' | '待重启生效' | '已回滚' | '未生效' | '未完成' | '已取消';
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
export interface EvolutionProgressNotice {
    text: string;
    summary: string;
}
export interface EvolutionHistoryEntry {
    createdAt: string;
    headline: string;
    phase: EvolutionTaskPhase;
    outcome: NonNullable<EvolutionTaskCard['result']>['outcome'] | '尚未裁决';
    verdict: UserEvolutionReport['verdict'] | null;
}
/** Restore safe confirmation context after another turn or host interaction. */
export declare function evolutionTaskCardExtras(session: EvolutionTaskSession, planId: string): EvolutionTaskCardExtras;
/** Latest immutable tasks, stripped of all routing ids and filesystem details. */
export declare function userEvolutionHistoryView(plans: UserEvolutionPlan[], limit?: number): EvolutionHistoryEntry[];
export interface EvolutionEvidenceView {
    schemaVersion: 1;
    frozen: true;
    frozenAt: string;
    target: string;
    coverage: {
        actorFrames: number;
        actorEvents: number;
        lastFrameAt: string | null;
        sources: Array<{
            name: string;
            present: boolean;
            lineCount: number;
        }>;
    };
    observations: {
        turns: number;
        toolCalls: number;
        toolErrors: number;
        toolErrorRate: number | null;
        signals: string[];
        actorAssessmentIncluded: boolean;
    };
    adjudication?: {
        verdict: UserEvolutionReport['verdict'];
        applied: boolean;
        effective: boolean | null;
        restartRequired: boolean;
        rolledBack: boolean;
    };
    privacy: string;
}
/** Stable Actor-facing task card; it deliberately excludes before snapshots and raw paths. */
export declare function userEvolutionTaskCard(plan: UserEvolutionPlan, jobStatus?: string, extras?: EvolutionTaskCardExtras): EvolutionTaskCard;
/**
 * User-visible proof inventory. It reports what was frozen and what the
 * independent boundary decided, while deliberately omitting raw content,
 * hashes, local paths, snapshots, credentials, and hidden model reasoning.
 */
export declare function userEvolutionEvidenceView(plan: UserEvolutionPlan, pack: ActorEvidencePack): EvolutionEvidenceView;
/** One low-frequency, state-backed progress notice; never a model-authored claim. */
export declare function userEvolutionProgressNotice(plan: UserEvolutionPlan, jobStatus?: string): EvolutionProgressNotice;
