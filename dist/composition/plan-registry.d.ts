import type { CompositionWorkspacePlan } from './compiler.js';
/**
 * Controller-owned registry for multi-target work.  The request surface only
 * carries an id; the graph, targets, before snapshots and trajectories are
 * selected here before a Builder workspace exists.
 */
export declare class CompositionPlanRegistry {
    private readonly plans;
    constructor(plans: readonly CompositionWorkspacePlan[]);
    resolve(id: string): CompositionWorkspacePlan;
    ids(): string[];
    private assertPlan;
}
