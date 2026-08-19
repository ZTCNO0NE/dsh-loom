import type { ActorEvolutionGateway, ActorEvolutionResult } from '../candidates/actor-gateway.js'
import { adjudicateComposition, type ActorCompositionProposal, type CompositionAdjudicationDeps, type CompositionAdjudicationResult } from './index.js'
import { CompositionPlanRegistry } from './plan-registry.js'

/** Controller seam: requesters select a registered plan id, never a graph. */
export class CompositionController {
  constructor(
    private readonly registry: CompositionPlanRegistry,
    private readonly gateway: ActorEvolutionGateway,
    private readonly depsFor: (proposal: ActorCompositionProposal) => CompositionAdjudicationDeps,
  ) {}

  async execute(planId: string, requirements: string): Promise<{ run: ActorEvolutionResult; adjudication?: CompositionAdjudicationResult }> {
    const plan = this.registry.resolve(planId)
    const started = this.gateway.startComposition(requirements, { capability: 'actor-composition', ...plan })
    const run = await this.gateway.runComposition(started.runId)
    if (run.state !== 'submitted' || !run.proposal) return { run }
    const proposal = asComposition(run.proposal)
    return { run, adjudication: await adjudicateComposition(proposal, this.depsFor(proposal)) }
  }
}

function asComposition(value: Record<string, unknown>): ActorCompositionProposal {
  if (value.capability !== 'actor-composition' || typeof value.id !== 'string' || !Array.isArray(value.operations)
    || typeof value.rationale !== 'string' || typeof value.expectedOutcome !== 'string') {
    throw new Error('runtime submitted an invalid actor-composition envelope')
  }
  return value as unknown as ActorCompositionProposal
}
