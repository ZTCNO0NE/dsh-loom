import { join } from 'node:path'
import { CandidateRegistry } from './index.js'
import type { LlmStreamLike } from '../meta/propose.js'
import { atomicWriteJson, sha256 } from '../protocol/index.js'
import { BuilderDriver } from '../builder/driver.js'
import { BuilderKernel, type BuilderJournalEntry, type BuilderRunState } from '../builder/kernel.js'
import { LOOP_EVOLUTION_CAPABILITY } from '../builder/capabilities.js'

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
  onUsage?: (usage: { prompt: number; completion: number }) => void
}

export interface LoopExplorationResult {
  accepted: boolean
  mode: 'exploration'
  runId: string
  state: 'submitted' | 'aborted'
  proposal?: Record<string, unknown>
  modelTurns: number
  toolSteps: number
  reason?: string
}

/** Returned immediately to an actor that delegates an exploration. */
export type LoopExplorationStart =
  | { accepted: true; mode: 'exploration'; runId: string; state: 'created' }
  | { accepted: false; mode: 'exploration'; state: 'disabled'; reason: string }

/** A bounded projection of durable Builder state suitable for actor tools. */
export interface LoopExplorationStatus {
  runId: string
  state: BuilderRunState
  modelTurns: number
  toolSteps: number
  inboxMessages: number
  proposal: { available: boolean; hash?: string; keys?: string[] }
  journalTail: Array<{ seq: number; at: string; kind: string; action: string; result?: Record<string, unknown>; error?: string }>
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

/**
 * The sole loop-candidate ingress for meta.auto. Discovery uses the same
 * bounded BuilderKernel as patch design; after a frozen draft is submitted,
 * core (not the model) performs the allowlisted HTTPS acquisition into staging.
 * It has no transition API: verifier/gate own every later state.
 */
export class LoopCandidateGateway {
  constructor(private readonly options: LoopCandidateGatewayOptions) {}

  /** Create a durable run before it enters the background queue. */
  startExploration(requirements: string, context: Record<string, unknown> = {}): LoopExplorationStart {
    if (!this.options.enabled) return { accepted: false, mode: 'exploration', state: 'disabled', reason: 'allowLoopCandidates is disabled' }
    const llm = this.options.llm
    if (!llm) throw new Error('loop exploration: no independent builder llm available')
    const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`)
    const run = kernel.create({
      kind: 'loop_candidate',
      actor: { requirements, context },
      targetBefore: { registry: this.status(), context },
    })
    return { accepted: true, mode: 'exploration', runId: run.id, state: 'created' }
  }

  /**
   * Execute an already-created actor exploration. It deliberately stops after
   * Builder submit: no importer, registry transition, verifier, or gate runs.
   */
  async runExploration(runId: string): Promise<LoopExplorationResult> {
    if (!this.options.enabled) return { accepted: false, mode: 'exploration', runId, state: 'aborted', modelTurns: 0, toolSteps: 0, reason: 'allowLoopCandidates is disabled' }
    const llm = this.options.llm
    if (!llm) throw new Error('loop exploration: no independent builder llm available')
    const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`)
    const initial = kernel.context(runId).input.actor
    const requirements = typeof initial.requirements === 'string' ? initial.requirements : ''
    const context = initial.context && typeof initial.context === 'object' && !Array.isArray(initial.context)
      ? initial.context as Record<string, unknown>
      : {}
    const outcome = await new BuilderDriver({
      llm,
      provider: this.options.provider,
      model: this.options.model,
      systemPrompt: 'You are the free exploratory loop-evolution Builder. The actor has just relayed a user request. Explore the current loop, rebuild or replace it if useful, run real feedback commands, and submit what you learned. Do not install anything.',
      taskContext: [
        'This run was actively requested through the actor, not passively scheduled.',
        `User request relayed by actor: ${requirements.slice(0, 12_000)}`,
        `Actor/runtime context: ${JSON.stringify(context).slice(0, 16_000)}`,
        'You may choose a small edit, a complete replacement, or a new foundation. Use your tools and actual feedback; do not follow a prescribed strategy.',
        'At the end write_submission with your candidate path, tests, observations, and rationale, then submit.',
      ].join('\n'),
      draftKind: 'loop_candidate',
      capabilities: [LOOP_EVOLUTION_CAPABILITY],
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
    if (!started.accepted) return { accepted: false, mode: 'exploration', runId: '', state: 'aborted', modelTurns: 0, toolSteps: 0, reason: started.reason }
    return this.runExploration(started.runId)
  }

  explorationStatus(runId: string): LoopExplorationStatus {
    const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`)
    const context = kernel.context(runId)
    const proposal = kernel.proposal(runId)
    const journal = context.journal
    return {
      runId,
      state: context.run.state,
      modelTurns: journal.filter((entry) => entry.kind === 'model' && entry.action === 'decision').length,
      toolSteps: journal.filter((entry) => entry.kind === 'tool').length,
      inboxMessages: context.messages.length,
      proposal: proposal
        ? { available: true, hash: sha256(proposal), keys: Object.keys(proposal).slice(0, 20) }
        : { available: false },
      journalTail: journal.slice(-12).map((entry) => summarizeJournal(entry)),
    }
  }

  messageExploration(runId: string, text: string): { accepted: true; runId: string; state: BuilderRunState; queuedAt: string } {
    const normalized = text.trim()
    if (!normalized) throw new Error('builder message must not be empty')
    if (normalized.length > 12_000) throw new Error('builder message exceeds 12000 characters')
    const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`)
    const message = kernel.receiveActorMessage(runId, normalized)
    return { accepted: true, runId, state: kernel.load(runId).state, queuedAt: message.at }
  }

  /**
   * Verifier/gate rejection reopens an immutable Builder run with the report
   * as previous-attempt input; the actor inbox carries over so follow-up
   * observations remain visible to the next attempt.
   */
  reopenExploration(runId: string, report: Record<string, unknown>): string {
    const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`)
    if (kernel.load(runId).state !== 'submitted') {
      throw new Error(`only submitted builder runs may be reopened: ${kernel.load(runId).state}`)
    }
    const messages = kernel.context(runId).messages
    const next = kernel.reopenFromRejection(runId, report)
    for (const message of messages) kernel.receiveActorMessage(next.id, message.text)
    return next.id
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
