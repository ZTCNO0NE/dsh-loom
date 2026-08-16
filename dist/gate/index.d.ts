import type { Context } from '@deepseek-ai/cordis';
import type { AppliedMetaPatch, MetaPatch, PatchState, SmokeReport } from '../types.js';
import { type LockedTargetPolicy } from '../policy.js';
/** Injected runtime access so the gate can be tested without a live dsh context. */
export interface ApplyOps {
    readConfig(targetId: string): Record<string, unknown>;
    writeConfig(targetId: string, config: Record<string, unknown>, patch: MetaPatch): string | void | Promise<string | void>;
    restoreConfig?(targetId: string, before: Record<string, unknown>, patch: MetaPatch): void | Promise<void>;
    smoke(patch: MetaPatch, before: Record<string, unknown>): SmokeReport | Promise<SmokeReport>;
    baseline?: Record<string, unknown>;
    rowExists?(id: string): boolean;
    insertRow?(patch: MetaPatch): void | Promise<void>;
    removeRow?(id: string): void | Promise<void>;
    skillExists?(id: string): boolean;
    installSkill?(patch: MetaPatch): void | Promise<void>;
    removeSkill?(id: string): void | Promise<void>;
}
export interface ApplyResult extends AppliedMetaPatch {
    smoke?: SmokeReport;
    conflict?: string;
    /** Persisted overlay path for config-update patches (cold-apply artifact). */
    overlay?: string;
}
export declare class Gate {
    private ctx;
    private meta;
    private lockedTargets;
    private pending;
    constructor(ctx: Context | null, meta?: {
        root: string;
        sessionId: string;
    }, lockedTargets?: LockedTargetPolicy);
    pendingCount(): number;
    enqueue(patch: MetaPatch): void;
    drain(ops: ApplyOps): Promise<ApplyResult[]>;
    /**
     * Prime-agent style cold apply: snapshot -> baseline conflict check ->
     * atomic write -> smoke -> rollback on failure. History is append-only.
     */
    applyWithRollback(patch: MetaPatch, ops: ApplyOps): Promise<ApplyResult>;
    private applyInsert;
    /** M4: skill patches install SKILL.md files into a skill root (no loader row). */
    private applyInsertSkill;
    /** Persist the patch state machine (I11). */
    markStatus(root: string, sessionId: string, patchId: string, state: PatchState, operator: string, iteration: number, error?: string): void;
    private record;
}
