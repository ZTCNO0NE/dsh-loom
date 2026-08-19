import { adjudicateComposition } from './index.js';
/** Controller seam: requesters select a registered plan id, never a graph. */
export class CompositionController {
    registry;
    gateway;
    depsFor;
    constructor(registry, gateway, depsFor) {
        this.registry = registry;
        this.gateway = gateway;
        this.depsFor = depsFor;
    }
    async execute(planId, requirements) {
        const plan = this.registry.resolve(planId);
        const started = this.gateway.startComposition(requirements, { capability: 'actor-composition', ...plan });
        const run = await this.gateway.runComposition(started.runId);
        if (run.state !== 'submitted' || !run.proposal)
            return { run };
        const proposal = asComposition(run.proposal);
        return { run, adjudication: await adjudicateComposition(proposal, this.depsFor(proposal)) };
    }
}
function asComposition(value) {
    if (value.capability !== 'actor-composition' || typeof value.id !== 'string' || !Array.isArray(value.operations)
        || typeof value.rationale !== 'string' || typeof value.expectedOutcome !== 'string') {
        throw new Error('runtime submitted an invalid actor-composition envelope');
    }
    return value;
}
