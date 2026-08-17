export interface CandidateProfileOptions {
    /** Runtime-owned directory. The adapter creates one isolated DSH home below it. */
    runtimeRoot: string;
    /** Stable candidate identifier, used only as a filesystem-safe owned directory name. */
    candidateId: string;
    /** Formal vendored or gate-promoted candidate artifact directory. */
    candidateArtifact: string;
    /** DSH base bundle source, normally `<DSH_CWD>/packages/bundle/base`. */
    baseBundle: string;
    /** DSH CLI dependency anchor, normally `<DSH_CWD>/apps/cli/node_modules`. */
    dependencyRoot: string;
    /** Additional read-only DSH package anchors when the CLI omits a loop peer. */
    additionalDependencyRoots?: string[];
    profileName?: string;
}
export interface CandidateProfile {
    schemaVersion: 1;
    candidateId: string;
    home: string;
    profile: string;
    profileDir: string;
    runtimeEntry: string;
    candidateHash: string;
    baseBundleHash: string;
    loaderBridge: 'scheduler-symbol-v1';
    createdAt: string;
}
/** Hash regular files only. Profile input must not smuggle an executable symlink. */
export declare function hashProfileArtifact(directory: string): string;
/** Replace the base insert row before Loader composes the entry tree. */
export declare function replaceBaseLoopEntry(patch: string, runtimeEntry: string): string;
/**
 * Materialize a Loader-level replacement without modifying the DSH checkout.
 * The generated DSH home owns both the copied base patch and a copied candidate
 * package, so the entry resolves from a stable, auditable runtime path.
 */
export declare function createCandidateProfile(options: CandidateProfileOptions): CandidateProfile;
/** Remove only a complete adapter-owned profile with a matching marker. */
export declare function removeCandidateProfile(profile: CandidateProfile): void;
