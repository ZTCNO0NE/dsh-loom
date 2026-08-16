import type { MetaPatch } from './types.js';
/** Loop-layer rows that must never be modified, even through targetKind=config. */
export interface LockedTargetPolicy {
    ids: string[];
    names: string[];
}
export declare const DEFAULT_LOCKED_TARGETS: LockedTargetPolicy;
export declare function isLockedTarget(patch: Pick<MetaPatch, 'targetKind' | 'targetId' | 'targetName'>, policy?: LockedTargetPolicy): boolean;
