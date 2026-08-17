import type { LlmStreamLike } from '../meta/propose.js'
import { BuilderKernel, type BuilderDecision, type BuilderToolAction } from './kernel.js'

export interface BuilderDriverOptions {
  llm: LlmStreamLike
  provider: string
  model: string
  systemPrompt: string
  taskContext: string
  draftKind?: 'patch' | 'loop_candidate'
  maxModelTurns?: number
  maxToolSteps?: number
  maxTokens?: number
  maxWallTimeMs?: number
  onUsage?: (usage: { prompt: number; completion: number }) => void
}

export interface BuilderDriverOutcome {
  state: 'submitted' | 'aborted'
  runId: string
  proposal?: Record<string, unknown>
  modelTurns: number
  toolSteps: number
  reason?: string
}

/**
 * Bounded, file-backed builder micro-loop. The LLM selects a decision, while
 * the kernel alone executes tools, records outcomes, and owns terminal state.
 */
export class BuilderDriver {
  constructor(private readonly options: BuilderDriverOptions) {}

  async run(kernel: BuilderKernel, runId: string): Promise<BuilderDriverOutcome> {
    const startedAt = Date.now()
    const maxTurns = this.options.maxModelTurns ?? 8
    const maxTools = this.options.maxToolSteps ?? 12
    const maxWallTimeMs = this.options.maxWallTimeMs ?? 120_000
    let modelTurns = 0
    let toolSteps = 0

    while (modelTurns < maxTurns && toolSteps <= maxTools && Date.now() - startedAt <= maxWallTimeMs) {
      const context = kernel.context(runId)
      if (context.run.state === 'submitted') {
        return {
          state: 'submitted', runId, proposal: kernel.proposal(runId) ?? undefined,
          modelTurns, toolSteps,
        }
      }
      if (context.run.state === 'aborted') return { state: 'aborted', runId, modelTurns, toolSteps, reason: abortReason(context.journal) }

      let decision: BuilderDecision
      try {
        const text = await this.stream(this.prompt(context), runId)
        decision = this.parseDecision(text)
      } catch (error) {
        kernel.append(runId, 'error', 'model_response', undefined, error)
        kernel.decide(runId, { kind: 'abort', reason: `invalid model response: ${String(error)}` })
        return { state: 'aborted', runId, modelTurns: modelTurns + 1, toolSteps, reason: String(error) }
      }
      modelTurns++
      try {
        const result = kernel.decide(runId, decision)
        if (decision.kind === 'tool') toolSteps++
        if (decision.kind === 'submit') {
          return { state: 'submitted', runId, proposal: kernel.proposal(runId) ?? undefined, modelTurns, toolSteps }
        }
        if (decision.kind === 'abort') return { state: 'aborted', runId, modelTurns, toolSteps, reason: decision.reason }
        // A tool failure is deliberately feedback, not a driver failure. The
        // error is journaled by the kernel and appears in the next prompt.
        void result
      } catch {
        if (decision.kind === 'tool') toolSteps++
      }
    }

    const reason = Date.now() - startedAt > maxWallTimeMs
      ? 'builder wall-time budget exhausted'
      : modelTurns >= maxTurns
        ? 'builder model-turn budget exhausted'
        : 'builder tool-step budget exhausted'
    kernel.append(runId, 'error', 'budget', { modelTurns, toolSteps }, reason)
    if (kernel.load(runId).state !== 'aborted' && kernel.load(runId).state !== 'submitted') {
      kernel.decide(runId, { kind: 'abort', reason })
    }
    return { state: kernel.load(runId).state === 'submitted' ? 'submitted' : 'aborted', runId, modelTurns, toolSteps, reason }
  }

  private prompt(context: ReturnType<BuilderKernel['context']>): string {
    const journal = context.journal.slice(-24)
    const draftWritten = journal.some((entry) => entry.kind === 'tool' && entry.action === 'write_candidate_draft')
    const preflightPassed = journal.some((entry) => entry.kind === 'tool' && entry.action === 'preflight_staging_entry' && entry.result?.passed === true)
    const nextAction = !draftWritten
      ? '当前没有 draft：先用 read_input/read_journal 理解证据（可选），随后 write_candidate_draft。'
      : !preflightPassed
        ? this.options.draftKind === 'loop_candidate'
          ? 'loop candidate draft 已存在：下一回合必须只输出 preflight_staging_entry(candidate.json)；不要 inspect、重写或使用其它动作。'
          : 'candidate draft 已存在：现在必须 inspect_staging 或 preflight_staging_entry；不要再次 write_candidate_draft，除非上一条 preflight 明确报错且你正在修复。'
        : 'preflight 已通过：现在只能 submit 同一份 proposal，或 abort；不要再写 draft。'
    return [
      this.options.systemPrompt,
      '你是受限 builder 微循环的一回合。你没有 verifier、gate、install 权限；不能调用 shell、网络或任意文件系统。',
      '只输出一个严格 JSON decision，禁止 Markdown、解释和额外字段。允许的形式：',
      JSON.stringify({ kind: 'tool', action: { name: 'write_candidate_draft', proposal: this.options.draftKind === 'loop_candidate' ? { candidate: {} } : { patch: {} } } }),
      JSON.stringify({ kind: 'tool', action: { name: 'read_input', document: 'actor' } }),
      JSON.stringify({ kind: 'tool', action: { name: 'read_journal', limit: 20 } }),
      JSON.stringify({ kind: 'tool', action: { name: 'write_world_model', value: {} } }),
      JSON.stringify({ kind: 'tool', action: { name: 'write_plan', value: {} } }),
      JSON.stringify({ kind: 'tool', action: { name: 'inspect_staging', path: 'candidate.json' } }),
      JSON.stringify({ kind: 'tool', action: { name: 'preflight_staging_entry', entry: 'candidate.json' } }),
      JSON.stringify({ kind: 'continue', summary: '根据刚才工具反馈继续' }),
      JSON.stringify({ kind: 'submit' }),
      JSON.stringify({ kind: 'abort', reason: '证据不足或不能安全提交' }),
      '提交前必须按顺序写 candidate draft、读取/检查反馈、预检 candidate.json；submit 没有 payload，只会冻结已预检 draft，不能携带或改写 proposal。',
      '工具报错是下一轮可见反馈；可纠正时继续，不可纠正时 abort。预检不是 verifier 通过。',
      `当前工作流硬提示：${nextAction}`,
      this.options.draftKind === 'loop_candidate'
        ? '本 run 的 draft 是 { candidate: CandidateAcquisitionRequest, rationale: string }；candidate.source 可以是受限 HTTPS Git source，也可以是固定 DSH baseline 上的 builder-generated edits。提交后核心 importer 才会执行校验、构建并只写 staging。你可以 abort 表示没有可审计候选。'
        : '本 run 的 draft 是 { patch: MetaPatch, expectedTrajectory, selfCheck, worldModel? }。',
      `任务上下文：\n${this.options.taskContext.slice(0, 28_000)}`,
      `内核上下文（不可修改输入）：\n${JSON.stringify({ run: context.run, input: context.input, journal })}`.slice(0, 28_000),
    ].join('\n\n')
  }

  private async stream(prompt: string, runId: string): Promise<string> {
    let out = ''
    let inText = false
    for await (const chunk of this.options.llm.stream({
      provider: this.options.provider,
      model: this.options.model,
      prompt,
      temperature: 0,
      maxTokens: this.options.maxTokens ?? 6000,
      sessionId: `${runId}:builder`,
    })) {
      if (chunk.kind === 'block-start') inText = chunk.type === 'text'
      else if (chunk.kind === 'block-end') inText = false
      else if (chunk.kind === 'text-delta' && inText && typeof chunk.text === 'string') out += chunk.text
      else if (chunk.kind === 'usage' && chunk.usage) this.options.onUsage?.({ prompt: chunk.usage.prompt ?? 0, completion: chunk.usage.completion ?? 0 })
    }
    return out
  }

  private parseDecision(text: string): BuilderDecision {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error(`no JSON decision: ${JSON.stringify(text.slice(0, 200))}`)
    const value = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('decision must be an object')
    const decision = value as Record<string, unknown>
    const kind = decision.kind
    if (kind === 'continue' && exactKeys(decision, ['kind', 'summary']) && typeof decision.summary === 'string') return { kind, summary: decision.summary }
    if (kind === 'abort' && exactKeys(decision, ['kind', 'reason']) && typeof decision.reason === 'string') return { kind, reason: decision.reason }
    if (kind === 'submit' && exactKeys(decision, ['kind'])) return { kind }
    if (kind === 'tool' && exactKeys(decision, ['kind', 'action']) && isObject(decision.action)) return { kind, action: this.parseTool(decision.action) }
    throw new Error('decision does not match the allowlisted protocol')
  }

  private parseTool(action: Record<string, unknown>): BuilderToolAction {
    if (action.name === 'read_input' && isOneOf(action.document, ['actor', 'target_before', 'previous_attempt', 'world_model', 'plan'])) return { name: action.name, document: action.document }
    if (action.name === 'read_journal' && typeof action.limit === 'number' && Number.isFinite(action.limit)) return { name: action.name, limit: action.limit }
    if (action.name === 'write_world_model' && isObject(action.value)) return { name: action.name, value: action.value }
    if (action.name === 'write_plan' && isObject(action.value)) return { name: action.name, value: action.value }
    if (action.name === 'write_candidate_draft' && isObject(action.proposal)) return { name: action.name, proposal: action.proposal }
    if (action.name === 'inspect_staging' && typeof action.path === 'string') return { name: action.name, path: action.path }
    if (action.name === 'preflight_staging_entry' && typeof action.entry === 'string') return { name: action.name, entry: action.entry }
    throw new Error(`tool is not allowlisted: ${String(action.name)}`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys.slice().sort()[index])
}

function abortReason(journal: Array<{ kind: string; action: string; error?: string; result?: Record<string, unknown> }>): string | undefined {
  const abort = [...journal].reverse().find((entry) => entry.kind === 'model' && entry.action === 'decision' && entry.result?.kind === 'abort')
  return typeof abort?.result?.reason === 'string' ? abort.result.reason : undefined
}
