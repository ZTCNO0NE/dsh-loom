import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, readJson, sha256 } from '../protocol/index.js'
import { PluginEvolutionGateway, type PluginEvolutionRunResult } from './gateway.js'
import { freezePluginTargets, type PluginTargetRequest } from './source.js'
import { PluginTransactionManager } from './transaction.js'
import { verifyPluginEvolution, type VerifyPluginEvolutionOptions } from './verifier.js'
import type {
  PluginCommand,
  PluginEvolutionPlan,
  PluginEvolutionProposal,
  PluginTransactionRecord,
  PluginVerificationReport,
} from './types.js'

export interface CreatePluginEvolutionPlan {
  requirements: string
  expectedOutcome: string
  targets: PluginTargetRequest[]
  integrationCommand?: PluginCommand
}

interface PluginEvolutionRuntime {
  start(plan: PluginEvolutionPlan): { runId: string }
  run(runId: string, plan: PluginEvolutionPlan): Promise<PluginEvolutionRunResult>
}

interface PluginTransactions {
  prepare(plan: PluginEvolutionPlan, proposal: PluginEvolutionProposal, report: PluginVerificationReport): PluginTransactionRecord
  cancelReady(id: string): PluginTransactionRecord
  prepareRestore(id: string): PluginTransactionRecord
  read(id: string): PluginTransactionRecord
}

export interface PluginEvolutionControllerOptions {
  root: string
  sessionId: string
  profile: string
  profileDir: string
  gateway: PluginEvolutionRuntime
  transactions: PluginTransactions
  verify?: (plan: PluginEvolutionPlan, proposal: PluginEvolutionProposal, options?: VerifyPluginEvolutionOptions) => PluginVerificationReport
  verifierOptions?: VerifyPluginEvolutionOptions
}

/**
 * Host-owned orchestration for source-level plugin changes. The frozen target
 * graph is persisted before Builder gets a workspace. This controller stops
 * at ready_to_activate; only the cold-start transaction hook may touch the
 * live Profile.
 */
export class PluginEvolutionController {
  constructor(private readonly options: PluginEvolutionControllerOptions) {}

  plan(input: CreatePluginEvolutionPlan): PluginEvolutionPlan {
    if (!input.requirements.trim()) throw new Error('plugin evolution requires a non-empty user goal')
    if (!input.expectedOutcome.trim()) throw new Error('plugin evolution requires an explicit expected outcome')
    const id = `plugin-evolution-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const targets = freezePluginTargets({
      planRoot: join(this.directory(), id),
      profileDir: this.options.profileDir,
      requests: input.targets,
    })
    const plan: PluginEvolutionPlan = {
      schemaVersion: 1,
      capability: 'plugin-evolution',
      id,
      createdAt: new Date().toISOString(),
      profile: this.options.profile,
      profileDir: this.options.profileDir,
      requirements: input.requirements,
      expectedOutcome: input.expectedOutcome,
      targets,
      ...(input.integrationCommand ? { integrationCommand: structuredClone(input.integrationCommand) } : {}),
      state: 'planned',
    }
    this.write(plan)
    return plan
  }

  read(planId: string): PluginEvolutionPlan {
    const plan = readJson<PluginEvolutionPlan>(this.file(planId))
    if (!plan || plan.schemaVersion !== 1 || plan.capability !== 'plugin-evolution') throw new Error(`unknown plugin evolution plan: ${planId}`)
    return plan
  }

  async execute(planId: string): Promise<PluginEvolutionPlan> {
    const plan = this.read(planId)
    if (plan.state !== 'planned') throw new Error(`plugin evolution plan is not executable: ${plan.state}`)
    const started = this.options.gateway.start(plan)
    plan.state = 'implementing'
    plan.execution = { runId: started.runId, at: new Date().toISOString() }
    this.write(plan)
    const run = await this.options.gateway.run(started.runId, plan)
    if (run.state !== 'submitted' || !run.proposal) {
      plan.state = 'aborted'
      plan.result = this.result('aborted', 'Builder implementation runtime did not submit a completed plugin candidate；详细原因仅保留在受控 run record')
      this.write(plan)
      return plan
    }
    plan.state = 'verifying'
    this.write(plan)
    const report = (this.options.verify ?? verifyPluginEvolution)(plan, run.proposal, this.options.verifierOptions)
    if (report.verdict !== 'approved') {
      plan.state = 'rejected'
      plan.result = this.result('rejected', report.failureSummary ?? 'Independent plugin verification rejected the candidate')
      this.write(plan)
      return plan
    }
    const transaction = this.options.transactions.prepare(plan, run.proposal, report)
    plan.transactionId = transaction.id
    if (transaction.state !== 'ready_to_activate') {
      plan.state = 'rejected'
      plan.result = this.result('rejected', transaction.verification?.failureSummary
        ? `Staged Profile rejected required checks: ${transaction.verification.failureSummary}`
        : 'Staged Profile rejected the plugin composition；详细原因仅保留在受控 transaction record')
      this.write(plan)
      return plan
    }
    plan.state = 'ready_to_activate'
    plan.result = {
      verdict: 'approved', applied: false, effective: false, restartRequired: true,
      summary: '组合候选已通过独立验证和 Shadow Profile 冷启动；将在下一次 Loom 冷启动前整体激活',
      limitations: ['The live Profile is unchanged until cold activation.', 'All target packages activate or remain on the previous combination together.'],
    }
    this.write(plan)
    return plan
  }

  cancelReady(planId: string): PluginEvolutionPlan {
    const plan = this.read(planId)
    if (plan.state !== 'ready_to_activate' || !plan.transactionId) throw new Error(`plugin evolution plan is not cancellable: ${plan.state}`)
    this.options.transactions.cancelReady(plan.transactionId)
    plan.state = 'cancelled'
    plan.result = this.result('aborted', '用户在冷启动激活前取消了组合更新')
    this.write(plan)
    return plan
  }

  cancelPlanned(planId: string): PluginEvolutionPlan {
    const plan = this.read(planId)
    if (plan.state !== 'planned') throw new Error(`plugin evolution plan is not cancellable: ${plan.state}`)
    plan.state = 'cancelled'
    plan.result = this.result('aborted', '用户在 Builder 启动前取消了插件演进任务')
    this.write(plan)
    return plan
  }

  markAborted(planId: string, summary = '插件隔离实现未完成'): PluginEvolutionPlan {
    const plan = this.read(planId)
    if (plan.state !== 'implementing' && plan.state !== 'verifying') return plan
    plan.state = 'aborted'
    plan.result = this.result('aborted', summary)
    this.write(plan)
    return plan
  }

  reconcile(planId: string): PluginEvolutionPlan {
    const plan = this.read(planId)
    if (!plan.transactionId) return plan
    const transaction = this.options.transactions.read(plan.transactionId)
    if (transaction.state === 'completed') {
      plan.state = 'completed'
      plan.result = {
        verdict: 'approved', applied: true, effective: true, restartRequired: false,
        summary: '目标插件组合已在冷启动前整体激活，并通过 Loader 与组合行为复核',
        limitations: ['The receipt proves the declared integration behavior, not universal workload improvement.'],
      }
      this.write(plan)
    } else if (transaction.state === 'rolled_back') {
      plan.state = 'completed'
      plan.result = {
        verdict: 'approved', applied: false, effective: false, restartRequired: false,
        summary: '已通过独立恢复事务还原安装前的插件组合',
        limitations: ['The original evolution record remains immutable and linked to its restore receipt.'],
      }
      this.write(plan)
    } else if (transaction.state === 'failed') {
      plan.state = 'rejected'
      plan.result = this.result('rejected', transaction.rollback?.succeeded
        ? '冷激活未通过；整个 Profile 已恢复到安装前组合'
        : '冷激活与自动恢复均未完成，需要人工检查隔离 Profile receipt')
      this.write(plan)
    } else if (transaction.state === 'cancelled') {
      plan.state = 'cancelled'
      plan.result = this.result('aborted', '组合更新已在激活前取消')
      this.write(plan)
    }
    return plan
  }

  prepareRestore(planId: string): PluginTransactionRecord {
    const plan = this.reconcile(planId)
    if (plan.state !== 'completed' || !plan.transactionId || !plan.result?.effective) throw new Error('only an effective plugin evolution can create a restore transaction')
    return this.options.transactions.prepareRestore(plan.transactionId)
  }

  private result(verdict: 'rejected' | 'aborted', summary: string): NonNullable<PluginEvolutionPlan['result']> {
    return {
      verdict, applied: false, effective: false, restartRequired: false, summary,
      limitations: ['No candidate package was partially activated.', 'Builder cannot bypass the independent Verifier or package transaction Gate.'],
    }
  }

  private sessionKey(): string { return sha256(this.options.sessionId).slice(0, 24) }
  private directory(): string { return join(this.options.root, 'plugin-evolution', this.sessionKey()) }
  private file(planId: string): string {
    if (!/^plugin-evolution-[a-z0-9-]+$/i.test(planId)) throw new Error('invalid plugin evolution plan id')
    return join(this.directory(), `${planId}.json`)
  }
  private write(plan: PluginEvolutionPlan): void {
    mkdirSync(this.directory(), { recursive: true })
    atomicWriteJson(this.file(plan.id), plan)
  }
}

export { PluginEvolutionGateway, PluginTransactionManager }
