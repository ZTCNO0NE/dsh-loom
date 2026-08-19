import type { ActorEvolutionGateway, ActorEvolutionResult } from '../candidates/actor-gateway.js';
import { type ActorCompositionProposal, type CompositionAdjudicationDeps, type CompositionAdjudicationResult } from './index.js';
import { CompositionPlanRegistry } from './plan-registry.js';
/** Controller seam: requesters select a registered plan id, never a graph. */
export declare class CompositionController {
    private readonly registry;
    private readonly gateway;
    private readonly depsFor;
    constructor(registry: CompositionPlanRegistry, gateway: ActorEvolutionGateway, depsFor: (proposal: ActorCompositionProposal) => CompositionAdjudicationDeps);
    execute(planId: string, requirements: string): Promise<{
        run: ActorEvolutionResult;
        adjudication?: CompositionAdjudicationResult;
    }>;
}
