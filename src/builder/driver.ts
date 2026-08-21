import type { LlmNativeTool, LlmStreamLike } from '../meta/propose.js'
import { BUILDER_BASE_TOOLS, BuilderCapabilityRegistry, type BuilderCapabilityPlugin } from './capabilities.js'
import { BuilderKernel, type BuilderDecision, type BuilderToolAction } from './kernel.js'
import { sha256 } from '../protocol/index.js'

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
  /** Experimental text-only intervention; Kernel permissions remain unchanged. */
  progressBanner?: boolean
  /** Replace repeated full prompt exemplars with a durable context-index map. */
  compactPrompt?: boolean
  capabilities?: readonly BuilderCapabilityPlugin[]
  /** Expose only observation/dialogue/report tools during a diagnosis pass. */
  readOnlyDiagnosis?: boolean
  onUsage?: (usage: { prompt: number; completion: number }) => void
  /** Deterministic terminal signal: a run_workspace_command whose stdout/stderr
   * contains this marker with exit 0 marks the run ready_to_submit. */
  successMarker?: string
}

export interface BuilderDriverOutcome {
  state: 'submitted' | 'aborted' | 'paused' | 'cancelled' | 'waiting_for_input'
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
      if (context.run.state === 'paused' || context.run.state === 'waiting_for_input' || context.run.state === 'cancelled') {
        return { state: context.run.state, runId, modelTurns, toolSteps, reason: context.run.state === 'cancelled' ? 'builder run cancelled by actor' : undefined }
      }

      let decision: BuilderDecision
      let responseText = ''
      try {
        const prompt = this.prompt(context)
        const promptHash = sha256(prompt)
        const promptBytes = Buffer.byteLength(prompt, 'utf8')
        const lastToolResultHash = context.journal.filter((entry) => entry.kind === 'tool').at(-1)?.result
          ? sha256(context.journal.filter((entry) => entry.kind === 'tool').at(-1)?.result)
          : undefined
        const pendingMessageIds = context.messages
          .filter((message) => !context.events.some((event) => event.kind === 'message_ack' && event.payload.messageId === message.id))
          .map((message) => message.id)
        kernel.append(runId, 'model', 'prompt', {
          promptHash,
          promptBytes,
          visibleState: context.run.state,
          lastJournalAction: context.journal.at(-1)?.action,
          lastToolResultHash,
          pendingMessageIds,
          progressStateVersion: context.progressState.version,
          progressStateHash: sha256(context.progressState),
        })
        kernel.recordPromptVisible(runId, {
          prompt,
          promptHash,
          promptBytes,
          visibleState: context.run.state,
          lastJournalAction: context.journal.at(-1)?.action,
          lastToolResultHash,
          pendingMessageIds,
          progressStateVersion: context.progressState.version,
          progressStateHash: sha256(context.progressState),
        })
        responseText = await this.stream(prompt, runId)
        decision = this.parseDecision(responseText)
      } catch (error) {
        modelTurns++
        kernel.append(runId, 'error', 'model_response', {
          preview: responseText.slice(0, 2_000),
          responseHash: responseText ? sha256(responseText) : undefined,
        }, error)
        // A malformed decision is feedback to the same persistent loop. The
        // next model turn may correct its JSON; only the normal budget aborts.
        if (modelTurns >= maxTurns) {
          const reason = `invalid model response at budget: ${String(error)}`
          if (kernel.load(runId).state !== 'aborted') kernel.decide(runId, { kind: 'abort', reason })
          return { state: 'aborted', runId, modelTurns, toolSteps, reason }
        }
        continue
      }
      modelTurns++
      try {
        if (context.run.state === 'ready_to_submit' && !isCompletionDecision(decision)) {
          if (decision.kind === 'tool') toolSteps++
          // A target-declared success marker is not an ordinary phase hint:
          // it is the terminal success condition of this bounded pass. Keep
          // the already-verified workspace intact while the Builder writes
          // its proposal. A new experiment belongs in a fresh immutable run.
          const action = decision.kind === 'tool' ? decision.action.name : decision.kind
          const error = new Error(`verified completion requires write_submission, submit, or abort; ${action} would mutate or extend a completed pass`)
          kernel.append(runId, 'error', action, undefined, error)
          continue
        }
        const result = kernel.decide(runId, decision)
        if (decision.kind === 'tool') toolSteps++
        if (decision.kind === 'tool' && this.options.successMarker
          && kernel.load(runId).state !== 'submitted' && kernel.load(runId).state !== 'aborted'
          && result && typeof result === 'object' && (result as { exitCode?: unknown }).exitCode === 0
          && `${String((result as { stdout?: unknown }).stdout ?? '')}${String((result as { stderr?: unknown }).stderr ?? '')}`.includes(this.options.successMarker)) {
          kernel.transition(runId, 'ready_to_submit')
          kernel.requireSubmissionDraft(runId)
        }
        if (decision.kind === 'tool' && (decision.action.name === 'write_workspace_file' || decision.action.name === 'apply_workspace_patch')
          && this.options.successMarker && kernel.load(runId).state !== 'submitted') {
          kernel.requireEvidence(runId)
        }
        if (decision.kind === 'submit') {
          return { state: 'submitted', runId, proposal: kernel.proposal(runId) ?? undefined, modelTurns, toolSteps }
        }
        if (decision.kind === 'abort') return { state: 'aborted', runId, modelTurns, toolSteps, reason: decision.reason }
        if (kernel.load(runId).state === 'paused' || kernel.load(runId).state === 'waiting_for_input' || kernel.load(runId).state === 'cancelled') {
          return { state: kernel.load(runId).state as 'paused' | 'waiting_for_input' | 'cancelled', runId, modelTurns, toolSteps }
        }
        // A tool failure is deliberately feedback, not a driver failure. The
        // error is journaled by the kernel and appears in the next prompt.
        void result
      } catch (error) {
        if (decision.kind === 'tool') toolSteps++
        // A rejected decision (e.g. submit without a draft) is feedback, not
        // a silent failure: journal it so the next prompt can correct it.
        kernel.append(runId, 'error', decision.kind === 'tool' ? decision.action.name : decision.kind, undefined, error)
        if (decision.kind === 'submit' && String(error).includes('requires a proposal draft')) {
          // Do not leave the model to infer the recovery from a prose error.
          // Turn this common delivery mistake into a durable kernel obligation;
          // the next turn can only satisfy it with write_submission.
          kernel.requireSubmissionDraft(runId)
        }
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
    const diagnosisMode = context.run.mode === 'diagnosis'
    const readOnlyDiagnosis = diagnosisMode && this.options.readOnlyDiagnosis === true
    const journal = context.journal.slice(-10).map((entry) => ({
      seq: entry.seq,
      kind: entry.kind,
      action: entry.action,
      ...(entry.error ? { error: entry.error.slice(0, 500) } : {}),
      ...(entry.result ? { result: compactPromptValue(entry.result, 600) } : {}),
    }))
    const messages = context.messages.slice(-4).map((message) => ({
      id: message.id,
      at: message.at,
      rawUserText: compactText(message.rawUserText, 1_600),
      ...(message.actorMemo ? { actorMemo: compactText(message.actorMemo, 600) } : {}),
      ...(message.evidenceRefs ? { evidenceRefs: message.evidenceRefs.slice(0, 8).map((ref) => compactText(ref, 300)) } : {}),
    }))
    const acknowledged = new Set(context.events
      .filter((event) => event.kind === 'message_ack' && typeof event.payload.messageId === 'string')
      .map((event) => event.payload.messageId as string))
    const pendingMessages = messages.filter((message) => !acknowledged.has(message.id))
    const capabilities = new BuilderCapabilityRegistry().registerAll(this.options.capabilities ?? [])
    const progressBanner = this.options.progressBanner ? deriveProgressBanner(context.journal) : ''
    const evidenceSatisfied = context.run.state === 'ready_to_submit' && this.options.successMarker
      ? `Oracle evidence satisfied (marker=${this.options.successMarker}). The Kernel now accepts only write_submission, submit, or abort for this pass; do not keep exploring or edit the verified workspace.`
      : ''
    if (this.options.compactPrompt) return this.compactPrompt(context, pendingMessages, progressBanner)
    return [
      this.options.systemPrompt,
      readOnlyDiagnosis
        ? '你是持久化 Builder 的一个只读诊断回合。你可以按需读取输入、文件、目录和溯源关系，并维护公开 world model/plan、向 Actor 提问或写出方向报告；本 pass 没有编辑、命令、仿真、提交或安装能力。'
        : '你是持久化 Builder 的一个极简 loop 回合。你可以按需读取输入、全局文件与目录，在自己的 workspace 写多文件，并运行工作区命令获得真实反馈。你自己决定下一步、是否继续探索或何时提交。',
      diagnosisMode
        ? '当前是 diagnosis-first 对齐 pass：使命是从真实会话、状态和工具反馈中形成 1–3 个有证据的优化方向，并把无法由事实决定的优先级明确交给 Actor/用户。完成定义只有 write_diagnosis_report；报告持久化后必须等待用户方向。不得写 proposal、submit、修改或宣称已改进。'
        : '你的上层使命：作为 Actor 的外部协助者，基于真实会话、状态和工具反馈，找出最值得改进且能提升用户体验/任务成功率/安全性的具体问题，并形成可验证的改进候选。不是为了修改而修改，也不是为了证明自己做过探索。',
      diagnosisMode
        ? '最小必要探索后应立即 write_diagnosis_report；不要用重复读取、continue 或仿真替代报告。每个方向须绑定 evidenceRefs 与 unknowns；问题必须有两个以上选项、whyNow 和 evidenceRefs。'
        : '完成定义：至少形成一个具体问题和可证伪假设；优先用现有事实或 workspace simulation 区分假设；目标取舍无法从证据推出时向 Actor/用户提出 choice/clarification；证据足够时 write_submission→submit；没有有意义或安全的改进时带证据 abort。你可以选择小改、重建、替换、请求澄清或放弃，路线不由这些文字替你决定。',
      '你没有 verifier、gate、install 权限；提交只会冻结 proposal，绝不会直接改变 actor、builder 或 loop 的 live target。',
      `Builder 起始工具：${(readOnlyDiagnosis ? BUILDER_BASE_TOOLS.filter((tool) => !['write_workspace_file', 'run_workspace_command', 'write_submission'].includes(tool)) : BUILDER_BASE_TOOLS).join(', ')}`,
      '只输出一个严格 JSON decision，禁止 Markdown、解释和额外字段。允许的形式：',
      diagnosisMode
        ? '硬性回合规则：本轮若尚未收到上一工具的真实反馈，必须先选择 tool；continue 只能紧跟一次工具反馈，不能连续空转。完成最小必要探索后应 write_diagnosis_report；不要用 continue 或重复读取代替报告。'
        : '硬性回合规则：本轮若尚未收到上一工具的真实反馈，必须先选择 tool；continue 只能紧跟一次工具反馈，不能连续空转。完成最小必要探索后应 write_submission 再 submit；不要用 continue 代替行动。',
      `已注册 capability（仅提供上下文，不限制你的选择）：\n${capabilities.describe()}`,
      'actor input and target-before are already present in the immutable kernel context below; do not repeatedly reread them. Read previous_attempt and previous_run when a rejection exists: previous_run provides read-only paths and hashes for the prior workspace, journal, plan and artifacts. You decide whether to reuse or restart; never treat prior artifacts as automatically approved.',
      'Actor message protocol: `rawUserText` is the user’s original wording; `actorMemo` is a helpful but non-authoritative interpretation. Preserve the distinction. For each new relevant message, call acknowledge_message with your understanding, next action, or a clarification question. You may publish_progress at meaningful phase boundaries; never expose hidden chain-of-thought.',
      JSON.stringify({ kind: 'tool', action: { name: 'read_journal', limit: 20 } }),
      JSON.stringify({ kind: 'tool', action: { name: 'read_input', document: 'previous_attempt' } }),
      JSON.stringify({ kind: 'tool', action: { name: 'read_input', document: 'previous_run' } }),
      JSON.stringify({ kind: 'tool', action: { name: 'read_input', document: 'progress_state' } }),
      JSON.stringify({ kind: 'tool', action: { name: 'read_file', path: '/path/to/source.ts' } }),
      JSON.stringify({ kind: 'tool', action: { name: 'list_directory', path: '/path/to/source' } }),
      JSON.stringify({ kind: 'tool', action: { name: 'search_text', query: 'runActorLoop', roots: ['/path/to/project'], maxResults: 20 } }),
      JSON.stringify({ kind: 'tool', action: { name: 'inspect_file', path: '/path/to/candidate.mjs' } }),
      JSON.stringify({ kind: 'tool', action: { name: 'trace_artifact', artifact: 'artifact-id-or-absolute-path' } }),
      ...(readOnlyDiagnosis ? [] : [
        JSON.stringify({ kind: 'tool', action: { name: 'write_workspace_file', path: 'notes/idea.md', content: '...' } }),
        JSON.stringify({ kind: 'tool', action: { name: 'read_workspace_file', path: 'notes/idea.md' } }),
        JSON.stringify({ kind: 'tool', action: { name: 'run_workspace_command', command: 'git', args: ['status', '--short'] } }),
      ]),
      JSON.stringify({ kind: 'tool', action: { name: 'acknowledge_message', messageId: 'message-id', status: 'accepted', understanding: '...', nextAction: '...' } }),
      JSON.stringify({ kind: 'tool', action: { name: 'publish_progress', phase: 'diagnosis', summary: '...' } }),
      JSON.stringify({ kind: 'tool', action: { name: 'request_input', kind: 'choice', question: '需要用户确认哪一项优先级？', options: [{ id: 'safe', label: '优先安全', description: '保留并发但不宣称提升' }, { id: 'speed', label: '优先吞吐' }], whyNow: '静态检查无法区分两个候选', evidenceRefs: ['journal:42'], context: '已完成的检查…' } }),
      ...(readOnlyDiagnosis ? [] : [JSON.stringify({ kind: 'tool', action: { name: 'invoke_capability', capability: 'workspace-simulation', tool: 'run_simulation', input: { id: 'probe-1', command: 'node', args: ['fixture.mjs'], files: { 'fixture.mjs': 'console.log("ok")' }, expectedStdoutIncludes: ['ok'] } } })]),
      JSON.stringify({ kind: 'tool', action: { name: 'write_world_model', value: {} } }),
      JSON.stringify({ kind: 'tool', action: { name: 'write_plan', value: {} } }),
      JSON.stringify({ kind: 'tool', action: { name: 'write_diagnosis_report', report: { observations: [], directions: [{ id: 'convergence', layer: 'skill', goal: '...', evidenceRefs: [], unknowns: [], cost: 'low' }, { id: 'no-change', layer: 'no_change', goal: '...', evidenceRefs: [], unknowns: [], cost: 'none' }], question: { question: '请选择优先方向。', options: [{ id: 'convergence', label: '优先收敛' }, { id: 'no-change', label: '暂不修改' }], whyNow: '现有证据无法推出优先级', evidenceRefs: [] } } } }),
      ...(diagnosisMode ? [] : [
        JSON.stringify({ kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'loop-evolution', payload: { id: 'candidate-id', displayName: '...', source: { kind: 'builder-generated', baseline: { uri: '...', ref: '...' }, edits: [] }, packageName: '...', entry: 'lib/index.js', config: {}, expectedOutcome: '...', capabilities: [] }, rationale: '...' } } }),
        JSON.stringify({ kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'patch-evolution', payload: { id: 'patch-id', targetId: '...', targetKind: 'config', action: 'update', config: {}, dependencies: [], rationale: '...', expectedOutcome: '...', version: 1, createdAt: '...' }, rationale: '...' } } }),
      ]),
      JSON.stringify({ kind: 'continue', summary: '根据刚才工具反馈继续' }),
      ...(diagnosisMode ? [] : [JSON.stringify({ kind: 'submit' })]),
      JSON.stringify({ kind: 'abort', reason: '证据不足或不能安全提交' }),
      '出现 error/rejection 时，不把错误文本当结论。先按需沿事实关系追因：trace_artifact(error/report) → consumer 的实际输入 → producer/prior run → inspect_file 接口/实现 → 自主编辑、实验、提问、提交或 abort。每个因果主张必须引用已读文件或工具反馈；图谱不提供修复答案。工具报错和命令的 stdout/stderr 是下一轮可见反馈；由你判断可否纠正、继续或 abort。预检不是 verifier 通过。',
      ...(evidenceSatisfied ? [evidenceSatisfied] : []),
      ...(progressBanner ? [progressBanner] : []),
      ...(context.progressState.progressRequirement !== 'none'
        ? [`KERNEL PROGRESS CHECKPOINT (deterministic, temporary): ${context.progressState.progressRequirement === 'declare_direction'
          ? '先 write_world_model 或 write_plan 公开一个可证伪方向；也可以 request_input、write_submission 或 abort。不要继续读取。'
          : '先产生新证据（invoke_capability 仿真、run_workspace_command、workspace 编辑、request_input 或 write_submission）。不要继续读取。'}`]
        : []),
      !diagnosisMode && this.options.draftKind === 'loop_candidate'
        ? '本 run 可将 loop candidate 作为 `loop-evolution` capability proposal。你可先探索来源、源码、构建和测试，再选择提交何种可审计变更。'
        : !diagnosisMode ? '本 run 的 draft 是 { patch: MetaPatch, expectedTrajectory, selfCheck, worldModel? }。' : '',
      `任务上下文：\n${this.options.taskContext.slice(0, 28_000)}`,
      'actor 在本 run 开始后的新观察会写入 durable inbox；它们不是命令，你应结合证据自行决定是否调整路线。',
      `本回合先恢复 compact progress-state，再按需读取原始证据；progress-state 是公开工作记忆，不是隐藏思维链。\ncompact progress-state：\n${JSON.stringify(context.progressState)}`,
      `内核上下文（不可修改输入；原始 actor/target/journal 通过工具按需读取）：\n${JSON.stringify({
        run: context.run,
        input: {
          actor: { available: true, hash: sha256(context.input.actor), keys: Object.keys(context.input.actor).slice(0, 32) },
          targetBefore: { available: true, hash: sha256(context.input.targetBefore), keys: Object.keys(context.input.targetBefore).slice(0, 32) },
          previousAttempt: context.input.previousAttempt ? { available: true, hash: sha256(context.input.previousAttempt), keys: Object.keys(context.input.previousAttempt).slice(0, 32) } : null,
          previousRun: context.input.previousRun ? { available: true, runId: context.input.previousRun.runId, lineageId: context.input.previousRun.lineageId, assets: context.input.previousRun.assets.slice(0, 16) } : null,
        },
        messages,
        pendingMessageIds: pendingMessages.map((message) => message.id),
        journalTail: journal.slice(-6),
      })}`.slice(0, 28_000),
    ].join('\n\n')
  }

  private compactPrompt(context: ReturnType<BuilderKernel['context']>, pendingMessages: Array<{ id: string; rawUserText: unknown; actorMemo?: unknown; evidenceRefs?: unknown }>, progressBanner: string): string {
    const diagnosisMode = context.run.mode === 'diagnosis'
    const readOnlyDiagnosis = diagnosisMode && this.options.readOnlyDiagnosis === true
    const capabilities = new BuilderCapabilityRegistry().registerAll(this.options.capabilities ?? [])
    const latestFeedback = [...context.journal].reverse().find((entry) => entry.kind === 'tool' || entry.kind === 'error')
    const evidenceSatisfied = context.run.state === 'ready_to_submit' && this.options.successMarker
      ? `Oracle evidence satisfied (marker=${this.options.successMarker}). The Kernel now accepts only write_submission, submit, or abort for this pass; do not keep exploring or edit the verified workspace.`
      : ''
    const previousAttempt = context.input.previousAttempt as Record<string, unknown> | null | undefined
    const rejectionFacts = previousAttempt && (previousAttempt.verdict === 'rejected' || previousAttempt.failureSummary)
      ? {
          verdict: typeof previousAttempt.verdict === 'string' ? previousAttempt.verdict : 'rejected',
          failureSummary: typeof previousAttempt.failureSummary === 'string' ? previousAttempt.failureSummary.slice(0, 1_200) : undefined,
          firstDivergence: previousAttempt.firstDivergence ?? undefined,
          previousCandidatePath: typeof previousAttempt.previousCandidatePath === 'string' ? previousAttempt.previousCandidatePath : undefined,
          oraclePath: typeof previousAttempt.oraclePath === 'string' ? previousAttempt.oraclePath : undefined,
        }
      : null
    const protocol = [
      'tool read_input {document: actor|target_before|context_index|provenance|progress_state|world_model|plan|previous_attempt|previous_run}',
      'tool read_journal {limit}',
      'tool read_file {path}; list_directory {path}; inspect_file {path}; trace_artifact {artifact: id|absolutePath}',
      'tool search_text {query,roots?: string[],maxResults?: number}; it is read-only argv search, never write a shell pipeline into command.',
      readOnlyDiagnosis
        ? 'No workspace mutation, command execution, simulation, submission, verifier, gate, or install tools exist in this pass.'
        : 'tool read_workspace_file {path}; write_workspace_file {path,content}; apply_workspace_patch {patch: unified git diff}; run_workspace_command {command,args?: string[],timeoutMs?: number}',
      'tool acknowledge_message {messageId,status,understanding,nextAction?}',
      'tool request_input {kind?,question,options?,whyNow?,evidenceRefs?,blocking?}',
      'tool write_world_model/write_plan {value:{hypothesis:"...",nextIntent:"..."}}',
      readOnlyDiagnosis ? '' : 'tool invoke_capability {capability,tool,input}',
      diagnosisMode
        ? 'tool write_diagnosis_report {report:{directions:[{id:string,layer:"config"|"skill"|"loop"|"no_change",goal:string,evidenceRefs:string[],unknowns:string[],cost:string}],question:{question:string,options:[{id:string,label:string,description?:string}],whyNow:string,evidenceRefs:string[]}}}; every option id must name a direction id; then wait for user direction'
        : 'tool write_submission {proposal}; for a workspace loop edit use compile_loop_submission {rationale,expectedOutcome?}; then submit when evidence is sufficient',
      !diagnosisMode ? 'For a verified workspace loop candidate, call compile_loop_submission after tests pass; Kernel derives exact beforeHash/after edits from the captured workspace, then call submit.' : '',
      'decision is exactly one JSON object: {kind:"tool",action} | {kind:"continue",summary} | {kind:"submit"} | {kind:"abort",reason}',
      'Tool arguments are direct fields of action; action.input and action.params are equivalent wrappers.',
    ].join('\n')
    return [
      this.options.systemPrompt,
      readOnlyDiagnosis
        ? 'You are a persistent read-only Builder diagnosis loop. Choose whether to read, inspect, trace, maintain a public hypothesis/plan, ask Actor/user, write a diagnosis report, or abort. Actor is the translator and the user owns the direction choice. This pass cannot edit, execute, simulate, submit, verify, install, or claim improvement.'
        : 'You are a persistent Builder micro-loop. Keep cognition open: choose whether to read, hypothesize, simulate, edit, ask Actor/user, submit, or abort. Do not ask when evidence is sufficient; do ask when a product choice or verification decision cannot be inferred. Actor is the translator; verifier/gate/install are independent final authorities. Tool errors are feedback: correct and retry or ask/abort; verifier rejection creates a new immutable run with previous-attempt evidence.',
      diagnosisMode ? 'This is an explicitly requested diagnosis pass: report 1–3 evidence-backed directions and a blocking question, then wait. No proposal.' : 'This is an implementation pass: form a falsifiable hypothesis, use evidence/simulation as useful, and submit only a concrete auditable proposal.',
      `Tools (minimal protocol):\n${protocol}`,
      `Capability ids (metadata is available from the context index): ${capabilities.list().map((capability) => capability.id).join(', ') || '(none)'}`,
      `Task objective and entry points (authoritative handoff):\n${this.options.taskContext.slice(0, 1_800)}`,
      `Durable context index: ${String(context.contextIndex.path ?? 'read_input(context_index)')}. It contains every durable file address and a one-line content overview. Read it first only when you need to locate evidence; then read only the necessary entry.`,
      rejectionFacts
        ? `Previous attempt rejection (facts, not pointers): ${JSON.stringify(rejectionFacts)}. Your job is to fix the candidate so it satisfies the oracle at oraclePath: read previousCandidatePath (read-only), make the minimal correction, and write the repaired file to YOUR OWN workspace using a relative path such as actor-loop.mjs (the workspace tool is already rooted at your workspace; do not write to previousCandidatePath), run the oracle command against your workspace file, then write_submission and submit.`
        : '',
      `Artifact/provenance graph: ${JSON.stringify({ path: 'read_input(provenance)', artifactCount: context.provenance.artifacts.length, failureIds: context.provenance.artifacts.filter((artifact) => artifact.role === 'failure_report').map((artifact) => artifact.id), candidateIds: context.provenance.artifacts.filter((artifact) => artifact.role === 'candidate').map((artifact) => artifact.id) })}. For an error or rejection, trace the report/candidate artifact before guessing a repair.`,
      `Pending Actor messages: ${JSON.stringify(pendingMessages.map((message) => ({ id: message.id, rawUserText: message.rawUserText, actorMemo: message.actorMemo, evidenceRefs: message.evidenceRefs })))}`,
      `Compact progress state: ${JSON.stringify(context.progressState)}`,
      `Recent feedback index: ${JSON.stringify(context.journal.slice(-4).map((entry) => ({ seq: entry.seq, kind: entry.kind, action: entry.action, resultHash: entry.result ? sha256(entry.result) : undefined, error: entry.error })))}`,
      latestFeedback
        ? `Latest observable tool feedback (compressed; use it before rereading): ${JSON.stringify({ seq: latestFeedback.seq, kind: latestFeedback.kind, action: latestFeedback.action, ...(latestFeedback.result ? { result: compactPromptValue(latestFeedback.result, 1_200) } : {}), ...(latestFeedback.error ? { error: latestFeedback.error.slice(0, 800) } : {}) })}`
        : '',
      context.progressState.progressRequirement === 'write_submission'
        ? 'KERNEL DELIVERY CHECKPOINT: the last submit was rejected because no proposal draft exists. The only valid next tool is write_submission with the concrete verified candidate proposal; do not call submit again until it succeeds.'
        : context.progressState.progressRequirement === 'produce_evidence'
          ? 'KERNEL EVIDENCE CHECKPOINT: the candidate was edited. The next tool must produce fresh evidence (run the oracle/simulation or request verification) before another edit or submission.'
        : '',
      'The immutable actor snapshot and Actor messages are the task handoff. Read actor only if the pending message, provenance graph and index do not identify the next evidence. Treat errors as pointers into artifacts: trace → inspect → change/test, not as an instruction to repeat a broad read.',
      evidenceSatisfied,
      progressBanner,
    ].filter(Boolean).join('\n\n')
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
      nativeTools: builderNativeTools(this.options.readOnlyDiagnosis === true),
    })) {
      if (chunk.kind === 'block-start') inText = chunk.type === 'text'
      else if (chunk.kind === 'block-end') inText = false
      else if (chunk.kind === 'text-delta' && inText && typeof chunk.text === 'string') out += chunk.text
      else if (chunk.kind === 'usage' && chunk.usage) this.options.onUsage?.({ prompt: chunk.usage.prompt ?? 0, completion: chunk.usage.completion ?? 0 })
    }
    return out
  }

  private parseDecision(text: string): BuilderDecision {
    const json = firstCompleteJsonObject(text)
    if (!json) throw new Error(`no JSON decision: ${JSON.stringify(text.slice(0, 200))}`)
    const value = JSON.parse(json) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('decision must be an object')
    // Native function-call providers commonly wrap the protocol object in a
    // single named argument (`{ decision: {...} }`).  Unwrapping this transport
    // envelope does not broaden the decision grammar: the exact same strict
    // allowlist below validates the inner object.
    const rawValue = value as Record<string, unknown>
    const decision: Record<string, unknown> = isObject(rawValue.decision)
      ? rawValue.decision
      : rawValue
    const kind = decision.kind
    // Required fields are strict; harmless model-added metadata is ignored so
    // the micro-loop can recover from ordinary JSON wrappers without narrowing
    // the Builder's exploratory choices.
    if (kind === 'continue' && typeof decision.summary === 'string') return { kind, summary: decision.summary }
    if (kind === 'abort' && typeof decision.reason === 'string') return { kind, reason: decision.reason }
    if (kind === 'submit') return { kind }
    if (kind === 'tool') {
      const rawAction = isObject(decision.action)
        ? decision.action
        : typeof decision.action === 'string'
          ? { ...decision, name: decision.action }
          : null
      if (rawAction) {
        // V4 Flash sometimes emits the tool name as `action` inside the
        // action object. Normalize that harmless wrapper before allowlisting.
        // Providers commonly call this transport wrapper `input` or `params`.
        // Both normalize to the same already-allowlisted arguments.
        const input = isObject(rawAction.input)
          ? rawAction.input
          : isObject(rawAction.params)
            ? rawAction.params
            : {}
        const normalized = rawAction.name === undefined && typeof rawAction.action === 'string'
          ? { ...rawAction, ...input, name: rawAction.action }
          : rawAction.name === undefined && typeof rawAction.tool === 'string'
            ? { ...rawAction, ...input, name: rawAction.tool }
            : rawAction.name !== undefined && (isObject(rawAction.input) || isObject(rawAction.params))
              ? { ...rawAction, ...input }
              : rawAction
        return { kind, action: this.parseTool(normalized) }
      }
    }
    throw new Error('decision does not match the allowlisted protocol')
  }

  private parseTool(action: Record<string, unknown>): BuilderToolAction {
    if (action.name === 'read_input' && isOneOf(action.document, ['actor', 'target_before', 'previous_attempt', 'previous_run', 'world_model', 'plan', 'progress_state', 'context_index', 'provenance'])) return { name: action.name, document: action.document }
    if (action.name === 'read_journal' && typeof action.limit === 'number' && Number.isFinite(action.limit)) return { name: action.name, limit: action.limit }
    if (action.name === 'write_world_model' && isObject(action.value)) return { name: action.name, value: action.value }
    if (action.name === 'write_plan' && isObject(action.value)) return { name: action.name, value: action.value }
    if (action.name === 'read_file' && typeof action.path === 'string') return { name: action.name, path: action.path }
    if (action.name === 'list_directory' && typeof action.path === 'string') return { name: action.name, path: action.path }
    if (action.name === 'search_text' && typeof action.query === 'string'
      && (action.roots === undefined || (Array.isArray(action.roots) && action.roots.every((root) => typeof root === 'string')))
      && (action.maxResults === undefined || (typeof action.maxResults === 'number' && Number.isFinite(action.maxResults)))) {
      return { name: action.name, query: action.query, ...(action.roots === undefined ? {} : { roots: action.roots }), ...(action.maxResults === undefined ? {} : { maxResults: action.maxResults }) }
    }
    if (action.name === 'inspect_file' && typeof action.path === 'string') return { name: action.name, path: action.path }
    if (action.name === 'trace_artifact' && typeof action.artifact === 'string') return { name: action.name, artifact: action.artifact }
    if (action.name === 'write_workspace_file' && typeof action.path === 'string' && typeof action.content === 'string') return { name: action.name, path: action.path, content: action.content }
    if (action.name === 'apply_workspace_patch' && typeof action.patch === 'string') return { name: action.name, patch: action.patch }
    if (action.name === 'read_workspace_file' && typeof action.path === 'string') return { name: action.name, path: action.path }
    if (action.name === 'run_workspace_command' && typeof action.command === 'string' && (action.args === undefined || (Array.isArray(action.args) && action.args.every(arg => typeof arg === 'string')))
      && (action.timeoutMs === undefined || typeof action.timeoutMs === 'number')) {
      return { name: action.name, command: action.command, ...(action.args === undefined ? {} : { args: action.args }), ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }) }
    }
    if (action.name === 'write_diagnosis_report' && isObject(action.report)) return { name: action.name, report: action.report }
    if (action.name === 'acknowledge_message' && typeof action.messageId === 'string' && typeof action.status === 'string' && typeof action.understanding === 'string'
      && (action.nextAction === undefined || typeof action.nextAction === 'string') && (action.question === undefined || typeof action.question === 'string')) {
      return {
        name: action.name,
        messageId: action.messageId,
        status: action.status,
        understanding: action.understanding,
        ...(action.nextAction === undefined ? {} : { nextAction: action.nextAction }),
        ...(action.question === undefined ? {} : { question: action.question }),
      }
    }
    if (action.name === 'publish_progress' && typeof action.summary === 'string'
      && (action.phase === undefined || typeof action.phase === 'string') && (action.question === undefined || typeof action.question === 'string')) {
      return {
        name: action.name,
        summary: action.summary,
        ...(action.phase === undefined ? {} : { phase: action.phase }),
        ...(action.question === undefined ? {} : { question: action.question }),
      }
    }
    if (action.name === 'request_input' && typeof action.question === 'string' && (action.context === undefined || typeof action.context === 'string')
      && (action.kind === undefined || isOneOf(action.kind, ['clarification', 'choice', 'verification']))
      && (action.whyNow === undefined || typeof action.whyNow === 'string')
      && (action.blocking === undefined || typeof action.blocking === 'boolean')
      && (action.evidenceRefs === undefined || (Array.isArray(action.evidenceRefs) && action.evidenceRefs.every((ref) => typeof ref === 'string')))
      && (action.options === undefined || (Array.isArray(action.options) && action.options.every((option) => isObject(option) && typeof option.id === 'string' && typeof option.label === 'string' && (option.description === undefined || typeof option.description === 'string'))))) {
      return {
        name: action.name,
        question: action.question,
        ...(action.context === undefined ? {} : { context: action.context }),
        ...(action.kind === undefined ? {} : { kind: action.kind }),
        ...(action.options === undefined ? {} : { options: action.options.map((option) => ({ id: option.id as string, label: option.label as string, ...(typeof option.description === 'string' ? { description: option.description } : {}) })) }),
        ...(action.whyNow === undefined ? {} : { whyNow: action.whyNow }),
        ...(action.evidenceRefs === undefined ? {} : { evidenceRefs: action.evidenceRefs as string[] }),
        ...(action.blocking === undefined ? {} : { blocking: action.blocking }),
      }
    }
    if (action.name === 'invoke_capability' && typeof action.capability === 'string' && typeof action.tool === 'string' && isObject(action.input)) {
      return { name: action.name, capability: action.capability, tool: action.tool, input: action.input }
    }
    if (action.name === 'write_submission' && isObject(action.proposal)) return { name: action.name, proposal: action.proposal }
    if (action.name === 'compile_loop_submission' && typeof action.rationale === 'string' && (action.expectedOutcome === undefined || typeof action.expectedOutcome === 'string')) return { name: action.name, rationale: action.rationale, ...(action.expectedOutcome === undefined ? {} : { expectedOutcome: action.expectedOutcome }) }
    if (action.name === 'compile_config_submission' && typeof action.rationale === 'string' && (action.expectedOutcome === undefined || typeof action.expectedOutcome === 'string')) return { name: action.name, rationale: action.rationale, ...(action.expectedOutcome === undefined ? {} : { expectedOutcome: action.expectedOutcome }) }
    if (action.name === 'compile_module_submission' && typeof action.rationale === 'string' && (action.expectedOutcome === undefined || typeof action.expectedOutcome === 'string')) return { name: action.name, rationale: action.rationale, ...(action.expectedOutcome === undefined ? {} : { expectedOutcome: action.expectedOutcome }) }
    if (action.name === 'write_candidate_draft' && isObject(action.proposal)) return { name: action.name, proposal: action.proposal }
    if (action.name === 'inspect_staging' && typeof action.path === 'string') return { name: action.name, path: action.path }
    if (action.name === 'preflight_staging_entry' && typeof action.entry === 'string') return { name: action.name, entry: action.entry }
    throw new Error(`tool is not allowlisted: ${String(action.name)}`)
  }
}

/** Native schemas make the existing Kernel tools visible as callable actions.
 * They are transport metadata only; parseTool remains the sole allowlist. */
function builderNativeTools(readOnlyDiagnosis = false): LlmNativeTool[] {
  const object = (properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false })
  const string = { type: 'string' }
  const number = { type: 'number' }
  const value = { type: 'object' }
  const tools: Array<[string, string, Record<string, unknown>]> = [
    ['read_input', 'Read one immutable Builder input document.', object({ document: { type: 'string', enum: ['actor', 'target_before', 'context_index', 'provenance', 'progress_state', 'world_model', 'plan', 'previous_attempt', 'previous_run'] } }, ['document'])],
    ['read_journal', 'Read recent durable Builder tool and decision feedback.', object({ limit: number })],
    ['read_file', 'Read a global or workspace-relative file.', object({ path: string }, ['path'])],
    ['list_directory', 'List a global or workspace-relative directory.', object({ path: string }, ['path'])],
    ['search_text', 'Search text under workspace-relative or absolute roots.', object({ query: string, roots: { type: 'array', items: string }, maxResults: number }, ['query'])],
    ['inspect_file', 'Inspect exports, imports and preview of a source file.', object({ path: string }, ['path'])],
    ['trace_artifact', 'Trace a factual provenance artifact.', object({ artifact: string }, ['artifact'])],
    ['write_world_model', 'Persist an explicit hypothesis and next intent.', object({ value }, ['value'])],
    ['write_plan', 'Persist a public plan.', object({ value }, ['value'])],
    ['write_diagnosis_report', 'Persist diagnosis directions and user choice.', object({ report: value }, ['report'])],
    ['write_workspace_file', 'Write a file in this immutable Builder workspace.', object({ path: string, content: string }, ['path', 'content'])],
    ['apply_workspace_patch', 'Apply a unified diff in this Builder workspace.', object({ patch: string }, ['patch'])],
    ['read_workspace_file', 'Read a file in this Builder workspace.', object({ path: string }, ['path'])],
    ['run_workspace_command', 'Run an argv command in this Builder workspace.', object({ command: string, args: { type: 'array', items: string }, timeoutMs: number }, ['command'])],
    ['acknowledge_message', 'Acknowledge an Actor message.', object({ messageId: string, status: string, understanding: string, nextAction: string, question: string }, ['messageId', 'status', 'understanding'])],
    ['publish_progress', 'Publish a user-visible progress summary.', object({ summary: string, phase: string, question: string }, ['summary'])],
    ['request_input', 'Request clarification, choice, or verification from Actor.', object({ kind: string, question: string, context: string, whyNow: string, evidenceRefs: { type: 'array', items: string }, blocking: { type: 'boolean' }, options: { type: 'array', items: value } }, ['question'])],
    ['invoke_capability', 'Invoke a registered capability tool.', object({ capability: string, tool: string, input: value }, ['capability', 'tool', 'input'])],
    ['write_submission', 'Freeze a concrete proposal draft.', object({ proposal: value }, ['proposal'])],
    ['compile_loop_submission', 'Compile a loop proposal from captured workspace edits.', object({ rationale: string, expectedOutcome: string }, ['rationale'])],
    ['compile_config_submission', 'Compile a config proposal from the host-materialized actor-config.json edit.', object({ rationale: string, expectedOutcome: string }, ['rationale'])],
    ['compile_module_submission', 'Compile a tool or skill proposal from the host-materialized actor-module bundle.', object({ rationale: string, expectedOutcome: string }, ['rationale'])],
    ['submit', 'Submit the already frozen proposal.', object()],
    ['continue', 'Continue after tool feedback.', object({ summary: string }, ['summary'])],
    ['abort', 'Abort with an evidence-backed reason.', object({ reason: string }, ['reason'])],
  ]
  const forbidden = new Set([
    'write_workspace_file', 'apply_workspace_patch', 'run_workspace_command', 'invoke_capability',
    'write_submission', 'compile_loop_submission', 'compile_config_submission', 'compile_module_submission',
    'write_candidate_draft', 'preflight_staging_entry', 'submit',
  ])
  return tools.filter(([name]) => !readOnlyDiagnosis || !forbidden.has(name)).map(([name, description, parameters]) => ({ name, description, parameters }))
}

/**
 * Some providers append a stray closing brace after an otherwise complete
 * decision. Recover the first balanced JSON object only; tool allowlisting
 * and schema validation still happen below.
 */
function firstCompleteJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaping = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaping) escaping = false
      else if (char === '\\') escaping = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth++
    if (char === '}') {
      depth--
      if (depth === 0) return text.slice(start, index + 1)
      if (depth < 0) return null
    }
  }
  return null
}

/** A verified bounded pass may only finalize its already-tested candidate. */
function isCompletionDecision(decision: BuilderDecision): boolean {
  return decision.kind === 'submit'
    || decision.kind === 'abort'
    || (decision.kind === 'tool' && decision.action.name === 'write_submission')
}

function deriveProgressBanner(journal: ReturnType<BuilderKernel['context']>['journal']): string {
  const toolEntries = journal.filter((entry) => entry.kind === 'tool')
  const last = toolEntries.at(-1)
  if (!last || !isReadActionName(last.action) || !last.result?.observation || typeof last.result.observation !== 'object') return ''
  const observation = last.result.observation as Record<string, unknown>
  if (observation.newInformation !== false) return ''
  const target = typeof last.result.path === 'string'
    ? last.result.path
    : typeof last.result.document === 'string'
      ? last.result.document
      : last.action
  let streak = 1
  for (let i = toolEntries.length - 2; i >= 0; i--) {
    const entry = toolEntries[i]
    if (entry.action !== last.action || readResultTarget(entry.result) !== target || !hasUnchangedObservation(entry.result)) break
    streak++
  }
  return `PROGRESS BANNER (textual hint, not a permission grant): the last ${streak} read actions observed unchanged information for ${target}. Do not repeat that same read unless you have a concrete reason; choose a state-changing action (write_world_model/write_plan/workspace edit), simulation, request_input, write_submission, submit, or abort.`
}

function hasUnchangedObservation(result: Record<string, unknown> | undefined): boolean {
  if (!result || typeof result.observation !== 'object' || result.observation === null) return false
  return (result.observation as Record<string, unknown>).newInformation === false
}

function isReadActionName(action: string): boolean {
  return action === 'read_file' || action === 'read_input' || action === 'read_journal' || action === 'list_directory' || action === 'read_workspace_file'
}

function readResultTarget(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return undefined
  if (typeof result.path === 'string') return result.path
  if (typeof result.document === 'string') return result.document
  return result.entries !== undefined ? 'journal' : undefined
}

function compactPromptValue(value: unknown, maxBytes: number): unknown {
  const encoded = JSON.stringify(value)
  if (encoded.length <= maxBytes) return value
  return { truncated: true, originalBytes: Buffer.byteLength(encoded, 'utf8'), preview: encoded.slice(0, maxBytes - 120) }
}

function compactText(value: string, maxChars: number): string | { truncated: true; originalChars: number; preview: string } {
  if (value.length <= maxChars) return value
  return { truncated: true, originalChars: value.length, preview: value.slice(0, maxChars) }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function abortReason(journal: Array<{ kind: string; action: string; error?: string; result?: Record<string, unknown> }>): string | undefined {
  const abort = [...journal].reverse().find((entry) => entry.kind === 'model' && entry.action === 'decision' && entry.result?.kind === 'abort')
  return typeof abort?.result?.reason === 'string' ? abort.result.reason : undefined
}
