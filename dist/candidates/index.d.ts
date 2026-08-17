/** A loop candidate is never an ordinary MetaPatch: it has its own supply-chain state machine. */
export type CandidateState = 'staging' | 'pending' | 'verified' | 'approved' | 'installed' | 'rejected';
export interface CandidateSource {
    kind: 'vendored' | 'git' | 'builder-generated';
    /** Immutable source identity: a Git URL, or `vendored/<id>` for a seed. */
    uri: string;
    ref: string;
    commit?: string;
    contentHash: string;
}
/** Build recipe selected from a small core-controlled allowlist, never shell text from the builder. */
export interface CandidateBuildRecord {
    method: 'prebuilt' | 'sandboxed-dsh-workspace';
    command: string;
}
export interface CandidateManifest {
    schemaVersion: 1;
    id: string;
    displayName: string;
    targetId: 'agent-loop';
    packageName: string;
    /** Project-relative source directory. Gate resolves it; builder never supplies a live absolute path. */
    artifactPath: string;
    entry: string;
    build: CandidateBuildRecord;
    source: CandidateSource;
    config: Record<string, unknown>;
    expectedOutcome: string;
    capabilities: string[];
    createdAt: string;
    createdBy: 'seed' | 'builder';
}
export interface ContractEvidence {
    contractReport: string;
    regressionReport: string;
    installReport?: string;
    verifiedAt: string;
}
export interface CandidateRecord {
    manifest: CandidateManifest;
    state: CandidateState;
    updatedAt: string;
    evidence?: ContractEvidence;
    reason?: string;
}
export interface CandidateRegistryFile {
    schemaVersion: 1;
    candidates: Record<string, CandidateRecord>;
}
export interface LoopInstallReport {
    schemaVersion: 1;
    candidateId: string;
    state: 'installed' | 'rolled_back' | 'rejected';
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    smoke: {
        passed: boolean;
        checks: Array<{
            name: string;
            passed: boolean;
            detail?: string;
        }>;
    };
    rollback?: {
        attempted: boolean;
        succeeded: boolean;
        error?: string;
    };
    createdAt: string;
}
export declare function candidatePaths(root: string): {
    base: string;
    registry: string;
    install: (id: string) => string;
};
export declare function hashDirectory(directory: string): string;
/**
 * Persistent candidate registry. Builder may create staging/pending records;
 * only verifier/gate callers may advance the record beyond pending.
 */
export declare class CandidateRegistry {
    private readonly root;
    constructor(root: string);
    list(): CandidateRegistryFile;
    get(id: string): CandidateRecord | null;
    stage(manifest: CandidateManifest): CandidateRecord;
    transition(id: string, state: CandidateState, reason?: string, evidence?: ContractEvidence): CandidateRecord;
    recordInstall(report: LoopInstallReport): void;
    private write;
}
export interface CandidateAcquisitionRequest {
    id: string;
    displayName: string;
    /** A builder's requested Git revision. It is an input to the importer, never a trusted manifest. */
    source: {
        uri: string;
        ref: string;
    };
    packageName: string;
    /** Package root within a Git repository; defaults to the repository root. */
    packagePath?: string;
    entry: string;
    build: {
        method: CandidateBuildRecord['method'];
    };
    config: Record<string, unknown>;
    expectedOutcome: string;
    capabilities: string[];
}
export interface CandidateImporterOptions {
    /** Runtime-owned meta workspace, never the repository's vendored source tree. */
    root: string;
    allowedGitHosts: string[];
    /** Read-only dependency root for the audited sandbox build recipe. Empty disables source builds. */
    buildDependencyRoot?: string;
}
/**
 * The only networked candidate path. It deliberately writes a content-addressed
 * staging directory and a `staging` record, never `approved` or project `vendored/`.
 */
export declare class CandidateImporter {
    private readonly options;
    constructor(options: CandidateImporterOptions);
    acquire(request: CandidateAcquisitionRequest): CandidateManifest;
    /**
     * Build only a known DSH workspace recipe in a networkless bubblewrap
     * namespace. Builder text never becomes a command, and no host path other
     * than the read-only dependency store is visible to candidate build code.
     */
    private buildArtifact;
    /** Gate-only promotion after verifier approval; copies a hash-pinned staging artifact. */
    promoteApproved(candidateId: string): string;
}
export interface LoopInstallOps {
    snapshot(): Record<string, unknown>;
    install(manifest: CandidateManifest): void | Promise<void>;
    smoke(manifest: CandidateManifest): {
        passed: boolean;
        checks: Array<{
            name: string;
            passed: boolean;
            detail?: string;
        }>;
    } | Promise<{
        passed: boolean;
        checks: Array<{
            name: string;
            passed: boolean;
            detail?: string;
        }>;
    }>;
    rollback(before: Record<string, unknown>, manifest: CandidateManifest): void | Promise<void>;
}
/** Gate-owned cold replacement. It deliberately accepts only an approved candidate record. */
export declare function coldInstallCandidate(registry: CandidateRegistry, candidateId: string, ops: LoopInstallOps): Promise<LoopInstallReport>;
