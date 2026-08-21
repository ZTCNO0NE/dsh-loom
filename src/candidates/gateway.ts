import { join } from 'node:path'
import { CandidateRegistry } from './index.js'
import type { LlmStreamLike } from '../meta/propose.js'
import { atomicWriteJson, scopedSessionId, sha256 } from '../protocol/index.js'
import { BuilderDriver } from '../builder/driver.js'
import { BuilderKernel, builderRunPaths, type BuilderEvent, type BuilderJournalEntry, type BuilderKernelOptions, type BuilderMessageInput, type BuilderProgressState, type BuilderRunMode, type BuilderRunState } from '../builder/kernel.js'
import { BuilderCapabilityRuntimeRegistry, LOOP_EVOLUTION_CAPABILITY, WORKSPACE_SIMULATION_CAPABILITY } from '../builder/capabilities.js'
import { createWorkspaceSimulationRuntime } from '../builder/simulation.js'
import { materializeMiniSweWorkspace, miniSweBaselineCommit, runMiniSwe, type MiniSweRuntimeOptions } from '../builder/mini-swe.js'

export interface LoopCandidateGatewayOptions {
  enabled: boolean
  root: string
  sessionId: string
  llm?: LlmStreamLike
  provider: string
  model: string
  maxTokens: number
  buildDependencyRoot?: string
  builderMaxModelTurns?: number
  builderMaxToolSteps?: number
  builderMaxWallTimeMs?: number
  /** Broad user requests begin with an evidence-backed direction-selection pass. */
  diagnosisFirst?: boolean
  /** Generic Actor direction diagnosis across config/skill/loop; no loop-first bias. */
  directionDiagnosis?: boolean
  /** Optional no-progress experiment; omitted keeps free exploration unchanged. */
  builderKernelOptions?: BuilderKernelOptions
  onUsage?: (usage: { prompt: number; completion: number }) => void
  capabilityRuntimes?: BuilderCapabilityRuntimeRegistry
  /**
   * v1.2 implementation runtime. Loom-native remains available only for
   * durable diagnosis/clarification when a run is explicitly in diagnosis
   * mode; it is not the production complex-source implementation path.
   */
  executionRuntime?: 'loom-native' | 'mini-swe'
  miniSwe?: Omit<MiniSweRuntimeOptions, 'model'>
}

export interface LoopExplorationResult {
  accepted: boolean
  mode: 'exploration'
  runId: string
  passMode: BuilderRunMode
  state: 'submitted' | 'aborted' | 'paused' | 'cancelled' | 'waiting_for_input'
  proposal?: Record<string, unknown>
  modelTurns: number
  toolSteps: number
  reason?: string
}

/** Returned immediately to an actor that delegates an exploration. */
export type LoopExplorationStart =
  | { accepted: true; mode: 'exploration'; runId: string; state: 'created'; passMode: BuilderRunMode }
  | { accepted: false; mode: 'exploration'; state: 'disabled'; reason: string }

/** A bounded projection of durable Builder state suitable for actor tools. */
export interface LoopExplorationStatus {
  runId: string
  lineageId: string
  state: BuilderRunState
  passMode: BuilderRunMode
  modelTurns: number
  toolSteps: number
  inboxMessages: number
  pendingMessageIds: string[]
  progressState: BuilderProgressState
  proposal: { available: boolean; hash?: string; keys?: string[] }
  diagnosisReport: {
    available: boolean
    hash?: string
    directions?: Array<{ id?: string; goal?: string; layer?: 'config' | 'skill' | 'loop' | 'no_change'; evidenceRefs?: string[]; unknowns?: string[]; cost?: string }>
    question?: { question?: string; whyNow?: string; options?: Array<{ id?: string; label?: string; description?: string }>; evidenceRefs?: string[] }
  }
  journalTail: Array<{ seq: number; at: string; kind: string; action: string; result?: Record<string, unknown>; error?: string }>
  eventTail: Array<{ seq: number; at: string; kind: string; payload: Record<string, unknown> }>
}

function summarizeEvent(event: BuilderEvent): { seq: number; at: string; kind: string; lineageId: string; runId: string; payload: Record<string, unknown> } {
  return {
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    lineageId: event.lineageId,
    runId: event.runId,
    payload: JSON.parse(JSON.stringify(event.payload, (_key, value) => typeof value === 'string' && value.length > 2_000 ? `${value.slice(0, 2_000)}…[truncated]` : value)) as Record<string, unknown>,
  }
}

function summarizeJournal(entry: BuilderJournalEntry): { seq: number; at: string; kind: string; action: string; result?: Record<string, unknown>; error?: string } {
  const result = entry.result === undefined ? undefined : JSON.parse(JSON.stringify(entry.result, (_key, value) => {
    if (typeof value === 'string' && value.length > 2_000) return `${value.slice(0, 2_000)}…[truncated]`
    return value
  })) as Record<string, unknown>
  return {
    seq: entry.seq,
    at: entry.at,
    kind: entry.kind,
    action: entry.action,
    ...(result ? { result } : {}),
    ...(entry.error ? { error: entry.error.slice(0, 2_000) } : {}),
  }
}

function summarizeDiagnosis(report: Record<string, unknown>): {
  directions: Array<{ id?: string; goal?: string; layer?: 'config' | 'skill' | 'loop' | 'no_change'; evidenceRefs?: string[]; unknowns?: string[]; cost?: string }>
  question?: { question?: string; whyNow?: string; options?: Array<{ id?: string; label?: string; description?: string }>; evidenceRefs?: string[] }
} {
  const directions = Array.isArray(report.directions) ? report.directions.slice(0, 3).flatMap((direction) => {
    if (!direction || typeof direction !== 'object' || Array.isArray(direction)) return []
    const value = direction as Record<string, unknown>
    return [{
      ...(typeof value.id === 'string' ? { id: value.id.slice(0, 160) } : {}),
      ...(typeof value.goal === 'string' ? { goal: value.goal.slice(0, 1_000) } : {}),
      ...(value.layer === 'config' || value.layer === 'skill' || value.layer === 'loop' || value.layer === 'no_change' ? { layer: value.layer as 'config' | 'skill' | 'loop' | 'no_change' } : {}),
      ...(Array.isArray(value.evidenceRefs) ? { evidenceRefs: value.evidenceRefs.filter((ref): ref is string => typeof ref === 'string').slice(0, 12) } : {}),
      ...(Array.isArray(value.unknowns) ? { unknowns: value.unknowns.filter((item): item is string => typeof item === 'string').slice(0, 12) } : {}),
      ...(typeof value.cost === 'string' ? { cost: value.cost.slice(0, 120) } : {}),
    }]
  }) : []
  const rawQuestion = report.question
  const question = rawQuestion && typeof rawQuestion === 'object' && !Array.isArray(rawQuestion)
    ? (() => {
        const value = rawQuestion as Record<string, unknown>
        return {
          ...(typeof value.question === 'string' ? { question: value.question.slice(0, 2_000) } : {}),
          ...(typeof value.whyNow === 'string' ? { whyNow: value.whyNow.slice(0, 2_000) } : {}),
          ...(Array.isArray(value.options) ? { options: value.options.slice(0, 6).flatMap((option) => {
            if (!option || typeof option !== 'object' || Array.isArray(option)) return []
            const item = option as Record<string, unknown>
            return [{
              ...(typeof item.id === 'string' ? { id: item.id.slice(0, 160) } : {}),
              ...(typeof item.label === 'string' ? { label: item.label.slice(0, 500) } : {}),
              ...(typeof item.description === 'string' ? { description: item.description.slice(0, 1_000) } : {}),
            }]
          }) } : {}),
          ...(Array.isArray(value.evidenceRefs) ? { evidenceRefs: value.evidenceRefs.filter((ref): ref is string => typeof ref === 'string').slice(0, 12) } : {}),
        }
      })()
    : undefined
  return { directions, ...(question ? { question } : {}) }
}

/**
 * The sole loop-candidate ingress for meta.auto. Discovery uses the same
 * bounded BuilderKernel as patch design; after a frozen draft is submitted,
 * core (not the model) performs the allowlisted HTTPS acquisition into staging.
 * It has no transition API: verifier/gate own every later state.
 */
export class LoopCandidateGateway {
  private readonly runtimes: BuilderCapabilityRuntimeRegistry

  constructor(private readonly options: LoopCandidateGatewayOptions) {
    this.runtimes = options.capabilityRuntimes ?? new BuilderCapabilityRuntimeRegistry().register(createWorkspaceSimulationRuntime())
  }

  private kernel(): BuilderKernel {
    return new BuilderKernel(this.options.root, this.builderSessionId(), this.runtimes, this.options.builderKernelOptions)
  }

  private builderSessionId(): string { return scopedSessionId(this.options.sessionId, 'loop-exploration') }

  /** Create a durable run before it enters the background queue. */
  startExploration(requirements: string, context: Record<string, unknown> = {}): LoopExplorationStart {
    if (!this.options.enabled) return { accepted: false, mode: 'exploration', state: 'disabled', reason: 'allowLoopCandidates is disabled' }
    const llm = this.options.llm
    if (!llm) throw new Error('loop exploration: no independent builder llm available')
    const kernel = this.kernel()
    const resumeFromRunId = typeof context.resumeFromRunId === 'string' ? context.resumeFromRunId : undefined
    const previousRun = resumeFromRunId ? kernel.previousRunReference(resumeFromRunId) : undefined
    const priorMode = resumeFromRunId ? kernel.load(resumeFromRunId).mode : undefined
    const requestedMode = context.passMode === 'diagnosis' || context.passMode === 'implementation'
      ? context.passMode
      : undefined
    const passMode: BuilderRunMode = priorMode === 'diagnosis'
      ? 'implementation'
      : requestedMode ?? (this.options.diagnosisFirst ? 'diagnosis' : 'implementation')
    // A diagnosis is Loom-native by design; mini-SWE is only materialized for
    // the concrete implementation pass created after the actor/user selects a
    // direction. This keeps dialogue and coding separate without reviving the
    // old native JSON loop as an implementation executor.
    const mini = this.options.executionRuntime === 'mini-swe' && passMode === 'implementation' ? this.options.miniSwe : undefined
    if (this.options.executionRuntime === 'mini-swe' && passMode === 'implementation' && !mini) throw new Error('mini-SWE runtime is selected but not configured')
    if (mini && (!mini.executable || !mini.configPath || !mini.baselineRoot || !mini.dependencySnapshot || mini.stepLimit < 1 || mini.timeoutMs < 1)) {
      throw new Error('mini-SWE runtime requires executable, configPath, baselineRoot, dependencySnapshot, positive stepLimit, and positive timeoutMs')
    }
    const baselineCommit = mini ? miniSweBaselineCommit(mini.baselineRoot) : undefined
    const run = kernel.create({
      kind: 'loop_candidate',
      mode: passMode,
      actor: { requirements, context },
      targetBefore: { registry: this.status(), context, ...(baselineCommit ? { baselineCommit } : {}) },
      ...(previousRun ? {
        previousRun,
        lineageId: previousRun.lineageId,
        parentRunId: previousRun.runId,
        previousAttempt: {
          source: 'host-restart-resume',
          priorRunId: resumeFromRunId,
          observedAt: new Date().toISOString(),
          note: 'A host restart interrupted the prior attempt. Reuse or discard its read-only assets as you judge appropriate.',
        },
      } : {}),
    })
    if (mini && baselineCommit) this.materializeMiniWorkspace(kernel, run.id, mini, baselineCommit)
    // The initiating user request is a normal durable conversation message as
    // well as part of the immutable actor snapshot, so Builder can explicitly
    // acknowledge or question it on its first micro-turn.
    if (requirements.trim()) {
      const actorMemo = typeof context.actorAssessment === 'string' ? context.actorAssessment : undefined
      const evidencePack = context.evidencePack
      const evidenceRefs = evidencePack && typeof evidencePack === 'object' && !Array.isArray(evidencePack)
        && typeof (evidencePack as Record<string, unknown>).manifestPath === 'string'
        ? [(evidencePack as Record<string, unknown>).manifestPath as string]
        : undefined
      kernel.receiveActorMessage(run.id, {
        rawUserText: requirements,
        ...(actorMemo ? { actorMemo } : {}),
        ...(evidenceRefs ? { evidenceRefs } : {}),
        idempotencyKey: `initial:${run.id}`,
      })
    }
    return { accepted: true, mode: 'exploration', runId: run.id, state: 'created', passMode }
  }

  /**
   * Execute an already-created actor exploration. It deliberately stops after
   * Builder submit: no importer, registry transition, verifier, or gate runs.
   */
  async runExploration(runId: string): Promise<LoopExplorationResult> {
    if (!this.options.enabled) return { accepted: false, mode: 'exploration', runId, passMode: 'implementation', state: 'aborted', modelTurns: 0, toolSteps: 0, reason: 'allowLoopCandidates is disabled' }
    const llm = this.options.llm
    const kernel = this.kernel()
    const runContext = kernel.context(runId)
    const initial = runContext.input.actor
    const requirements = typeof initial.requirements === 'string' ? initial.requirements : ''
    const context = initial.context && typeof initial.context === 'object' && !Array.isArray(initial.context)
      ? initial.context as Record<string, unknown>
      : {}
    if (this.options.executionRuntime === 'mini-swe' && runContext.run.mode === 'implementation') {
      const mini = this.options.miniSwe
      if (!mini) throw new Error('mini-SWE runtime is selected but not configured')
      const paths = builderRunPaths(this.options.root, this.builderSessionId(), runId)
      const execution = await runMiniSwe({
        ...mini,
        model: this.options.model,
        workspace: paths.workspace,
        trajectoryPath: join(paths.base, 'mini-swe-agent-trajectory.json'),
        task: [
          'You are the Builder execution runtime. Work only in the supplied workspace.',
          `Actor request: ${requirements.slice(0, 12_000)}`,
          `Actor inbox (each item must be considered before completion): ${JSON.stringify(runContext.messages.map((message) => ({ id: message.id, rawUserText: message.rawUserText, actorMemo: message.actorMemo }))).slice(0, 12_000)}`,
          `Context: ${JSON.stringify(context).slice(0, 12_000)}`,
          'You may inspect, edit, and run relevant tests freely. Change only packages/core/agent-loop/src/**/*.ts. Do not modify tests, verifier, gate, or live profiles.',
          'When you have a tested candidate, submit using the runtime completion command. Loom will independently compile, verify, and gate the resulting workspace diff.',
        ].join('\n'),
      })
      if (!execution.submitted) {
        kernel.decide(runId, { kind: 'abort', reason: execution.error ?? 'mini-SWE did not submit a completed trajectory' })
        const result: LoopExplorationResult = { accepted: false, mode: 'exploration', runId, passMode: runContext.run.mode, state: 'aborted', modelTurns: execution.modelTurns, toolSteps: execution.toolSteps, reason: execution.error ?? 'mini-SWE did not submit' }
        this.persist(result)
        return result
      }
      try {
        // mini-SWE has a durable external trajectory rather than per-message
        // Kernel tool calls. Its completed trajectory proves it received the
        // task/inbox embedded above; record that factual receipt before the
        // normal Kernel submission invariant is checked.
        for (const message of runContext.messages) {
          kernel.decide(runId, {
            kind: 'tool',
            action: {
              name: 'acknowledge_message',
              messageId: message.id,
              status: 'accepted',
              understanding: 'The mini-SWE execution runtime received this Actor message in its immutable task input and completed a workspace candidate.',
              nextAction: 'Freeze the runtime workspace diff for independent verification.',
            },
          })
        }
        kernel.decide(runId, { kind: 'tool', action: { name: 'compile_loop_submission', rationale: 'mini-SWE submitted a completed workspace candidate; Loom captured and compiled its immutable diff' } })
        kernel.decide(runId, { kind: 'submit' })
      } catch (caught) {
        kernel.decide(runId, { kind: 'abort', reason: `mini-SWE submission compilation failed: ${String(caught)}` })
        const result: LoopExplorationResult = { accepted: false, mode: 'exploration', runId, passMode: runContext.run.mode, state: 'aborted', modelTurns: execution.modelTurns, toolSteps: execution.toolSteps, reason: String(caught) }
        this.persist(result)
        return result
      }
      const proposal = kernel.proposal(runId) ?? undefined
      const result: LoopExplorationResult = { accepted: Boolean(proposal), mode: 'exploration', runId, passMode: runContext.run.mode, state: 'submitted', ...(proposal ? { proposal } : {}), modelTurns: execution.modelTurns, toolSteps: execution.toolSteps }
      this.persist(result)
      return result
    }
    if (!llm) throw new Error('loop exploration: no independent builder llm available')
    const directionDiagnosis = runContext.run.mode === 'diagnosis' && this.options.directionDiagnosis === true
    const outcome = await new BuilderDriver({
      llm,
      provider: this.options.provider,
      model: this.options.model,
      systemPrompt: directionDiagnosis
        ? 'You are the Actor’s independent direction-diagnosis Builder. Read the frozen user/Actor evidence and relevant source facts, distinguish symptoms from causes, and propose 1–3 routes across config, skill, loop, or no-change. Actor translates your report and the user owns the choice. This pass is read-only: do not edit, execute commands, simulate, submit, verify, install, or claim improvement.'
        : 'You are the free exploratory loop-evolution Builder and an external improvement partner for the Actor. Based on real actor/user evidence, identify the most valuable concrete problem affecting user experience, task success, or safety; form a falsifiable hypothesis; use workspace evidence/simulation when useful; ask the Actor/user when a product tradeoff cannot be inferred; and submit a verifiable candidate when evidence is sufficient. Do not modify or install any live target.',
      taskContext: [
        'This run was actively requested through the actor, not passively scheduled.',
        `User request relayed by actor: ${requirements.slice(0, 12_000)}`,
        `Actor/runtime context: ${JSON.stringify(context).slice(0, 16_000)}`,
        directionDiagnosis
          ? 'For every direction include layer=config|skill|loop|no_change, a concrete goal, evidenceRefs, unknowns, and cost. Prefer the smallest layer that explains the evidence; do not avoid loop when the evidence is structural, and do not choose loop merely because the request is vague.'
          : 'You may choose a small edit, a complete replacement, or a new foundation. Use your tools and actual feedback; do not follow a prescribed strategy.',
        runContext.run.mode === 'diagnosis'
          ? 'This is the direction-selection pass. Completion means a durable diagnosis-report with 1-3 evidence-backed directions and a blocking user choice. Do not submit a proposal in this pass.'
          : 'Completion means a concrete problem, a falsifiable hypothesis, evidence or simulation, and either a frozen write_submission→submit, a blocking choice question, or an evidence-backed abort.',
      ].join('\n'),
      draftKind: 'loop_candidate',
      capabilities: directionDiagnosis ? [] : [LOOP_EVOLUTION_CAPABILITY, WORKSPACE_SIMULATION_CAPABILITY],
      readOnlyDiagnosis: directionDiagnosis,
      maxModelTurns: this.options.builderMaxModelTurns ?? 24,
      maxToolSteps: this.options.builderMaxToolSteps ?? 48,
      maxWallTimeMs: this.options.builderMaxWallTimeMs ?? 600_000,
      maxTokens: this.options.maxTokens,
      onUsage: this.options.onUsage,
    }).run(kernel, runId)
    const result: LoopExplorationResult = {
      accepted: outcome.state === 'submitted',
      mode: 'exploration',
      runId,
      passMode: kernel.load(runId).mode,
      state: outcome.state,
      ...(outcome.proposal ? { proposal: outcome.proposal } : {}),
      modelTurns: outcome.modelTurns,
      toolSteps: outcome.toolSteps,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    }
    this.persist(result)
    return result
  }

  /** Compatibility helper for callers that intentionally want to wait. */
  async explore(requirements: string, context: Record<string, unknown> = {}): Promise<LoopExplorationResult> {
    const started = this.startExploration(requirements, context)
    if (!started.accepted) return { accepted: false, mode: 'exploration', runId: '', passMode: 'implementation', state: 'aborted', modelTurns: 0, toolSteps: 0, reason: started.reason }
    return this.runExploration(started.runId)
  }

  explorationStatus(runId: string): LoopExplorationStatus {
    const kernel = this.kernel()
    const context = kernel.context(runId)
    const proposal = kernel.proposal(runId)
    const journal = context.journal
    const acknowledged = new Set(context.events
      .filter((event) => event.kind === 'message_ack' && typeof event.payload.messageId === 'string')
      .map((event) => event.payload.messageId as string))
    return {
      runId,
      lineageId: context.run.lineageId,
      state: context.run.state,
      passMode: context.run.mode,
      modelTurns: journal.filter((entry) => entry.kind === 'model' && entry.action === 'decision').length,
      toolSteps: journal.filter((entry) => entry.kind === 'tool').length,
      inboxMessages: context.messages.length,
      pendingMessageIds: context.messages.filter((message) => !acknowledged.has(message.id)).map((message) => message.id),
      progressState: context.progressState,
      proposal: proposal
        ? { available: true, hash: sha256(proposal), keys: Object.keys(proposal).slice(0, 20) }
        : { available: false },
      diagnosisReport: context.diagnosisReport
        ? { available: true, hash: sha256(context.diagnosisReport), ...summarizeDiagnosis(context.diagnosisReport) }
        : { available: false },
      journalTail: journal.slice(-12).map((entry) => summarizeJournal(entry)),
      eventTail: context.events.slice(-12).map((event) => summarizeEvent(event)),
    }
  }

  events(runId: string, cursor: { lineageId?: string; runId?: string; seq?: number } = {}, limit = 50): {
    runId: string
    lineageId: string
    events: Array<{ seq: number; at: string; kind: string; lineageId: string; runId: string; payload: Record<string, unknown> }>
    cursor: string
    reset: boolean
  } {
    const kernel = this.kernel()
    const run = kernel.load(runId)
    const reset = Boolean(cursor.runId && (cursor.runId !== runId || cursor.lineageId !== run.lineageId))
    const afterSeq = reset ? 0 : Math.max(0, cursor.seq ?? 0)
    const events = kernel.events(runId, afterSeq, limit).map((event) => summarizeEvent(event))
    const nextSeq = events.at(-1)?.seq ?? afterSeq
    return { runId, lineageId: run.lineageId, events, cursor: `${run.lineageId}:${runId}:${nextSeq}`, reset }
  }

  messageExploration(runId: string, input: string | BuilderMessageInput): { accepted: true; runId: string; messageId: string; deduplicated: boolean; state: BuilderRunState; queuedAt: string } {
    const rawUserText = typeof input === 'string' ? input : input.rawUserText
    const normalized = rawUserText.trim()
    if (!normalized) throw new Error('builder message must not be empty')
    if (normalized.length > 12_000) throw new Error('builder message exceeds 12000 characters')
    if (typeof input !== 'string' && input.actorMemo !== undefined && input.actorMemo.length > 12_000) throw new Error('builder actor memo exceeds 12000 characters')
    if (typeof input !== 'string' && (input.evidenceRefs?.some((ref) => ref.length > 4_000) ?? false)) throw new Error('builder evidence reference exceeds 4000 characters')
    if (typeof input !== 'string' && input.idempotencyKey !== undefined && (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200)) throw new Error('builder idempotency key must be 1-200 characters')
    const kernel = this.kernel()
    const message = kernel.receiveActorMessage(runId, typeof input === 'string' ? normalized : { ...input, rawUserText: normalized })
    return { accepted: true, runId, messageId: message.id, deduplicated: message.deduplicated === true, state: kernel.load(runId).state, queuedAt: message.at }
  }

  /** Pause/cancel are deterministic kernel transitions; resume is a new run. */
  controlExploration(runId: string, action: 'pause' | 'cancel'): { runId: string; lineageId: string; state: BuilderRunState } {
    const kernel = this.kernel()
    const run = kernel.control(runId, action)
    return { runId, lineageId: run.lineageId, state: run.state }
  }

  /**
   * Never replays a possibly in-flight command. The new attempt inherits the
   * old assets by hash and copies prior actor messages for independent review.
   */
  resumeExploration(runId: string): LoopExplorationStart {
    const kernel = this.kernel()
    const prior = kernel.context(runId)
    if (!['paused', 'waiting_for_input', 'cancelled'].includes(prior.run.state)) {
      throw new Error(`only paused, waiting_for_input, or cancelled runs may resume: ${prior.run.state}`)
    }
    const requirements = typeof prior.input.actor.requirements === 'string' ? prior.input.actor.requirements : ''
    const context = prior.input.actor.context && typeof prior.input.actor.context === 'object' && !Array.isArray(prior.input.actor.context)
      ? prior.input.actor.context as Record<string, unknown>
      : {}
    const started = this.startExploration(requirements, { ...context, resumeFromRunId: runId })
    if (!started.accepted) return started
    for (const message of prior.messages) {
      if (message.idempotencyKey?.startsWith('initial:')) continue
      kernel.receiveActorMessage(started.runId, {
        rawUserText: message.rawUserText,
        ...(message.actorMemo ? { actorMemo: message.actorMemo } : {}),
        ...(message.evidenceRefs ? { evidenceRefs: message.evidenceRefs } : {}),
        ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
      })
    }
    return started
  }

  /**
   * Verifier/gate rejection reopens an immutable Builder run with the report
   * as previous-attempt input; the actor inbox carries over so follow-up
   * observations remain visible to the next attempt.
   */
  reopenExploration(runId: string, report: Record<string, unknown>): string {
    const kernel = this.kernel()
    if (kernel.load(runId).state !== 'submitted') {
      throw new Error(`only submitted builder runs may be reopened: ${kernel.load(runId).state}`)
    }
    const messages = kernel.context(runId).messages
    const next = kernel.reopenFromRejection(runId, report)
    if (this.options.executionRuntime === 'mini-swe') {
      const mini = this.options.miniSwe
      if (!mini) throw new Error('mini-SWE runtime is selected but not configured')
      const target = kernel.context(next.id).input.targetBefore
      const baselineCommit = typeof target.baselineCommit === 'string' ? target.baselineCommit : miniSweBaselineCommit(mini.baselineRoot)
      this.materializeMiniWorkspace(kernel, next.id, mini, baselineCommit)
    }
    for (const message of messages) {
      kernel.receiveActorMessage(next.id, {
        rawUserText: message.rawUserText,
        ...(message.actorMemo ? { actorMemo: message.actorMemo } : {}),
        ...(message.evidenceRefs ? { evidenceRefs: message.evidenceRefs } : {}),
        ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
      })
    }
    return next.id
  }

  private materializeMiniWorkspace(kernel: BuilderKernel, runId: string, mini: Omit<MiniSweRuntimeOptions, 'model'>, baselineCommit: string): void {
    const paths = builderRunPaths(this.options.root, this.builderSessionId(), runId)
    materializeMiniSweWorkspace({
      baselineRoot: mini.baselineRoot,
      dependencySnapshot: mini.dependencySnapshot,
      commit: baselineCommit,
      workspace: paths.workspace,
    })
    kernel.captureWorkspaceBaseline(runId)
  }

  status(): ReturnType<CandidateRegistry['list']> {
    return new CandidateRegistry(this.options.root).list()
  }
  private persist(outcome: LoopExplorationResult): void {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    atomicWriteJson(join(this.options.root, 'workspace', this.options.sessionId, 'loop-candidates', `${stamp}.json`), {
      schemaVersion: 1,
      at: new Date().toISOString(),
      outcome,
    })
  }
}
