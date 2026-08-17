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
 * Freeze an index over the actor's current evidence without copying the raw
 * transcript. Raw files remain the source of truth; summaries are navigation.
 */
export declare function createActorEvidencePack(options: ActorEvidencePackOptions): ActorEvidencePack;
/** Read a previously frozen manifest for status/reporting tools. */
export declare function readActorEvidencePack(path: string): ActorEvidencePack | null;
