/**
 * Durable meta workspace (08 §11-§12). File-first: no role trusts context;
 * every artifact is written atomically and carries a schemaVersion.
 */
export declare const PROTOCOL_VERSION = 1;
export declare function metaRoot(): string;
export declare function workspaceDir(root: string, sessionId: string): string;
export declare function patchDir(root: string, sessionId: string, patchId: string): string;
export declare function sha256(value: unknown): string;
export declare function atomicWriteJson(path: string, value: unknown): void;
export declare function appendJsonl(path: string, record: unknown): void;
export declare function readJson<T>(path: string): T | null;
export declare function readJsonl<T>(path: string): T[];
export interface ProtocolFile {
    schemaVersion: number;
    name: string;
}
export declare function ensureWorkspace(root: string, sessionId: string): void;
export declare const paths: {
    readonly requirements: (root: string, sessionId: string) => string;
    readonly triggers: (root: string, sessionId: string) => string;
    readonly signals: (root: string, sessionId: string) => string;
    readonly events: (root: string, sessionId: string) => string;
    readonly frames: (root: string, sessionId: string) => string;
    readonly handoff: (root: string, sessionId: string) => string;
    readonly errors: (root: string, sessionId: string) => string;
    readonly notices: (root: string, sessionId: string) => string;
    readonly worldState: (root: string, sessionId: string) => string;
    readonly actorProfile: (root: string, sessionId: string) => string;
    readonly worldModel: (root: string, sessionId: string) => string;
    readonly selfCheck: (root: string, sessionId: string) => string;
    readonly candidate: (root: string, sessionId: string, patchId: string) => string;
    readonly expectedTrajectory: (root: string, sessionId: string, patchId: string) => string;
    readonly report: (root: string, sessionId: string, patchId: string) => string;
    readonly status: (root: string, sessionId: string, patchId: string) => string;
    readonly smoke: (root: string, sessionId: string, patchId: string) => string;
    readonly runEvents: (root: string, sessionId: string, patchId: string) => string;
    readonly probes: (root: string, sessionId: string, patchId: string) => string;
    readonly builderRun: (root: string, sessionId: string, patchId: string) => string;
    readonly builderResume: (root: string, sessionId: string) => string;
    readonly history: (root: string, sessionId: string) => string;
    readonly gateDecisions: (root: string, sessionId: string) => string;
    readonly autopilotState: (root: string, sessionId: string) => string;
    readonly costLog: (root: string, sessionId: string) => string;
    readonly ledger: (root: string, sessionId: string) => string;
    readonly growthLedger: (root: string, sessionId: string) => string;
    readonly growthPreferences: (root: string, sessionId: string) => string;
    readonly growthReport: (root: string, sessionId: string) => string;
    readonly harnessState: (root: string, sessionId: string) => string;
    readonly overlays: (root: string, sessionId: string) => string;
    readonly overlayFile: (root: string, sessionId: string, patchId: string) => string;
    readonly staging: (root: string, sessionId: string, patchId: string) => string;
};
