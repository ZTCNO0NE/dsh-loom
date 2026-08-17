import type { LoopInstallOps } from './index.js';
import { type CandidateProfile } from './profile.js';
export interface ProfileGateOptions {
    runtimeRoot: string;
    baseBundle: string;
    dependencyRoot: string;
    additionalDependencyRoots?: string[];
    /** The gate owns this invocation; callers never provide a mutable Loader patch. */
    dumpConfig(profile: CandidateProfile): {
        exitCode: number;
        output: string;
    };
}
/**
 * Adapter-backed gate operations. A successful install is only an isolated
 * Loader profile; it never edits the DSH checkout or any user profile.
 */
export declare function profileGateOps(options: ProfileGateOptions, candidateId: string): LoopInstallOps;
