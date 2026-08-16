import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { officialDeepSeekLlm } from './llm/official.js';
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
                const reason = typeof job.request.requirements === 'string' && job.request.requirements.trim()
                    ? String(job.request.requirements).slice(0, 100)
                    : `检测到改进需求（${String(job.request.tool ?? 'refine')}）`;
                injectNotice(`正在后台优化：${reason}。完成会通知你，不影响当前对话。`, '开始后台优化');
            }
            atomicWriteJson(jobPath, { schemaVersion: 1, id: job.id, status: 'running', at: new Date().toISOString() });
            try {
                const outcome = await withRefineRunning(job.run);
                atomicWriteJson(jobPath, { schemaVersion: 1, id: job.id, status: 'finished', summary: outcome.summary, at: new Date().toISOString() });
                if (config.notify.completion)
                    injectNotice(`优化完成：${outcome.summary}。reload 后生效。`, '优化完成');
            }
            catch (error) {
                atomicWriteJson(jobPath, { schemaVersion: 1, id: job.id, status: 'failed', error: String(error), at: new Date().toISOString() });
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
        description: '自动频率控制器：确定性硬触发 -> 独立 LLM 评审门 -> 需要时启动迭代闭环（M3.5，回合边界自动挂接的入口）。',
        parameters: {
            turn: { type: 'number', description: '当前回合号（宿主回合边界传入）' },
            requirements: { type: 'string', description: '用户需求原文（可选）' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args) {
            const turn = typeof args.turn === 'number' ? args.turn : 0;
            const requirements = args.requirements ? String(args.requirements) : undefined;
            if (requirements) {
                observer.persistTrigger('user', 'meta_auto');
                observer.ingest({ kind: 'user-message', turn: 0, text: requirements });
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
