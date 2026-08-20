import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BuilderKernel, builderRunPaths } from '../builder/kernel.js'
import { scopedSessionId } from '../protocol/index.js'
import { runMiniSwe, type MiniSweRuntimeOptions } from '../builder/mini-swe.js'
import type { ExpectedTrajectory } from '../types.js'
import { compileCompositionWorkspace, type CompositionWorkspacePlan } from '../composition/compiler.js'

/** A host-selected plan. The external runtime never selects its compiler. */
export interface ConfigEvolutionPlan {
  capability: 'config-evolution'
  targetId: string
  before: Record<string, unknown>
  expectedTrajectory?: ExpectedTrajectory
}

export interface ModuleEvolutionPlan {
  capability: 'tool-evolution' | 'skill-evolution'
  targetId: string
  targetName?: string
  targetKind: 'tool' | 'skill'
  entry: string
  /** Host-owned verifier binding, never supplied by the execution runtime. */
  expectedTrajectory?: ExpectedTrajectory
}

export interface CompositionEvolutionPlan extends CompositionWorkspacePlan {
  capability: 'actor-composition'
}

export interface ActorEvolutionGatewayOptions {
  root: string
  sessionId: string
  model: string
  miniSwe: Omit<MiniSweRuntimeOptions, 'model' | 'baselineRoot' | 'dependencySnapshot'>
}

export interface ActorEvolutionResult {
  runId: string
  state: 'submitted' | 'aborted'
  proposal?: Record<string, unknown>
  reason?: string
}

/**
 * Generic actor execution ingress. v1 implements config-evolution only; its
 * output is deliberately the existing patch-evolution envelope, so Validator
 * and Gate remain the sole acceptance path rather than a second subsystem.
 */
export class ActorEvolutionGateway {
  constructor(private readonly options: ActorEvolutionGatewayOptions) {}

  startConfig(requirements: string, plan: ConfigEvolutionPlan): { runId: string } {
    if (!plan.targetId) throw new Error('config evolution requires targetId')
    const kernel = this.kernel()
    const run = kernel.create({
      kind: 'patch',
      actor: { requirements },
      targetBefore: { targetId: plan.targetId, targetKind: 'config', ...(plan.expectedTrajectory ? { expectedTrajectory: plan.expectedTrajectory } : {}) },
    })
    const paths = this.paths(run.id)
    mkdirSync(paths.workspace, { recursive: true })
    // The runtime may edit this copy only. Identity is kept in target-before.
    kernel.decide(run.id, { kind: 'tool', action: { name: 'write_workspace_file', path: 'actor-config.json', content: JSON.stringify(plan.before, null, 2) } })
    kernel.captureWorkspaceBaseline(run.id, 'actor-config.json')
    if (requirements.trim()) kernel.receiveActorMessage(run.id, { rawUserText: requirements, idempotencyKey: `initial:${run.id}` })
    return { runId: run.id }
  }

  async runConfig(runId: string): Promise<ActorEvolutionResult> {
    const kernel = this.kernel()
    const context = kernel.context(runId)
    if (context.run.kind !== 'patch' || context.input.targetBefore.targetKind !== 'config') throw new Error('run is not a config evolution pass')
    const requirements = typeof context.input.actor.requirements === 'string' ? context.input.actor.requirements : ''
    const execution = await runMiniSwe({
      ...this.options.miniSwe,
      model: this.options.model,
      workspace: this.paths(runId).workspace,
      trajectoryPath: join(this.paths(runId).base, 'mini-swe-agent-trajectory.json'),
      task: [
        'You are the Builder execution runtime. Work only in the supplied workspace.',
        `Actor request: ${requirements.slice(0, 12_000)}`,
        `Actor inbox: ${JSON.stringify(context.messages.map((message) => ({ id: message.id, rawUserText: message.rawUserText, actorMemo: message.actorMemo }))).slice(0, 12_000)}`,
        'Edit actor-config.json only. Do not edit verifier, gate, live profiles, or files outside the workspace.',
        'When the config change is tested, submit using the runtime completion command. Loom will independently compile, validate and gate it.',
      ].join('\n'),
    })
    if (!execution.submitted) {
      const reason = execution.error ?? 'mini-SWE did not submit a completed trajectory'
      kernel.decide(runId, { kind: 'abort', reason })
      return { runId, state: 'aborted', reason }
    }
    try {
      for (const message of context.messages) {
        kernel.decide(runId, { kind: 'tool', action: {
          name: 'acknowledge_message', messageId: message.id, status: 'accepted',
          understanding: 'The mini-SWE execution runtime received this Actor message in its immutable task input and completed a config workspace candidate.',
          nextAction: 'Freeze the runtime config diff for independent validation.',
        } })
      }
      kernel.decide(runId, { kind: 'tool', action: { name: 'compile_config_submission', rationale: 'mini-SWE submitted a completed config workspace candidate; Loom captured the isolated before/after diff' } })
      kernel.decide(runId, { kind: 'submit' })
      return { runId, state: 'submitted', proposal: kernel.proposal(runId) ?? undefined }
    } catch (caught) {
      const reason = `mini-SWE config submission compilation failed: ${String(caught)}`
      kernel.decide(runId, { kind: 'abort', reason })
      return { runId, state: 'aborted', reason }
    }
  }

  startModule(requirements: string, plan: ModuleEvolutionPlan): { runId: string } {
    if (!plan.targetId || !plan.entry) throw new Error('module evolution requires targetId and entry')
    const kernel = this.kernel()
    const run = kernel.create({
      kind: 'patch', actor: { requirements },
      targetBefore: {
        targetId: plan.targetId,
        targetKind: plan.targetKind,
        ...(plan.targetName ? { targetName: plan.targetName } : {}),
        moduleEntry: plan.entry,
        ...(plan.expectedTrajectory ? { expectedTrajectory: plan.expectedTrajectory } : {}),
      },
    })
    mkdirSync(join(this.paths(run.id).workspace, 'actor-module'), { recursive: true })
    if (requirements.trim()) kernel.receiveActorMessage(run.id, { rawUserText: requirements, idempotencyKey: `initial:${run.id}` })
    return { runId: run.id }
  }

  async runModule(runId: string): Promise<ActorEvolutionResult> {
    const kernel = this.kernel()
    const context = kernel.context(runId)
    const target = context.input.targetBefore
    if (context.run.kind !== 'patch' || (target.targetKind !== 'tool' && target.targetKind !== 'skill')) throw new Error('run is not a module evolution pass')
    const requirements = typeof context.input.actor.requirements === 'string' ? context.input.actor.requirements : ''
    const execution = await runMiniSwe({
      ...this.options.miniSwe, model: this.options.model, workspace: this.paths(runId).workspace,
      trajectoryPath: join(this.paths(runId).base, 'mini-swe-agent-trajectory.json'),
      task: [
        'You are the Builder execution runtime. Work only in the supplied workspace.',
        `Actor request: ${requirements.slice(0, 12_000)}`,
        `Actor inbox: ${JSON.stringify(context.messages.map((message) => ({ id: message.id, rawUserText: message.rawUserText, actorMemo: message.actorMemo }))).slice(0, 12_000)}`,
        `Create only the module bundle under actor-module/. Its required entry is ${String(target.moduleEntry)}. Do not edit verifier, gate, live profiles, or files outside the workspace.`,
        'When the module is tested, submit using the runtime completion command. Loom will independently compile, validate and gate it.',
      ].join('\n'),
    })
    if (!execution.submitted) return this.abort(kernel, runId, execution.error ?? 'mini-SWE did not submit a completed trajectory')
    try {
      this.acknowledgeRuntimeInbox(kernel, runId, context.messages, 'module')
      kernel.decide(runId, { kind: 'tool', action: { name: 'compile_module_submission', rationale: 'mini-SWE submitted a completed module workspace candidate; Loom captured the isolated bundle' } })
      kernel.decide(runId, { kind: 'submit' })
      return { runId, state: 'submitted', proposal: kernel.proposal(runId) ?? undefined }
    } catch (caught) {
      return this.abort(kernel, runId, `mini-SWE module submission compilation failed: ${String(caught)}`)
    }
  }

  startComposition(requirements: string, plan: CompositionEvolutionPlan): { runId: string } {
    if (!plan.targets.length) throw new Error('composition evolution requires at least one host-selected target')
    const kernel = this.kernel()
    const run = kernel.create({ kind: 'patch', actor: { requirements }, targetBefore: { capability: plan.capability, compositionPlan: plan } })
    const workspace = this.paths(run.id).workspace
    for (const target of plan.targets) {
      const base = join(workspace, 'composition', target.id)
      if (target.targetKind === 'config') {
        if (!target.before) throw new Error(`composition config target ${target.id} requires before snapshot`)
        mkdirSync(base, { recursive: true })
        writeFileSync(join(base, 'config.json'), `${JSON.stringify(target.before, null, 2)}\n`, 'utf8')
      } else {
        mkdirSync(join(base, 'module'), { recursive: true })
      }
    }
    if (requirements.trim()) kernel.receiveActorMessage(run.id, { rawUserText: requirements, idempotencyKey: `initial:${run.id}` })
    return { runId: run.id }
  }

  async runComposition(runId: string): Promise<ActorEvolutionResult> {
    const kernel = this.kernel()
    const context = kernel.context(runId)
    const plan = context.input.targetBefore.compositionPlan
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('run is not a composition evolution pass')
    const compositionPlan = plan as CompositionWorkspacePlan
    const requirements = typeof context.input.actor.requirements === 'string' ? context.input.actor.requirements : ''
    const execution = await runMiniSwe({
      ...this.options.miniSwe, model: this.options.model, workspace: this.paths(runId).workspace,
      trajectoryPath: join(this.paths(runId).base, 'mini-swe-agent-trajectory.json'),
      task: [
        'You are the Builder execution runtime. Work only in the supplied workspace.',
        `Actor request: ${requirements.slice(0, 12_000)}`,
        `Actor inbox: ${JSON.stringify(context.messages.map((message) => ({ id: message.id, rawUserText: message.rawUserText, actorMemo: message.actorMemo }))).slice(0, 12_000)}`,
        'The host selected a composition graph. Edit only composition/<node>/config.json for config nodes or composition/<node>/module/ for tool/skill nodes.',
        'Do not add graph nodes, edit live profiles, verifier, gate, or files outside the workspace. Test the coupled change, then submit using the runtime completion command.',
      ].join('\n'),
    })
    if (!execution.submitted) return this.abort(kernel, runId, execution.error ?? 'mini-SWE did not submit a completed trajectory')
    try {
      this.acknowledgeRuntimeInbox(kernel, runId, context.messages, 'composition')
      const proposal = compileCompositionWorkspace(this.paths(runId).workspace, compositionPlan)
      kernel.decide(runId, { kind: 'tool', action: { name: 'write_submission', proposal: proposal as unknown as Record<string, unknown> } })
      kernel.decide(runId, { kind: 'submit' })
      return { runId, state: 'submitted', proposal: kernel.proposal(runId) ?? undefined }
    } catch (caught) {
      return this.abort(kernel, runId, `mini-SWE composition submission compilation failed: ${String(caught)}`)
    }
  }

  /**
   * A verifier/gate rejection never resumes a mutable workspace.  It creates
   * a new immutable run with the full report and rematerializes only the
   * host-owned baseline shape required by the selected capability.
   */
  reopen(runId: string, report: Record<string, unknown>): { runId: string } {
    const kernel = this.kernel()
    const prior = kernel.context(runId)
    if (prior.run.state !== 'submitted') throw new Error(`only submitted actor evolution runs may be reopened: ${prior.run.state}`)
    const next = kernel.reopenFromRejection(runId, report)
    const target = prior.input.targetBefore
    const nextPaths = this.paths(next.id)
    if (target.targetKind === 'config') {
      const priorBaseline = join(this.paths(runId).workspaceBaseline, 'actor-config.json')
      if (!priorBaseline) throw new Error('config reopen requires prior captured baseline')
      const content = readFileSync(priorBaseline, 'utf8')
      kernel.decide(next.id, { kind: 'tool', action: { name: 'write_workspace_file', path: 'actor-config.json', content } })
      kernel.captureWorkspaceBaseline(next.id, 'actor-config.json')
    } else if (target.targetKind === 'tool' || target.targetKind === 'skill') {
      mkdirSync(join(nextPaths.workspace, 'actor-module'), { recursive: true })
    } else {
      throw new Error(`actor evolution reopen has unsupported target kind: ${String(target.targetKind)}`)
    }
    for (const message of prior.messages) {
      kernel.receiveActorMessage(next.id, {
        rawUserText: message.rawUserText,
        ...(message.actorMemo ? { actorMemo: message.actorMemo } : {}),
        ...(message.evidenceRefs ? { evidenceRefs: message.evidenceRefs } : {}),
        ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
      })
    }
    return { runId: next.id }
  }

  private abort(kernel: BuilderKernel, runId: string, reason: string): ActorEvolutionResult {
    kernel.decide(runId, { kind: 'abort', reason })
    return { runId, state: 'aborted', reason }
  }

  private acknowledgeRuntimeInbox(kernel: BuilderKernel, runId: string, messages: ReturnType<BuilderKernel['context']>['messages'], subject: string): void {
    for (const message of messages) kernel.decide(runId, { kind: 'tool', action: {
      name: 'acknowledge_message', messageId: message.id, status: 'accepted',
      understanding: `The mini-SWE execution runtime received this Actor message in its immutable task input and completed a ${subject} workspace candidate.`,
      nextAction: `Freeze the runtime ${subject} artifact for independent validation.`,
    } })
  }

  private builderSessionId(): string { return scopedSessionId(this.options.sessionId, 'actor-evolution') }
  private kernel(): BuilderKernel { return new BuilderKernel(this.options.root, this.builderSessionId()) }
  private paths(runId: string) { return builderRunPaths(this.options.root, this.builderSessionId(), runId) }
}
