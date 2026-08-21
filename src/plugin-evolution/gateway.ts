import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BuilderKernel, builderRunPaths } from '../builder/kernel.js'
import { runMiniSwe, type MiniSweRuntimeOptions } from '../builder/mini-swe.js'
import { scopedSessionId } from '../protocol/index.js'
import { compilePluginEvolutionProposal } from './compiler.js'
import type { PluginEvolutionPlan, PluginEvolutionProposal } from './types.js'

export interface PluginEvolutionGatewayOptions {
  root: string
  sessionId: string
  model: string
  miniSwe: Omit<MiniSweRuntimeOptions, 'model' | 'baselineRoot' | 'dependencySnapshot'>
}

export interface PluginEvolutionRunResult {
  runId: string
  state: 'submitted' | 'aborted'
  proposal?: PluginEvolutionProposal
  reason?: string
}

export class PluginEvolutionGateway {
  constructor(private readonly options: PluginEvolutionGatewayOptions) {}

  start(plan: PluginEvolutionPlan): { runId: string } {
    if (plan.capability !== 'plugin-evolution' || plan.targets.length < 1 || plan.targets.length > 3) throw new Error('invalid plugin evolution plan')
    const kernel = this.kernel()
    const run = kernel.create({
      kind: 'patch',
      actor: { requirements: plan.requirements },
      targetBefore: {
        capability: 'plugin-evolution',
        planId: plan.id,
        profile: plan.profile,
        targets: plan.targets.map((target) => ({ id: target.id, packageName: target.packageName, dependsOn: target.dependsOn, sourceHash: target.source.treeHash })),
      },
    })
    const workspace = this.paths(run.id).workspace
    for (const target of plan.targets) {
      const destination = join(workspace, 'plugins', target.id)
      if (existsSync(destination)) throw new Error(`plugin run workspace already contains target: ${target.id}`)
      mkdirSync(join(workspace, 'plugins'), { recursive: true })
      cpSync(target.source.snapshotPath, destination, { recursive: true, dereference: false })
    }
    if (plan.requirements.trim()) kernel.receiveActorMessage(run.id, { rawUserText: plan.requirements, idempotencyKey: `initial:${run.id}` })
    return { runId: run.id }
  }

  async run(runId: string, plan: PluginEvolutionPlan): Promise<PluginEvolutionRunResult> {
    const kernel = this.kernel()
    const context = kernel.context(runId)
    if (context.input.targetBefore.capability !== 'plugin-evolution' || context.input.targetBefore.planId !== plan.id) throw new Error('run does not belong to plugin evolution plan')
    const targetLines = plan.targets.map((target) => {
      const commands = [...target.prepareCommands, ...target.buildCommands, ...target.testCommands]
        .map((command) => `${command.command} ${command.args.join(' ')}`.trim())
      return `- ${target.id}: ${target.packageName}@${target.installed.version}; source=plugins/${target.id}; packageDir=${target.source.packageDir}; dependsOn=${target.dependsOn.join(',') || 'none'}; required commands=${commands.join(' | ')}`
    })
    const execution = await runMiniSwe({
      ...this.options.miniSwe,
      model: this.options.model,
      workspace: this.paths(runId).workspace,
      trajectoryPath: join(this.paths(runId).base, 'mini-swe-agent-trajectory.json'),
      task: [
        'You are the Builder implementation runtime for a frozen DSH plugin-evolution plan.',
        `User goal: ${plan.requirements.slice(0, 12_000)}`,
        `Expected outcome: ${plan.expectedOutcome.slice(0, 4_000)}`,
        'Edit only the existing plugins/<target-id>/ source trees listed below. You may change source, tests, and package build metadata inside those trees.',
        ...targetLines,
        'Do not add another plugin target. Do not edit DSH, dsh-loom, credentials, live profiles, verifier/gate, or files outside plugins/.',
        'Run the required focused tests. When the coupled change is ready, use the runtime completion command. Loom will rerun host-owned commands, pack immutable tar artifacts, and independently verify the whole composition.',
      ].join('\n'),
    })
    if (!execution.submitted) return this.abort(kernel, runId, execution.error ?? 'mini-SWE did not submit a completed plugin trajectory')
    try {
      const proposal = compilePluginEvolutionProposal({
        plan,
        workspace: this.paths(runId).workspace,
        artifactsRoot: join(this.paths(runId).base, 'artifacts'),
      })
      for (const message of context.messages) kernel.decide(runId, { kind: 'tool', action: {
        name: 'acknowledge_message', messageId: message.id, status: 'accepted',
        understanding: 'The plugin implementation runtime received the Actor message and completed the frozen multi-plugin workspace candidate.',
        nextAction: 'Freeze package artifacts for independent verification.',
      } })
      kernel.decide(runId, { kind: 'tool', action: { name: 'write_submission', proposal: proposal as unknown as Record<string, unknown> } })
      kernel.decide(runId, { kind: 'submit' })
      return { runId, state: 'submitted', proposal }
    } catch (error) {
      return this.abort(kernel, runId, `plugin submission compilation failed: ${String(error)}`)
    }
  }

  private abort(kernel: BuilderKernel, runId: string, reason: string): PluginEvolutionRunResult {
    kernel.decide(runId, { kind: 'abort', reason })
    return { runId, state: 'aborted', reason }
  }

  private sessionId(): string { return scopedSessionId(this.options.sessionId, 'plugin-evolution') }
  private kernel(): BuilderKernel { return new BuilderKernel(this.options.root, this.sessionId()) }
  private paths(runId: string) { return builderRunPaths(this.options.root, this.sessionId(), runId) }
}
