import type { MetaPatch } from '../types.js';
import type { VerifierInput } from '../validate/index.js';
import { runIsolation } from '../isolation/runner.js';
export interface CollectFramesOptions {
    enabled: boolean;
    dshCommand: string[];
    cwd: string;
    profile: string;
    baseOverlays: string[];
    probe?: string;
    probeTimeoutMs?: number;
    stagingRootFor: (patchId: string) => string;
    isolationRunner?: typeof runIsolation;
    /** Skill patches: real catalog probe (verifier-owned) mapped to frames. */
    skillProbe?: (patch: MetaPatch) => {
        passed: boolean;
        name?: string;
    } | Promise<{
        passed: boolean;
        name?: string;
    }>;
}
/**
 * M4/M3 wiring: after the builder produces a candidate, run the isolation
 * probe against the REAL dsh environment and map probe success to the frames
 * the verifier aligns against. Skill patches pass through (the verifier's own
 * skillIsolation handles them); disabled isolation passes through unchanged.
 */
export declare function collectFramesForPatch(patch: MetaPatch, base: VerifierInput, options: CollectFramesOptions): Promise<VerifierInput>;
