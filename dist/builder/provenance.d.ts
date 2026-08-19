/**
 * A deliberately small, factual graph linking the files and reports a Builder
 * sees.  It is navigation evidence, not a planner and never contains a repair
 * recommendation.  The shape is inspired by the public Apache-2.0 Tycho
 * workspace contract (tool schemas + verifier state), but is Loom-native.
 */
export type BuilderArtifactRole = 'actor_handoff' | 'target_before' | 'failure_report' | 'prior_run' | 'prior_run_asset' | 'workspace' | 'source' | 'candidate' | 'submission' | 'verification_report' | 'tool_result';
export type BuilderProvenanceRelation = 'consumes' | 'produces' | 'tests' | 'reports_on' | 'derived_from';
export interface BuilderArtifact {
    schemaVersion: 1;
    /** Stable for the same role/path/hash; it is safe to quote in a later tool call. */
    id: string;
    role: BuilderArtifactRole;
    path?: string;
    hash?: string;
    exists?: boolean;
    sourceRunId?: string;
    summary: string;
}
export interface BuilderProvenanceEdge {
    schemaVersion: 1;
    from: string;
    relation: BuilderProvenanceRelation;
    to: string;
    evidence?: string;
}
export interface BuilderProvenanceGraph {
    schemaVersion: 1;
    runId: string;
    generatedAt: string;
    artifacts: BuilderArtifact[];
    edges: BuilderProvenanceEdge[];
}
export interface BuilderProvenanceSeed {
    runId: string;
    actorPath: string;
    targetBeforePath: string;
    previousAttemptPath: string;
    previousRunPath: string;
    workspacePath: string;
    proposalPath: string;
    submissionManifestPath: string;
    actor: Record<string, unknown>;
    previousAttempt?: Record<string, unknown>;
    previousRun?: {
        runId: string;
        assets: Array<{
            name: string;
            path: string;
            exists: boolean;
            hash?: string;
        }>;
    };
}
export declare function createBuilderProvenance(seed: BuilderProvenanceSeed): BuilderProvenanceGraph;
export declare function addObservedArtifact(graph: BuilderProvenanceGraph, role: BuilderArtifactRole, path: string, summary: string, sourceRunId?: string): BuilderArtifact;
export declare function traceBuilderArtifact(graph: BuilderProvenanceGraph, selector: string): Record<string, unknown>;
/** Inspect a file as an interface-bearing artifact, rather than a raw blob only. */
export declare function inspectBuilderFile(path: string): Record<string, unknown>;
/** Read-only, argv-based text search. No shell is involved. */
export declare function searchBuilderText(query: string, roots: string[], maxResults?: number): Record<string, unknown>;
