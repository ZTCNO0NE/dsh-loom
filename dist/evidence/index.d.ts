import type { AutopilotState, EvolutionSignal } from '../types.js';
import { type RuntimeDigest } from '../meta/digest.js';
import type { Observer } from '../observer/index.js';
export interface ActorEvidencePack {
    schemaVersion: number;
    id: string;
    sessionId: string;
    createdAt: string;
    watermark: {
        frameCount: number;
        eventCount: number;
        lastFrameAt: string | null;
    };
    rawRefs: Array<{
        name: string;
        path: string;
        snapshotPath?: string;
        exists: boolean;
        bytes: number;
        lineCount: number;
        sha256?: string;
    }>;
    deterministicDigest: RuntimeDigest;
    actorHandoff: {
        path: string;
        sha256: string;
        supplied: boolean;
    };
    configSnapshot: {
        path: string;
        sha256: string;
    };
    manifestPath: string;
}
export interface ActorEvidencePackOptions {
    root: string;
    sessionId: string;
    observer: Observer;
    currentConfig: Record<string, unknown>;
    signals: EvolutionSignal[];
    state: AutopilotState;
    requirements: string;
    actorAssessment?: string;
}
/**
 * Freeze an index over the actor's current evidence. The original path remains
 * discoverable for broader Builder exploration, while `snapshotPath` is the
 * immutable evidence input used by verifiers and replay. This avoids claiming
 * a frozen pack while reading an append-only live transcript.
 */
export declare function createActorEvidencePack(options: ActorEvidencePackOptions): ActorEvidencePack;
/** Read a previously frozen manifest for status/reporting tools. */
export declare function readActorEvidencePack(path: string): ActorEvidencePack | null;
