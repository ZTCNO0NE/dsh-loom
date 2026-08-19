import { join } from 'node:path';
import { CandidateRegistry } from './index.js';
import { atomicWriteJson, sha256 } from '../protocol/index.js';
import { BuilderDriver } from '../builder/driver.js';
import { BuilderKernel, builderRunPaths } from '../builder/kernel.js';
import { BuilderCapabilityRuntimeRegistry, LOOP_EVOLUTION_CAPABILITY, WORKSPACE_SIMULATION_CAPABILITY } from '../builder/capabilities.js';
import { createWorkspaceSimulationRuntime } from '../builder/simulation.js';
import { materializeMiniSweWorkspace, miniSweBaselineCommit, runMiniSwe } from '../builder/mini-swe.js';
function summarizeEvent(event) {
    return {
        seq: event.seq,
        at: event.at,
        kind: event.kind,
        lineageId: event.lineageId,
        runId: event.runId,
        payload: JSON.parse(JSON.stringify(event.payload, (_key, value) => typeof value === 'string' && value.length > 2_000 ? `${value.slice(0, 2_000)}…[truncated]` : value)),
    };
}
function summarizeJournal(entry) {
    const result = entry.result === undefined ? undefined : JSON.parse(JSON.stringify(entry.result, (_key, value) => {
        if (typeof value === 'string' && value.length > 2_000)
            return `${value.slice(0, 2_000)}…[truncated]`;
        return value;
    }));
    return {
        seq: entry.seq,
        at: entry.at,
        kind: entry.kind,
        action: entry.action,
        ...(result ? { result } : {}),
        ...(entry.error ? { error: entry.error.slice(0, 2_000) } : {}),
    };
}
function summarizeDiagnosis(report) {
    const directions = Array.isArray(report.directions) ? report.directions.slice(0, 3).flatMap((direction) => {
        if (!direction || typeof direction !== 'object' || Array.isArray(direction))
            return [];
        const value = direction;
        return [{
                ...(typeof value.id === 'string' ? { id: value.id.slice(0, 160) } : {}),
                ...(typeof value.goal === 'string' ? { goal: value.goal.slice(0, 1_000) } : {}),
                ...(Array.isArray(value.evidenceRefs) ? { evidenceRefs: value.evidenceRefs.filter((ref) => typeof ref === 'string').slice(0, 12) } : {}),
                ...(Array.isArray(value.unknowns) ? { unknowns: value.unknowns.filter((item) => typeof item === 'string').slice(0, 12) } : {}),
                ...(typeof value.cost === 'string' ? { cost: value.cost.slice(0, 120) } : {}),
            }];
    }) : [];
    const rawQuestion = report.question;
    const question = rawQuestion && typeof rawQuestion === 'object' && !Array.isArray(rawQuestion)
        ? (() => {
            const value = rawQuestion;
            return {
                ...(typeof value.question === 'string' ? { question: value.question.slice(0, 2_000) } : {}),
                ...(typeof value.whyNow === 'string' ? { whyNow: value.whyNow.slice(0, 2_000) } : {}),
                ...(Array.isArray(value.options) ? { options: value.options.slice(0, 6).flatMap((option) => {
                        if (!option || typeof option !== 'object' || Array.isArray(option))
                            return [];
                        const item = option;
                        return [{
                                ...(typeof item.id === 'string' ? { id: item.id.slice(0, 160) } : {}),
                                ...(typeof item.label === 'string' ? { label: item.label.slice(0, 500) } : {}),
                                ...(typeof item.description === 'string' ? { description: item.description.slice(0, 1_000) } : {}),
                            }];
                    }) } : {}),
                ...(Array.isArray(value.evidenceRefs) ? { evidenceRefs: value.evidenceRefs.filter((ref) => typeof ref === 'string').slice(0, 12) } : {}),
            };
        })()
        : undefined;
    return { directions, ...(question ? { question } : {}) };
}
/**
 * The sole loop-candidate ingress for meta.auto. Discovery uses the same
 * bounded BuilderKernel as patch design; after a frozen draft is submitted,
 * core (not the model) performs the allowlisted HTTPS acquisition into staging.
 * It has no transition API: verifier/gate own every later state.
 */
export class LoopCandidateGateway {
    options;
    runtimes;
    constructor(options) {
        this.options = options;
        this.runtimes = options.capabilityRuntimes ?? new BuilderCapabilityRuntimeRegistry().register(createWorkspaceSimulationRuntime());
    }
    kernel() {
        return new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`, this.runtimes, this.options.builderKernelOptions);
    }
    /** Create a durable run before it enters the background queue. */
    startExploration(requirements, context = {}) {
        if (!this.options.enabled)
            return { accepted: false, mode: 'exploration', state: 'disabled', reason: 'allowLoopCandidates is disabled' };
        const llm = this.options.llm;
        if (!llm)
            throw new Error('loop exploration: no independent builder llm available');
        const kernel = this.kernel();
        const resumeFromRunId = typeof context.resumeFromRunId === 'string' ? context.resumeFromRunId : undefined;
        const previousRun = resumeFromRunId ? kernel.previousRunReference(resumeFromRunId) : undefined;
        const priorMode = resumeFromRunId ? kernel.load(resumeFromRunId).mode : undefined;
        const requestedMode = context.passMode === 'diagnosis' || context.passMode === 'implementation'
            ? context.passMode
            : undefined;
        const passMode = priorMode === 'diagnosis'
            ? 'implementation'
            : requestedMode ?? (this.options.diagnosisFirst ? 'diagnosis' : 'implementation');
        // A diagnosis is Loom-native by design; mini-SWE is only materialized for
        // the concrete implementation pass created after the actor/user selects a
        // direction. This keeps dialogue and coding separate without reviving the
        // old native JSON loop as an implementation executor.
        const mini = this.options.executionRuntime === 'mini-swe' && passMode === 'implementation' ? this.options.miniSwe : undefined;
        if (this.options.executionRuntime === 'mini-swe' && passMode === 'implementation' && !mini)
            throw new Error('mini-SWE runtime is selected but not configured');
        if (mini && (!mini.executable || !mini.configPath || !mini.baselineRoot || !mini.dependencySnapshot || mini.stepLimit < 1 || mini.timeoutMs < 1)) {
            throw new Error('mini-SWE runtime requires executable, configPath, baselineRoot, dependencySnapshot, positive stepLimit, and positive timeoutMs');
        }
        const baselineCommit = mini ? miniSweBaselineCommit(mini.baselineRoot) : undefined;
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
        });
        if (mini && baselineCommit)
            this.materializeMiniWorkspace(kernel, run.id, mini, baselineCommit);
        // The initiating user request is a normal durable conversation message as
        // well as part of the immutable actor snapshot, so Builder can explicitly
        // acknowledge or question it on its first micro-turn.
        if (requirements.trim()) {
            const actorMemo = typeof context.actorAssessment === 'string' ? context.actorAssessment : undefined;
            const evidencePack = context.evidencePack;
            const evidenceRefs = evidencePack && typeof evidencePack === 'object' && !Array.isArray(evidencePack)
                && typeof evidencePack.manifestPath === 'string'
                ? [evidencePack.manifestPath]
                : undefined;
            kernel.receiveActorMessage(run.id, {
                rawUserText: requirements,
                ...(actorMemo ? { actorMemo } : {}),
                ...(evidenceRefs ? { evidenceRefs } : {}),
                idempotencyKey: `initial:${run.id}`,
            });
        }
        return { accepted: true, mode: 'exploration', runId: run.id, state: 'created', passMode };
    }
    /**
     * Execute an already-created actor exploration. It deliberately stops after
     * Builder submit: no importer, registry transition, verifier, or gate runs.
     */
    async runExploration(runId) {
        if (!this.options.enabled)
            return { accepted: false, mode: 'exploration', runId, passMode: 'implementation', state: 'aborted', modelTurns: 0, toolSteps: 0, reason: 'allowLoopCandidates is disabled' };
        const llm = this.options.llm;
        const kernel = this.kernel();
        const runContext = kernel.context(runId);
        const initial = runContext.input.actor;
        const requirements = typeof initial.requirements === 'string' ? initial.requirements : '';
        const context = initial.context && typeof initial.context === 'object' && !Array.isArray(initial.context)
            ? initial.context
            : {};
        if (this.options.executionRuntime === 'mini-swe' && runContext.run.mode === 'implementation') {
            const mini = this.options.miniSwe;
            if (!mini)
                throw new Error('mini-SWE runtime is selected but not configured');
            const paths = builderRunPaths(this.options.root, `${this.options.sessionId}:loop-exploration`, runId);
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
            });
            if (!execution.submitted) {
                kernel.decide(runId, { kind: 'abort', reason: execution.error ?? 'mini-SWE did not submit a completed trajectory' });
                const result = { accepted: false, mode: 'exploration', runId, passMode: runContext.run.mode, state: 'aborted', modelTurns: execution.modelTurns, toolSteps: execution.toolSteps, reason: execution.error ?? 'mini-SWE did not submit' };
                this.persist(result);
                return result;
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
                    });
                }
                kernel.decide(runId, { kind: 'tool', action: { name: 'compile_loop_submission', rationale: 'mini-SWE submitted a completed workspace candidate; Loom captured and compiled its immutable diff' } });
                kernel.decide(runId, { kind: 'submit' });
            }
            catch (caught) {
                kernel.decide(runId, { kind: 'abort', reason: `mini-SWE submission compilation failed: ${String(caught)}` });
                const result = { accepted: false, mode: 'exploration', runId, passMode: runContext.run.mode, state: 'aborted', modelTurns: execution.modelTurns, toolSteps: execution.toolSteps, reason: String(caught) };
                this.persist(result);
                return result;
            }
            const proposal = kernel.proposal(runId) ?? undefined;
            const result = { accepted: Boolean(proposal), mode: 'exploration', runId, passMode: runContext.run.mode, state: 'submitted', ...(proposal ? { proposal } : {}), modelTurns: execution.modelTurns, toolSteps: execution.toolSteps };
            this.persist(result);
            return result;
        }
        if (!llm)
            throw new Error('loop exploration: no independent builder llm available');
        const outcome = await new BuilderDriver({
            llm,
            provider: this.options.provider,
            model: this.options.model,
            systemPrompt: 'You are the free exploratory loop-evolution Builder and an external improvement partner for the Actor. Based on real actor/user evidence, identify the most valuable concrete problem affecting user experience, task success, or safety; form a falsifiable hypothesis; use workspace evidence/simulation when useful; ask the Actor/user when a product tradeoff cannot be inferred; and submit a verifiable candidate when evidence is sufficient. Do not modify or install any live target.',
            taskContext: [
                'This run was actively requested through the actor, not passively scheduled.',
                `User request relayed by actor: ${requirements.slice(0, 12_000)}`,
                `Actor/runtime context: ${JSON.stringify(context).slice(0, 16_000)}`,
                'You may choose a small edit, a complete replacement, or a new foundation. Use your tools and actual feedback; do not follow a prescribed strategy.',
                runContext.run.mode === 'diagnosis'
                    ? 'This is the direction-selection pass. Completion means a durable diagnosis-report with 1-3 evidence-backed directions and a blocking user choice. Do not submit a proposal in this pass.'
                    : 'Completion means a concrete problem, a falsifiable hypothesis, evidence or simulation, and either a frozen write_submission→submit, a blocking choice question, or an evidence-backed abort.',
            ].join('\n'),
            draftKind: 'loop_candidate',
            capabilities: [LOOP_EVOLUTION_CAPABILITY, WORKSPACE_SIMULATION_CAPABILITY],
            maxModelTurns: this.options.builderMaxModelTurns ?? 24,
            maxToolSteps: this.options.builderMaxToolSteps ?? 48,
            maxWallTimeMs: this.options.builderMaxWallTimeMs ?? 600_000,
            maxTokens: this.options.maxTokens,
            onUsage: this.options.onUsage,
        }).run(kernel, runId);
        const result = {
            accepted: outcome.state === 'submitted',
            mode: 'exploration',
            runId,
            passMode: kernel.load(runId).mode,
            state: outcome.state,
            ...(outcome.proposal ? { proposal: outcome.proposal } : {}),
            modelTurns: outcome.modelTurns,
            toolSteps: outcome.toolSteps,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
        };
        this.persist(result);
        return result;
    }
    /** Compatibility helper for callers that intentionally want to wait. */
    async explore(requirements, context = {}) {
        const started = this.startExploration(requirements, context);
        if (!started.accepted)
            return { accepted: false, mode: 'exploration', runId: '', passMode: 'implementation', state: 'aborted', modelTurns: 0, toolSteps: 0, reason: started.reason };
        return this.runExploration(started.runId);
    }
    explorationStatus(runId) {
        const kernel = this.kernel();
        const context = kernel.context(runId);
        const proposal = kernel.proposal(runId);
        const journal = context.journal;
        const acknowledged = new Set(context.events
            .filter((event) => event.kind === 'message_ack' && typeof event.payload.messageId === 'string')
            .map((event) => event.payload.messageId));
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
        };
    }
    events(runId, cursor = {}, limit = 50) {
        const kernel = this.kernel();
        const run = kernel.load(runId);
        const reset = Boolean(cursor.runId && (cursor.runId !== runId || cursor.lineageId !== run.lineageId));
        const afterSeq = reset ? 0 : Math.max(0, cursor.seq ?? 0);
        const events = kernel.events(runId, afterSeq, limit).map((event) => summarizeEvent(event));
        const nextSeq = events.at(-1)?.seq ?? afterSeq;
        return { runId, lineageId: run.lineageId, events, cursor: `${run.lineageId}:${runId}:${nextSeq}`, reset };
    }
    messageExploration(runId, input) {
        const rawUserText = typeof input === 'string' ? input : input.rawUserText;
        const normalized = rawUserText.trim();
        if (!normalized)
            throw new Error('builder message must not be empty');
        if (normalized.length > 12_000)
            throw new Error('builder message exceeds 12000 characters');
        if (typeof input !== 'string' && input.actorMemo !== undefined && input.actorMemo.length > 12_000)
            throw new Error('builder actor memo exceeds 12000 characters');
        if (typeof input !== 'string' && (input.evidenceRefs?.some((ref) => ref.length > 4_000) ?? false))
            throw new Error('builder evidence reference exceeds 4000 characters');
        if (typeof input !== 'string' && input.idempotencyKey !== undefined && (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200))
            throw new Error('builder idempotency key must be 1-200 characters');
        const kernel = this.kernel();
        const message = kernel.receiveActorMessage(runId, typeof input === 'string' ? normalized : { ...input, rawUserText: normalized });
        return { accepted: true, runId, messageId: message.id, deduplicated: message.deduplicated === true, state: kernel.load(runId).state, queuedAt: message.at };
    }
    /** Pause/cancel are deterministic kernel transitions; resume is a new run. */
    controlExploration(runId, action) {
        const kernel = this.kernel();
        const run = kernel.control(runId, action);
        return { runId, lineageId: run.lineageId, state: run.state };
    }
    /**
     * Never replays a possibly in-flight command. The new attempt inherits the
     * old assets by hash and copies prior actor messages for independent review.
     */
    resumeExploration(runId) {
        const kernel = this.kernel();
        const prior = kernel.context(runId);
        if (!['paused', 'waiting_for_input', 'cancelled'].includes(prior.run.state)) {
            throw new Error(`only paused, waiting_for_input, or cancelled runs may resume: ${prior.run.state}`);
        }
        const requirements = typeof prior.input.actor.requirements === 'string' ? prior.input.actor.requirements : '';
        const context = prior.input.actor.context && typeof prior.input.actor.context === 'object' && !Array.isArray(prior.input.actor.context)
            ? prior.input.actor.context
            : {};
        const started = this.startExploration(requirements, { ...context, resumeFromRunId: runId });
        if (!started.accepted)
            return started;
        for (const message of prior.messages) {
            if (message.idempotencyKey?.startsWith('initial:'))
                continue;
            kernel.receiveActorMessage(started.runId, {
                rawUserText: message.rawUserText,
                ...(message.actorMemo ? { actorMemo: message.actorMemo } : {}),
                ...(message.evidenceRefs ? { evidenceRefs: message.evidenceRefs } : {}),
                ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
            });
        }
        return started;
    }
    /**
     * Verifier/gate rejection reopens an immutable Builder run with the report
     * as previous-attempt input; the actor inbox carries over so follow-up
     * observations remain visible to the next attempt.
     */
    reopenExploration(runId, report) {
        const kernel = this.kernel();
        if (kernel.load(runId).state !== 'submitted') {
            throw new Error(`only submitted builder runs may be reopened: ${kernel.load(runId).state}`);
        }
        const messages = kernel.context(runId).messages;
        const next = kernel.reopenFromRejection(runId, report);
        if (this.options.executionRuntime === 'mini-swe') {
            const mini = this.options.miniSwe;
            if (!mini)
                throw new Error('mini-SWE runtime is selected but not configured');
            const target = kernel.context(next.id).input.targetBefore;
            const baselineCommit = typeof target.baselineCommit === 'string' ? target.baselineCommit : miniSweBaselineCommit(mini.baselineRoot);
            this.materializeMiniWorkspace(kernel, next.id, mini, baselineCommit);
        }
        for (const message of messages) {
            kernel.receiveActorMessage(next.id, {
                rawUserText: message.rawUserText,
                ...(message.actorMemo ? { actorMemo: message.actorMemo } : {}),
                ...(message.evidenceRefs ? { evidenceRefs: message.evidenceRefs } : {}),
                ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
            });
        }
        return next.id;
    }
    materializeMiniWorkspace(kernel, runId, mini, baselineCommit) {
        const paths = builderRunPaths(this.options.root, `${this.options.sessionId}:loop-exploration`, runId);
        materializeMiniSweWorkspace({
            baselineRoot: mini.baselineRoot,
            dependencySnapshot: mini.dependencySnapshot,
            commit: baselineCommit,
            workspace: paths.workspace,
        });
        kernel.captureWorkspaceBaseline(runId);
    }
    status() {
        return new CandidateRegistry(this.options.root).list();
    }
    persist(outcome) {
        const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        atomicWriteJson(join(this.options.root, 'workspace', this.options.sessionId, 'loop-candidates', `${stamp}.json`), {
            schemaVersion: 1,
            at: new Date().toISOString(),
            outcome,
        });
    }
}
