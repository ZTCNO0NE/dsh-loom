import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Gate } from './gate/index.js';
import { AutoPilot } from './meta/autopilot.js';
import { IterationLoop } from './meta/loop.js';
import { Proposer } from './meta/propose.js';
import { ReviewGate } from './meta/review.js';
import { TurnBoundaryHook } from './meta/turnboundary.js';
import { collectFramesForPatch } from './meta/collectFrames.js';
import { Observer } from './observer/index.js';
import { Validator } from './validate/index.js';
import { appendJsonl, atomicWriteJson, ensureWorkspace, metaRoot, paths, PROTOCOL_VERSION, readJson, readJsonl, sha256, } from './protocol/index.js';
import { runIsolation } from './isolation/runner.js';
import { childEnv } from './isolation/runner.js';
import { officialDeepSeekLlm } from './llm/official.js';
import { LoopCandidateGateway } from './candidates/gateway.js';
import { CandidateImporter, CandidateRegistry } from './candidates/index.js';
import { profileGateOps } from './candidates/profile-gate.js';
import { installVerifiedCandidate } from './candidates/lifecycle.js';
import { adjudicatePatch, adjudicateLoop } from './deliberation/index.js';
import { createActorEvidencePack, readActorEvidencePack } from './evidence/index.js';
import { DEFAULT_LOCKED_TARGETS } from './policy.js';
import { appendLedger, appendReport, readLedger, readPreferences, scenarioOf, } from './growth/index.js';
export const name = 'dsh-meta-validate';
export const inject = ['tools', 'agents', 'loader'];
export const Config = Schema.object({
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
        builderMaxModelTurns: Schema.number().default(24),
        builderMaxToolSteps: Schema.number().default(48),
        builderMaxWallTimeMs: Schema.number().default(600000),
    }),
    lockedTargets: Schema.object({
        ids: Schema.array(Schema.string()).default(DEFAULT_LOCKED_TARGETS.ids),
        names: Schema.array(Schema.string()).default(DEFAULT_LOCKED_TARGETS.names),
    }),
});
export function apply(ctx, config) {
    const root = config.workspaceRoot || metaRoot();
    ensureWorkspace(root, config.sessionId);
    // dsh rebuilds its loader tree between turns (observed: after the first
    // applied update the tree collapses to include + plugin entry). All config
    // reads/writes therefore merge a lazily-captured baseline with live entries.
    const baselineRows = {};
    let baselineLoaded = false;
    const ensureBaseline = () => {
        if (baselineLoaded)
            return baselineRows;
        baselineLoaded = true;
        const loader = ctx.loader;
        if (loader) {
            for (const entry of loader.entries()) {
                baselineRows[entry.options.id] = { name: entry.options.name, config: entry.options.config ?? {} };
            }
        }
        return baselineRows;
    };
    const baseline = {
        ensureLoaded: () => { ensureBaseline(); },
        rows: baselineRows,
        set: (targetId, name, config) => {
            baselineRows[targetId] = { name, config };
        },
    };
    // Scheduled background refine (预约式后台执行): meta tools return
    // immediately; the loop runs single-flight; completion is injected back
    // into the actor session as a plugin notice ("reload 后生效").
    const refineState = { running: false };
    const jobQueue = [];
    let jobRunning = false;
    const withRefineRunning = async (fn) => {
        refineState.running = true;
        try {
            return await fn();
        }
        finally {
            refineState.running = false;
        }
    };
    const injectNotice = (text, summary) => {
        appendJsonl(paths.notices(root, config.sessionId), { text, summary, at: new Date().toISOString() });
        try {
            const agents = ctx.agents;
            for (const agent of agents?.list?.() ?? []) {
                agent.inject({
                    role: 'user',
                    content: [{ type: 'text', text }],
                    source: { kind: 'plugin', plugin: 'dsh-meta-validate', form: 'notice', summary },
                });
            }
        }
        catch {
            // Notification is best-effort; a missing agents service must not kill the job.
        }
    };
    const startNextJob = () => {
        if (jobRunning || jobQueue.length === 0)
            return;
        jobRunning = true;
        const job = jobQueue.shift();
        const activeJobId = job.id;
        const progressTimer = config.notify.progress && config.notify.progressAfterMs > 0
            ? setTimeout(() => {
                if (jobRunning && activeJobId === job.id) {
                    injectNotice('优化仍在进行：已超过预估时间，正在补齐。你可以继续。', '优化进度');
                }
            }, config.notify.progressAfterMs)
            : null;
        void (async () => {
            const jobPath = join(root, 'workspace', config.sessionId, 'jobs', `${job.id}.json`);
            if (config.notify.start) {
                const isLoopExploration = job.request.kind === 'loop-exploration';
                const reason = typeof job.request.requirements === 'string' && job.request.requirements.trim()
                    ? String(job.request.requirements).slice(0, 100)
                    : `检测到改进需求（${String(job.request.tool ?? 'refine')}）`;
                injectNotice(isLoopExploration
                    ? `Builder 正在后台探索 loop：${reason}。你可以继续当前对话，也可查询或补充该 run。`
                    : `正在后台优化：${reason}。完成会通知你，不影响当前对话。`, isLoopExploration ? 'Builder 开始探索' : '开始后台优化');
            }
            atomicWriteJson(jobPath, { schemaVersion: 1, id: job.id, status: 'running', request: job.request, at: new Date().toISOString() });
            try {
                const outcome = await withRefineRunning(job.run);
                atomicWriteJson(jobPath, { schemaVersion: 1, id: job.id, status: 'finished', request: job.request, summary: outcome.summary, at: new Date().toISOString() });
                if (config.notify.completion) {
                    const isLoopExploration = job.request.kind === 'loop-exploration';
                    injectNotice(isLoopExploration
                        ? `Builder 探索结束：${outcome.summary}`
                        : `优化完成：${outcome.summary}。reload 后生效。`, isLoopExploration ? 'Builder 探索结束' : '优化完成');
                }
            }
            catch (error) {
                atomicWriteJson(jobPath, { schemaVersion: 1, id: job.id, status: 'failed', request: job.request, error: String(error), at: new Date().toISOString() });
                injectNotice(`改进失败：${String(error).slice(0, 300)}`, '改进失败');
            }
            finally {
                if (progressTimer)
                    clearTimeout(progressTimer);
                jobRunning = false;
                startNextJob();
            }
        })();
    };
    const scheduleRefine = (request, run) => {
        const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        atomicWriteJson(join(root, 'workspace', config.sessionId, 'jobs', `${id}.json`), {
            schemaVersion: 1,
            id,
            status: 'scheduled',
            request,
            at: new Date().toISOString(),
        });
        jobQueue.push({ id, request, run });
        startNextJob();
        return id;
    };
    const observer = new Observer(ctx, {
        root,
        sessionId: config.sessionId,
        autoIngestUserMessages: config.reviewGate.autoIngestUserMessages,
    });
    observer.subscribe();
    const recordUsage = (role) => (usage) => {
        appendJsonl(paths.costLog(root, config.sessionId), {
            schemaVersion: 1,
            at: new Date().toISOString(),
            role,
            model: config.llm.model,
            prompt: usage.prompt,
            completion: usage.completion,
        });
    };
    // Independent meta-layer model: builder + review gate use the official
    // DeepSeek API (V4 Flash by default), while the actor keeps its own route.
    const metaLlm = config.llm.provider === 'deepseek-official' ? officialDeepSeekLlm() : undefined;
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
        onUsage: recordUsage('builder-loop-candidate'),
    });
    const builderRunFor = (jobId, explicitRunId) => {
        if (explicitRunId)
            return { ...(jobId ? { jobId } : {}), runId: explicitRunId };
        if (!jobId)
            return { error: 'jobId or runId is required' };
        const job = readJson(join(root, 'workspace', config.sessionId, 'jobs', `${jobId}.json`));
        if (!job)
            return { error: `unknown job: ${jobId}` };
        if (job.request?.kind !== 'loop-exploration' || typeof job.request.runId !== 'string') {
            return { error: `job is not a Builder loop exploration: ${jobId}` };
        }
        return { jobId, runId: job.request.runId };
    };
    const proposer = new Proposer(ctx, {
        systemPrompt: '你是 dsh-meta-validate 的独立迭代者（builder）：基于用户需求、失败信号与配置快照，' +
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
    });
    const isolationOptions = config.isolation.enabled
        ? {
            dshCommand: config.isolation.dshCommand,
            cwd: config.isolation.cwd,
            profile: config.isolation.profile,
            baseOverlays: config.isolation.baseOverlays,
            probe: config.isolation.probe,
            probeTimeoutMs: config.isolation.probeTimeoutMs,
        }
        : undefined;
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
    });
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
    });
    const gate = new Gate(ctx, { root, sessionId: config.sessionId }, config.lockedTargets);
    const reviewGate = new ReviewGate(ctx, {
        enabled: config.reviewGate.enabled && config.mode !== 'observe',
        prompt: config.reviewGate.prompt,
        root,
        sessionId: config.sessionId,
        provider: config.llm.provider,
        model: config.llm.model,
        llm: metaLlm,
        onUsage: recordUsage('gate'),
    });
    const createLoop = (autoConfirm) => new IterationLoop({
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
            if (!config.isolation.enabled || patch.targetKind === 'skill')
                return { exit: 0, outputTail: '' };
            const isolation = runIsolation(patch, {
                dshCommand: config.isolation.dshCommand,
                cwd: config.isolation.cwd,
                profile: config.isolation.profile,
                baseOverlays: config.isolation.baseOverlays,
                stagingRoot: paths.staging(root, config.sessionId, patch.id),
                probe: task,
                probeTimeoutMs: config.isolation.probeTimeoutMs,
            });
            return { exit: isolation.probe?.exitCode ?? -1, outputTail: isolation.probe?.outputTail ?? '' };
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
            };
            appendLedger(root, config.sessionId, entry);
            appendReport(root, config.sessionId, `进化 ${entry.triggeredBy}: ${patch.targetKind} ${patch.targetId}（${JSON.stringify(patch.config)}）→ ${report.verdict}`);
        },
    });
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
    });
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
            const rationale = args.rationale ? String(args.rationale) : undefined;
            observer.persistTrigger('user', rationale ? 'user request' : undefined);
            if (rationale)
                observer.persistRequirements(rationale);
            return {
                accepted: true,
                sessionId: config.sessionId,
                workspaceRoot: root,
                note: '信号已记录；M1 阶段由宿主/测试驱动 builder 产出候选。',
            };
        },
    }));
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
            const jobId = typeof args.jobId === 'string' ? args.jobId : undefined;
            const runId = typeof args.runId === 'string' ? args.runId : undefined;
            const target = builderRunFor(jobId, runId);
            if (!target.runId)
                return { accepted: false, error: target.error };
            try {
                const job = target.jobId
                    ? readJson(join(root, 'workspace', config.sessionId, 'jobs', `${target.jobId}.json`))
                    : null;
                return cleanToolResult({
                    accepted: true,
                    ...(target.jobId ? { jobId: target.jobId } : {}),
                    exploration: loopCandidateGateway.explorationStatus(target.runId),
                    ...(job ? { job: { status: job.status ?? null, summary: job.summary ?? null, error: job.error ?? null } } : {}),
                    note: '状态来自持久 Builder run；proposal 的 verifier/gate 裁决结果见 job.summary 与 meta_growth。',
                });
            }
            catch (error) {
                return { accepted: false, runId: target.runId, error: String(error) };
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'meta_builder_message',
        description: '向仍在运行的 Builder loop 探索投递 actor 的新观察/用户补充；消息写入 durable inbox，供下一 Builder 微循环回合读取。不会直接改变目标。',
        parameters: {
            message: { type: 'string', description: '要交给该 Builder 的新观察、纠正或用户补充' },
            jobId: { type: 'string', description: 'meta_auto 返回的 Builder jobId（与 runId 二选一）' },
            runId: { type: 'string', description: 'Builder runId（与 jobId 二选一）' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args) {
            const jobId = typeof args.jobId === 'string' ? args.jobId : undefined;
            const runId = typeof args.runId === 'string' ? args.runId : undefined;
            const message = typeof args.message === 'string' ? args.message : '';
            const target = builderRunFor(jobId, runId);
            if (!target.runId)
                return { accepted: false, error: target.error };
            try {
                return cleanToolResult({
                    ...loopCandidateGateway.messageExploration(target.runId, message),
                    ...(target.jobId ? { jobId: target.jobId } : {}),
                    note: '已写入 Builder durable inbox；将在下一微循环回合进入其上下文。',
                });
            }
            catch (error) {
                return { accepted: false, runId: target.runId, error: String(error) };
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'meta_status',
        description: '查询优化进度：当前后台优化任务（job）状态、最近进化次数、工作区与阈值。用户问"优化进度怎么样"时用它。',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute() {
            const jobsDir = join(root, 'workspace', config.sessionId, 'jobs');
            const jobFiles = existsSync(jobsDir) ? readdirSync(jobsDir).sort().reverse() : [];
            const latestJob = jobFiles.length > 0
                ? readJson(join(jobsDir, jobFiles[0]))
                : null;
            return {
                mode: config.mode,
                sessionId: config.sessionId,
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
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'meta_growth',
        description: '查看成长记录与已记住的偏好：进化次数、触发场景、最近改动、偏好清单。用户问"你学到了什么/记住了什么"时用它。',
        parameters: {},
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute() {
            const ledger = readLedger(root, config.sessionId);
            const byScenario = {};
            let appliedCount = 0;
            for (const entry of ledger) {
                byScenario[entry.triggeredBy] = (byScenario[entry.triggeredBy] ?? 0) + 1;
                if (entry.applied)
                    appliedCount += 1;
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
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'meta_validate',
        description: '对最新 submitted 候选运行固定式完整核验（对齐 + 回归集 + 配置不变性），写入 report.json 并更新状态。',
        parameters: {},
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute() {
            const submitted = findSubmittedPatch(root, config.sessionId);
            if (!submitted) {
                return {
                    verdict: 'rejected',
                    failureSummary: 'no submitted patch found',
                };
            }
            const patch = submitted.patch;
            const cases = await validator.loadRegressionCases();
            const runEvents = readJsonl(paths.runEvents(root, config.sessionId, patch.id));
            const report = await validator.run(patch, cases, { actualEvents: runEvents });
            validator.persistReport(root, config.sessionId, patch.id, report, runEvents);
            gate.markStatus(root, config.sessionId, patch.id, report.verdict === 'approved' ? 'approved' : 'rejected', 'meta_validate', 1, report.failureSummary);
            return report;
        },
    }));
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
            const requirements = args.requirements ? String(args.requirements) : undefined;
            const runIterate = async () => {
                const signals = observer.collect(config.thresholds);
                const cases = await validator.loadRegressionCases();
                const loop = createLoop(config.mode === 'apply');
                const ops = buildApplyOps(ctx, validator, cases, { root, sessionId: config.sessionId, skillRoot: config.skillRoot }, baseline);
                const currentConfig = currentConfigOf(ctx, baseline);
                const actorModel = currentConfig['agent-default-model']?.config?.model;
                observer.collectTelemetry(typeof actorModel === 'string' ? actorModel : undefined);
                const result = await loop.run(signals, currentConfig, requirements, { actualEvents: [] }, ops);
                return { result };
            };
            if (config.scheduled) {
                const jobId = scheduleRefine({ tool: 'meta_iterate', requirements }, async () => {
                    const { result } = await runIterate();
                    return {
                        summary: `target=${result.patch?.targetId ?? 'n/a'}（${result.patch?.targetKind ?? '?'}）verdict=${result.report.verdict} applied=${result.applied?.applied ?? false}`,
                    };
                });
                return { scheduled: true, jobId };
            }
            const { result } = await runIterate();
            return cleanToolResult({
                iterations: result.iterations,
                verdict: result.report.verdict,
                patchId: result.patch?.id ?? null,
                applied: result.applied?.applied ?? false,
                escalated: result.escalated,
                note: '同步执行完成（scheduled=false）',
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'meta_auto',
        description: '用户主动委托入口：exploreLoop=true 时冻结三层证据包，后台 Builder 自由探索并提交 proposal，随后经 verifier/gate 裁决；无被动触发。',
        parameters: {
            turn: { type: 'number', description: '当前回合号（宿主回合边界传入）' },
            requirements: { type: 'string', description: '用户需求原文（可选）' },
            actorAssessment: { type: 'string', description: 'actor 对当前会话问题的自然语言观察、怀疑和上下文；不是结构化 JSON 约束（可选）' },
            exploreLoop: { type: 'boolean', description: '仅当 allowLoopCandidates 开启时，让独立 builder 阅读三层证据包并自由探索/演进 config/tool/skill/loop；proposal 经 verifier/gate 裁决后才应用。' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args) {
            const turn = typeof args.turn === 'number' ? args.turn : 0;
            const requirements = args.requirements ? String(args.requirements) : undefined;
            const actorAssessment = typeof args.actorAssessment === 'string' ? args.actorAssessment : undefined;
            if (requirements) {
                observer.persistTrigger('user', 'meta_auto');
                observer.ingest({ kind: 'user-message', turn: 0, text: requirements });
            }
            if (args.exploreLoop === true) {
                const currentConfig = currentConfigOf(ctx, baseline);
                const signals = observer.collect(config.thresholds);
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
                });
                const started = loopCandidateGateway.startExploration(requirements ?? '', {
                    ...currentConfig,
                    runtimeCwd: process.cwd(),
                    activeActorRequest: requirements ?? '',
                    ...(actorAssessment ? { actorAssessment } : {}),
                    evidencePack,
                });
                if (!started.accepted) {
                    return cleanToolResult({
                        mode: 'loop-exploration',
                        enabled: config.allowLoopCandidates.enabled,
                        exploration: started,
                        note: 'Builder exploration was not started.',
                    });
                }
                const jobId = scheduleRefine({
                    tool: 'meta_auto',
                    kind: 'loop-exploration',
                    runId: started.runId,
                    requirements: requirements ?? '',
                }, async () => {
                    const exploration = await loopCandidateGateway.runExploration(started.runId);
                    let summary = `run=${started.runId} state=${exploration.state} turns=${exploration.modelTurns} tools=${exploration.toolSteps}${exploration.reason ? ` reason=${exploration.reason}` : ''}`;
                    if (exploration.state !== 'submitted' || !exploration.proposal) {
                        return { summary: `${summary}；未提交 proposal，不进入裁决` };
                    }
                    let proposal;
                    try {
                        proposal = normalizeBuilderProposal(exploration.proposal);
                    }
                    catch (error) {
                        return { summary: `${summary}；invalid proposal: ${String(error)}` };
                    }
                    if (proposal.capability === 'patch-evolution') {
                        const cases = await validator.loadRegressionCases();
                        const ops = buildApplyOps(ctx, validator, cases, { root, sessionId: config.sessionId, skillRoot: config.skillRoot }, baseline);
                        const pack = readActorEvidencePack(evidencePack.manifestPath) ?? evidencePack;
                        const result = await adjudicatePatch(proposal, {
                            root,
                            sessionId: config.sessionId,
                            validator: loopValidator,
                            gate,
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
                            applyOps: ops,
                            evidenceEvents: evidenceEventsOf(pack),
                            onApplied: async ({ patch, report, applied }) => {
                                appendLedger(root, config.sessionId, {
                                    id: patch.id,
                                    triggeredBy: 'S9-explicit-request',
                                    problem: report.failureSummary ?? requirements ?? 'user-initiated builder delegation',
                                    changes: [{ target: patch.targetId, kind: patch.targetKind, before: {}, after: patch.config }],
                                    verdict: report.verdict,
                                    applied: applied.applied,
                                    metricsBefore: {},
                                    metricsAfter: {},
                                    rolledBack: false,
                                    appliedAt: new Date().toISOString(),
                                });
                                appendReport(root, config.sessionId, `用户主动委托：${patch.targetKind} ${patch.targetId} → ${report.verdict}（applied=${applied.applied}）`);
                                if (config.isolation.enabled) {
                                    const rerun = runIsolation(patch, {
                                        dshCommand: config.isolation.dshCommand,
                                        cwd: config.isolation.cwd,
                                        profile: config.isolation.profile,
                                        baseOverlays: config.isolation.baseOverlays,
                                        stagingRoot: paths.staging(root, config.sessionId, patch.id),
                                        probe: requirements || config.isolation.probe,
                                        probeTimeoutMs: config.isolation.probeTimeoutMs,
                                    });
                                    appendReport(root, config.sessionId, `同任务重跑：exit=${rerun.probe?.exitCode ?? 'n/a'} ${rerun.probe?.outputTail?.slice(0, 200) ?? ''}`);
                                }
                            },
                        });
                        summary += `；patch verdict=${result.verdict} target=${result.patch.targetId} applied=${result.applied?.applied ?? false}`;
                    }
                    else {
                        const loopRoot = config.allowLoopCandidates.runtimeRoot || join(root, 'loop-candidate-runtime');
                        const importer = new CandidateImporter({
                            root: loopRoot,
                            baselineRoot: config.allowLoopCandidates.baselineRoot,
                            buildDependencyRoot: config.allowLoopCandidates.buildDependencyRoot,
                        });
                        const result = await adjudicateLoop(proposal, {
                            root: loopRoot,
                            importer,
                            verifyContract: (manifest) => verifyLoopContract(manifest, ctx, baseline, root, config.sessionId, config),
                            install: (candidateId) => installLoopCandidate(candidateId, config, root),
                        });
                        summary += `；loop verdict=${result.verdict} candidate=${result.candidateId}${result.reason ? ` reason=${result.reason}` : ''}`;
                        appendReport(root, config.sessionId, `loop 演进：${result.candidateId} → ${result.verdict}${result.install ? ` state=${result.install.state}` : ''}`);
                    }
                    return { summary };
                });
                return cleanToolResult({
                    mode: 'loop-exploration',
                    enabled: config.allowLoopCandidates.enabled,
                    accepted: true,
                    jobId,
                    runId: started.runId,
                    state: 'scheduled',
                    note: 'Builder exploration is running in the background. Use meta_builder_status or meta_builder_message; a submitted proposal will go through verifier/gate.',
                });
            }
            const runAuto = async () => {
                const cases = await validator.loadRegressionCases();
                const ops = buildApplyOps(ctx, validator, cases, { root, sessionId: config.sessionId, skillRoot: config.skillRoot }, baseline);
                const currentConfig = currentConfigOf(ctx, baseline);
                const outcome = await autopilot.step(turn, currentConfig, requirements, { actualEvents: [] }, ops);
                return { outcome };
            };
            if (config.scheduled) {
                const jobId = scheduleRefine({ tool: 'meta_auto', turn, requirements }, async () => {
                    const { outcome } = await runAuto();
                    if (!outcome.fired)
                        return { summary: `未触发（${outcome.reason}）` };
                    return {
                        summary: `target=${outcome.result.patch?.targetId ?? 'n/a'}（${outcome.result.patch?.targetKind ?? '?'}）verdict=${outcome.result.report.verdict} applied=${outcome.result.applied?.applied ?? false}`,
                    };
                });
                return { scheduled: true, jobId };
            }
            const { outcome } = await runAuto();
            return cleanToolResult({
                fired: outcome.fired,
                reason: outcome.reason,
                decision: outcome.decision,
                iterations: outcome.fired ? outcome.result.iterations : undefined,
                verdict: outcome.fired ? outcome.result.report.verdict : undefined,
                applied: outcome.fired ? (outcome.result.applied?.applied ?? false) : false,
                escalated: outcome.fired ? outcome.result.escalated : false,
                note: '同步执行完成（scheduled=false）',
            });
        },
    }));
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
                        const cases = await validator.loadRegressionCases();
                        const ops = buildApplyOps(ctx, validator, cases, { root, sessionId: config.sessionId, skillRoot: config.skillRoot }, baseline);
                        const currentConfig = currentConfigOf(ctx, baseline);
                        await autopilot.step(turn, currentConfig, undefined, { actualEvents: [] }, ops);
                    });
                }
                catch (error) {
                    appendJsonl(paths.errors(root, config.sessionId), {
                        schemaVersion: PROTOCOL_VERSION,
                        at: new Date().toISOString(),
                        turn,
                        error: String(error),
                    });
                }
            },
        });
        hook.attach();
    }
}
function findSubmittedPatch(root, sessionId) {
    const patchesDir = join(root, 'workspace', sessionId, 'patches');
    if (!existsSync(patchesDir))
        return null;
    let best = null;
    for (const name of readdirSync(patchesDir)) {
        const dir = join(patchesDir, name);
        const status = readJson(join(dir, 'status.json'));
        if (!status || status.state !== 'submitted')
            continue;
        const patch = readJson(join(dir, 'candidate.json'));
        if (!patch)
            continue;
        const at = new Date(status.updatedAt).getTime();
        if (!best || at > best.at)
            best = { patch, status, at };
    }
    return best ? { patch: best.patch, status: best.status } : null;
}
function cleanToolResult(value) {
    const cleaned = {};
    for (const [key, item] of Object.entries(value)) {
        if (item !== undefined)
            cleaned[key] = item;
    }
    return cleaned;
}
function loopRuntimeConfigured(cfg) {
    return Boolean(cfg.baselineRoot && cfg.baseBundle && cfg.dependencyRoot && cfg.contractCommand.length > 0 && cfg.goldenPath);
}
function evidenceEventsOf(pack) {
    const eventsRef = pack.rawRefs.find((ref) => ref.name === 'events');
    if (!eventsRef?.exists)
        return [];
    return readFileSync(eventsRef.path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function normalizeBuilderProposal(value) {
    const capability = value.capability;
    if (capability === 'patch-evolution' && value.patch && typeof value.patch === 'object' && !Array.isArray(value.patch)) {
        return {
            capability,
            patch: value.patch,
            ...(typeof value.rationale === 'string' ? { rationale: value.rationale } : {}),
        };
    }
    if (capability === 'loop-evolution' && value.loop && typeof value.loop === 'object' && !Array.isArray(value.loop)) {
        return {
            capability,
            loop: value.loop,
            ...(typeof value.rationale === 'string' ? { rationale: value.rationale } : {}),
        };
    }
    throw new Error(`unsupported builder proposal capability: ${String(capability)}`);
}
function yamlRows(rows) {
    return Object.entries(rows).map(([id, row]) => {
        const value = row;
        const name = value?.name ?? id;
        const config = value?.config ?? {};
        const configLines = JSON.stringify(config, null, 2).split('\n').map((line) => `    ${line}`).join('\n');
        return `- id: ${id}\n  name: ${JSON.stringify(name)}\n  config:\n${configLines}`;
    }).join('\n');
}
/**
 * v1.1 loop contract overlay: current loader rows (llm/model/meta-validate)
 * plus an agent-loop row pointing at the staged candidate entry. The contract
 * runner runs the same probe task against this overlay in an isolated runtime.
 */
function writeContractOverlay(manifest, ctx, baseline, root, sessionId, config) {
    const rows = currentConfigOf(ctx, baseline);
    const metaRow = rows['meta-validate'];
    rows['meta-validate'] = {
        name: metaRow?.name ?? '/chenzute/dsh-meta-validate-handoff/dist/index.js',
        config: { ...(metaRow?.config ?? {}), mode: 'observe', sessionId: 'loom-contract' },
    };
    rows['agent-loop'] = {
        name: join(manifest.artifactPath, manifest.entry),
        config: manifest.config,
    };
    const dir = join(root, 'workspace', sessionId, 'loop-candidates', 'overlays');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${manifest.id}.yml`);
    writeFileSync(path, `${yamlRows(rows)}\n`, 'utf8');
    return path;
}
/**
 * Independent loop contract verifier (C0/C1-C8/C6). Fail-closed whenever the
 * runtime is not configured or the runner output is not a passing report.
 */
async function verifyLoopContract(manifest, ctx, baseline, root, sessionId, config) {
    const cfg = config.allowLoopCandidates;
    if (!loopRuntimeConfigured(cfg)) {
        return { passed: false, reason: 'loop runtime not configured (baselineRoot/baseBundle/dependencyRoot/contractCommand/goldenPath)' };
    }
    const overlay = writeContractOverlay(manifest, ctx, baseline, root, sessionId, config);
    const runtimeRoot = cfg.runtimeRoot || join(root, 'loop-candidate-runtime');
    const runtime = join(runtimeRoot, 'contract-runtime');
    const reportPath = join(runtimeRoot, 'reports', `${manifest.id}.json`);
    mkdirSync(dirname(reportPath), { recursive: true });
    try {
        const out = execFileSync(cfg.contractCommand[0], [
            ...cfg.contractCommand.slice(1),
            'check', overlay, cfg.contractTask, cfg.goldenPath,
            '--expected-entry', join(manifest.artifactPath, manifest.entry),
        ], {
            cwd: process.cwd(),
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
        });
        writeFileSync(reportPath, out, 'utf8');
        const report = JSON.parse(out.slice(out.indexOf('{')));
        const evidence = { contractReport: reportPath, regressionReport: reportPath, verifiedAt: new Date().toISOString() };
        if (report.pass !== true) {
            return { passed: false, evidence, reason: `contract failed: ${JSON.stringify(report.detail ?? '').slice(0, 500)}` };
        }
        return { passed: true, evidence };
    }
    catch (error) {
        const detail = error;
        const tail = `${detail.stdout?.toString() ?? ''}${detail.stderr?.toString() ?? ''}`.slice(-1000) || String(detail.message);
        return { passed: false, reason: `contract runner failed: ${tail}` };
    }
}
/** Gate-owned cold install through the Loader-level candidate profile adapter. */
async function installLoopCandidate(candidateId, config, root) {
    const cfg = config.allowLoopCandidates;
    if (!cfg.runtimeRoot)
        throw new Error('loop runtimeRoot is not configured');
    const runtimeRoot = cfg.runtimeRoot || join(root, 'loop-candidate-runtime');
    const registry = new CandidateRegistry(runtimeRoot);
    const ops = profileGateOps({
        runtimeRoot,
        baseBundle: cfg.baseBundle,
        dependencyRoot: cfg.dependencyRoot,
        additionalDependencyRoots: cfg.additionalDependencyRoots,
        dumpConfig: (profile) => {
            try {
                const output = execFileSync(config.isolation.dshCommand[0], [
                    ...config.isolation.dshCommand.slice(1),
                    '--profile', profile.profile, '--dump-config',
                ], {
                    cwd: config.isolation.cwd,
                    env: { ...childEnv(), DSH_HOME: profile.home },
                    encoding: 'utf8',
                    timeout: 60_000,
                });
                return { exitCode: 0, output };
            }
            catch (error) {
                const detail = error;
                return { exitCode: detail.status ?? 1, output: String(detail.stdout ?? detail.stderr ?? detail.message) };
            }
        },
    }, candidateId);
    return installVerifiedCandidate(registry, candidateId, ops);
}
/**
 * Real, redacted config snapshot for the builder (08 §12 I6): every loader row
 * id/name/config except secret-looking values. This is builder input only; the
 * builder decides what to change.
 */
function currentConfigOf(ctx, baseline) {
    baseline.ensureLoaded();
    const merged = {};
    for (const [id, row] of Object.entries(baseline.rows)) {
        merged[id] = { name: row.name ?? id, config: { ...row.config } };
    }
    const loader = ctx.loader;
    if (loader) {
        for (const entry of loader.entries()) {
            merged[entry.options.id] = { name: entry.options.name ?? entry.options.id, config: { ...(entry.options.config ?? {}) } };
        }
    }
    const rows = Object.entries(merged).map(([id, row]) => ({ id, name: row.name, config: row.config }));
    const priority = ['agent', 'agent-default-model', 'llm-deepseek', 'llm-pi-ai', 'meta-validate', 'system-prompt'];
    const rank = (row) => {
        const index = priority.indexOf(row.id);
        return index < 0 ? priority.length : index;
    };
    rows.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    const out = {};
    for (const row of rows) {
        const config = {};
        for (const [key, value] of Object.entries(row.config)) {
            config[key] = /(api[_-]?key|token|secret|password|authorization)/i.test(key) ? '***' : value;
        }
        out[row.id] = { name: row.name, config };
    }
    return out;
}
function buildApplyOps(ctx, validator, cases, meta, baseline) {
    baseline.ensureLoaded();
    let loader;
    try {
        loader = ctx.loader;
    }
    catch {
        loader = undefined;
    }
    if (!loader)
        return undefined;
    const installedByTarget = new Map();
    const entries = () => [...loader.entries()];
    const harnessStatePath = paths.harnessState(meta.root, meta.sessionId);
    const readHarnessState = () => readJson(harnessStatePath)
        ?? { schemaVersion: PROTOCOL_VERSION, sessionId: meta.sessionId, restartRequired: false, applied: [] };
    const writeHarnessState = (state) => {
        atomicWriteJson(harnessStatePath, state);
    };
    const updateHarnessState = (patch, overlay, before) => {
        const state = readHarnessState();
        state.restartRequired = true;
        state.applied = state.applied.filter((record) => record.patchId !== patch.id);
        state.applied.push({
            patchId: patch.id,
            targetId: patch.targetId,
            targetName: patch.targetName,
            overlay,
            beforeHash: sha256(before),
            afterHash: sha256(patch.config),
            appliedAt: new Date().toISOString(),
        });
        writeHarnessState(state);
    };
    const removeHarnessState = (patch) => {
        const state = readHarnessState();
        state.applied = state.applied.filter((record) => record.patchId !== patch.id);
        state.restartRequired = state.applied.length > 0;
        writeHarnessState(state);
    };
    return {
        readConfig: (targetId) => {
            if (baseline.rows[targetId])
                return baseline.rows[targetId]?.config ?? {};
            const live = entries().find((entry) => entry.options.id === targetId);
            return live?.options.config ?? {};
        },
        writeConfig: (targetId, config, patch) => {
            const all = entries();
            const entry = all.find((item) => item.options.id === targetId);
            const name = entry?.options.name ?? baseline.rows[targetId]?.name ?? patch.targetId;
            const overlay = paths.overlayFile(meta.root, meta.sessionId, patch.id);
            const lines = [
                `- id: ${patch.targetId}`,
                `  name: '${name}'`,
                '  config:',
                ...String(JSON.stringify(config, null, 2)).split('\n').map((line) => `    ${line}`),
            ];
            mkdirSync(paths.overlays(meta.root, meta.sessionId), { recursive: true });
            writeFileSync(overlay, `${lines.join('\n')}\n`, 'utf8');
            baseline.set(patch.targetId, name, config);
            updateHarnessState(patch, overlay, entry?.options.config ?? baseline.rows[patch.targetId]?.config ?? {});
            return overlay;
        },
        restoreConfig: (_targetId, _before, patch) => {
            const overlay = paths.overlayFile(meta.root, meta.sessionId, patch.id);
            rmSync(overlay, { force: true });
            baseline.set(patch.targetId, baseline.rows[patch.targetId]?.name, _before);
            removeHarnessState(patch);
        },
        smoke: (patch) => validator.runSmoke(patch, cases),
        rowExists: (id) => entries().some((entry) => entry.options.id === id),
        insertRow: async (patch) => {
            if (!patch.module)
                throw new Error('insert patch missing module');
            const dir = join(meta.root, 'installed', meta.sessionId, patch.id);
            mkdirSync(dir, { recursive: true });
            for (const file of patch.module.files) {
                const target = join(dir, file.path);
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, file.content, 'utf8');
            }
            const entry = join(dir, patch.module.entry);
            const entryId = String(await loader.create({ id: patch.targetId, name: entry, config: patch.config }));
            installedByTarget.set(patch.targetId, { dir, entryId });
        },
        removeRow: async (id) => {
            const installed = installedByTarget.get(id);
            if (installed) {
                await loader.remove(installed.entryId);
                rmSync(installed.dir, { recursive: true, force: true });
            }
        },
        skillExists: (id) => meta.skillRoot ? existsSync(join(meta.skillRoot, id)) : false,
        installSkill: async (patch) => {
            if (!meta.skillRoot)
                throw new Error('skillRoot not configured');
            if (!patch.module)
                throw new Error('skill patch missing module');
            for (const file of patch.module.files) {
                const target = join(meta.skillRoot, file.path);
                mkdirSync(join(meta.skillRoot, file.path.split('/')[0] ?? ''), { recursive: true });
                writeFileSync(target, file.content, 'utf8');
            }
        },
        removeSkill: async (id) => {
            if (meta.skillRoot)
                rmSync(join(meta.skillRoot, id), { recursive: true, force: true });
        },
    };
}
