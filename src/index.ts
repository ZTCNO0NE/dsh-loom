import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Gate } from './gate/index.js'
import { AutoPilot } from './meta/autopilot.js'
import { IterationLoop } from './meta/loop.js'
import { Proposer } from './meta/propose.js'
import { ReviewGate } from './meta/review.js'
import { TurnBoundaryHook } from './meta/turnboundary.js'
import { collectFramesForPatch } from './meta/collectFrames.js'
import { Observer } from './observer/index.js'
import { Validator, type ActualEvent } from './validate/index.js'
import {
  appendJsonl,
  atomicWriteJson,
  ensureWorkspace,
  metaRoot,
  paths,
  PROTOCOL_VERSION,
  readJson,
  readJsonl,
  sha256,
} from './protocol/index.js'
import type { IsolationOptions } from './isolation/runner.js'
import { runIsolation } from './isolation/runner.js'
import { childEnv } from './isolation/runner.js'
import { officialDeepSeekLlm, terraLlm } from './llm/official.js'
import { BuilderCredentialResolver, type CredentialServiceLike } from './llm/credentials.js'
import { LoopCandidateGateway } from './candidates/gateway.js'
import { miniSweChildEnv } from './builder/mini-swe-env.js'
import { bundledMiniSwePaths } from './builder/bundled-mini-swe.js'
import { ActorEvolutionGateway } from './candidates/actor-gateway.js'
import { UserEvolutionController, type UserEvolutionPlan, type UserEvolutionTargetKind } from './evolution/controller.js'
import { userEvolutionTaskCard } from './evolution/presentation.js'
import { EvolutionTaskSessionStore } from './evolution/task-session.js'
import { CandidateImporter, CandidateRegistry, type CandidateManifest, type ContractEvidence, type LoopInstallReport } from './candidates/index.js'
import { profileGateOps } from './candidates/profile-gate.js'
import { createCandidateProfile } from './candidates/profile.js'
import { installVerifiedCandidate } from './candidates/lifecycle.js'
import { adjudicatePatch, adjudicateLoop, classifyBuilderProposal, type BuilderProposal } from './deliberation/index.js'
import { createActorEvidencePack, readActorEvidencePack, type ActorEvidencePack } from './evidence/index.js'
import { runActorReplay, writeActorComparison, type ActorComparison } from './evidence/comparison.js'
import type { MetaPatch, PatchStatus } from './types.js'
import { DEFAULT_LOCKED_TARGETS, type LockedTargetPolicy } from './policy.js'
import {
  appendLedger,
  appendReport,
  readLedger,
  readPreferences,
  scenarioOf,
} from './growth/index.js'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Resolve the package root from an entry such as `dsh-loom/dist/index.js`. */
export function pluginRootFromModuleUrl(moduleUrl: string): string {
  // One parent is the package root; two parents incorrectly resolve to the
  // surrounding `node_modules` directory and lose the vendored mini-SWE config.
  return fileURLToPath(new URL('..', moduleUrl))
}

const PLUGIN_ROOT = pluginRootFromModuleUrl(import.meta.url)

export const name = 'dsh-meta-validate'

// DSH owns secrets and their hot-reload lifecycle. Loom consumes only this
// service seam; it never reads or persists the credentials document itself.
export const inject = ['tools', 'agents', 'loader', 'credentials'] as const

export interface MetaValidateConfig {
  mode: 'observe' | 'propose' | 'apply'
  /** Scheduled background refine: meta tools return immediately, completion is injected. */
  scheduled: boolean
  regressionDir: string
  maxPendingPatches: number
  maxSignalsPerCycle: number
  maxIterations: number
  sessionId: string
  workspaceRoot?: string
  skillRoot: string
  skillStagingRoot: string
  thresholds: {
    repeatedFailureCount: number
    regressionFailureCount: number
  }
  llm: {
    provider: string
    model: string
    /** Advanced: a DSH credential reference, never a secret value. */
    credentialRef: string
  }
  builder: {
    maxModelTurns: number
    maxToolSteps: number
    maxTokens: number
    maxWallTimeMs: number
  }
  isolation: {
    enabled: boolean
    dshCommand: string[]
    cwd: string
    profile: string
    baseOverlays: string[]
    probe: string
    probeTimeoutMs: number
  }
  reviewGate: {
    enabled: boolean
    minIntervalTurns: number
    maxIterationsPerEpoch: number
    prompt: string
    postLoopMaxRounds: number
    autoIngestUserMessages: boolean
    stallAbort: {
      enabled: boolean
      maxTurnSeconds: number
      maxStepsPerTurn: number
      checkIntervalMs: number
    }
  }
  notify: {
    start: boolean
    progress: boolean
    progressAfterMs: number
    completion: boolean
  }
  allowLoopCandidates: {
    enabled: boolean
    runtimeRoot: string
    maxTokens: number
    buildDependencyRoot: string
    baselineRoot: string
    baseBundle: string
    dependencyRoot: string
    additionalDependencyRoots: string[]
    contractCommand: string[]
    contractTask: string
    goldenPath: string
    builderMaxReopenAttempts: number
    builderMaxModelTurns: number
    builderMaxToolSteps: number
    builderMaxWallTimeMs: number
    diagnosisFirst: boolean
    repeatReadRejectAfter: number
    enforceProgressCheckpoints: boolean
    executionRuntime: 'loom-native' | 'mini-swe'
    miniSweExecutable: string
    miniSweConfigPath: string
    miniSweDependencySnapshot: string
    miniSweStepLimit: number
  }
  /** Explicit user-facing Config/Skill execution runtime. Disabled by default. */
  activeEvolution: {
    enabled: boolean
    /** Optional user-owned bootstrap cache; default lives below the Loom meta root. */
    runtimeRoot: string
    miniSweExecutable: string
    miniSweConfigPath: string
    miniSweStepLimit: number
    timeoutMs: number
  }
  lockedTargets: LockedTargetPolicy
}

export const Config: Schema<MetaValidateConfig> = Schema.object({
  mode: Schema.union(['observe', 'propose', 'apply']).default('observe'),
  scheduled: Schema.boolean().default(false),
  regressionDir: Schema.string().default('./meta-regressions'),
  maxPendingPatches: Schema.number().default(8),
  maxSignalsPerCycle: Schema.number().default(50),
  maxIterations: Schema.number().default(5),
  sessionId: Schema.string().default('default-session'),
  workspaceRoot: Schema.string().default(''),
  skillRoot: Schema.string().default(''),
  skillStagingRoot: Schema.string().default(''),
  thresholds: Schema.object({
    repeatedFailureCount: Schema.number().default(3),
    regressionFailureCount: Schema.number().default(1),
  }),
  llm: Schema.object({
    provider: Schema.string().default('deepseek-official'),
    model: Schema.string().default('deepseek-v4-flash'),
    credentialRef: Schema.string().default(''),
  }),
  builder: Schema.object({
    maxModelTurns: Schema.number().default(12),
    maxToolSteps: Schema.number().default(16),
    maxTokens: Schema.number().default(6000),
    maxWallTimeMs: Schema.number().default(180000),
  }),
  isolation: Schema.object({
    enabled: Schema.boolean().default(false),
    dshCommand: Schema.array(Schema.string()).default(['dsh']),
    cwd: Schema.string().default('.'),
    profile: Schema.string().default('headless'),
    baseOverlays: Schema.array(Schema.string()).default([]),
    probe: Schema.string().default('reply with ok'),
    probeTimeoutMs: Schema.number().default(120000),
  }),
  reviewGate: Schema.object({
    enabled: Schema.boolean().default(true),
    minIntervalTurns: Schema.number().default(10),
    maxIterationsPerEpoch: Schema.number().default(2),
    prompt: Schema.string().default('你是监督检测器：基于 actor 运行时摘要（关键指标，非全量）判断是否值得唤起 builder 做一次全量感知迭代。只输出 JSON。'),
    postLoopMaxRounds: Schema.number().default(2),
    autoIngestUserMessages: Schema.boolean().default(true),
    stallAbort: Schema.object({
      enabled: Schema.boolean().default(true),
      maxTurnSeconds: Schema.number().default(300),
      maxStepsPerTurn: Schema.number().default(30),
      checkIntervalMs: Schema.number().default(30000),
    }),
  }),
  notify: Schema.object({
    start: Schema.boolean().default(true),
    progress: Schema.boolean().default(false),
    progressAfterMs: Schema.number().default(120000),
    completion: Schema.boolean().default(true),
  }),
  allowLoopCandidates: Schema.object({
    enabled: Schema.boolean().default(false),
    runtimeRoot: Schema.string().default(''),
    maxTokens: Schema.number().default(4096),
    buildDependencyRoot: Schema.string().default(''),
    baselineRoot: Schema.string().default(''),
    baseBundle: Schema.string().default(''),
    dependencyRoot: Schema.string().default(''),
    additionalDependencyRoots: Schema.array(Schema.string()).default([]),
    contractCommand: Schema.array(Schema.string()).default([]),
    contractTask: Schema.string().default('reply with ok'),
    goldenPath: Schema.string().default(''),
    builderMaxReopenAttempts: Schema.number().default(3),
    builderMaxModelTurns: Schema.number().default(24),
    builderMaxToolSteps: Schema.number().default(48),
    builderMaxWallTimeMs: Schema.number().default(600000),
    // Builder remains free to decide whether evidence is insufficient and ask
    // the Actor. Controllers may explicitly opt into a diagnosis-only pass,
    // but a broad request must not be converted into a mandatory form flow.
    diagnosisFirst: Schema.boolean().default(false),
    repeatReadRejectAfter: Schema.number().default(0),
    enforceProgressCheckpoints: Schema.boolean().default(false),
    // v1.2: Loom-native is a diagnosis/clarification kernel, not the Loop
    // implementation runtime. Real source changes run through mini-SWE.
    executionRuntime: Schema.union(['loom-native', 'mini-swe']).default('mini-swe'),
    miniSweExecutable: Schema.string().default(''),
    miniSweConfigPath: Schema.string().default(''),
    miniSweDependencySnapshot: Schema.string().default(''),
    miniSweStepLimit: Schema.number().default(30),
  }),
  activeEvolution: Schema.object({
    enabled: Schema.boolean().default(false),
    runtimeRoot: Schema.string().default(''),
    miniSweExecutable: Schema.string().default(''),
    miniSweConfigPath: Schema.string().default(''),
    miniSweStepLimit: Schema.number().default(30),
    timeoutMs: Schema.number().default(600000),
  }),
  lockedTargets: Schema.object({
    ids: Schema.array(Schema.string()).default(DEFAULT_LOCKED_TARGETS.ids),
    names: Schema.array(Schema.string()).default(DEFAULT_LOCKED_TARGETS.names),
  }),
})

export function apply(ctx: Context, config: MetaValidateConfig) {
  const root = config.workspaceRoot || metaRoot()
  ensureWorkspace(root, config.sessionId)

  // dsh rebuilds its loader tree between turns (observed: after the first
  // applied update the tree collapses to include + plugin entry). All config
  // reads/writes therefore merge a lazily-captured baseline with live entries.
  const baselineRows: Record<string, { name?: string; config: Record<string, unknown> }> = {}
  let baselineLoaded = false
  const ensureBaseline = (): Record<string, { name?: string; config: Record<string, unknown> }> => {
    if (baselineLoaded) return baselineRows
    baselineLoaded = true
    const loader = (ctx as unknown as { loader?: LoaderLike }).loader
    if (loader) {
      for (const entry of loader.entries()) {
        baselineRows[entry.options.id] = { name: entry.options.name, config: entry.options.config ?? {} }
      }
    }
    return baselineRows
  }
  const baseline = {
    ensureLoaded: (): void => { ensureBaseline() },
    rows: baselineRows,
    set: (targetId: string, name: string | undefined, config: Record<string, unknown>): void => {
      baselineRows[targetId] = { name, config }
    },
  }

  // Scheduled background refine (预约式后台执行): meta tools return
  // immediately; the loop runs single-flight; completion is injected back
  // into the actor session as a plugin notice ("reload 后生效").
  const refineState = { running: false }
  type JobOutcome = { summary: string; status?: 'finished' | 'paused' | 'cancelled' | 'waiting_for_input' }
  const jobQueue: Array<{ id: string; request: Record<string, unknown>; run: () => Promise<JobOutcome> }> = []
  let jobRunning = false
  type PersistedJob = {
    schemaVersion?: number
    id?: string
    status?: string
    request?: Record<string, unknown>
    activeRunId?: string
    runLineage?: string[]
    summary?: string
    error?: string
    at?: string
  }
  const jobPathFor = (jobId: string): string => join(root, 'workspace', config.sessionId, 'jobs', `${jobId}.json`)
  const updateJob = (jobId: string, patch: Partial<PersistedJob>): PersistedJob => {
    const path = jobPathFor(jobId)
    const prior = readJson<PersistedJob>(path) ?? { schemaVersion: 1, id: jobId }
    const next = { ...prior, ...patch, at: new Date().toISOString() }
    atomicWriteJson(path, next)
    return next
  }
  /**
   * The queue itself is process-local. On reload, never leave a persisted job
   * claiming to be scheduled/running when no worker owns it; mark it as an
   * explicit interruption so the actor can safely issue a fresh delegation.
   */
  const recoverInterruptedJobs = (): void => {
    const jobsDir = dirname(jobPathFor('placeholder'))
    if (!existsSync(jobsDir)) return
    for (const file of readdirSync(jobsDir)) {
      if (!file.endsWith('.json')) continue
      const jobId = file.slice(0, -'.json'.length)
      const job = readJson<PersistedJob>(join(jobsDir, file))
      if (!job || (job.status !== 'scheduled' && job.status !== 'running')) continue
      updateJob(jobId, {
        status: 'interrupted',
        error: 'Builder job interrupted by host reload before its worker completed',
      })
      if (job.request?.kind === 'user-evolution' && typeof job.request.planId === 'string') {
        const planPath = join(root, 'user-evolution', config.sessionId, `${job.request.planId}.json`)
        const plan = readJson<UserEvolutionPlan>(planPath)
        if (plan && (plan.state === 'queued' || plan.state === 'executing' || plan.state === 'verifying')) {
          plan.state = 'interrupted'
          plan.result = {
            runId: plan.execution?.runId ?? 'interrupted', targetKind: plan.target.kind, targetId: plan.target.plan.targetId,
            verdict: 'aborted', applied: false, summary: '宿主重载中断了本轮；原任务与证据已保留',
            limitations: ['本轮不会自动续跑；请根据原任务创建新的 immutable plan。'],
          }
          atomicWriteJson(planPath, plan)
        }
      }
    }
  }
  recoverInterruptedJobs()
  const withRefineRunning = async <T>(fn: () => Promise<T>): Promise<T> => {
    refineState.running = true
    try {
      return await fn()
    } finally {
      refineState.running = false
    }
  }
  const injectNotice = (text: string, summary: string): void => {
    appendJsonl(paths.notices(root, config.sessionId), { text, summary, at: new Date().toISOString() })
    try {
      const agents = (ctx as unknown as {
        agents?: { list?: () => Array<{ inject(message: unknown): void }> }
      }).agents
      for (const agent of agents?.list?.() ?? []) {
        agent.inject({
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'dsh-meta-validate', form: 'notice', summary },
        })
      }
    } catch {
      // Notification is best-effort; a missing agents service must not kill the job.
    }
  }
  const startNextJob = (): void => {
    if (jobRunning || jobQueue.length === 0) return
    jobRunning = true
    const job = jobQueue.shift()!
    const activeJobId = job.id
    const progressTimer = config.notify.progress && config.notify.progressAfterMs > 0
      ? setTimeout(() => {
          if (jobRunning && activeJobId === job.id) {
            injectNotice('优化仍在进行：已超过预估时间，正在补齐。你可以继续。', '优化进度')
          }
        }, config.notify.progressAfterMs)
      : null
    void (async () => {
      if (config.notify.start) {
        const isLoopExploration = job.request.kind === 'loop-exploration'
        const evolutionPlanId = job.request.kind === 'user-evolution' && typeof job.request.planId === 'string' ? job.request.planId : undefined
        const evolutionPlan = evolutionPlanId ? readJson<UserEvolutionPlan>(join(root, 'user-evolution', config.sessionId, `${evolutionPlanId}.json`)) : undefined
        const reason = typeof job.request.requirements === 'string' && job.request.requirements.trim()
          ? String(job.request.requirements).slice(0, 100)
          : `检测到改进需求（${String(job.request.tool ?? 'refine')}）`
        injectNotice(
          isLoopExploration
            ? `Builder 正在后台探索 loop：${reason}。你可以继续当前对话，也可查询或补充该 run。`
            : evolutionPlan
              ? `演进已开始：${evolutionPlan.target.summary}。现在在隔离环境实现，尚未生效；Verifier/Gate 会决定是否放行。`
            : `正在后台优化：${reason}。完成会通知你，不影响当前对话。`,
          isLoopExploration ? 'Builder 开始探索' : evolutionPlan ? '用户演进已开始' : '开始后台优化',
        )
      }
      updateJob(job.id, { status: 'running', request: job.request })
      try {
        const outcome = await withRefineRunning(job.run)
        const persistedStatus = outcome.status ?? 'finished'
        updateJob(job.id, { status: persistedStatus, request: job.request, summary: outcome.summary })
        if (config.notify.completion && persistedStatus === 'finished') {
          const isLoopExploration = job.request.kind === 'loop-exploration'
          const evolutionPlanId = job.request.kind === 'user-evolution' && typeof job.request.planId === 'string' ? job.request.planId : undefined
          const evolutionPlan = evolutionPlanId ? readJson<UserEvolutionPlan>(join(root, 'user-evolution', config.sessionId, `${evolutionPlanId}.json`)) : undefined
          const evolutionCard = evolutionPlan ? userEvolutionTaskCard(evolutionPlan, persistedStatus) : undefined
          injectNotice(
            isLoopExploration
              ? `Builder 探索结束：${outcome.summary}`
              : evolutionCard
                ? `演进完成：${evolutionCard.result?.outcome ?? evolutionCard.phase}。${evolutionCard.result?.summary ?? evolutionCard.progress.current}`
              : `优化完成：${outcome.summary}。reload 后生效。`,
            isLoopExploration ? 'Builder 探索结束' : evolutionCard ? '用户演进完成' : '优化完成',
          )
        }
      } catch (error) {
        updateJob(job.id, { status: 'failed', request: job.request, error: String(error) })
        const evolutionPlanId = job.request.kind === 'user-evolution' && typeof job.request.planId === 'string' ? job.request.planId : undefined
        if (evolutionPlanId) {
          const planPath = join(root, 'user-evolution', config.sessionId, `${evolutionPlanId}.json`)
          const plan = readJson<UserEvolutionPlan>(planPath)
          if (plan && (plan.state === 'queued' || plan.state === 'executing' || plan.state === 'verifying')) {
            plan.state = 'aborted'
            plan.result = {
              runId: plan.execution?.runId ?? 'unavailable', targetKind: plan.target.kind, targetId: plan.target.plan.targetId,
              verdict: 'aborted', applied: false, summary: '隔离实现未完成，未产生可安装结果',
              limitations: ['详细诊断保留在受控审计记录中；本轮不会自动重试。'],
            }
            atomicWriteJson(planPath, plan)
            new EvolutionTaskSessionStore(root, config.sessionId).finish(evolutionPlanId, 'aborted')
            const card = userEvolutionTaskCard(plan, 'failed')
            injectNotice(`演进未完成：${card.progress.current}。${card.progress.next}`, '用户演进未完成')
          }
        } else {
          injectNotice(`改进失败：${String(error).slice(0, 300)}`, '改进失败')
        }
      } finally {
        if (progressTimer) clearTimeout(progressTimer)
        jobRunning = false
        startNextJob()
      }
    })()
  }
  const scheduleRefine = (request: Record<string, unknown>, run: () => Promise<JobOutcome>): string => {
    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const initialRunId = typeof request.runId === 'string' ? request.runId : undefined
    atomicWriteJson(jobPathFor(id), {
      schemaVersion: 1,
      id,
      status: 'scheduled',
      request,
      ...(initialRunId ? { activeRunId: initialRunId, runLineage: [initialRunId] } : {}),
      at: new Date().toISOString(),
    })
    jobQueue.push({ id, request, run })
    // Defer dispatch one microtask so callers receive the job id before a
    // runner closure can observe it (important for resume callbacks that
    // capture their freshly allocated job id).
    queueMicrotask(startNextJob)
    return id
  }
  /** Only jobs still owned by the in-memory queue are cancellable. */
  const cancelQueuedJob = (jobId: string): boolean => {
    const index = jobQueue.findIndex((job) => job.id === jobId)
    if (index < 0) return false
    jobQueue.splice(index, 1)
    updateJob(jobId, { status: 'cancelled' })
    return true
  }

  const observer = new Observer(ctx, {
    root,
    sessionId: config.sessionId,
    autoIngestUserMessages: config.reviewGate.autoIngestUserMessages,
  })
  observer.subscribe()

  const recordUsage = (role: string) => (usage: { prompt: number; completion: number }) => {
    appendJsonl(paths.costLog(root, config.sessionId), {
      schemaVersion: 1,
      at: new Date().toISOString(),
      role,
      model: config.llm.model,
      prompt: usage.prompt,
      completion: usage.completion,
    })
  }

  const credentials = (ctx as Context & { credentials?: CredentialServiceLike }).credentials
  const builderCredentials = new BuilderCredentialResolver(credentials, config.llm.provider, config.llm.credentialRef)
  const resolveBuilderKey = async (): Promise<string | undefined> => (await builderCredentials.resolve())?.value

  // Independent meta-layer model: builder + review gate use the official
  // DeepSeek API (V4 Flash by default), while the actor keeps its own route.
  // The key is resolved from DSH immediately before every request so editing
  // .credentials.yaml takes effect without restarting Web.
  const metaLlm = config.llm.provider === 'deepseek-official'
    ? officialDeepSeekLlm({ resolveApiKey: resolveBuilderKey })
    : config.llm.provider === 'gpt-5.6-terra' ? terraLlm({ resolveApiKey: resolveBuilderKey }) : undefined
  const loopCandidateGateway = new LoopCandidateGateway({
    enabled: config.allowLoopCandidates.enabled,
    root: config.allowLoopCandidates.runtimeRoot || join(root, 'loop-candidate-runtime'),
    sessionId: config.sessionId,
    llm: metaLlm,
    provider: config.llm.provider,
    model: config.llm.model,
    maxTokens: config.allowLoopCandidates.maxTokens,
    buildDependencyRoot: config.allowLoopCandidates.buildDependencyRoot,
    builderMaxModelTurns: config.allowLoopCandidates.builderMaxModelTurns,
    builderMaxToolSteps: config.allowLoopCandidates.builderMaxToolSteps,
    builderMaxWallTimeMs: config.allowLoopCandidates.builderMaxWallTimeMs,
    diagnosisFirst: config.allowLoopCandidates.diagnosisFirst,
    builderKernelOptions: {
      ...(config.allowLoopCandidates.repeatReadRejectAfter > 0 ? { repeatReadRejectAfter: config.allowLoopCandidates.repeatReadRejectAfter } : {}),
      ...(config.allowLoopCandidates.enforceProgressCheckpoints ? { enforceProgressCheckpoints: true } : {}),
    },
    onUsage: recordUsage('builder-loop-candidate'),
    executionRuntime: config.allowLoopCandidates.executionRuntime,
    ...(config.allowLoopCandidates.executionRuntime === 'mini-swe' ? {
      miniSwe: {
        executable: config.allowLoopCandidates.miniSweExecutable,
        configPath: config.allowLoopCandidates.miniSweConfigPath,
        baselineRoot: config.allowLoopCandidates.baselineRoot,
        dependencySnapshot: config.allowLoopCandidates.miniSweDependencySnapshot,
        stepLimit: config.allowLoopCandidates.miniSweStepLimit,
        timeoutMs: config.allowLoopCandidates.builderMaxWallTimeMs,
        resolveEnv: async () => {
          const credential = await builderCredentials.require()
          return miniSweChildEnv(config.llm.provider, process.env, credential.value)
        },
      },
    } : {}),
  })
  const loopJobRunners = new Map<string, (jobId: string) => Promise<{ summary: string; status?: 'finished' | 'paused' | 'cancelled' | 'waiting_for_input' }>>()
  const loopRunHolders = new Map<string, { runId: string; runner: (jobId: string) => Promise<{ summary: string; status?: 'finished' | 'paused' | 'cancelled' | 'waiting_for_input' }>; request: Record<string, unknown>; holder?: { runId: string } }>()
  const builderRunFor = (jobId: string | undefined, explicitRunId: string | undefined): { jobId?: string; runId?: string; error?: string } => {
    if (explicitRunId) return { ...(jobId ? { jobId } : {}), runId: explicitRunId }
    if (!jobId) return { error: 'jobId or runId is required' }
    const job = readJson<PersistedJob>(jobPathFor(jobId))
    if (!job) return { error: `unknown job: ${jobId}` }
    const activeRunId = typeof job.activeRunId === 'string'
      ? job.activeRunId
      : typeof job.request?.runId === 'string' ? job.request.runId : undefined
    if (job.request?.kind !== 'loop-exploration' || !activeRunId) {
      return { error: `job is not a Builder loop exploration: ${jobId}` }
    }
    return { jobId, runId: activeRunId }
  }

  const proposer = new Proposer(ctx, {
    systemPrompt:
      '你是 dsh-meta-validate 的独立迭代者（builder）：基于用户需求、失败信号与配置快照，' +
      '产出单变量、可核验的候选 patch，并给出预期轨迹与自我评估。',
    maxSignals: config.maxSignalsPerCycle,
    provider: config.llm.provider,
    model: config.llm.model,
    root,
    sessionId: config.sessionId,
    llm: metaLlm,
    onUsage: recordUsage('builder'),
    lockedTargets: config.lockedTargets,
    builder: config.builder,
  })

  const isolationOptions: IsolationOptions | undefined = config.isolation.enabled
    ? {
        dshCommand: config.isolation.dshCommand,
        cwd: config.isolation.cwd,
        profile: config.isolation.profile,
        baseOverlays: config.isolation.baseOverlays,
        probe: config.isolation.probe,
        probeTimeoutMs: config.isolation.probeTimeoutMs,
      }
    : undefined
  const validator = new Validator(ctx, {
    regressionDir: config.regressionDir,
    maxCases: 20,
    isolation: isolationOptions,
    workspaceRoot: root,
    sessionId: config.sessionId,
    skillIsolation: config.isolation.enabled && config.skillStagingRoot
      ? {
          dshCommand: config.isolation.dshCommand,
          cwd: config.isolation.cwd,
          profile: config.isolation.profile,
          baseOverlays: config.isolation.baseOverlays,
          stagingRoot: config.skillStagingRoot,
          probeTimeoutMs: config.isolation.probeTimeoutMs,
        }
      : undefined,
  })
  // Loop path: isolation probing is owned by collectFrames (which knows the
  // staging root); the verifier must not run a second isolation without it.
  const loopValidator = new Validator(ctx, {
    regressionDir: config.regressionDir,
    maxCases: 20,
    workspaceRoot: root,
    sessionId: config.sessionId,
    skillIsolation: config.isolation.enabled && config.skillStagingRoot
      ? {
          dshCommand: config.isolation.dshCommand,
          cwd: config.isolation.cwd,
          profile: config.isolation.profile,
          baseOverlays: config.isolation.baseOverlays,
          stagingRoot: config.skillStagingRoot,
          probeTimeoutMs: config.isolation.probeTimeoutMs,
        }
      : undefined,
  })
  const gate = new Gate(ctx, { root, sessionId: config.sessionId }, config.lockedTargets)
  const reviewGate = new ReviewGate(ctx, {
    enabled: config.reviewGate.enabled && config.mode !== 'observe',
    prompt: config.reviewGate.prompt,
    root,
    sessionId: config.sessionId,
    provider: config.llm.provider,
    model: config.llm.model,
    llm: metaLlm,
    onUsage: recordUsage('gate'),
  })
  const createLoop = (autoConfirm: boolean): IterationLoop => new IterationLoop({
    proposer,
    validator: loopValidator,
    gate,
    root,
    sessionId: config.sessionId,
    maxIterations: config.maxIterations,
    confirm: async () => false,
    autoConfirm,
    collectFrames: (patch, base) => collectFramesForPatch(patch, base, {
      enabled: config.isolation.enabled,
      dshCommand: config.isolation.dshCommand,
      cwd: config.isolation.cwd,
      profile: config.isolation.profile,
      baseOverlays: config.isolation.baseOverlays,
      probe: config.isolation.probe,
      probeTimeoutMs: config.isolation.probeTimeoutMs,
      stagingRootFor: (patchId) => paths.staging(root, config.sessionId, patchId),
      skillProbe: (patch) => loopValidator.probeSkillForFrames(patch),
    }),
    probeRunner: async (patch, task) => {
      if (!config.isolation.enabled || patch.targetKind === 'skill') return { exit: 0, outputTail: '' }
      const isolation = runIsolation(patch, {
        dshCommand: config.isolation.dshCommand,
        cwd: config.isolation.cwd,
        profile: config.isolation.profile,
        baseOverlays: config.isolation.baseOverlays,
        stagingRoot: paths.staging(root, config.sessionId, patch.id),
        probe: task,
        probeTimeoutMs: config.isolation.probeTimeoutMs,
      })
      return { exit: isolation.probe?.exitCode ?? -1, outputTail: isolation.probe?.outputTail ?? '' }
    },
    onApplied: async ({ patch, report, applied, signals }) => {
      const entry = {
        id: `${patch.id}`,
        triggeredBy: scenarioOf(signals),
        problem: report.failureSummary ?? signals.map((signal) => signal.evidence.join(' | ')).join('; ').slice(0, 300) ?? 'no signal',
        changes: [{ target: patch.targetId, kind: patch.targetKind, before: {}, after: patch.config }],
        verdict: report.verdict,
        applied: applied.applied,
        metricsBefore: {},
        metricsAfter: {},
        rolledBack: false,
        appliedAt: new Date().toISOString(),
      }
      appendLedger(root, config.sessionId, entry)
      appendReport(root, config.sessionId, `进化 ${entry.triggeredBy}: ${patch.targetKind} ${patch.targetId}（${JSON.stringify(patch.config)}）→ ${report.verdict}`)
    },
  })
  const autopilot = new AutoPilot({
    gate: reviewGate,
    loop: createLoop(config.mode === 'apply'),
    observer,
    root,
    sessionId: config.sessionId,
    thresholds: config.thresholds,
    minIntervalTurns: config.reviewGate.minIntervalTurns,
    maxIterationsPerEpoch: config.reviewGate.maxIterationsPerEpoch,
    postLoopMaxRounds: config.reviewGate.postLoopMaxRounds,
  })

  ctx.tools.register(defineTool({
    name: 'meta_request_validate',
    description: '请求一次自我迭代：把当前用户需求与信号交给 builder，产出候选 patch 与预期轨迹（不直接修改任何运行时配置）。',
    parameters: {
      rationale: { type: 'string', description: '迭代原因或用户需求原文' },
      targetId: { type: 'string', description: '期望修改的插件行 id（可省略，由 builder 决定）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const rationale = args.rationale ? String(args.rationale) : undefined
      observer.persistTrigger('user', rationale ? 'user request' : undefined)
      if (rationale) observer.persistRequirements(rationale)
      return {
        accepted: true,
        sessionId: config.sessionId,
        workspaceRoot: root,
        note: '信号已记录；M1 阶段由宿主/测试驱动 builder 产出候选。',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meta_builder_status',
    description: '查询一个后台 Builder loop 探索 run：状态、已用回合/工具、actor inbox、最近 journal 与 proposal 摘要。不会唤起、批准或安装。',
    parameters: {
      jobId: { type: 'string', description: 'meta_auto 返回的 Builder jobId（与 runId 二选一）' },
      runId: { type: 'string', description: 'Builder runId（与 jobId 二选一）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const jobId = typeof args.jobId === 'string' ? args.jobId : undefined
      const runId = typeof args.runId === 'string' ? args.runId : undefined
      const target = builderRunFor(jobId, runId)
      if (!target.runId) return { accepted: false, error: target.error } as unknown as JsonValue
      try {
        const job = target.jobId
          ? readJson<{ status?: string; summary?: string; error?: string }>(join(root, 'workspace', config.sessionId, 'jobs', `${target.jobId}.json`))
          : null
        return cleanToolResult({
          accepted: true,
          ...(target.jobId ? { jobId: target.jobId } : {}),
          exploration: loopCandidateGateway.explorationStatus(target.runId),
          ...(job ? { job: { status: job.status ?? null, summary: job.summary ?? null, error: job.error ?? null } } : {}),
          note: job?.status === 'interrupted'
            ? '该 job 在宿主重载时被安全标记为 interrupted；Builder run 和证据仍保留。Actor 可调用 meta_auto(exploreLoop=true, resumeJobId=...) 创建继承旧资产的新 immutable run。'
            : '状态来自持久 Builder run；proposal 的 verifier/gate 裁决结果见 job.summary 与 meta_growth。',
        }) as unknown as JsonValue
      } catch (error) {
        return { accepted: false, runId: target.runId, error: String(error) } as unknown as JsonValue
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meta_builder_message',
    description: '向仍在运行的 Builder 持久会话投递用户原话与 Actor 的解释。rawUserText 保留用户原意，actorMemo 只是非权威解释；Builder 会在下一微循环回合看到并可回执/追问。不会直接改变目标。',
    parameters: {
      message: { type: 'string', description: '兼容字段：若 rawUserText 未提供，将作为用户原话投递' },
      rawUserText: { type: 'string', description: '用户原始措辞；Actor 应尽量逐字保留，不用摘要取代' },
      actorMemo: { type: 'string', description: 'Actor 对目标、约束、歧义或上下文的解释；Builder 可采纳、质疑或追问' },
      evidenceRefs: { type: 'array', items: { type: 'string' }, description: '与本次指导有关的不可变证据或文件引用（可选）' },
      idempotencyKey: { type: 'string', description: 'Actor 为本次用户消息生成的稳定重试键；同一 key 的同内容投递只会生效一次' },
      jobId: { type: 'string', description: 'meta_auto 返回的 Builder jobId（与 runId 二选一）' },
      runId: { type: 'string', description: 'Builder runId（与 jobId 二选一）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const jobId = typeof args.jobId === 'string' ? args.jobId : undefined
      const runId = typeof args.runId === 'string' ? args.runId : undefined
      const rawUserText = typeof args.rawUserText === 'string'
        ? args.rawUserText
        : typeof args.message === 'string' ? args.message : ''
      const actorMemo = typeof args.actorMemo === 'string' ? args.actorMemo : undefined
      const evidenceRefs = Array.isArray(args.evidenceRefs) && args.evidenceRefs.every((ref) => typeof ref === 'string')
        ? args.evidenceRefs as string[]
        : undefined
      const idempotencyKey = typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined
      const target = builderRunFor(jobId, runId)
      if (!target.runId) return { accepted: false, error: target.error } as unknown as JsonValue
      try {
        return cleanToolResult({
          ...loopCandidateGateway.messageExploration(target.runId, {
            rawUserText,
            ...(actorMemo ? { actorMemo } : {}),
            ...(evidenceRefs ? { evidenceRefs } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }),
          ...(target.jobId ? { jobId: target.jobId } : {}),
          note: '已保留用户原话并写入 Builder durable inbox；下一微循环会看到。Builder 的理解/追问请通过 meta_builder_events 读取，再由 Actor 向用户解释。',
        }) as unknown as JsonValue
      } catch (error) {
        return { accepted: false, runId: target.runId, error: String(error) } as unknown as JsonValue
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meta_builder_events',
    description: '读取 Builder 持久会话的 Actor-facing 事件流（阶段、工具完成、消息回执、追问、proposal 草案），用于 Actor 向用户解释进度；不暴露模型隐藏推理，也不会唤起或批准 Builder。',
    parameters: {
      jobId: { type: 'string', description: 'meta_auto 返回的 Builder jobId（与 runId 二选一）' },
      runId: { type: 'string', description: 'Builder runId（与 jobId 二选一）' },
      cursor: { type: 'string', description: '上一响应返回的 composite cursor（lineageId:runId:seq）；run 切换时自动 reset，避免跨 run 漏事件' },
      afterSeq: { type: 'number', description: '兼容字段：仅当前 run 的 seq。优先使用 cursor；首次可传 0' },
      limit: { type: 'number', description: '最多返回事件数，默认 50，最大 200' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const jobId = typeof args.jobId === 'string' ? args.jobId : undefined
      const runId = typeof args.runId === 'string' ? args.runId : undefined
      const afterSeq = typeof args.afterSeq === 'number' && Number.isFinite(args.afterSeq) ? Math.max(0, Math.floor(args.afterSeq)) : 0
      const cursor = parseBuilderEventCursor(typeof args.cursor === 'string' ? args.cursor : undefined, afterSeq)
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 50
      const target = builderRunFor(jobId, runId)
      if (!target.runId) return { accepted: false, error: target.error } as unknown as JsonValue
      try {
        return cleanToolResult({
          accepted: true,
          ...(target.jobId ? { jobId: target.jobId } : {}),
          builderSessionId: target.jobId ?? target.runId,
          ...loopCandidateGateway.events(target.runId, cursor, limit),
          note: '事件是 Builder 向 Actor 的可审计摘要。Actor 应保留用户原意、翻译技术进度，并在 question 出现时向用户追问。',
        }) as unknown as JsonValue
      } catch (error) {
        return { accepted: false, runId: target.runId, error: String(error) } as unknown as JsonValue
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meta_builder_control',
    description: '控制持久 Builder 会话：pause/cancel 在 Kernel 立即落盘；resume 永远创建带 previousRun 引用的新 immutable attempt，不重放中断中的工具副作用。',
    parameters: {
      action: { type: 'string', description: 'pause、cancel 或 resume' },
      jobId: { type: 'string', description: 'meta_auto 返回的 jobId（与 runId 二选一）' },
      runId: { type: 'string', description: 'Builder runId（与 jobId 二选一）' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const action = args.action === 'pause' || args.action === 'cancel' || args.action === 'resume' ? args.action : undefined
      if (!action) return { accepted: false, error: 'action must be pause, cancel, or resume' } as unknown as JsonValue
      const jobId = typeof args.jobId === 'string' ? args.jobId : undefined
      const explicitRunId = typeof args.runId === 'string' ? args.runId : undefined
      const target = builderRunFor(jobId, explicitRunId)
      if (!target.runId) return { accepted: false, error: target.error } as unknown as JsonValue
      try {
        if (action === 'pause' || action === 'cancel') {
          const controlled = loopCandidateGateway.controlExploration(target.runId, action)
          if (target.jobId) {
            const queuedIndex = jobQueue.findIndex((item) => item.id === target.jobId)
            if (queuedIndex >= 0) jobQueue.splice(queuedIndex, 1)
            updateJob(target.jobId, { status: action === 'cancel' ? 'cancelled' : 'paused', activeRunId: target.runId })
          }
          return cleanToolResult({ accepted: true, action, ...(target.jobId ? { jobId: target.jobId } : {}), ...controlled, note: action === 'pause' ? '已暂停；不会再进入下一模型回合。resume 会创建新 attempt。' : '已取消；该 run 不可再次提交。' }) as unknown as JsonValue
        }
        const priorJob = target.jobId ? readJson<PersistedJob>(jobPathFor(target.jobId)) : null
        const holder = loopRunHolders.get(target.runId)
        if (!holder) {
          return { accepted: false, runId: target.runId, error: 'resume requires an in-process loop runner; after host reload re-delegate with meta_auto(resumeRunId=...)' } as unknown as JsonValue
        }
        const started = loopCandidateGateway.resumeExploration(target.runId)
        if (!started.accepted) return { accepted: false, exploration: started } as unknown as JsonValue
        if (holder.holder) holder.holder.runId = started.runId
        const request = { ...(priorJob?.request ?? holder.request), runId: started.runId, resumedFromRunId: target.runId }
        const nextJobId = scheduleRefine(request, () => holder.runner(nextJobId))
        loopJobRunners.set(nextJobId, holder.runner)
        loopRunHolders.set(started.runId, { ...holder, runId: started.runId })
        return cleanToolResult({ accepted: true, action, jobId: nextJobId, runId: started.runId, builderSessionId: nextJobId, resumedFromRunId: target.runId, state: 'scheduled', note: '已创建新的 immutable Builder attempt；旧 workspace/journal/artifacts 仅按 hash 只读继承。' }) as unknown as JsonValue
      } catch (error) {
        return { accepted: false, runId: target.runId, error: String(error) } as unknown as JsonValue
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meta_status',
    description: '查询优化进度：当前后台优化任务（job）状态、最近进化次数、工作区与阈值。用户问"优化进度怎么样"时用它。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const builderCredential = await builderCredentials.describe()
      const bundledRuntime = bundledMiniSwePaths({
        metaRoot: root,
        packageRoot: PLUGIN_ROOT,
        runtimeRoot: config.activeEvolution.runtimeRoot,
        executable: config.activeEvolution.miniSweExecutable,
        configPath: config.activeEvolution.miniSweConfigPath,
      })
      const jobsDir = join(root, 'workspace', config.sessionId, 'jobs')
      const jobFiles = existsSync(jobsDir) ? readdirSync(jobsDir).sort().reverse() : []
      const latestJob = jobFiles.length > 0
        ? readJson<{ id?: string; status?: string; summary?: string; error?: string }>(join(jobsDir, jobFiles[0]!))
        : null
      return {
        mode: config.mode,
        sessionId: config.sessionId,
        builder: {
          provider: config.llm.provider,
          model: config.llm.model,
          credentialRef: builderCredential.ref,
          credentialConfigured: builderCredential.configured,
          credentialSource: builderCredential.source ?? null,
          error: builderCredential.configured ? null : `Builder credential ${builderCredential.ref} is not configured in DSH credentials`,
        },
        activeEvolution: {
          enabled: config.activeEvolution.enabled,
          runtimeRoot: bundledRuntime.runtimeRoot,
          executablePresent: existsSync(bundledRuntime.executable),
          configPresent: existsSync(bundledRuntime.configPath),
          ready: bundledRuntime.ready,
          error: bundledRuntime.ready ? null : 'mini-SWE runtime is not ready at the configured runtimeRoot; rerun dsh-loom setup and launch with its generated patch',
        },
        workspaceRoot: root,
        thresholds: config.thresholds,
        maxIterations: config.maxIterations,
        pendingPatches: gate.pendingCount(),
        loopCandidates: Object.values(loopCandidateGateway.status().candidates).map((candidate) => ({
          id: candidate.manifest.id,
          state: candidate.state,
          updatedAt: candidate.updatedAt,
        })),
        latestJob: latestJob
          ? { id: latestJob.id ?? null, status: latestJob.status ?? null, summary: latestJob.summary ?? null, error: latestJob.error ?? null }
          : null,
        growthCount: readLedger(root, config.sessionId).length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meta_growth',
    description: '查看成长记录与已记住的偏好：进化次数、触发场景、最近改动、偏好清单。用户问"你学到了什么/记住了什么"时用它。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const ledger = readLedger(root, config.sessionId)
      const byScenario: Record<string, number> = {}
      let appliedCount = 0
      for (const entry of ledger) {
        byScenario[entry.triggeredBy] = (byScenario[entry.triggeredBy] ?? 0) + 1
        if (entry.applied) appliedCount += 1
      }
      return {
        count: ledger.length,
        appliedCount,
        byScenario,
        recent: ledger.slice(-5).map((entry) => ({
          triggeredBy: entry.triggeredBy,
          problem: entry.problem.slice(0, 160),
          changes: entry.changes.map((change) => ({
            target: change.target,
            kind: change.kind,
            before: String(change.before),
            after: String(change.after),
          })),
          verdict: entry.verdict,
          applied: entry.applied,
        })),
        preferences: readPreferences(root, config.sessionId).map((pref) => ({
          scope: pref.scope,
          value: pref.value,
          sourceRef: pref.sourceRef ?? null,
          at: pref.at ?? null,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meta_validate',
    description: '对最新 submitted 候选运行固定式完整核验（对齐 + 回归集 + 配置不变性），写入 report.json 并更新状态。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const submitted = findSubmittedPatch(root, config.sessionId)
      if (!submitted) {
        return {
          verdict: 'rejected',
          failureSummary: 'no submitted patch found',
        } as unknown as JsonValue
      }
      const patch = submitted.patch
      const cases = await validator.loadRegressionCases()
      const runEvents = readJsonl<ActualEvent>(
        paths.runEvents(root, config.sessionId, patch.id),
      )
      const report = await validator.run(patch, cases, { actualEvents: runEvents })
      validator.persistReport(root, config.sessionId, patch.id, report, runEvents)
      gate.markStatus(root, config.sessionId, patch.id, report.verdict === 'approved' ? 'approved' : 'rejected', 'meta_validate', 1, report.failureSummary)
      return report as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meta_iterate',
    description: '跑一轮自我迭代闭环：信号 -> builder -> verifier（含可选隔离校验）-> approved 后按 mode 自动/人工确认应用（M3）。',
    parameters: {
      requirements: { type: 'string', description: '用户需求原文（可选）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const requirements = args.requirements ? String(args.requirements) : undefined
      const runIterate = async (): Promise<{ result: Awaited<ReturnType<IterationLoop['run']>> }> => {
        const signals = observer.collect(config.thresholds)
        const cases = await validator.loadRegressionCases()
        const loop = createLoop(config.mode === 'apply')
        const ops = buildApplyOps(ctx, validator, cases, { root, sessionId: config.sessionId, skillRoot: config.skillRoot }, baseline)
        const currentConfig = currentConfigOf(ctx, baseline)
        const actorModel = (currentConfig['agent-default-model'] as { config?: { model?: unknown } } | undefined)?.config?.model
        observer.collectTelemetry(typeof actorModel === 'string' ? actorModel : undefined)
        const result = await loop.run(signals, currentConfig, requirements, { actualEvents: [] }, ops)
        return { result }
      }
      if (config.scheduled) {
        const jobId = scheduleRefine({ tool: 'meta_iterate', requirements }, async () => {
          const { result } = await runIterate()
          return {
            summary: `target=${result.patch?.targetId ?? 'n/a'}（${result.patch?.targetKind ?? '?'}）verdict=${result.report.verdict} applied=${result.applied?.applied ?? false}`,
          }
        })
        return { scheduled: true, jobId } as unknown as JsonValue
      }
      const { result } = await runIterate()
      return cleanToolResult({
        iterations: result.iterations,
        verdict: result.report.verdict,
        patchId: result.patch?.id ?? null,
        applied: result.applied?.applied ?? false,
        escalated: result.escalated,
        note: '同步执行完成（scheduled=false）',
      }) as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meta_evolution_status',
    description: '查询用户主动 Config/Skill 演进的易懂状态。只读取 immutable plan 与后台 job；不会唤起 Builder、修改目标或安装任何候选。',
    parameters: {
      jobId: { type: 'string', description: '内部关联字段；普通对话无需提供。' },
      planId: { type: 'string', description: '内部关联字段；普通对话无需提供。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const taskSession = new EvolutionTaskSessionStore(root, config.sessionId)
      const jobId = typeof args.jobId === 'string' ? args.jobId : taskSession.read().active?.jobId
      const job = jobId ? readJson<PersistedJob>(jobPathFor(jobId)) : undefined
      const planId = typeof args.planId === 'string' ? args.planId : typeof job?.request?.planId === 'string' ? job.request.planId : taskSession.currentPlanId()
      if (!planId) return { accepted: false, error: '当前会话没有演进任务' } as unknown as JsonValue
      const plan = readJson<UserEvolutionPlan>(join(root, 'user-evolution', config.sessionId, `${planId}.json`))
      if (!plan) return { accepted: false, planId, error: 'unknown evolution plan' } as unknown as JsonValue
      return cleanToolResult({
        accepted: true,
        task: userEvolutionTaskCard(plan, job?.status),
        note: plan.state === 'planned'
          ? '等待用户确认；尚未启动执行。'
          : plan.state === 'queued' || plan.state === 'executing'
            ? '正在隔离 workspace 中执行；未通过 Verifier/Gate 前不会生效。'
            : plan.state === 'completed'
              ? '已通过独立裁决并生效；报告包含限制与回滚边界。'
              : '未生效；请查看报告原因，不会静默重试或绕过裁决。',
      }) as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meta_evolution_control',
    description: 'Actor 对话任务卡的自然语言控制协议。用户只需说“查看进度”或“取消”；本工具不会暴露 planId、路径、快照或隐藏推理。确认与重做由 Actor 依据当前卡片调用 meta_auto 的受控 Plan/Execute 链。',
    parameters: {
      action: { type: 'string', description: 'status 或 cancel_queued。Actor 根据用户自然语言选择。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const taskSession = new EvolutionTaskSessionStore(root, config.sessionId)
      const session = taskSession.read()
      const planId = session.pending?.planId ?? session.active?.planId ?? session.recent?.planId
      if (!planId) return cleanToolResult({ accepted: false, error: '当前会话没有演进任务' }) as unknown as JsonValue
      const planPath = join(root, 'user-evolution', config.sessionId, `${planId}.json`)
      const plan = readJson<UserEvolutionPlan>(planPath)
      if (!plan) return cleanToolResult({ accepted: false, error: '当前任务记录不可用' }) as unknown as JsonValue
      if (args.action === 'cancel_queued') {
        if (!session.active || session.active.planId !== planId || session.active.cursor !== 'queued') {
          return cleanToolResult({ accepted: false, task: userEvolutionTaskCard(plan), error: plan.state === 'executing' || plan.state === 'verifying' ? '本轮已经开始实现或裁决，不能强制中断；它会保留完整审计记录。' : '只有已排队、尚未开始的任务可以取消。' }) as unknown as JsonValue
        }
        if (!cancelQueuedJob(session.active.jobId)) {
          return cleanToolResult({ accepted: false, task: userEvolutionTaskCard(plan), error: '任务已被 worker 接手，不能安全取消；请查看当前状态。' }) as unknown as JsonValue
        }
        plan.state = 'cancelled'
        plan.result = { runId: 'not-started', targetKind: plan.target.kind, targetId: plan.target.plan.targetId, verdict: 'aborted', applied: false, summary: '用户在隔离实现开始前取消了此任务', limitations: ['取消不会删除原计划或证据；重做会创建新的 immutable plan。'] }
        atomicWriteJson(planPath, plan)
        taskSession.finish(planId, 'cancelled')
        return cleanToolResult({ accepted: true, task: userEvolutionTaskCard(plan), note: '已取消排队任务；未启动 Builder，未修改任何内容。' }) as unknown as JsonValue
      }
      return cleanToolResult({ accepted: true, task: userEvolutionTaskCard(plan, session.active?.jobId ? readJson<PersistedJob>(jobPathFor(session.active.jobId))?.status : undefined) }) as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meta_auto',
    description: '用户主动委托入口：exploreLoop=true 时冻结三层证据包，后台 Builder 自由探索并提交 proposal，随后经 verifier/gate 裁决；无被动触发。',
    parameters: {
      turn: { type: 'number', description: '当前回合号（宿主回合边界传入）' },
      requirements: { type: 'string', description: '用户需求原文（可选）' },
      actorAssessment: { type: 'string', description: 'actor 对当前会话问题的自然语言观察、怀疑和上下文；不是结构化 JSON 约束（可选）' },
      evolutionMode: { type: 'string', description: '用户主动 Config/Skill 演进：plan 冻结证据与宿主目标并展示风险；execute 确认当前会话的待确认任务。' },
      targetKind: { type: 'string', description: 'plan 时必填：config 或 skill。' },
      targetId: { type: 'string', description: 'plan 时的用户意图提示。Config 必须是现有宿主行；Skill 仅允许 kebab-case id，入口由宿主生成。' },
      redo: { type: 'boolean', description: '仅对上一条未生效/未完成/已取消任务：用原目标和原用户意图创建一条新的 immutable plan。' },
      planId: { type: 'string', description: '内部兼容字段；Actor 确认当前任务时无需提供。' },
      exploreLoop: { type: 'boolean', description: '仅当 allowLoopCandidates 开启时，让独立 builder 阅读三层证据包并自由探索/演进 config/tool/skill/loop；proposal 经 verifier/gate 裁决后才应用。' },
      resumeJobId: { type: 'string', description: '可选：恢复一个被宿主重载中断的 Builder job。会创建新 immutable run，并只读继承旧 run 的 journal/workspace/artifacts。' },
      resumeRunId: { type: 'string', description: '可选：直接指定要恢复的 Builder run（与 resumeJobId 二选一）。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const turn = typeof args.turn === 'number' ? args.turn : 0
      const resumeJobId = typeof args.resumeJobId === 'string' ? args.resumeJobId : undefined
      const resumeRunId = typeof args.resumeRunId === 'string' ? args.resumeRunId : undefined
      const resumeTarget = resumeRunId
        ? { runId: resumeRunId }
        : resumeJobId ? builderRunFor(resumeJobId, undefined) : undefined
      if ((resumeJobId || resumeRunId) && !resumeTarget?.runId) {
        return { accepted: false, error: resumeTarget?.error ?? 'resumeJobId or resumeRunId is invalid' } as unknown as JsonValue
      }
      const priorRequirements = resumeJobId
        ? readJson<PersistedJob>(jobPathFor(resumeJobId))?.request?.requirements
        : undefined
      const requirements = args.requirements
        ? String(args.requirements)
        : typeof priorRequirements === 'string' ? priorRequirements : undefined
      const actorAssessment = typeof args.actorAssessment === 'string' ? args.actorAssessment : undefined
      if (requirements) {
        observer.persistTrigger('user', 'meta_auto')
        observer.ingest({ kind: 'user-message', turn: 0, text: requirements })
      }
      const evolutionMode = args.evolutionMode === 'plan' || args.evolutionMode === 'execute'
        ? args.evolutionMode : undefined
      if (evolutionMode) {
        const bundledRuntime = bundledMiniSwePaths({
          metaRoot: root, packageRoot: PLUGIN_ROOT, runtimeRoot: config.activeEvolution.runtimeRoot,
          executable: config.activeEvolution.miniSweExecutable, configPath: config.activeEvolution.miniSweConfigPath,
        })
        if (!config.activeEvolution.enabled || !bundledRuntime.ready) {
          return cleanToolResult({ accepted: false, mode: evolutionMode, error: config.activeEvolution.enabled ? 'mini-SWE runtime is not installed; run dsh-loom setup in the same DSH_META_VALIDATE_ROOT, then restart DSH' : 'activeEvolution is disabled' }) as unknown as JsonValue
        }
        const builderCredential = await builderCredentials.describe()
        if (!builderCredential.configured) {
          return cleanToolResult({ accepted: false, mode: evolutionMode, error: `Builder credential ${builderCredential.ref} is not configured in DSH credentials` }) as unknown as JsonValue
        }
        const taskSession = new EvolutionTaskSessionStore(root, config.sessionId)
        const redoSourceId = args.redo === true ? taskSession.read().recent?.planId : undefined
        const redoSource = redoSourceId ? readJson<UserEvolutionPlan>(join(root, 'user-evolution', config.sessionId, `${redoSourceId}.json`)) : undefined
        if (args.redo === true && (!redoSource || !['rejected', 'aborted', 'cancelled', 'interrupted'].includes(redoSource.state))) {
          return cleanToolResult({ accepted: false, mode: evolutionMode, error: '只有未生效、未完成或已取消的最近任务可以重做。' }) as unknown as JsonValue
        }
        const evolutionRequirements = requirements ?? redoSource?.requirements
        const targetKind = args.targetKind === 'config' || args.targetKind === 'skill'
          ? args.targetKind as UserEvolutionTargetKind : redoSource?.target.kind
        const requestedTargetId = typeof args.targetId === 'string' ? args.targetId : redoSource?.target.plan.targetId
        const currentConfig = currentConfigOf(ctx, baseline)
        const signals = observer.collect(config.thresholds)
        const evidencePack = createActorEvidencePack({
          root, sessionId: config.sessionId, observer, currentConfig, signals,
          state: readJson(paths.autopilotState(root, config.sessionId)) ?? {
            schemaVersion: PROTOCOL_VERSION, epoch: 0, iterationsThisEpoch: 0, lastIterationTurn: 0, lastApplyTurn: 0,
          },
          requirements: evolutionRequirements ?? '', actorAssessment,
        })
        const events = evidenceEventsOf(evidencePack)
        const evolutionGateway = new ActorEvolutionGateway({
          root, sessionId: config.sessionId, model: config.llm.model,
          miniSwe: {
            executable: bundledRuntime.executable,
            configPath: bundledRuntime.configPath,
            stepLimit: config.activeEvolution.miniSweStepLimit,
            timeoutMs: config.activeEvolution.timeoutMs,
            resolveEnv: async () => {
              const credential = await builderCredentials.require()
              return miniSweChildEnv(config.llm.provider, process.env, credential.value)
            },
          },
        })
        const controller = new UserEvolutionController({
          root, sessionId: config.sessionId, gateway: evolutionGateway,
          resolveTarget: (_request, kind) => {
            if (events.length === 0) throw new Error('cannot create an executable plan without frozen actor events')
            const expectedTrajectory = {
              schemaVersion: 1, patchId: `host-evidence-${evidencePack.id}`, events,
              coverage: { claimedBehaviors: [] },
            }
            if (kind === 'config') {
              if (!requestedTargetId || !Object.hasOwn(currentConfig, requestedTargetId)) throw new Error('config plan requires targetId of an existing host config row')
              const row = currentConfig[requestedTargetId] as { config?: unknown }
              if (!row || typeof row !== 'object' || !('config' in row) || !row.config || typeof row.config !== 'object' || Array.isArray(row.config)) throw new Error('host config row is not editable')
              if (Object.keys(row.config as Record<string, unknown>).some((key) => /(api[_-]?key|token|secret|password|authorization)/i.test(key))) throw new Error('config rows with credentials are not eligible for Builder execution')
              return {
                kind, plan: { capability: 'config-evolution', targetId: requestedTargetId, before: structuredClone(row.config as Record<string, unknown>), expectedTrajectory },
                summary: `修改宿主已存在的 config 行 ${requestedTargetId}`, verification: '固定 Validator、Gate、cold replay 与 rollback', risks: ['配置修改可能要求宿主 reload'],
              }
            }
            if (!requestedTargetId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestedTargetId)) throw new Error('skill plan requires a kebab-case targetId')
            return {
              kind, plan: { capability: 'skill-evolution', targetId: requestedTargetId, targetKind: 'skill', entry: `${requestedTargetId}/SKILL.md`, expectedTrajectory },
              summary: `生成隔离 skill bundle ${requestedTargetId}`, verification: 'catalog/load verifier、Gate install、cold Actor load/use 与 rollback', risks: ['技能内容不保证所有模型都遵循'],
            }
          },
          evidenceFor: () => ({ refs: [evidencePack.manifestPath, ...evidencePack.rawRefs.map((ref) => ref.snapshotPath ?? ref.path)], summary: `frozen evidence pack ${evidencePack.id}` }),
          adjudicate: async (proposal, frozenPlan) => {
            const classified = classifyBuilderProposal(proposal)
            if (classified.kind !== 'known' || classified.proposal.capability !== 'patch-evolution') throw new Error('only known patch-evolution proposals can enter product adjudication')
            const cases = await validator.loadRegressionCases()
            const ops = buildApplyOps(ctx, validator, cases, { root, sessionId: config.sessionId, skillRoot: config.skillRoot }, baseline)
            const frozenPack = readActorEvidencePack(frozenPlan.evidence.refs[0] ?? '')
            if (!frozenPack) throw new Error('immutable plan evidence pack is unavailable')
            return adjudicatePatch(classified.proposal, {
              root, sessionId: config.sessionId, validator, gate, applyOps: ops, evidenceEvents: evidenceEventsOf(frozenPack),
              collectFrames: (patch, base) => collectFramesForPatch(patch, base, {
                enabled: config.isolation.enabled, dshCommand: config.isolation.dshCommand, cwd: config.isolation.cwd,
                profile: config.isolation.profile, baseOverlays: config.isolation.baseOverlays, probe: config.isolation.probe,
                probeTimeoutMs: config.isolation.probeTimeoutMs, stagingRootFor: (patchId) => paths.staging(root, config.sessionId, patchId), skillProbe: (patch) => validator.probeSkillForFrames(patch),
              }),
            })
          },
        })
        try {
          if (evolutionMode === 'plan') {
            if (!evolutionRequirements || !targetKind) return cleanToolResult({ accepted: false, mode: 'plan', error: 'plan requires requirements and targetKind' }) as unknown as JsonValue
            const existing = taskSession.read().pending
            if (existing) {
              const prior = controller.read(existing.planId)
              return cleanToolResult({ accepted: false, mode: 'plan', task: userEvolutionTaskCard(prior), error: '该会话已有等待确认的任务；请保留、取消后替换，或先查看状态' }) as unknown as JsonValue
            }
            const plan = controller.plan(evolutionRequirements, targetKind)
            taskSession.beginPending({
              planId: plan.id, userRequest: evolutionRequirements, actorExplanation: actorAssessment ?? plan.target.summary,
              suggestions: [{ key: 'selected', title: plan.target.summary, summary: plan.target.verification, target: { kind: plan.target.kind, id: plan.target.plan.targetId } }],
            })
            return cleanToolResult({ accepted: true, mode: 'plan', task: userEvolutionTaskCard(plan, undefined, {
              suggestions: [{ key: 'selected', title: plan.target.summary, summary: plan.target.verification }],
              confirmation: '我已根据当前会话证据冻结这个候选。是否开始隔离实现，并交给独立 Verifier/Gate 裁决？',
            }), note: '方案已冻结但尚未执行。请向用户解释目标、风险和验收方式，等待明确确认。' }) as unknown as JsonValue
          }
          const planId = typeof args.planId === 'string' ? args.planId : taskSession.read().pending?.planId ?? ''
          if (!planId) return cleanToolResult({ accepted: false, mode: 'execute', error: '当前会话没有等待确认的任务；execute 不会猜测或创建旁路。' }) as unknown as JsonValue
          const queued = controller.queue(planId)
          const jobId = scheduleRefine({ tool: 'meta_auto', kind: 'user-evolution', planId }, async () => {
            taskSession.setCursor(planId, 'implementing')
            const complete = await controller.execute(planId)
            taskSession.finish(planId, complete.state === 'completed' ? 'completed' : complete.state === 'rejected' ? 'rejected' : 'aborted')
            const report = complete.result
            return {
              summary: `用户委托 ${complete.target.kind}/${complete.target.plan.targetId}：${report?.applied ? '已生效' : complete.state}${report?.summary ? `；${report.summary}` : ''}`,
            }
          })
          taskSession.beginActive(planId, jobId)
          return cleanToolResult({ accepted: true, mode: 'execute', task: userEvolutionTaskCard(queued, 'scheduled'), note: '已后台开始执行，不阻塞当前 Actor。可用任务状态卡解释进度。' }) as unknown as JsonValue
        } catch (caught) {
          return cleanToolResult({ accepted: false, mode: evolutionMode, error: String(caught) }) as unknown as JsonValue
        }
      }
      if (args.exploreLoop === true) {
        if (config.allowLoopCandidates.executionRuntime !== 'mini-swe') {
          return cleanToolResult({
            mode: 'loop-exploration', enabled: config.allowLoopCandidates.enabled,
            error: 'v1.2 Loop implementation requires executionRuntime=mini-swe; Loom-native is diagnosis/clarification only and cannot be delegated as a source editor.',
          }) as unknown as JsonValue
        }
        const currentConfig = currentConfigOf(ctx, baseline)
        const signals = observer.collect(config.thresholds)
        const evidencePack = createActorEvidencePack({
          root,
          sessionId: config.sessionId,
          observer,
          currentConfig,
          signals,
          state: readJson(paths.autopilotState(root, config.sessionId)) ?? {
            schemaVersion: PROTOCOL_VERSION,
            epoch: 0,
            iterationsThisEpoch: 0,
            lastIterationTurn: 0,
            lastApplyTurn: 0,
          },
          requirements: requirements ?? '',
          actorAssessment,
        })
        const started = loopCandidateGateway.startExploration(requirements ?? '', {
          ...currentConfig,
          runtimeCwd: process.cwd(),
          activeActorRequest: requirements ?? '',
          ...(actorAssessment ? { actorAssessment } : {}),
          ...(resumeTarget?.runId ? { resumeFromRunId: resumeTarget.runId } : {}),
          evidencePack,
        })
        if (!started.accepted) {
          return cleanToolResult({
            mode: 'loop-exploration',
            enabled: config.allowLoopCandidates.enabled,
            exploration: started,
            note: 'Builder exploration was not started.',
          }) as unknown as JsonValue
        }
        const loopHolder = { runId: started.runId }
        let loopRunner: (jobId: string) => Promise<{ summary: string; status?: 'finished' | 'paused' | 'cancelled' | 'waiting_for_input' }>
        loopRunner = async (runnerJobId: string) => {
          const jobId = runnerJobId
          const maxAttempts = Math.max(1, config.allowLoopCandidates.builderMaxReopenAttempts ?? 3)
          let currentRunId = loopHolder.runId
          const rejections: string[] = []
          let summary = ''
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const exploration = await loopCandidateGateway.runExploration(currentRunId)
            summary = `run=${currentRunId} attempt=${attempt}/${maxAttempts} state=${exploration.state} turns=${exploration.modelTurns} tools=${exploration.toolSteps}${exploration.reason ? ` reason=${exploration.reason}` : ''}`
            if (exploration.state !== 'submitted' || !exploration.proposal) {
              summary += '；未提交 proposal，不进入裁决'
              break
            }
            const classified = classifyBuilderProposal(exploration.proposal)
            if (classified.kind === 'malformed') {
              const rejection = {
                source: 'proposal-normalization',
                capability: exploration.proposal.capability,
                verdict: 'rejected',
                failureSummary: `invalid proposal: ${classified.reason}`,
                proposal: exploration.proposal,
                observedAt: new Date().toISOString(),
              } satisfies Record<string, unknown>
              summary += `；${rejection.failureSummary}`
              rejections.push(String(rejection.failureSummary))
              if (attempt < maxAttempts) {
                currentRunId = loopCandidateGateway.reopenExploration(currentRunId, rejection)
                loopRunHolders.set(currentRunId, { runId: currentRunId, runner: loopRunner, holder: loopHolder, request: { tool: 'meta_auto', kind: 'loop-exploration', runId: currentRunId, requirements: requirements ?? '' } })
                updateJob(runnerJobId, { activeRunId: currentRunId, runLineage: [...(readJson<PersistedJob>(jobPathFor(runnerJobId))?.runLineage ?? [loopHolder.runId]), currentRunId] })
                summary += `；rejected → reopened=${currentRunId}`
              }
              continue
            }
            if (classified.kind === 'needs_verifier') {
              const draftPath = persistCapabilityDraft(root, config.sessionId, currentRunId, classified)
              summary += `；submitted capability=${classified.capability} → needs_verifier（未安装，需新 verifier；草案=${draftPath}）`
              appendReport(root, config.sessionId, `能力草案：${classified.capability} → needs_verifier（等待新 verifier 接入；未安装）`)
              break
            }
            const proposal = classified.proposal
            let verdict: 'approved' | 'rejected' = 'rejected'
            let reason: string | undefined
            let rejectionReport: Record<string, unknown> = {
              source: 'deliberation', capability: proposal.capability, verdict: 'rejected', observedAt: new Date().toISOString(),
            }
            try {
              if (proposal.capability === 'patch-evolution') {
                const cases = await validator.loadRegressionCases()
                const ops = buildApplyOps(ctx, validator, cases, { root, sessionId: config.sessionId, skillRoot: config.skillRoot }, baseline)
                const pack = readActorEvidencePack(evidencePack.manifestPath) ?? evidencePack
                const result = await adjudicatePatch(proposal, {
                  root, sessionId: config.sessionId, validator: loopValidator, gate,
                  collectFrames: (patch, base) => collectFramesForPatch(patch, base, {
                    enabled: config.isolation.enabled, dshCommand: config.isolation.dshCommand, cwd: config.isolation.cwd,
                    profile: config.isolation.profile, baseOverlays: config.isolation.baseOverlays, probe: config.isolation.probe,
                    probeTimeoutMs: config.isolation.probeTimeoutMs,
                    stagingRootFor: (patchId) => paths.staging(root, config.sessionId, patchId),
                    skillProbe: (patch) => loopValidator.probeSkillForFrames(patch),
                  }),
                  applyOps: ops, evidenceEvents: evidenceEventsOf(pack),
                  onApplied: async ({ patch, report, applied }) => {
                    appendLedger(root, config.sessionId, {
                      id: patch.id, triggeredBy: 'S9-explicit-request',
                      problem: report.failureSummary ?? requirements ?? 'user-initiated builder delegation',
                      changes: [{ target: patch.targetId, kind: patch.targetKind, before: {}, after: patch.config }],
                      verdict: report.verdict, applied: applied.applied, metricsBefore: {}, metricsAfter: {}, rolledBack: false,
                      appliedAt: new Date().toISOString(),
                    })
                    appendReport(root, config.sessionId, `用户主动委托：${patch.targetKind} ${patch.targetId} → ${report.verdict}（applied=${applied.applied}）`)
                    if (config.isolation.enabled) {
                      const rerun = runIsolation(patch, {
                        dshCommand: config.isolation.dshCommand, cwd: config.isolation.cwd, profile: config.isolation.profile,
                        baseOverlays: config.isolation.baseOverlays, stagingRoot: paths.staging(root, config.sessionId, patch.id),
                        probe: requirements || config.isolation.probe, probeTimeoutMs: config.isolation.probeTimeoutMs,
                      })
                      appendReport(root, config.sessionId, `同任务重跑：exit=${rerun.probe?.exitCode ?? 'n/a'} ${rerun.probe?.outputTail?.slice(0, 200) ?? ''}`)
                    }
                  },
                })
                verdict = result.verdict; reason = result.reason
                rejectionReport = { ...rejectionReport, verdict: result.verdict, failureSummary: result.reason ?? result.report.failureSummary, report: result.report, applied: result.applied, patch: result.patch }
                summary += `；patch verdict=${result.verdict} target=${result.patch.targetId} applied=${result.applied?.applied ?? false}`
              } else {
                const loopRoot = config.allowLoopCandidates.runtimeRoot || join(root, 'loop-candidate-runtime')
                const importer = new CandidateImporter({ root: loopRoot, baselineRoot: config.allowLoopCandidates.baselineRoot, buildDependencyRoot: config.allowLoopCandidates.buildDependencyRoot })
                const result = await adjudicateLoop(proposal, {
                  root: loopRoot, importer,
                  verifyContract: (manifest) => verifyLoopContract(manifest, ctx, baseline, root, config.sessionId, config),
                  install: (candidateId) => installLoopCandidate(candidateId, config, root),
                })
                verdict = result.verdict; reason = result.reason
                rejectionReport = { ...rejectionReport, verdict: result.verdict, failureSummary: result.reason, candidateId: result.candidateId, evidence: result.evidence, install: result.install }
                summary += `；loop verdict=${result.verdict} candidate=${result.candidateId}${result.reason ? ` reason=${result.reason}` : ''}`
                appendReport(root, config.sessionId, `loop 演进：${result.candidateId} → ${result.verdict}${result.install ? ` state=${result.install.state}` : ''}`)
                if (result.install?.state === 'installed') {
                  const comparison = replayInstalledLoopTask(result.candidateId, requirements || config.allowLoopCandidates.contractTask, config, root, config.sessionId, result)
                  if (comparison) appendReport(root, config.sessionId, `同任务 before/after：${comparison.id} baseline=${comparison.baseline.durationMs}ms installed=${comparison.installed.durationMs}ms claim=${comparison.claimLevel}`)
                }
              }
            } catch (error) {
              verdict = 'rejected'; reason = `adjudication exception: ${String(error)}`
              rejectionReport = { ...rejectionReport, verdict: 'rejected', failureSummary: reason, error: String(error), proposal }
              summary += `；裁决异常已转为 rejected：${String(error).slice(0, 300)}`
            }
            if (verdict === 'approved') break
            rejections.push(reason ?? 'rejected')
            if (attempt < maxAttempts) {
              const priorLineage = readJson<PersistedJob>(jobPathFor(runnerJobId))?.runLineage ?? [loopHolder.runId]
              currentRunId = loopCandidateGateway.reopenExploration(currentRunId, { ...rejectionReport, failureSummary: reason ?? rejectionReport.failureSummary ?? 'verifier rejected' })
              loopRunHolders.set(currentRunId, { runId: currentRunId, runner: loopRunner, holder: loopHolder, request: { tool: 'meta_auto', kind: 'loop-exploration', runId: currentRunId, requirements: requirements ?? '' } })
              updateJob(runnerJobId, { activeRunId: currentRunId, runLineage: [...priorLineage, currentRunId] })
              summary += `；rejected → reopened=${currentRunId}`
            } else summary += `；maxAttempts=${maxAttempts} rejected=${rejections.join(' | ')}`
          }
          const finalState = loopCandidateGateway.explorationStatus(currentRunId).state
          if (finalState === 'paused' || finalState === 'waiting_for_input' || finalState === 'cancelled') {
            return { summary, status: finalState === 'cancelled' ? 'cancelled' : finalState }
          }
          return { summary, status: 'finished' }
        }
        const jobId = scheduleRefine({
          tool: 'meta_auto',
          kind: 'loop-exploration',
          runId: started.runId,
          requirements: requirements ?? '',
          ...(resumeTarget?.runId ? { resumedFromRunId: resumeTarget.runId } : {}),
        }, () => loopRunner(jobId))
        loopJobRunners.set(jobId, loopRunner)
        loopRunHolders.set(started.runId, { runId: started.runId, runner: loopRunner, holder: loopHolder, request: {
          tool: 'meta_auto', kind: 'loop-exploration', runId: started.runId, requirements: requirements ?? '', ...(resumeTarget?.runId ? { resumedFromRunId: resumeTarget.runId } : {}),
        } })
        return cleanToolResult({
          mode: 'loop-exploration',
          enabled: config.allowLoopCandidates.enabled,
          accepted: true,
          jobId,
          runId: started.runId,
          builderSessionId: jobId,
          ...(resumeTarget?.runId ? { resumedFromRunId: resumeTarget.runId } : {}),
          state: 'scheduled',
          note: 'Builder 会话已在后台运行。使用 meta_builder_status、meta_builder_events 或 meta_builder_message 读取进度、接收追问和投递用户原话；submitted proposal 才会进入 verifier/gate。',
        }) as unknown as JsonValue
      }
      const runAuto = async (): Promise<{ outcome: Awaited<ReturnType<AutoPilot['step']>> }> => {
        const cases = await validator.loadRegressionCases()
        const ops = buildApplyOps(ctx, validator, cases, { root, sessionId: config.sessionId, skillRoot: config.skillRoot }, baseline)
        const currentConfig = currentConfigOf(ctx, baseline)
        const outcome = await autopilot.step(turn, currentConfig, requirements, { actualEvents: [] }, ops)
        return { outcome }
      }
      if (config.scheduled) {
        const jobId = scheduleRefine({ tool: 'meta_auto', turn, requirements }, async () => {
          const { outcome } = await runAuto()
          if (!outcome.fired) return { summary: `未触发（${outcome.reason}）` }
          return {
            summary: `target=${outcome.result.patch?.targetId ?? 'n/a'}（${outcome.result.patch?.targetKind ?? '?'}）verdict=${outcome.result.report.verdict} applied=${outcome.result.applied?.applied ?? false}`,
          }
        })
        return { scheduled: true, jobId } as unknown as JsonValue
      }
      const { outcome } = await runAuto()
      return cleanToolResult({
        fired: outcome.fired,
        reason: outcome.reason,
        decision: outcome.decision,
        iterations: outcome.fired ? outcome.result.iterations : undefined,
        verdict: outcome.fired ? outcome.result.report.verdict : undefined,
        applied: outcome.fired ? (outcome.result.applied?.applied ?? false) : false,
        escalated: outcome.fired ? outcome.result.escalated : false,
        note: '同步执行完成（scheduled=false）',
      }) as unknown as JsonValue
    },
  }))

  if (config.mode !== 'observe') {
    const hook = new TurnBoundaryHook(ctx, {
      observer,
      thresholds: config.thresholds,
      root,
      sessionId: config.sessionId,
      stallAbort: config.reviewGate.stallAbort,
      refineRunning: () => refineState.running,
      onTrigger: async (turn) => {
        try {
          await withRefineRunning(async () => {
            const cases = await validator.loadRegressionCases()
            const ops = buildApplyOps(ctx, validator, cases, { root, sessionId: config.sessionId, skillRoot: config.skillRoot }, baseline)
            const currentConfig = currentConfigOf(ctx, baseline)
            await autopilot.step(turn, currentConfig, undefined, { actualEvents: [] }, ops)
          })
        } catch (error) {
          appendJsonl(paths.errors(root, config.sessionId), {
            schemaVersion: PROTOCOL_VERSION,
            at: new Date().toISOString(),
            turn,
            error: String(error),
          })
        }
      },
    })
    hook.attach()
  }

}

function findSubmittedPatch(root: string, sessionId: string): { patch: MetaPatch; status: PatchStatus } | null {
  const patchesDir = join(root, 'workspace', sessionId, 'patches')
  if (!existsSync(patchesDir)) return null
  let best: { patch: MetaPatch; status: PatchStatus; at: number } | null = null
  for (const name of readdirSync(patchesDir)) {
    const dir = join(patchesDir, name)
    const status = readJson<PatchStatus>(join(dir, 'status.json'))
    if (!status || status.state !== 'submitted') continue
    const patch = readJson<MetaPatch>(join(dir, 'candidate.json'))
    if (!patch) continue
    const at = new Date(status.updatedAt).getTime()
    if (!best || at > best.at) best = { patch, status, at }
  }
  return best ? { patch: best.patch, status: best.status } : null
}

function cleanToolResult<T extends Record<string, unknown>>(value: T): T {
  const cleaned = {} as T
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) (cleaned as Record<string, unknown>)[key] = item
  }
  return cleaned
}

function parseBuilderEventCursor(value: string | undefined, fallbackSeq: number): { lineageId?: string; runId?: string; seq: number } {
  if (!value) return { seq: fallbackSeq }
  const parts = value.split(':')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !/^\d+$/.test(parts[2]!)) return { seq: fallbackSeq }
  return { lineageId: parts[0], runId: parts[1], seq: Number(parts[2]) }
}

function loopRuntimeConfigured(cfg: MetaValidateConfig['allowLoopCandidates']): boolean {
  return Boolean(cfg.baselineRoot && cfg.baseBundle && cfg.dependencyRoot && cfg.contractCommand.length > 0 && cfg.goldenPath)
}

function evidenceEventsOf(pack: ActorEvidencePack): ActualEvent[] {
  const eventsRef = pack.rawRefs.find((ref) => ref.name === 'events')
  if (!eventsRef?.exists) return []
  const source = eventsRef.snapshotPath ?? eventsRef.path
  return readFileSync(source, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ActualEvent)
}

/**
 * Persist a well-formed but unknown capability submission as a draft awaiting
 * a new verifier. It is never installed and never blocked from exploration.
 */
function persistCapabilityDraft(
  root: string,
  sessionId: string,
  runId: string,
  draft: Extract<ReturnType<typeof classifyBuilderProposal>, { kind: 'needs_verifier' }>,
): string {
  const dir = join(root, 'workspace', sessionId, 'capability-drafts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${runId}.json`)
  atomicWriteJson(path, {
    schemaVersion: 1,
    runId,
    state: 'needs_verifier',
    capability: draft.capability,
    payload: draft.payload,
    rationale: draft.rationale ?? null,
    artifacts: draft.artifacts ?? [],
    submittedAt: new Date().toISOString(),
  })
  return path
}

/**
 * v1.1 loop contract overlay: llm/model rows plus an inserted meta-validate
 * observer. The candidate loop itself is resolved through the Loader-level
 * candidate profile, never through an overlay name (dsh only resolves package
 * names, not absolute entries).
 */
function writeContractOverlay(
  manifest: CandidateManifest,
  ctx: Context,
  baseline: { ensureLoaded(): void; rows: Record<string, { name?: string; config: Record<string, unknown> }> },
  root: string,
  sessionId: string,
  config: MetaValidateConfig,
): string {
  const rows = currentConfigOf(ctx, baseline)
  const metaRow = rows['meta-validate'] as { name?: string; config?: Record<string, unknown> } | undefined
  const metaName = metaRow?.name ?? '/chenzute/dsh-meta-validate-handoff/dist/index.js'
  const metaConfig: Record<string, unknown> = { ...(metaRow?.config ?? {}), mode: 'observe', sessionId: 'loom-contract' }
  // The contract runner owns its isolated workspace via DSH_META_VALIDATE_ROOT;
  // the host session workspaceRoot must not redirect observer frames.
  delete metaConfig.workspaceRoot
  delete metaConfig.runtimeRoot
  const selectorRows = ['llm-deepseek', 'agent-default-model']
    .filter((id) => rows[id])
    .map((id) => {
      const row = rows[id] as { name?: string; config?: Record<string, unknown> }
      const config = { ...(row.config ?? {}) }
      // currentConfigOf redacts any key containing "token"; the contract
      // overlay needs the real numeric maxTokens to boot the model row.
      if (id === 'llm-deepseek' && config.maxTokens === '***') config.maxTokens = 8192
      return { id, row: { name: row.name, config } }
    })
  const dir = join(root, 'workspace', sessionId, 'loop-candidates', 'overlays')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${manifest.id}.yml`)
  const body = [
    ...selectorRows.map(({ id, row }) => {
      const configLines = JSON.stringify(row.config ?? {}, null, 2).split('\n').map((line) => `    ${line}`).join('\n')
      return `- id: ${id}\n  name: ${JSON.stringify(row.name ?? id)}\n  config:\n${configLines}`
    }),
    `- insert:\n    - id: meta-validate\n      name: ${JSON.stringify(metaName)}\n      config:\n${JSON.stringify(metaConfig, null, 2).split('\n').map((line) => `        ${line}`).join('\n')}`,
  ].join('\n')
  writeFileSync(path, `${body}\n`, 'utf8')
  return path
}

/**
 * Independent loop contract verifier (C0/C1-C8/C6). Fail-closed whenever the
 * runtime is not configured or the runner output is not a passing report.
 */
async function verifyLoopContract(
  manifest: CandidateManifest,
  ctx: Context,
  baseline: { ensureLoaded(): void; rows: Record<string, { name?: string; config: Record<string, unknown> }> },
  root: string,
  sessionId: string,
  config: MetaValidateConfig,
): Promise<{ passed: boolean; evidence?: ContractEvidence; reason?: string }> {
  const cfg = config.allowLoopCandidates
  if (!loopRuntimeConfigured(cfg)) {
    return { passed: false, reason: 'loop runtime not configured (baselineRoot/baseBundle/dependencyRoot/contractCommand/goldenPath)' }
  }
  const overlay = writeContractOverlay(manifest, ctx, baseline, root, sessionId, config)
  const runtimeRoot = cfg.runtimeRoot || join(root, 'loop-candidate-runtime')
  const runtime = join(runtimeRoot, 'contract-runtime')
  const reportPath = join(runtimeRoot, 'reports', `${manifest.id}.json`)
  mkdirSync(dirname(reportPath), { recursive: true })
  try {
    const profile = createCandidateProfile({
      runtimeRoot,
      candidateId: manifest.id,
      candidateArtifact: manifest.artifactPath,
      baseBundle: cfg.baseBundle,
      dependencyRoot: cfg.dependencyRoot,
      additionalDependencyRoots: cfg.additionalDependencyRoots,
    })
    const out = execFileSync(cfg.contractCommand[0]!, [
      ...cfg.contractCommand.slice(1),
      'check', overlay, cfg.contractTask, cfg.goldenPath,
      '--profile', profile.profile,
      '--profile-home', profile.home,
      '--expected-entry', profile.runtimeEntry,
      '--regression',
    ], {
      cwd: PLUGIN_ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env: {
        ...childEnv(),
        DSH_CMD: config.isolation.dshCommand.join(' '),
        DSH_CWD: config.isolation.cwd,
        DSH_HOME: join(runtime, 'dsh-home'),
        DSH_META_VALIDATE_ROOT: runtime,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    writeFileSync(reportPath, out, 'utf8')
    const report = JSON.parse(out.slice(out.indexOf('{'))) as { pass?: unknown; detail?: unknown }
    const evidence: ContractEvidence = { contractReport: reportPath, regressionReport: reportPath, verifiedAt: new Date().toISOString() }
    if (report.pass !== true) {
      return { passed: false, evidence, reason: `contract failed: ${JSON.stringify(report.detail ?? '').slice(0, 500)}` }
    }
    return { passed: true, evidence }
  } catch (error) {
    const detail = error as { stdout?: Buffer; stderr?: Buffer; message?: string }
    const tail = `${detail.stdout?.toString() ?? ''}${detail.stderr?.toString() ?? ''}`.slice(-1000) || String(detail.message)
    return { passed: false, reason: `contract runner failed: ${tail}` }
  }
}

/** Gate-owned cold install through the Loader-level candidate profile adapter. */
async function installLoopCandidate(
  candidateId: string,
  config: MetaValidateConfig,
  root: string,
): Promise<LoopInstallReport> {
  const cfg = config.allowLoopCandidates
  if (!cfg.runtimeRoot) throw new Error('loop runtimeRoot is not configured')
  const runtimeRoot = cfg.runtimeRoot || join(root, 'loop-candidate-runtime')
  const registry = new CandidateRegistry(runtimeRoot)
  const ops = profileGateOps({
    runtimeRoot,
    baseBundle: cfg.baseBundle,
    dependencyRoot: cfg.dependencyRoot,
    additionalDependencyRoots: cfg.additionalDependencyRoots,
    dumpConfig: (profile) => {
      try {
        const output = execFileSync(config.isolation.dshCommand[0]!, [
          ...config.isolation.dshCommand.slice(1),
          '--profile', profile.profile, '--dump-config',
        ], {
          cwd: config.isolation.cwd,
          env: { ...childEnv(), DSH_HOME: profile.home },
          encoding: 'utf8',
          timeout: 60_000,
        })
        return { exitCode: 0, output }
      } catch (error) {
        const detail = error as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string }
        return { exitCode: detail.status ?? 1, output: String(detail.stdout ?? detail.stderr ?? detail.message) }
      }
    },
  }, candidateId)
  return installVerifiedCandidate(registry, candidateId, ops)
}

/**
 * Replay the exact delegated task once against the base profile and once
 * against the cold-installed candidate profile. This is deliberately an
 * evidence artifact only: an exit code is not promoted to a broad improvement
 * claim without a task oracle and the independent contract/gate reports.
 */
function replayInstalledLoopTask(
  candidateId: string,
  task: string,
  config: MetaValidateConfig,
  root: string,
  sessionId: string,
  adjudication: { evidence?: ContractEvidence; install?: LoopInstallReport },
): ActorComparison | null {
  const cfg = config.allowLoopCandidates
  if (!cfg.runtimeRoot || !config.isolation.cwd || config.isolation.dshCommand.length === 0) return null
  const id = `loop-${candidateId}-${Date.now()}`
  const baseCommand = [
    ...config.isolation.dshCommand,
    '--profile', config.isolation.profile,
    ...config.isolation.baseOverlays.flatMap((overlay) => ['--patch', overlay]),
  ]
  const installedCommand = [...config.isolation.dshCommand, '--profile', `loom-${candidateId}`]
  const outputDir = join(root, 'workspace', sessionId, 'comparisons', id)
  const baseline = runActorReplay({
    label: 'baseline', command: baseCommand, cwd: config.isolation.cwd,
    env: { ...childEnv(), DSH_HOME: join(cfg.runtimeRoot, 'baseline-home') },
    task, outputPath: join(outputDir, 'baseline.stdout'), timeoutMs: config.isolation.probeTimeoutMs,
  })
  const installed = runActorReplay({
    label: 'installed', command: installedCommand, cwd: config.isolation.cwd,
    env: { ...childEnv(), DSH_HOME: join(cfg.runtimeRoot, 'loader-profiles', candidateId) },
    task, outputPath: join(outputDir, 'installed.stdout'), timeoutMs: config.isolation.probeTimeoutMs,
  })
  return writeActorComparison({
    root,
    sessionId,
    id,
    task,
    baseline,
    installed,
    contractPass: Boolean(adjudication.evidence?.contractReport),
    regressionPass: Boolean(adjudication.evidence?.regressionReport),
    gatePass: adjudication.install?.state === 'installed',
    // Rollback is a separate fault-injection proof; this successful replay
    // does not silently claim that rollback was exercised.
    rollbackRequired: false,
    beforeSnapshot: adjudication.install?.before,
    afterSnapshot: adjudication.install?.after,
    extra: { candidateId, evidence: adjudication.evidence ?? null },
  })
}

interface LoaderLike {
  entries(): Array<{ options: { id: string; name?: string; config?: Record<string, unknown> } }>
  update(id: string, options: { config?: unknown }): Promise<unknown>
  create(options: { id: string; name: string; config?: unknown }): Promise<unknown>
  remove(id: string): Promise<unknown>
}

interface LoaderEntry {
  options: { id: string; name?: string; config?: Record<string, unknown> }
  id: string
}

interface HarnessStateRecord {
  schemaVersion: number
  sessionId: string
  restartRequired: boolean
  applied: Array<{
    patchId: string
    targetId: string
    targetName?: string
    overlay: string
    beforeHash?: string
    afterHash: string
    appliedAt: string
  }>
}

/**
 * Real, redacted config snapshot for the builder (08 §12 I6): every loader row
 * id/name/config except secret-looking values. This is builder input only; the
 * builder decides what to change.
 */
function currentConfigOf(
  ctx: Context,
  baseline: { ensureLoaded(): void; rows: Record<string, { name?: string; config: Record<string, unknown> }> },
): Record<string, unknown> {
  baseline.ensureLoaded()
  const merged: Record<string, { name: string; config: Record<string, unknown> }> = {}
  for (const [id, row] of Object.entries(baseline.rows)) {
    merged[id] = { name: row.name ?? id, config: { ...row.config } }
  }
  const loader = (ctx as unknown as { loader?: LoaderLike }).loader
  if (loader) {
    for (const entry of loader.entries()) {
      merged[entry.options.id] = { name: entry.options.name ?? entry.options.id, config: { ...(entry.options.config ?? {}) } }
    }
  }
  const rows = Object.entries(merged).map(([id, row]) => ({ id, name: row.name, config: row.config }))
  const priority = ['agent', 'agent-default-model', 'llm-deepseek', 'llm-pi-ai', 'meta-validate', 'system-prompt']
  const rank = (row: { id: string }): number => {
    const index = priority.indexOf(row.id)
    return index < 0 ? priority.length : index
  }
  rows.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    const config: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row.config)) {
      config[key] = /(api[_-]?key|token|secret|password|authorization)/i.test(key) ? '***' : value
    }
    out[row.id] = { name: row.name, config }
  }
  return out
}

function buildApplyOps(
  ctx: Context,
  validator: Validator,
  cases: Awaited<ReturnType<Validator['loadRegressionCases']>>,
  meta: { root: string; sessionId: string; skillRoot: string },
  baseline: { ensureLoaded(): void; rows: Record<string, { name?: string; config: Record<string, unknown> }>; set(targetId: string, name: string | undefined, config: Record<string, unknown>): void },
): Parameters<IterationLoop['run']>[4] {
  baseline.ensureLoaded()
  let loader: LoaderLike | undefined
  try {
    loader = (ctx as unknown as { loader?: LoaderLike }).loader
  } catch {
    loader = undefined
  }
  if (!loader) return undefined
  const installedByTarget = new Map<string, { dir: string; entryId: string }>()
  const entries = (): LoaderEntry[] => [...(loader.entries() as Iterable<LoaderEntry>)]
  const harnessStatePath = paths.harnessState(meta.root, meta.sessionId)
  const readHarnessState = (): HarnessStateRecord => readJson<HarnessStateRecord>(harnessStatePath)
    ?? { schemaVersion: PROTOCOL_VERSION, sessionId: meta.sessionId, restartRequired: false, applied: [] }
  const writeHarnessState = (state: HarnessStateRecord): void => {
    atomicWriteJson(harnessStatePath, state)
  }
  const updateHarnessState = (patch: MetaPatch, overlay: string, before: Record<string, unknown>): void => {
    const state = readHarnessState()
    state.restartRequired = true
    state.applied = state.applied.filter((record) => record.patchId !== patch.id)
    state.applied.push({
      patchId: patch.id,
      targetId: patch.targetId,
      targetName: patch.targetName,
      overlay,
      beforeHash: sha256(before),
      afterHash: sha256(patch.config),
      appliedAt: new Date().toISOString(),
    })
    writeHarnessState(state)
  }
  const removeHarnessState = (patch: MetaPatch): void => {
    const state = readHarnessState()
    state.applied = state.applied.filter((record) => record.patchId !== patch.id)
    state.restartRequired = state.applied.length > 0
    writeHarnessState(state)
  }
  return {
    readConfig: (targetId) => {
      if (baseline.rows[targetId]) return baseline.rows[targetId]?.config ?? {}
      const live = entries().find((entry) => entry.options.id === targetId)
      return live?.options.config ?? {}
    },
    writeConfig: (targetId, config, patch) => {
      const all = entries()
      const entry = all.find((item) => item.options.id === targetId)
      const name = entry?.options.name ?? baseline.rows[targetId]?.name ?? patch.targetId
      const overlay = paths.overlayFile(meta.root, meta.sessionId, patch.id)
      const lines = [
        `- id: ${patch.targetId}`,
        `  name: '${name}'`,
        '  config:',
        ...String(JSON.stringify(config, null, 2)).split('\n').map((line) => `    ${line}`),
      ]
      mkdirSync(paths.overlays(meta.root, meta.sessionId), { recursive: true })
      writeFileSync(overlay, `${lines.join('\n')}\n`, 'utf8')
      baseline.set(patch.targetId, name, config)
      updateHarnessState(patch, overlay, entry?.options.config ?? baseline.rows[patch.targetId]?.config ?? {})
      return overlay
    },
    restoreConfig: (_targetId, _before, patch) => {
      const overlay = paths.overlayFile(meta.root, meta.sessionId, patch.id)
      rmSync(overlay, { force: true })
      baseline.set(patch.targetId, baseline.rows[patch.targetId]?.name, _before)
      removeHarnessState(patch)
    },
    smoke: (patch) => validator.runSmoke(patch, cases),
    rowExists: (id) => entries().some((entry) => entry.options.id === id),
    insertRow: async (patch) => {
      if (!patch.module) throw new Error('insert patch missing module')
      const dir = join(meta.root, 'installed', meta.sessionId, patch.id)
      mkdirSync(dir, { recursive: true })
      for (const file of patch.module.files) {
        const target = join(dir, file.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.content, 'utf8')
      }
      const entry = join(dir, patch.module.entry)
      const entryId = String(await loader.create({ id: patch.targetId, name: entry, config: patch.config }))
      installedByTarget.set(patch.targetId, { dir, entryId })
    },
    removeRow: async (id) => {
      const installed = installedByTarget.get(id)
      if (installed) {
        await loader.remove(installed.entryId)
        rmSync(installed.dir, { recursive: true, force: true })
      }
    },
    skillExists: (id) => meta.skillRoot ? existsSync(join(meta.skillRoot, id)) : false,
    installSkill: async (patch) => {
      if (!meta.skillRoot) throw new Error('skillRoot not configured')
      if (!patch.module) throw new Error('skill patch missing module')
      for (const file of patch.module.files) {
        const target = join(meta.skillRoot, file.path)
        mkdirSync(join(meta.skillRoot, file.path.split('/')[0] ?? ''), { recursive: true })
        writeFileSync(target, file.content, 'utf8')
      }
    },
    removeSkill: async (id) => {
      if (meta.skillRoot) rmSync(join(meta.skillRoot, id), { recursive: true, force: true })
    },
  }
}
