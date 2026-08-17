import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendJsonl, atomicWriteJson, readJson, readJsonl, sha256, workspaceDir } from '../protocol/index.js'

export type BuilderRunState = 'created' | 'exploring' | 'preflighting' | 'ready_to_submit' | 'submitted' | 'aborted'
export type BuilderRunKind = 'patch' | 'loop_candidate'
export type BuilderJournalKind = 'model' | 'tool' | 'error' | 'snapshot' | 'state'

export interface BuilderRunInput {
  kind?: BuilderRunKind
  actor: Record<string, unknown>
  targetBefore: Record<string, unknown>
  previousAttempt?: Record<string, unknown>
}

export interface BuilderJournalEntry {
  schemaVersion: 1
  seq: number
  kind: BuilderJournalKind
  at: string
  action: string
  inputHash: string
  result?: Record<string, unknown>
  error?: string
}

export interface BuilderRunRecord {
  schemaVersion: 1
  id: string
  kind: BuilderRunKind
  state: BuilderRunState
  createdAt: string
  updatedAt: string
  inputHash: string
}

export type BuilderDecision =
  | { kind: 'continue'; summary: string }
  | { kind: 'tool'; action: BuilderToolAction }
  /** Freeze the already-preflighted draft; no model-supplied payload is accepted here. */
  | { kind: 'submit' }
  | { kind: 'abort'; reason: string }

export type BuilderToolAction =
  | { name: 'read_input'; document: 'actor' | 'target_before' | 'previous_attempt' | 'world_model' | 'plan' }
  | { name: 'read_journal'; limit: number }
  | { name: 'write_world_model'; value: Record<string, unknown> }
  | { name: 'write_plan'; value: Record<string, unknown> }
  /** Typed draft write; this is deliberately not a general filesystem tool. */
  | { name: 'write_candidate_draft'; proposal: Record<string, unknown> }
  | { name: 'inspect_staging'; path: string }
  | { name: 'preflight_staging_entry'; entry: string }

export function builderRunPaths(root: string, sessionId: string, id: string) {
  const base = join(workspaceDir(root, sessionId), 'builder-runs', id)
  return {
    base,
    record: join(base, 'run.json'),
    actor: join(base, 'input', 'actor-snapshot.json'),
    targetBefore: join(base, 'input', 'target-before.json'),
    previousAttempt: join(base, 'input', 'previous-attempt.json'),
    worldModel: join(base, 'state', 'world-model.json'),
    plan: join(base, 'state', 'plan.json'),
    journal: join(base, 'state', 'journal.jsonl'),
    snapshots: join(base, 'state', 'snapshots.jsonl'),
    staging: join(base, 'staging'),
    preflight: join(base, 'preflight'),
    proposal: join(base, 'submission', 'proposal.json'),
  }
}

/** Durable, builder-owned run state. The kernel—not an LLM—records every transition. */
export class BuilderKernel {
  constructor(private readonly root: string, private readonly sessionId: string) {}

  create(input: BuilderRunInput): BuilderRunRecord {
    const id = `builder-${Date.now()}-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const inputHash = sha256(input)
    const record: BuilderRunRecord = { schemaVersion: 1, id, kind: input.kind ?? 'patch', state: 'created', createdAt: now, updatedAt: now, inputHash }
    const paths = builderRunPaths(this.root, this.sessionId, id)
    atomicWriteJson(paths.actor, input.actor)
    atomicWriteJson(paths.targetBefore, input.targetBefore)
    atomicWriteJson(paths.previousAttempt, input.previousAttempt ?? null)
    atomicWriteJson(paths.worldModel, { schemaVersion: 1, version: 0, facts: [], unknowns: [], hash: sha256({}) })
    atomicWriteJson(paths.plan, { schemaVersion: 1, state: 'created', steps: [] })
    atomicWriteJson(paths.record, record)
    this.append(id, 'state', 'create', { state: 'created', inputHash })
    return record
  }

  load(id: string): BuilderRunRecord {
    const record = readJson<BuilderRunRecord>(builderRunPaths(this.root, this.sessionId, id).record)
    if (!record || record.schemaVersion !== 1) throw new Error(`unknown builder run: ${id}`)
    return record
  }

  transition(id: string, state: BuilderRunState): BuilderRunRecord {
    const record = this.load(id)
    if (record.state === 'submitted' || record.state === 'aborted') throw new Error(`builder run is terminal: ${record.state}`)
    const next = { ...record, state, updatedAt: new Date().toISOString() }
    atomicWriteJson(builderRunPaths(this.root, this.sessionId, id).record, next)
    this.append(id, 'state', `transition:${state}`, { from: record.state, to: state })
    return next
  }

  append(id: string, kind: BuilderJournalKind, action: string, result?: Record<string, unknown>, error?: unknown): BuilderJournalEntry {
    const paths = builderRunPaths(this.root, this.sessionId, id)
    const seq = readJsonl<BuilderJournalEntry>(paths.journal).length + 1
    const entry: BuilderJournalEntry = {
      schemaVersion: 1, seq, kind, action, result, at: new Date().toISOString(),
      inputHash: this.load(id).inputHash,
      ...(error === undefined ? {} : { error: String(error) }),
    }
    appendJsonl(paths.journal, entry)
    return entry
  }

  /** Record the model's declared decision without trusting it to write audit data. */
  recordDecision(id: string, decision: BuilderDecision): void {
    const result: Record<string, unknown> = { kind: decision.kind }
    if (decision.kind === 'tool') result.action = decision.action.name
    if (decision.kind === 'continue') result.summary = decision.summary.slice(0, 1000)
    if (decision.kind === 'submit') result.draftHash = sha256(readJson<Record<string, unknown>>(join(builderRunPaths(this.root, this.sessionId, id).staging, 'candidate.json')) ?? null)
    if (decision.kind === 'abort') result.reason = decision.reason.slice(0, 1000)
    this.append(id, 'model', 'decision', result)
  }

  context(id: string): { run: BuilderRunRecord; input: BuilderRunInput; journal: BuilderJournalEntry[] } {
    const paths = builderRunPaths(this.root, this.sessionId, id)
    const actor = readJson<Record<string, unknown>>(paths.actor) ?? {}
    const targetBefore = readJson<Record<string, unknown>>(paths.targetBefore) ?? {}
    const previousAttempt = readJson<Record<string, unknown> | null>(paths.previousAttempt) ?? null
    return { run: this.load(id), input: { actor, targetBefore, ...(previousAttempt ? { previousAttempt } : {}) }, journal: readJsonl(paths.journal) }
  }

  proposal(id: string): Record<string, unknown> | null {
    return readJson<Record<string, unknown>>(builderRunPaths(this.root, this.sessionId, id).proposal)
  }

  /** Execute exactly one allowlisted builder action and durably return its feedback. */
  decide(id: string, decision: BuilderDecision): Record<string, unknown> {
    const run = this.load(id)
    if (run.state === 'created') this.transition(id, 'exploring')
    this.recordDecision(id, decision)
    if (decision.kind === 'continue') {
      return { state: this.load(id).state, continue: true }
    }
    if (decision.kind === 'abort') {
      this.append(id, 'state', 'abort', undefined, decision.reason)
      this.transition(id, 'aborted')
      return { state: 'aborted' }
    }
    if (decision.kind === 'submit') {
      if (this.load(id).state !== 'ready_to_submit') throw new Error('builder run must pass preflight before submit')
      const draft = readJson<Record<string, unknown>>(join(builderRunPaths(this.root, this.sessionId, id).staging, 'candidate.json'))
      if (!draft) throw new Error('builder submission requires a preflighted candidate draft')
      atomicWriteJson(builderRunPaths(this.root, this.sessionId, id).proposal, draft)
      this.snapshot(id, 'submission/proposal.json', draft)
      this.append(id, 'state', 'submit', { proposalHash: sha256(draft) })
      this.transition(id, 'submitted')
      return { state: 'submitted' }
    }
    try {
      const result = this.executeTool(id, decision.action)
      this.append(id, 'tool', decision.action.name, result)
      return result
    } catch (error) {
      this.append(id, 'error', decision.action.name, undefined, error)
      throw error
    }
  }

  /** Kernel-owned verifier feedback starts a new immutable builder attempt. */
  reopenFromRejection(id: string, report: Record<string, unknown>): BuilderRunRecord {
    const context = this.context(id)
    if (context.run.state !== 'submitted') throw new Error('only submitted builder runs may be rejected')
    this.append(id, 'state', 'verifier_rejected', { reportHash: sha256(report) })
    return this.create({ kind: context.run.kind, actor: context.input.actor, targetBefore: context.input.targetBefore, previousAttempt: report })
  }

  private executeTool(id: string, action: BuilderToolAction): Record<string, unknown> {
    const paths = builderRunPaths(this.root, this.sessionId, id)
    if (action.name === 'read_input') {
      const path = {
        actor: paths.actor, target_before: paths.targetBefore, previous_attempt: paths.previousAttempt,
        world_model: paths.worldModel, plan: paths.plan,
      }[action.document]
      return { document: action.document, value: readJson<Record<string, unknown>>(path) ?? null }
    }
    if (action.name === 'read_journal') {
      const limit = Math.max(1, Math.min(100, Math.floor(action.limit)))
      return { entries: readJsonl<BuilderJournalEntry>(paths.journal).slice(-limit) }
    }
    if (action.name === 'write_world_model') {
      atomicWriteJson(paths.worldModel, action.value)
      this.snapshot(id, 'state/world-model.json', action.value)
      return { written: 'world_model', hash: sha256(action.value) }
    }
    if (action.name === 'write_plan') {
      atomicWriteJson(paths.plan, action.value)
      this.snapshot(id, 'state/plan.json', action.value)
      this.transition(id, 'preflighting')
      return { written: 'plan', hash: sha256(action.value) }
    }
    if (action.name === 'write_candidate_draft') {
      if (!action.proposal || Array.isArray(action.proposal)) throw new Error('candidate draft must be an object')
      const draft = join(paths.staging, 'candidate.json')
      const alreadyStaged = existsSync(draft)
      const priorPreflightError = readJsonl<BuilderJournalEntry>(paths.journal).some((entry) => entry.kind === 'error' && entry.action === 'preflight_staging_entry')
      if (alreadyStaged && !priorPreflightError) {
        throw new Error('candidate draft already exists; inspect or preflight it before rewriting')
      }
      atomicWriteJson(draft, action.proposal)
      this.snapshot(id, 'staging/candidate.json', action.proposal)
      return { written: 'candidate_draft', entry: 'candidate.json', hash: sha256(action.proposal) }
    }
    const requestedPath = action.name === 'preflight_staging_entry' ? action.entry : action.path
    const candidate = resolve(paths.staging, requestedPath)
    if (relative(paths.staging, candidate).startsWith('..') || !existsSync(candidate) || !statSync(candidate).isFile()) throw new Error('staging path is unavailable')
    if (action.name === 'preflight_staging_entry') {
      const source = readFileSync(candidate, 'utf8')
      if (!source.trim()) throw new Error('staging entry is empty')
      if (action.entry === 'candidate.json') {
        const draft = readJson<Record<string, unknown>>(candidate)
        if (!draft || Array.isArray(draft)) throw new Error('candidate draft must be an object')
        if (this.load(id).kind === 'loop_candidate') {
          const loop = draft.candidate
          if (!loop || typeof loop !== 'object' || Array.isArray(loop)) throw new Error('loop candidate draft must contain a candidate object')
        } else if (!draft.patch || typeof draft.patch !== 'object') {
          throw new Error('candidate draft must contain a patch object')
        }
        const patch = draft.patch as Record<string, unknown> | undefined
        const module = patch?.module
        if (module && typeof module === 'object' && !Array.isArray(module)) {
          const files = (module as Record<string, unknown>).files
          const entry = (module as Record<string, unknown>).entry
          if (!Array.isArray(files) || typeof entry !== 'string' || !files.some((file) => {
            if (!file || typeof file !== 'object') return false
            const path = (file as Record<string, unknown>).path
            const content = (file as Record<string, unknown>).content
            return path === entry && typeof content === 'string' && content.trim().length > 0
          })) throw new Error('candidate module entry is not present in the draft')
        }
      }
      this.snapshot(id, `preflight/${action.entry.replaceAll('/', '_')}.json`, { entry: action.entry, sourceHash: sha256(source), passed: true })
      this.transition(id, 'ready_to_submit')
      return { entry: action.entry, passed: true, sourceHash: sha256(source) }
    }
    return { path: action.path, content: readFileSync(candidate, 'utf8').slice(0, 16_000) }
  }

  private snapshot(id: string, ref: string, value: unknown): void {
    appendJsonl(builderRunPaths(this.root, this.sessionId, id).snapshots, {
      schemaVersion: 1,
      at: new Date().toISOString(),
      ref,
      hash: sha256(value),
    })
  }
}
