export interface LedgerEntry {
    id: string;
    triggeredBy: string;
    problem: string;
    changes: Array<{
        target: string;
        kind: string;
        before: unknown;
        after: unknown;
    }>;
    verdict: string;
    applied: boolean;
    metricsBefore: Record<string, number | string | null>;
    metricsAfter: Record<string, number | string | null>;
    rolledBack: boolean;
    appliedAt: string;
}
export interface Preference {
    scope: string;
    value: string;
    sourceRef?: string;
    at?: string;
}
export declare function scenarioOf(signals: Array<{
    kind: string;
}>): string;
export declare function appendLedger(root: string, sessionId: string, entry: LedgerEntry): void;
export declare function readLedger(root: string, sessionId: string): LedgerEntry[];
export declare function mergePreferences(root: string, sessionId: string, prefs: Preference[]): void;
export declare function readPreferences(root: string, sessionId: string): Preference[];
export declare function appendReport(root: string, sessionId: string, line: string): void;
