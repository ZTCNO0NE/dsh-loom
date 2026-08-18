import { join } from 'node:path';
import { CandidateRegistry } from './index.js';
import { atomicWriteJson, sha256 } from '../protocol/index.js';
import { BuilderDriver } from '../builder/driver.js';
import { BuilderKernel } from '../builder/kernel.js';
import { LOOP_EVOLUTION_CAPABILITY } from '../builder/capabilities.js';
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
/**
 * The sole loop-candidate ingress for meta.auto. Discovery uses the same
 * bounded BuilderKernel as patch design; after a frozen draft is submitted,
 * core (not the model) performs the allowlisted HTTPS acquisition into staging.
 * It has no transition API: verifier/gate own every later state.
 */
export class LoopCandidateGateway {
    options;
    constructor(options) {
        this.options = options;
    }
    /** Create a durable run before it enters the background queue. */
    startExploration(requirements, context = {}) {
        if (!this.options.enabled)
            return { accepted: false, mode: 'exploration', state: 'disabled', reason: 'allowLoopCandidates is disabled' };
        const llm = this.options.llm;
        if (!llm)
            throw new Error('loop exploration: no independent builder llm available');
        const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`);
        const resumeFromRunId = typeof context.resumeFromRunId === 'string' ? context.resumeFromRunId : undefined;
        const previousRun = resumeFromRunId ? kernel.previousRunReference(resumeFromRunId) : undefined;
        const run = kernel.create({
            kind: 'loop_candidate',
            actor: { requirements, context },
            targetBefore: { registry: this.status(), context },
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
        return { accepted: true, mode: 'exploration', runId: run.id, state: 'created' };
    }
    /**
     * Execute an already-created actor exploration. It deliberately stops after
     * Builder submit: no importer, registry transition, verifier, or gate runs.
     */
    async runExploration(runId) {
        if (!this.options.enabled)
            return { accepted: false, mode: 'exploration', runId, state: 'aborted', modelTurns: 0, toolSteps: 0, reason: 'allowLoopCandidates is disabled' };
        const llm = this.options.llm;
        if (!llm)
            throw new Error('loop exploration: no independent builder llm available');
        const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`);
        const initial = kernel.context(runId).input.actor;
        const requirements = typeof initial.requirements === 'string' ? initial.requirements : '';
        const context = initial.context && typeof initial.context === 'object' && !Array.isArray(initial.context)
            ? initial.context
            : {};
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
        }).run(kernel, runId);
        const result = {
            accepted: outcome.state === 'submitted',
            mode: 'exploration',
            runId,
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
            return { accepted: false, mode: 'exploration', runId: '', state: 'aborted', modelTurns: 0, toolSteps: 0, reason: started.reason };
        return this.runExploration(started.runId);
    }
    explorationStatus(runId) {
        const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`);
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
            modelTurns: journal.filter((entry) => entry.kind === 'model' && entry.action === 'decision').length,
            toolSteps: journal.filter((entry) => entry.kind === 'tool').length,
            inboxMessages: context.messages.length,
            pendingMessageIds: context.messages.filter((message) => !acknowledged.has(message.id)).map((message) => message.id),
            proposal: proposal
                ? { available: true, hash: sha256(proposal), keys: Object.keys(proposal).slice(0, 20) }
                : { available: false },
            journalTail: journal.slice(-12).map((entry) => summarizeJournal(entry)),
            eventTail: context.events.slice(-12).map((event) => summarizeEvent(event)),
        };
    }
    events(runId, cursor = {}, limit = 50) {
        const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`);
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
        const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`);
        const message = kernel.receiveActorMessage(runId, typeof input === 'string' ? normalized : { ...input, rawUserText: normalized });
        return { accepted: true, runId, messageId: message.id, deduplicated: message.deduplicated === true, state: kernel.load(runId).state, queuedAt: message.at };
    }
    /** Pause/cancel are deterministic kernel transitions; resume is a new run. */
    controlExploration(runId, action) {
        const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`);
        const run = kernel.control(runId, action);
        return { runId, lineageId: run.lineageId, state: run.state };
    }
    /**
     * Never replays a possibly in-flight command. The new attempt inherits the
     * old assets by hash and copies prior actor messages for independent review.
     */
    resumeExploration(runId) {
        const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`);
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
        const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-exploration`);
        if (kernel.load(runId).state !== 'submitted') {
            throw new Error(`only submitted builder runs may be reopened: ${kernel.load(runId).state}`);
        }
        const messages = kernel.context(runId).messages;
        const next = kernel.reopenFromRejection(runId, report);
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
