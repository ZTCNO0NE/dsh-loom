import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

/** An inbound observation from the actor, delivered between Builder turns. */
export interface BuilderMessage {
  schemaVersion: 1
  at: string
  from: 'actor'
  text: string
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
  /** Read-only host exploration. Deployment decides the readable scope. */
  | { name: 'read_file'; path: string }
  | { name: 'list_directory'; path: string }
  /** Builder-owned, persistent multi-file scratch space. */
  | { name: 'write_workspace_file'; path: string; content: string }
  | { name: 'read_workspace_file'; path: string }
  /** Trusted-development command tool; stdout/stderr are durable feedback. */
  | { name: 'run_workspace_command'; command: string; args: string[]; timeoutMs?: number }
  /** Generic frozen proposal for a capability; it never applies a target change. */
  | { name: 'write_submission'; proposal: Record<string, unknown> }
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
    messages: join(base, 'input', 'actor-messages.jsonl'),
    targetBefore: join(base, 'input', 'target-before.json'),
    previousAttempt: join(base, 'input', 'previous-attempt.json'),
    worldModel: join(base, 'state', 'world-model.json'),
    plan: join(base, 'state', 'plan.json'),
    journal: join(base, 'state', 'journal.jsonl'),
    snapshots: join(base, 'state', 'snapshots.jsonl'),
    workspace: join(base, 'workspace'),
    staging: join(base, 'staging'),
    preflight: join(base, 'preflight'),
    proposal: join(base, 'submission', 'proposal.json'),
    submissionDraft: join(base, 'submission', 'draft.json'),
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
    // The file is intentionally created up front.  It is a durable inbox, not
    // a mutable replacement for the actor snapshot captured at run creation.
    writeFileSync(paths.messages, '', 'utf8')
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
      schemaVersion: 1, seq, kind, action,
      ...(result === undefined ? {} : { result: boundedJournalValue(result) }),
      at: new Date().toISOString(),
      inputHash: this.load(id).inputHash,
      ...(error === undefined ? {} : { error: String(error) }),
    }
    appendJsonl(paths.journal, entry)
    return entry
  }

  /** Record the model's declared decision without trusting it to write audit data. */
  recordDecision(id: string, decision: BuilderDecision): void {
    const result: Record<string, unknown> = { kind: decision.kind }
    if (decision.kind === 'tool') {
      result.action = decision.action.name
      result.actionHash = sha256(decision.action)
    }
    if (decision.kind === 'continue') result.summary = decision.summary.slice(0, 1000)
    if (decision.kind === 'submit') result.draftHash = sha256(this.submissionDraft(id) ?? null)
    if (decision.kind === 'abort') result.reason = decision.reason.slice(0, 1000)
    this.append(id, 'model', 'decision', result)
  }

  context(id: string): { run: BuilderRunRecord; input: BuilderRunInput; messages: BuilderMessage[]; journal: BuilderJournalEntry[] } {
    const paths = builderRunPaths(this.root, this.sessionId, id)
    const actor = readJson<Record<string, unknown>>(paths.actor) ?? {}
    const targetBefore = readJson<Record<string, unknown>>(paths.targetBefore) ?? {}
    const previousAttempt = readJson<Record<string, unknown> | null>(paths.previousAttempt) ?? null
    return {
      run: this.load(id),
      input: { actor, targetBefore, ...(previousAttempt ? { previousAttempt } : {}) },
      messages: readJsonl<BuilderMessage>(paths.messages),
      journal: readJsonl(paths.journal),
    }
  }

  /**
   * Accept a new actor observation without changing the immutable initial
   * snapshot. The next driver turn reads this durable inbox in its prompt.
   */
  receiveActorMessage(id: string, text: string): BuilderMessage {
    const run = this.load(id)
    if (run.state === 'submitted' || run.state === 'aborted') throw new Error(`builder run is terminal: ${run.state}`)
    const message: BuilderMessage = { schemaVersion: 1, at: new Date().toISOString(), from: 'actor', text }
    appendJsonl(builderRunPaths(this.root, this.sessionId, id).messages, message)
    this.append(id, 'state', 'actor_message', { bytes: Buffer.byteLength(text, 'utf8'), messageHash: sha256(text) })
    return message
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
      const journal = readJsonl<BuilderJournalEntry>(builderRunPaths(this.root, this.sessionId, id).journal)
      const priorDecision = [...journal].reverse().find((entry) => entry.kind === 'model' && entry.action === 'decision' && entry.seq !== journal[journal.length - 1]?.seq)
      if (priorDecision?.result?.kind === 'continue') {
        this.append(id, 'error', 'continue', undefined, 'continue requires a new tool action; consecutive no-op turns are not allowed')
        throw new Error('continue requires a new tool action; consecutive no-op turns are not allowed')
      }
      return { state: this.load(id).state, continue: true }
    }
    if (decision.kind === 'abort') {
      this.append(id, 'state', 'abort', undefined, decision.reason)
      this.transition(id, 'aborted')
      return { state: 'aborted' }
    }
    if (decision.kind === 'submit') {
      const draft = this.submissionDraft(id)
      if (!draft) throw new Error('builder submission requires a proposal draft')
      if (existsSync(join(builderRunPaths(this.root, this.sessionId, id).staging, 'candidate.json')) && this.load(id).state !== 'ready_to_submit') {
        throw new Error('legacy candidate draft must pass preflight before submit')
      }
      atomicWriteJson(builderRunPaths(this.root, this.sessionId, id).proposal, draft)
      this.snapshot(id, 'submission/proposal.json', draft)
      this.append(id, 'state', 'submit', { proposalHash: sha256(draft) })
      this.transition(id, 'submitted')
      return { state: 'submitted' }
    }
    try {
      if (decision.kind === 'tool') {
        const actionHash = sha256(decision.action)
        const repeated = readJsonl<BuilderJournalEntry>(builderRunPaths(this.root, this.sessionId, id).journal)
          .filter((entry) => entry.kind === 'model' && entry.action === 'decision' && entry.result?.actionHash === actionHash).length
        if (repeated >= 8) {
          const reason = `identical tool action repeated ${repeated + 1} times: ${decision.action.name}`
          this.append(id, 'error', decision.action.name, { actionHash, repeated: repeated + 1 }, reason)
          this.transition(id, 'aborted')
          return { state: 'aborted', reason }
        }
      }
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
      return { written: 'plan', hash: sha256(action.value) }
    }
    if (action.name === 'read_file') {
      const file = resolve(action.path)
      if (!existsSync(file) || !statSync(file).isFile()) throw new Error('file is unavailable')
      const content = readFileSync(file, 'utf8')
      return { path: file, content: content.slice(0, 64_000), truncated: content.length > 64_000 }
    }
    if (action.name === 'list_directory') {
      const directory = resolve(action.path)
      if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error('directory is unavailable')
      const entries = readdirSync(directory, { withFileTypes: true }).slice(0, 500).map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }))
      return { path: directory, entries, truncated: readdirSync(directory).length > entries.length }
    }
    if (action.name === 'write_workspace_file') {
      const file = this.workspacePath(paths.workspace, action.path)
      mkdirSync(resolve(file, '..'), { recursive: true })
      writeFileSync(file, action.content, 'utf8')
      this.snapshot(id, `workspace/${action.path}`, action.content)
      return { path: action.path, bytes: Buffer.byteLength(action.content, 'utf8'), hash: sha256(action.content) }
    }
    if (action.name === 'read_workspace_file') {
      const file = this.workspacePath(paths.workspace, action.path)
      if (!existsSync(file) || !statSync(file).isFile()) throw new Error('workspace file is unavailable')
      const content = readFileSync(file, 'utf8')
      return { path: action.path, content: content.slice(0, 64_000), truncated: content.length > 64_000 }
    }
    if (action.name === 'run_workspace_command') {
      mkdirSync(paths.workspace, { recursive: true })
      const timeout = Math.max(1_000, Math.min(300_000, Math.floor(action.timeoutMs ?? 120_000)))
      const output = spawnSync(action.command, action.args, {
        cwd: paths.workspace, encoding: 'utf8', timeout, maxBuffer: 256 * 1024,
      })
      return {
        command: action.command, args: action.args, cwd: paths.workspace,
        exitCode: output.status, signal: output.signal ?? undefined,
        stdout: String(output.stdout ?? '').slice(-64_000), stderr: String(output.stderr ?? '').slice(-64_000),
        ...(output.error ? { error: String(output.error) } : {}),
      }
    }
    if (action.name === 'write_submission') {
      atomicWriteJson(paths.submissionDraft, action.proposal)
      this.snapshot(id, 'submission/draft.json', action.proposal)
      return { written: 'submission_draft', hash: sha256(action.proposal) }
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

  private submissionDraft(id: string): Record<string, unknown> | null {
    const paths = builderRunPaths(this.root, this.sessionId, id)
    return readJson<Record<string, unknown>>(paths.submissionDraft)
      ?? readJson<Record<string, unknown>>(join(paths.staging, 'candidate.json'))
  }

  private workspacePath(workspace: string, requestedPath: string): string {
    const path = resolve(workspace, requestedPath)
    if (relative(workspace, path).startsWith('..')) throw new Error('workspace path escapes builder workspace')
    return path
  }
}

/** Keep feedback durable without allowing a tool to recursively journal itself. */
function boundedJournalValue(value: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(value)
  if (encoded.length <= 16_000) return value
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(encoded, 'utf8'),
    originalHash: sha256(value),
    preview: encoded.slice(0, 15_000),
  }
}
