import type { CompositionWorkspacePlan } from './compiler.js'

/**
 * Controller-owned registry for multi-target work.  The request surface only
 * carries an id; the graph, targets, before snapshots and trajectories are
 * selected here before a Builder workspace exists.
 */
export class CompositionPlanRegistry {
  private readonly plans = new Map<string, CompositionWorkspacePlan>()

  constructor(plans: readonly CompositionWorkspacePlan[]) {
    for (const plan of plans) {
      if (this.plans.has(plan.id)) throw new Error(`duplicate composition plan: ${plan.id}`)
      this.assertPlan(plan)
      this.plans.set(plan.id, structuredClone(plan))
    }
  }

  resolve(id: string): CompositionWorkspacePlan {
    const plan = this.plans.get(id)
    if (!plan) throw new Error(`unknown controller composition plan: ${id}`)
    return structuredClone(plan)
  }

  ids(): string[] { return [...this.plans.keys()].sort() }

  private assertPlan(plan: CompositionWorkspacePlan): void {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.id)) throw new Error('composition plan id is invalid')
    if (!plan.rationale.trim() || !plan.expectedOutcome.trim() || plan.targets.length === 0 || plan.targets.length > 8) {
      throw new Error('composition plan requires bounded targets, rationale, and expected outcome')
    }
    const nodeIds = new Set<string>()
    const targetIds = new Set<string>()
    for (const target of plan.targets) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(target.id) || nodeIds.has(target.id)) throw new Error('composition plan has duplicate or invalid node id')
      if (!target.targetId || targetIds.has(target.targetId)) throw new Error('composition plan has duplicate or missing target id')
      if (!target.expectedTrajectory?.events?.length) throw new Error(`composition plan target ${target.id} lacks expected trajectory`)
      if (target.targetKind === 'config' && !target.before) throw new Error(`composition config target ${target.id} lacks before snapshot`)
      if ((target.targetKind === 'tool' || target.targetKind === 'skill') && !target.entry) throw new Error(`composition module target ${target.id} lacks entry`)
      nodeIds.add(target.id); targetIds.add(target.targetId)
    }
    for (const target of plan.targets) for (const dependency of target.dependsOn ?? []) {
      if (!nodeIds.has(dependency) || dependency === target.id) throw new Error(`composition plan target ${target.id} has invalid dependency`)
    }
  }
}
