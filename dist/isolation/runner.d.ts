import type { MetaPatch } from '../types.js';
export interface DumpRow {
    id: string;
    raw: string;
}
export interface IsolationOptions {
    dshCommand: string[];
    cwd: string;
    profile: string;
    baseOverlays: string[];
    probe?: string;
    probeTimeoutMs?: number;
    dumpRunner?: (overlays: string[]) => string;
    stagingRoot?: string;
}
export interface IsolationResult {
    composed: boolean;
    dumpError?: string;
    candidateRowPresent: boolean;
    changedRows: string[];
    probe?: {
        ran: boolean;
        exitCode: number;
        outputTail: string;
    };
    commands?: {
        baselineDump: string[];
        patchedDump: string[];
        probe: string[];
    };
}
export declare function childEnv(): Record<string, string>;
/** Minimal dump parser: `- id: <id>` rows; comments stripped; raw = lines until next row/comment/EOF. */
export declare function parseDump(dump: string): DumpRow[];
/** Rows whose raw text differs between baseline and patched dumps, excluding the candidate row. */
export declare function findChangedRows(baseline: DumpRow[], patched: DumpRow[], targetId: string): string[];
export declare function buildCandidateOverlay(patch: MetaPatch, stagingRoot?: string): string;
/**
 * M2.6 isolation executor (minimal scope, 2026-08-16):
 * validates the CANDIDATE's basic errors only — composed tree loads, target row
 * present, unrelated rows unchanged; optional probe runs the patched profile.
 * It does NOT sense the actor (no session/context copying).
 */
export declare function runIsolation(patch: MetaPatch, options: IsolationOptions): IsolationResult;
/** Re-run isolation against the exact persisted Gate overlay artifact. */
export declare function runOverlayIsolation(patch: MetaPatch, options: IsolationOptions, overlayPath: string): IsolationResult;
