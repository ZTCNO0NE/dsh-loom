import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, readJson } from '../protocol/index.js'
import { ActorEvolutionGateway, type ConfigEvolutionPlan, type ModuleEvolutionPlan } from '../candidates/actor-gateway.js'
import { classifyBuilderProposal, type PatchAdjudicationResult } from '../deliberation/index.js'

export type UserEvolutionTargetKind = 'config' | 'skill'
export type UserEvolutionMode = 'plan' | 'execute'

export type UserEvolutionTarget =
  | { kind: 'config'; plan: ConfigEvolutionPlan; summary: string; verification: string; risks: string[] }
  | { kind: 'skill'; plan: ModuleEvolutionPlan; summary: string; verification: string; risks: string[] }

export interface UserEvolutionPlan {
  schemaVersion: 1
  id: string
  createdAt: string
  requirements: string
  target: UserEvolutionTarget
  evidence: { refs: string[]; summary: string }
  state: 'planned' | 'queued' | 'executing' | 'verifying' | 'completed' | 'rejected' | 'aborted' | 'cancelled' | 'interrupted'
  execution?: { runId: string; at: string }
  result?: UserEvolutionReport
}

export interface UserEvolutionReport {
  runId: string
  targetKind: UserEvolutionTargetKind
  targetId: string
  verdict: 'approved' | 'rejected' | 'aborted'
  /** Gate artifact was installed. Config artifacts may still await a cold host restart. */
  applied: boolean
  /** The change is visible to the running Actor process. */
  effective?: boolean
  /** A verified config overlay is installed but requires a cold host restart. */
  restartRequired?: boolean
  /** A later Gate-owned receipt restored the original before snapshot. */
  rolledBack?: boolean
  /** Internal evidence location; presentation must not expose this path. */
  rollbackReceipt?: string
  summary: string
  limitations: string[]
}

export interface UserEvolutionControllerOptions {
  root: string
  sessionId: string
  gateway: ActorEvolutionGateway
  /** Host resolves identities/before snapshots; user text never supplies them directly. */
  resolveTarget(requirements: string, kind: UserEvolutionTargetKind): UserEvolutionTarget
  adjudicate(proposal: Record<string, unknown>, plan: UserEvolutionPlan): Promise<PatchAdjudicationResult>
  evidenceFor(requirements: string): { refs: string[]; summary: string }
}

/**
 * Product-facing Plan/Execute controller. It does not perform diagnosis by
 * model prompt: the Actor/host supplies an evidence-backed target and the
 * controller persists it before a runtime gets any writable workspace.
 */
export class UserEvolutionController {
  constructor(private readonly options: UserEvolutionControllerOptions) {}

  plan(requirements: string, kind: UserEvolutionTargetKind): UserEvolutionPlan {
    if (!requirements.trim()) throw new Error('evolution plan requires non-empty requirements')
    const target = this.options.resolveTarget(requirements, kind)
    if (target.kind !== kind) throw new Error(`host resolver returned ${target.kind} for requested ${kind}`)
    const createdAt = new Date().toISOString()
    const plan: UserEvolutionPlan = {
      schemaVersion: 1,
      id: `evolution-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      createdAt,
      requirements,
      target,
      evidence: this.options.evidenceFor(requirements),
      state: 'planned',
    }
    this.write(plan)
    return plan
  }

  read(planId: string): UserEvolutionPlan {
    const plan = readJson<UserEvolutionPlan>(this.file(planId))
    if (!plan || plan.schemaVersion !== 1) throw new Error(`unknown evolution plan: ${planId}`)
    return plan
  }

  /** Claim a plan synchronously before a background job is queued. */
  queue(planId: string): UserEvolutionPlan {
    const plan = this.read(planId)
    if (plan.state !== 'planned') throw new Error(`evolution plan is not queueable: ${plan.state}`)
    plan.state = 'queued'
    this.write(plan)
    return plan
  }

  /** Queued work has not acquired a writable workspace yet and is safe to cancel. */
  cancel(planId: string): UserEvolutionPlan {
    const plan = this.read(planId)
    if (plan.state !== 'queued') throw new Error(`evolution plan is not cancellable: ${plan.state}`)
    plan.state = 'cancelled'
    plan.result = this.report(plan, plan.execution?.runId ?? 'not-started', 'aborted', false, '用户在实现开始前取消了此任务')
    this.write(plan)
    return plan
  }

  /** A process reload cannot safely resume a pass whose worker no longer exists. */
  interrupt(planId: string): UserEvolutionPlan {
    const plan = this.read(planId)
    if (plan.state !== 'queued' && plan.state !== 'executing' && plan.state !== 'verifying') return plan
    plan.state = 'interrupted'
    plan.result = this.report(plan, plan.execution?.runId ?? 'interrupted', 'aborted', false, '宿主重载中断了本轮；原任务与证据已保留')
    this.write(plan)
    return plan
  }

  async execute(planId: string): Promise<UserEvolutionPlan> {
    const plan = this.read(planId)
    if (plan.state !== 'queued' && plan.state !== 'planned') throw new Error(`evolution plan is not executable: ${plan.state}`)
    const started = plan.target.kind === 'config'
      ? this.options.gateway.startConfig(plan.requirements, plan.target.plan)
      : this.options.gateway.startModule(plan.requirements, plan.target.plan)
    plan.state = 'executing'
    plan.execution = { runId: started.runId, at: new Date().toISOString() }
    this.write(plan)
    const run = plan.target.kind === 'config'
      ? await this.options.gateway.runConfig(started.runId)
      : await this.options.gateway.runModule(started.runId)
    if (run.state !== 'submitted' || !run.proposal) {
      plan.state = 'aborted'
      plan.result = this.report(plan, started.runId, 'aborted', false, run.reason ?? 'Builder did not submit')
      this.write(plan)
      return plan
    }
    const classified = classifyBuilderProposal(run.proposal)
    if (classified.kind !== 'known' || classified.proposal.capability !== 'patch-evolution') {
      plan.state = 'rejected'
      plan.result = this.report(plan, started.runId, 'rejected', false, classified.kind === 'malformed' ? classified.reason : 'proposal requires an unregistered verifier')
      this.write(plan)
      return plan
    }
    plan.state = 'verifying'
    this.write(plan)
    const adjudication = await this.options.adjudicate(run.proposal, plan)
    const applied = adjudication.applied?.applied ?? false
    plan.state = adjudication.verdict === 'approved' && applied ? 'completed' : 'rejected'
    plan.result = this.report(plan, started.runId, adjudication.verdict, applied, adjudication.reason ?? adjudication.report.failureSummary ?? adjudication.verdict)
    this.write(plan)
    return plan
  }

  private report(plan: UserEvolutionPlan, runId: string, verdict: UserEvolutionReport['verdict'], applied: boolean, summary: string): UserEvolutionReport {
    const targetId = plan.target.plan.targetId
    const restartRequired = applied && plan.target.kind === 'config'
    return {
      runId,
      targetKind: plan.target.kind,
      targetId,
      verdict,
      applied,
      effective: applied && !restartRequired,
      restartRequired,
      summary: restartRequired ? `${summary}；配置 overlay 已通过冷启动验证，宿主重启后生效` : summary,
      limitations: [
        'Only the host-selected target and isolated workspace are mutable.',
        'Verifier and Gate remain independent final authorities.',
        'A successful install does not by itself prove general task improvement.',
        ...(restartRequired ? ['The verified config overlay requires a cold host restart before it affects Actor sessions.'] : []),
      ],
    }
  }

  private file(planId: string): string { return join(this.options.root, 'user-evolution', this.options.sessionId, `${planId}.json`) }
  private write(plan: UserEvolutionPlan): void {
    const file = this.file(plan.id)
    mkdirSync(join(this.options.root, 'user-evolution', this.options.sessionId), { recursive: true })
    atomicWriteJson(file, plan)
  }
}
