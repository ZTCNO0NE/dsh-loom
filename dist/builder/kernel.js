import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendJsonl, atomicWriteJson, paths as protocolPaths, readJson, readJsonl, sha256, workspaceDir } from '../protocol/index.js';
import { BuilderCapabilityRuntimeRegistry } from './capabilities.js';
import { addObservedArtifact, createBuilderProvenance, inspectBuilderFile, searchBuilderText, traceBuilderArtifact, } from './provenance.js';
/** SHA-256 of exact file bytes, matching CandidateImporter's beforeHash check. */
function fileContentHash(content) {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}
export function builderRunPaths(root, sessionId, id) {
    const base = join(workspaceDir(root, sessionId), 'builder-runs', id);
    return {
        base,
        record: join(base, 'run.json'),
        actor: join(base, 'input', 'actor-snapshot.json'),
        messages: join(base, 'input', 'actor-messages.jsonl'),
        targetBefore: join(base, 'input', 'target-before.json'),
        previousAttempt: join(base, 'input', 'previous-attempt.json'),
        previousRun: join(base, 'input', 'previous-run.json'),
        diagnosisReport: join(base, 'state', 'diagnosis-report.json'),
        contextIndex: join(base, 'state', 'context-index.json'),
        provenance: join(base, 'state', 'provenance.json'),
        worldModel: join(base, 'state', 'world-model.json'),
        plan: join(base, 'state', 'plan.json'),
        progressState: join(base, 'state', 'progress-state.json'),
        journal: join(base, 'state', 'journal.jsonl'),
        promptVisible: join(base, 'state', 'prompt-visible.jsonl'),
        events: join(base, 'state', 'events.jsonl'),
        snapshots: join(base, 'state', 'snapshots.jsonl'),
        workspaceBaseline: join(base, 'state', 'workspace-baseline'),
        workspace: join(base, 'workspace'),
        staging: join(base, 'staging'),
        preflight: join(base, 'preflight'),
        proposal: join(base, 'submission', 'proposal.json'),
        submissionDraft: join(base, 'submission', 'draft.json'),
        submissionManifest: join(base, 'submission', 'manifest.json'),
    };
}
/** Durable, builder-owned run state. The kernel—not an LLM—records every transition. */
export class BuilderKernel {
    root;
    sessionId;
    capabilityRuntimes;
    options;
    constructor(root, sessionId, capabilityRuntimes = new BuilderCapabilityRuntimeRegistry(), options = {}) {
        this.root = root;
        this.sessionId = sessionId;
        this.capabilityRuntimes = capabilityRuntimes;
        this.options = options;
    }
    create(input) {
        const id = input.id ?? `builder-${Date.now()}-${randomUUID().slice(0, 8)}`;
        if (!/^builder-[0-9]+-[a-f0-9]{8}$/.test(id))
            throw new Error(`invalid builder run id: ${id}`);
        if (existsSync(builderRunPaths(this.root, this.sessionId, id).record))
            throw new Error(`builder run already exists: ${id}`);
        const now = new Date().toISOString();
        const inputHash = sha256(input);
        const record = {
            schemaVersion: 1,
            id,
            kind: input.kind ?? 'patch',
            mode: input.mode ?? 'implementation',
            state: 'created',
            phase: 'observing',
            createdAt: now,
            updatedAt: now,
            inputHash,
            lineageId: input.lineageId ?? `lineage-${id}`,
            ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        };
        const paths = builderRunPaths(this.root, this.sessionId, id);
        atomicWriteJson(paths.actor, input.actor);
        // The file is intentionally created up front.  It is a durable inbox, not
        // a mutable replacement for the actor snapshot captured at run creation.
        writeFileSync(paths.messages, '', 'utf8');
        atomicWriteJson(paths.targetBefore, input.targetBefore);
        atomicWriteJson(paths.previousAttempt, input.previousAttempt ?? null);
        atomicWriteJson(paths.previousRun, input.previousRun ?? null);
        atomicWriteJson(paths.provenance, createBuilderProvenance({
            runId: id,
            actorPath: paths.actor,
            targetBeforePath: paths.targetBefore,
            previousAttemptPath: paths.previousAttempt,
            previousRunPath: paths.previousRun,
            workspacePath: paths.workspace,
            proposalPath: paths.submissionDraft,
            submissionManifestPath: paths.submissionManifest,
            actor: input.actor,
            ...(input.previousAttempt ? { previousAttempt: input.previousAttempt } : {}),
            ...(input.previousRun ? { previousRun: input.previousRun } : {}),
        }));
        atomicWriteJson(paths.contextIndex, buildContextIndex(paths, input, id));
        atomicWriteJson(paths.worldModel, { schemaVersion: 1, version: 0, facts: [], unknowns: [], hash: sha256({}) });
        atomicWriteJson(paths.plan, { schemaVersion: 1, state: 'created', steps: [] });
        atomicWriteJson(paths.progressState, initialProgressState(record, input));
        atomicWriteJson(paths.record, record);
        this.append(id, 'state', 'create', { state: 'created', inputHash });
        this.emit(id, 'run_created', { runId: id, state: 'created', mode: record.mode });
        return record;
    }
    /** Host/runtime adapter captures an immutable source baseline after it has
     * materialized a workspace, before an external coding runtime can edit it. */
    captureWorkspaceBaseline(id, sourceRoot = 'packages/core/agent-loop/src') {
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const source = this.workspacePath(paths.workspace, sourceRoot);
        if (!existsSync(source) || (!statSync(source).isDirectory() && !statSync(source).isFile()))
            throw new Error(`workspace baseline source is unavailable: ${sourceRoot}`);
        const target = resolve(paths.workspaceBaseline, sourceRoot);
        if (existsSync(target))
            return { path: sourceRoot, captured: false };
        mkdirSync(resolve(target, '..'), { recursive: true });
        cpSync(source, target, { recursive: true, dereference: false });
        this.snapshot(id, `workspace-baseline/${sourceRoot.replaceAll('/', '_')}.json`, { sourceRoot, capturedAt: new Date().toISOString() });
        return { path: sourceRoot, captured: true };
    }
    load(id) {
        const record = readJson(builderRunPaths(this.root, this.sessionId, id).record);
        if (!record || record.schemaVersion !== 1)
            throw new Error(`unknown builder run: ${id}`);
        return {
            ...record,
            mode: record.mode ?? 'implementation',
            lineageId: record.lineageId || `lineage-${record.id}`,
            // Runs created before phase was introduced remain readable and acquire
            // a conservative phase without mutating their historical journal.
            phase: record.phase ?? phaseForState(record.state),
        };
    }
    transition(id, state) {
        const record = this.load(id);
        if (isTerminalState(record.state))
            throw new Error(`builder run is terminal: ${record.state}`);
        const next = { ...record, state, phase: phaseForState(state, record.phase), updatedAt: new Date().toISOString() };
        atomicWriteJson(builderRunPaths(this.root, this.sessionId, id).record, next);
        this.updateProgress(id, { state, phase: next.phase });
        this.append(id, 'state', `transition:${state}`, { from: record.state, to: state });
        this.emit(id, 'state_changed', { from: record.state, to: state, phase: next.phase });
        return next;
    }
    append(id, kind, action, result, error) {
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const seq = readJsonl(paths.journal).length + 1;
        const entry = {
            schemaVersion: 1, seq, kind, action,
            ...(result === undefined ? {} : { result: boundedJournalValue(result) }),
            at: new Date().toISOString(),
            inputHash: this.load(id).inputHash,
            ...(error === undefined ? {} : { error: String(error) }),
        };
        appendJsonl(paths.journal, entry);
        return entry;
    }
    /** Persist the visible prompt input separately from the journal/decision log. */
    recordPromptVisible(id, input) {
        const path = builderRunPaths(this.root, this.sessionId, id).promptVisible;
        const entry = {
            schemaVersion: 1,
            seq: readJsonl(path).length + 1,
            at: new Date().toISOString(),
            promptHash: input.promptHash,
            promptBytes: input.promptBytes,
            visibleState: input.visibleState,
            phase: this.load(id).phase,
            ...(input.progressStateVersion === undefined ? {} : { progressStateVersion: input.progressStateVersion }),
            ...(input.progressStateHash ? { progressStateHash: input.progressStateHash } : {}),
            ...(input.lastJournalAction ? { lastJournalAction: input.lastJournalAction } : {}),
            ...(input.lastToolResultHash ? { lastToolResultHash: input.lastToolResultHash } : {}),
            pendingMessageIds: [...input.pendingMessageIds],
            prompt: redactPrompt(input.prompt),
            redacted: redactPrompt(input.prompt) !== input.prompt,
        };
        appendJsonl(path, entry);
        return entry;
    }
    /** Read the compact working memory used to recover a fresh model turn. */
    progressState(id) {
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const existing = readJson(paths.progressState);
        if (existing && existing.schemaVersion === 1)
            return normalizeProgressState(existing, this.load(id));
        const context = this.contextWithoutProgress(id);
        const recovered = initialProgressState(context.run, {
            actor: context.input.actor,
            targetBefore: context.input.targetBefore,
            ...(context.input.previousAttempt ? { previousAttempt: context.input.previousAttempt } : {}),
            ...(context.input.previousRun ? { previousRun: context.input.previousRun } : {}),
        });
        atomicWriteJson(paths.progressState, recovered);
        return recovered;
    }
    /** Record the model's declared decision without trusting it to write audit data. */
    recordDecision(id, decision) {
        const result = { kind: decision.kind };
        if (decision.kind === 'tool') {
            result.action = decision.action.name;
            result.actionHash = sha256(decision.action);
            if (decision.action.name === 'invoke_capability') {
                result.capability = decision.action.capability;
                result.capabilityTool = decision.action.tool;
            }
        }
        if (decision.kind === 'continue')
            result.summary = decision.summary.slice(0, 1000);
        if (decision.kind === 'submit')
            result.draftHash = sha256(this.submissionDraft(id) ?? null);
        if (decision.kind === 'abort')
            result.reason = decision.reason.slice(0, 1000);
        this.append(id, 'model', 'decision', result);
        this.updateProgress(id, {
            lastAction: decision.kind === 'tool' ? `tool:${decision.action.name}` : decision.kind,
            ...(decision.kind === 'submit' ? { nextIntent: 'await independent verifier and gate decision' } : {}),
            ...(decision.kind === 'abort' ? { nextIntent: 'stop; preserve evidence for actor review' } : {}),
        });
    }
    context(id) {
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const actor = readJson(paths.actor) ?? {};
        const targetBefore = readJson(paths.targetBefore) ?? {};
        const previousAttempt = readJson(paths.previousAttempt) ?? null;
        const previousRun = readJson(paths.previousRun) ?? null;
        const diagnosisReport = readJson(paths.diagnosisReport) ?? null;
        const contextIndex = readJson(paths.contextIndex) ?? {};
        const provenance = readJson(paths.provenance) ?? createBuilderProvenance({
            runId: id, actorPath: paths.actor, targetBeforePath: paths.targetBefore,
            previousAttemptPath: paths.previousAttempt, previousRunPath: paths.previousRun,
            workspacePath: paths.workspace, proposalPath: paths.submissionDraft,
            submissionManifestPath: paths.submissionManifest, actor,
            ...(previousAttempt ? { previousAttempt } : {}), ...(previousRun ? { previousRun } : {}),
        });
        return {
            run: this.load(id),
            input: { actor, targetBefore, ...(previousAttempt ? { previousAttempt } : {}), ...(previousRun ? { previousRun } : {}) },
            messages: this.messages(id),
            journal: readJsonl(paths.journal),
            events: readJsonl(paths.events),
            progressState: this.progressState(id),
            diagnosisReport,
            contextIndex,
            provenance,
        };
    }
    contextWithoutProgress(id) {
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const actor = readJson(paths.actor) ?? {};
        const targetBefore = readJson(paths.targetBefore) ?? {};
        const previousAttempt = readJson(paths.previousAttempt) ?? null;
        const previousRun = readJson(paths.previousRun) ?? null;
        return {
            run: this.load(id),
            input: { actor, targetBefore, ...(previousAttempt ? { previousAttempt } : {}), ...(previousRun ? { previousRun } : {}) },
        };
    }
    messages(id) {
        return readJsonl(builderRunPaths(this.root, this.sessionId, id).messages).map((value, index) => ({
            schemaVersion: 1,
            id: typeof value.id === 'string' ? value.id : `legacy-${index + 1}`,
            at: typeof value.at === 'string' ? value.at : new Date(0).toISOString(),
            from: 'actor',
            rawUserText: typeof value.rawUserText === 'string' ? value.rawUserText : typeof value.text === 'string' ? value.text : '',
            ...(typeof value.actorMemo === 'string' ? { actorMemo: value.actorMemo } : {}),
            ...(Array.isArray(value.evidenceRefs) && value.evidenceRefs.every((ref) => typeof ref === 'string') ? { evidenceRefs: value.evidenceRefs } : {}),
            ...(typeof value.idempotencyKey === 'string' ? { idempotencyKey: value.idempotencyKey } : {}),
            text: typeof value.text === 'string' ? value.text : typeof value.rawUserText === 'string' ? value.rawUserText : '',
        }));
    }
    events(id, afterSeq = 0, limit = 50) {
        const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
        return readJsonl(builderRunPaths(this.root, this.sessionId, id).events)
            .filter((event) => event.seq > afterSeq)
            .slice(0, boundedLimit);
    }
    /**
     * Accept a new actor observation without changing the immutable initial
     * snapshot. The next driver turn reads this durable inbox in its prompt.
     */
    receiveActorMessage(id, input) {
        const run = this.load(id);
        if (isTerminalState(run.state))
            throw new Error(`builder run is terminal: ${run.state}`);
        const rawUserText = typeof input === 'string' ? input : input.rawUserText;
        const actorMemo = typeof input === 'string' ? undefined : input.actorMemo;
        const evidenceRefs = typeof input === 'string' ? undefined : input.evidenceRefs;
        const idempotencyKey = typeof input === 'string' ? undefined : input.idempotencyKey;
        if (!rawUserText.trim())
            throw new Error('builder message must not be empty');
        if (idempotencyKey) {
            const existing = this.messages(id).find((message) => message.idempotencyKey === idempotencyKey);
            if (existing) {
                const existingHash = sha256({ rawUserText: existing.rawUserText, actorMemo: existing.actorMemo ?? null, evidenceRefs: existing.evidenceRefs ?? [] });
                const incomingHash = sha256({ rawUserText, actorMemo: actorMemo ?? null, evidenceRefs: evidenceRefs ?? [] });
                if (existingHash !== incomingHash)
                    throw new Error(`builder idempotency key conflicts with a different message: ${idempotencyKey}`);
                return { ...existing, deduplicated: true };
            }
        }
        const message = {
            schemaVersion: 1,
            id: `message-${Date.now()}-${randomUUID().slice(0, 8)}`,
            at: new Date().toISOString(),
            from: 'actor',
            rawUserText,
            ...(actorMemo?.trim() ? { actorMemo } : {}),
            ...(evidenceRefs?.length ? { evidenceRefs: [...evidenceRefs] } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
            text: rawUserText,
        };
        appendJsonl(builderRunPaths(this.root, this.sessionId, id).messages, message);
        this.append(id, 'state', 'actor_message', { messageId: message.id, bytes: Buffer.byteLength(rawUserText, 'utf8'), messageHash: sha256(rawUserText), ...(idempotencyKey ? { idempotencyKey } : {}) });
        this.emit(id, 'actor_message_received', { messageId: message.id, rawUserHash: sha256(rawUserText), ...(actorMemo ? { actorMemoHash: sha256(actorMemo) } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) });
        const progress = this.progressState(id);
        this.updateProgress(id, {
            objective: progress.objective ?? rawUserText.slice(0, 2_000),
            pendingMessageIds: [...new Set([...progress.pendingMessageIds, message.id])],
            nextIntent: 'acknowledge the latest actor message and reassess the hypothesis',
            lastAction: 'actor_message_received',
        });
        // A reply is durable input only. The Actor must explicitly resume the
        // background job; this prevents a message arrival from racing a worker
        // that has already returned at the needs_input boundary.
        return message;
    }
    /** Kernel-owned lifecycle boundary. A paused/cancelled run never submits. */
    control(id, action) {
        const run = this.load(id);
        if (isTerminalState(run.state))
            throw new Error(`builder run is terminal: ${run.state}`);
        const nextState = action === 'pause' ? 'paused' : 'cancelled';
        this.append(id, 'state', `control:${action}`, { from: run.state, to: nextState });
        return this.transition(id, nextState);
    }
    /** Make a missing proposal draft an explicit, durable next-step obligation. */
    requireSubmissionDraft(id) {
        return this.updateProgress(id, {
            progressRequirement: 'write_submission',
            nextIntent: 'write_submission with the concrete verified candidate proposal before attempting submit',
            lastAction: 'guard:missing_submission_draft',
        });
    }
    /** After a candidate edit, require one fresh executable observation before
     * the model can continue editing or hand off the proposal. */
    requireEvidence(id) {
        return this.updateProgress(id, {
            progressRequirement: 'produce_evidence',
            nextIntent: 'run the relevant oracle or simulation against the edited candidate before editing again',
            lastAction: 'guard:candidate_requires_evidence',
        });
    }
    proposal(id) {
        return readJson(builderRunPaths(this.root, this.sessionId, id).proposal);
    }
    /** Execute exactly one allowlisted builder action and durably return its feedback. */
    decide(id, decision) {
        const run = this.load(id);
        if (run.state === 'paused' || run.state === 'waiting_for_input')
            throw new Error(`builder run is not runnable: ${run.state}`);
        if (run.state === 'cancelled')
            throw new Error('builder run is cancelled');
        if (run.state === 'created')
            this.transition(id, 'exploring');
        this.recordDecision(id, decision);
        if (decision.kind === 'continue') {
            const journal = readJsonl(builderRunPaths(this.root, this.sessionId, id).journal);
            const priorDecision = [...journal].reverse().find((entry) => entry.kind === 'model' && entry.action === 'decision' && entry.seq !== journal[journal.length - 1]?.seq);
            if (priorDecision?.result?.kind === 'continue') {
                this.append(id, 'error', 'continue', undefined, 'continue requires a new tool action; consecutive no-op turns are not allowed');
                throw new Error('continue requires a new tool action; consecutive no-op turns are not allowed');
            }
            return { state: this.load(id).state, continue: true };
        }
        if (decision.kind === 'abort') {
            this.append(id, 'state', 'abort', undefined, decision.reason);
            this.transition(id, 'aborted');
            return { state: 'aborted' };
        }
        if (decision.kind === 'submit') {
            if (run.mode === 'diagnosis')
                throw new Error('diagnosis pass cannot submit; write a diagnosis report and await user direction');
            const progress = this.progressState(id);
            if (progress.progressRequirement === 'write_submission') {
                throw new Error('builder submission requires write_submission before submit');
            }
            const draft = this.submissionDraft(id);
            if (!draft)
                throw new Error('builder submission requires a proposal draft');
            const pendingMessages = this.unacknowledgedMessageIds(id);
            if (pendingMessages.length > 0)
                throw new Error(`builder submission requires acknowledgement of actor messages: ${pendingMessages.join(', ')}`);
            const manifest = readJson(builderRunPaths(this.root, this.sessionId, id).submissionManifest);
            const currentTargetBeforeHash = sha256(readJson(builderRunPaths(this.root, this.sessionId, id).targetBefore) ?? {});
            if (!manifest
                || manifest.runId !== id
                || manifest.lineageId !== this.load(id).lineageId
                || manifest.proposalHash !== sha256(draft)
                || manifest.inputHash !== this.load(id).inputHash
                || manifest.targetBeforeHash !== currentTargetBeforeHash) {
                throw new Error('builder submission manifest is missing or does not bind the frozen proposal/input');
            }
            if (!pathRefsStillBind(manifest.evidenceRefs) || !pathRefsStillBind(manifest.artifactRefs)) {
                throw new Error('builder submission manifest evidence or artifacts changed after freeze');
            }
            if (existsSync(join(builderRunPaths(this.root, this.sessionId, id).staging, 'candidate.json')) && this.load(id).state !== 'ready_to_submit') {
                throw new Error('legacy candidate draft must pass preflight before submit');
            }
            atomicWriteJson(builderRunPaths(this.root, this.sessionId, id).proposal, draft);
            this.snapshot(id, 'submission/proposal.json', draft);
            this.append(id, 'state', 'submit', { proposalHash: sha256(draft) });
            this.transition(id, 'submitted');
            return { state: 'submitted' };
        }
        try {
            if (decision.kind === 'tool') {
                const actionHash = sha256(decision.action);
                const progress = this.progressState(id);
                if (this.options.enforceProgressCheckpoints
                    && progress.progressRequirement !== 'none'
                    && !satisfiesProgressRequirement(progress.progressRequirement, decision.action.name)) {
                    const reason = `progress checkpoint required: ${progress.progressRequirement}; action ${decision.action.name} does not produce the required evidence`;
                    this.append(id, 'error', decision.action.name, {
                        actionHash, noProgress: true, guard: 'progressCheckpoint', progressRequirement: progress.progressRequirement,
                    }, reason);
                    this.updateProgress(id, {
                        nextIntent: progressRequirementIntent(progress.progressRequirement),
                        lastAction: `guard:${progress.progressRequirement}`,
                    });
                    throw new Error(reason);
                }
                if (this.options.enforceProgressCheckpoints && progress.progressRequirement === 'declare_direction') {
                    const invalidCheckpoint = progressCheckpointValidation(decision.action);
                    if (invalidCheckpoint) {
                        const reason = `progress checkpoint is incomplete: ${invalidCheckpoint}`;
                        this.append(id, 'error', decision.action.name, {
                            actionHash, noProgress: true, guard: 'progressCheckpoint', progressRequirement: progress.progressRequirement,
                        }, reason);
                        this.updateProgress(id, {
                            nextIntent: 'write a falsifiable hypothesis and nextIntent in world_model/plan before reading again',
                            lastAction: 'guard:declare_direction',
                        });
                        throw new Error(reason);
                    }
                }
                const repeated = repeatedToolWithoutProgress(readJsonl(builderRunPaths(this.root, this.sessionId, id).journal), actionHash);
                const repeatReadThreshold = this.options.repeatReadRejectAfter === undefined
                    ? undefined
                    : Math.max(1, Math.floor(this.options.repeatReadRejectAfter));
                if (repeatReadThreshold !== undefined
                    && isReadAction(decision.action.name)
                    // Use the run-wide unchanged-read streak, not only one exact path.
                    // A model can otherwise evade the guard by alternating two stale
                    // files while still producing no new evidence.
                    && this.progressState(id).unchangedReadStreak >= Math.max(0, repeatReadThreshold - 1)) {
                    const progress = this.progressState(id);
                    const requirement = this.options.enforceProgressCheckpoints
                        ? progress.progressRequirement === 'none'
                            ? (progress.hypothesis?.trim() ? 'produce_evidence' : 'declare_direction')
                            : progress.progressRequirement
                        : progress.progressRequirement;
                    const reason = `unchanged read rejected at streak ${progress.unchangedReadStreak + 1}: ${decision.action.name}`;
                    this.append(id, 'error', decision.action.name, {
                        actionHash, repeated: progress.unchangedReadStreak + 1, noProgress: true,
                        guard: 'repeatReadRejectAfter', ...(requirement === 'none' ? {} : { progressRequirement: requirement }),
                    }, reason);
                    if (requirement !== 'none') {
                        this.updateProgress(id, {
                            progressRequirement: requirement,
                            nextIntent: progressRequirementIntent(requirement),
                            lastAction: `guard:${requirement}`,
                        });
                    }
                    throw new Error(reason);
                }
                if (repeated >= 8) {
                    const reason = `identical tool feedback repeated ${repeated + 1} times without progress: ${decision.action.name}`;
                    this.append(id, 'error', decision.action.name, { actionHash, repeated: repeated + 1, noProgress: true }, reason);
                    this.transition(id, 'aborted');
                    return { state: 'aborted', reason };
                }
            }
            const result = this.executeTool(id, decision.action);
            this.append(id, 'tool', decision.action.name, result);
            this.updateProgressAfterTool(id, decision.action, result);
            this.emit(id, 'tool_completed', { action: decision.action.name, resultHash: sha256(result) });
            return result;
        }
        catch (error) {
            this.append(id, 'error', decision.action.name, undefined, error);
            this.updateProgress(id, {
                lastAction: `error:${decision.action.name}`,
                nextIntent: isReadAction(decision.action.name)
                    ? 'state the hypothesis or choose a new evidence-producing action after the unchanged-read rejection'
                    : 'inspect the tool error and decide whether to correct, ask, submit, or abort',
            });
            this.emit(id, 'tool_failed', { action: decision.action.name, error: String(error).slice(0, 1_000) });
            throw error;
        }
    }
    /** Kernel-owned verifier feedback starts a new immutable builder attempt. */
    reopenFromRejection(id, report) {
        const context = this.context(id);
        if (context.run.state !== 'submitted')
            throw new Error('only submitted builder runs may be rejected');
        this.append(id, 'state', 'verifier_rejected', { reportHash: sha256(report) });
        return this.create({
            kind: context.run.kind,
            mode: context.run.mode,
            actor: context.input.actor,
            targetBefore: context.input.targetBefore,
            previousAttempt: report,
            previousRun: this.previousRunReference(id),
            lineageId: context.run.lineageId,
            parentRunId: id,
        });
    }
    /** Add machine-readable progress feedback without preventing repeated reads. */
    annotateReadFeedback(id, action, target, result) {
        const prior = readJsonl(builderRunPaths(this.root, this.sessionId, id).journal)
            .filter((entry) => entry.kind === 'tool' && entry.action === action && readTarget(entry.result) === target)
            .at(-1);
        const currentHash = sha256(stripReadObservation(result));
        const priorHash = prior?.result ? sha256(stripReadObservation(prior.result)) : undefined;
        return {
            ...result,
            observation: prior
                ? { newInformation: currentHash !== priorHash, unchangedSinceSeq: currentHash === priorHash ? prior.seq : undefined }
                : { newInformation: true },
        };
    }
    executeTool(id, action) {
        const paths = builderRunPaths(this.root, this.sessionId, id);
        if (action.name === 'read_input') {
            const path = {
                actor: paths.actor, target_before: paths.targetBefore, previous_attempt: paths.previousAttempt,
                previous_run: paths.previousRun, world_model: paths.worldModel, plan: paths.plan, progress_state: paths.progressState, context_index: paths.contextIndex, provenance: paths.provenance,
            }[action.document];
            return this.annotateReadFeedback(id, action.name, action.document, { document: action.document, value: readJson(path) ?? null });
        }
        if (action.name === 'read_journal') {
            const limit = Math.max(1, Math.min(100, Math.floor(action.limit)));
            return this.annotateReadFeedback(id, action.name, 'journal', { entries: readJsonl(paths.journal).slice(-limit) });
        }
        if (action.name === 'write_world_model') {
            atomicWriteJson(paths.worldModel, action.value);
            this.snapshot(id, 'state/world-model.json', action.value);
            this.setPhase(id, 'hypothesizing');
            return { written: 'world_model', hash: sha256(action.value) };
        }
        if (action.name === 'write_plan') {
            atomicWriteJson(paths.plan, action.value);
            this.snapshot(id, 'state/plan.json', action.value);
            return { written: 'plan', hash: sha256(action.value) };
        }
        if (action.name === 'write_diagnosis_report') {
            if (this.load(id).mode !== 'diagnosis')
                throw new Error('write_diagnosis_report is only available in a diagnosis pass');
            validateDiagnosisReport(action.report);
            atomicWriteJson(paths.diagnosisReport, action.report);
            this.snapshot(id, 'state/diagnosis-report.json', action.report);
            this.setPhase(id, 'waiting_for_actor');
            this.emit(id, 'diagnosis_report', {
                reportHash: sha256(action.report),
                directions: Array.isArray(action.report.directions) ? action.report.directions.length : 0,
            });
            this.transition(id, 'waiting_for_input');
            return { written: 'diagnosis_report', path: paths.diagnosisReport, hash: sha256(action.report), waitingFor: 'user_direction' };
        }
        if (action.name === 'read_file') {
            const file = this.readablePath(paths.workspace, action.path);
            if (!existsSync(file) || !statSync(file).isFile())
                throw new Error(`file is unavailable: ${file}`);
            const content = readFileSync(file, 'utf8');
            const result = this.annotateReadFeedback(id, action.name, file, { path: file, content: content.slice(0, 64_000), truncated: content.length > 64_000 });
            this.observeArtifact(id, 'source', file, 'Source file read during Builder exploration.');
            return result;
        }
        if (action.name === 'list_directory') {
            const directory = this.readablePath(paths.workspace, action.path);
            if (!existsSync(directory) || !statSync(directory).isDirectory())
                throw new Error(`directory is unavailable: ${directory}`);
            const entries = readdirSync(directory, { withFileTypes: true }).slice(0, 500).map(entry => ({
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
            }));
            return this.annotateReadFeedback(id, action.name, directory, { path: directory, entries, truncated: readdirSync(directory).length > entries.length });
        }
        if (action.name === 'search_text') {
            // Match read/list semantics: a Builder's relative source root belongs to
            // its immutable workspace, while an explicitly absolute root stays a
            // global read-only location.
            const roots = action.roots?.length
                ? action.roots.map((root) => this.readablePath(paths.workspace, root))
                : [paths.workspace, process.cwd()];
            const result = searchBuilderText(action.query, roots, action.maxResults);
            for (const match of Array.isArray(result.matches) ? result.matches : []) {
                if (match && typeof match === 'object' && typeof match.path === 'string') {
                    const source = match.path;
                    this.observeArtifact(id, 'source', source, `Source matched text query ${JSON.stringify(action.query.slice(0, 160))}.`);
                }
            }
            return result;
        }
        if (action.name === 'inspect_file') {
            const result = inspectBuilderFile(action.path);
            this.observeArtifact(id, 'source', String(result.path), 'Source interface inspected during Builder exploration.');
            return result;
        }
        if (action.name === 'trace_artifact') {
            return traceBuilderArtifact(this.provenance(id), action.artifact);
        }
        if (action.name === 'write_workspace_file') {
            const file = this.workspacePath(paths.workspace, action.path);
            const relativePath = relative(paths.workspace, file);
            this.captureWorkspaceBaselineFile(paths.workspaceBaseline, paths.workspace, file);
            mkdirSync(resolve(file, '..'), { recursive: true });
            writeFileSync(file, action.content, 'utf8');
            this.snapshot(id, `workspace/${relativePath}`, action.content);
            this.setPhase(id, 'exploring');
            return { path: relativePath, bytes: Buffer.byteLength(action.content, 'utf8'), hash: sha256(action.content) };
        }
        if (action.name === 'apply_workspace_patch') {
            for (const relativePath of unifiedPatchFiles(action.patch)) {
                this.captureWorkspaceBaselineFile(paths.workspaceBaseline, paths.workspace, this.workspacePath(paths.workspace, relativePath));
            }
            const check = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', '-'], {
                cwd: paths.workspace, encoding: 'utf8', input: action.patch, maxBuffer: 256 * 1024,
            });
            if (check.status !== 0)
                throw new Error(`workspace patch rejected: ${(check.stderr || check.stdout || 'git apply check failed').trim()}`);
            const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], {
                cwd: paths.workspace, encoding: 'utf8', input: action.patch, maxBuffer: 256 * 1024,
            });
            if (applied.status !== 0)
                throw new Error(`workspace patch failed: ${(applied.stderr || applied.stdout || 'git apply failed').trim()}`);
            const hash = sha256(action.patch);
            this.snapshot(id, `workspace/patches/${hash}.diff`, action.patch);
            this.setPhase(id, 'exploring');
            return { applied: true, hash, bytes: Buffer.byteLength(action.patch, 'utf8'), files: unifiedPatchFiles(action.patch) };
        }
        if (action.name === 'read_workspace_file') {
            const file = this.workspacePath(paths.workspace, action.path);
            if (!existsSync(file) || !statSync(file).isFile())
                throw new Error('workspace file is unavailable');
            const content = readFileSync(file, 'utf8');
            return { path: relative(paths.workspace, file), content: content.slice(0, 64_000), truncated: content.length > 64_000 };
        }
        if (action.name === 'run_workspace_command') {
            mkdirSync(paths.workspace, { recursive: true });
            const timeout = Math.max(1_000, Math.min(300_000, Math.floor(action.timeoutMs ?? 120_000)));
            const output = spawnSync(action.command, action.args ?? [], {
                cwd: paths.workspace, encoding: 'utf8', timeout, maxBuffer: 256 * 1024,
            });
            this.setPhase(id, 'exploring');
            return {
                command: action.command, args: action.args, cwd: paths.workspace,
                exitCode: output.status, signal: output.signal ?? undefined,
                stdout: String(output.stdout ?? '').slice(-64_000), stderr: String(output.stderr ?? '').slice(-64_000),
                ...(output.error ? { error: String(output.error) } : {}),
            };
        }
        if (action.name === 'acknowledge_message') {
            const message = this.messages(id).find((item) => item.id === action.messageId);
            if (!message)
                throw new Error(`actor message is unavailable: ${action.messageId}`);
            const priorAck = readJsonl(paths.events).find((event) => event.kind === 'message_ack' && event.payload.messageId === action.messageId);
            if (priorAck) {
                return { acknowledged: action.messageId, ...priorAck.payload, deduplicated: true };
            }
            const payload = {
                messageId: action.messageId,
                status: action.status.slice(0, 80),
                understanding: action.understanding.slice(0, 4_000),
                ...(action.nextAction ? { nextAction: action.nextAction.slice(0, 4_000) } : {}),
                ...(action.question ? { question: action.question.slice(0, 4_000) } : {}),
            };
            this.emit(id, 'message_ack', payload);
            return { acknowledged: action.messageId, ...payload };
        }
        if (action.name === 'publish_progress') {
            const payload = {
                summary: action.summary.slice(0, 4_000),
                ...(action.phase ? { phase: action.phase.slice(0, 160) } : {}),
                ...(action.question ? { question: action.question.slice(0, 4_000) } : {}),
            };
            this.emit(id, 'builder_update', payload);
            return { published: true, ...payload };
        }
        if (action.name === 'request_input') {
            validateInputRequest(action);
            const payload = {
                question: action.question.slice(0, 4_000),
                ...(action.context ? { context: action.context.slice(0, 4_000) } : {}),
                ...(action.kind ? { kind: action.kind } : {}),
                ...(action.options?.length ? { options: action.options.slice(0, 8).map((option) => ({
                        id: option.id.slice(0, 120), label: option.label.slice(0, 500),
                        ...(option.description ? { description: option.description.slice(0, 1_000) } : {}),
                    })) } : {}),
                ...(action.whyNow ? { whyNow: action.whyNow.slice(0, 4_000) } : {}),
                ...(action.evidenceRefs?.length ? { evidenceRefs: action.evidenceRefs.slice(0, 16).map((ref) => ref.slice(0, 4_000)) } : {}),
                ...(action.blocking === undefined ? { blocking: true } : { blocking: action.blocking }),
            };
            this.emit(id, 'needs_input', payload);
            this.setPhase(id, action.kind === 'verification' ? 'waiting_for_verification' : 'waiting_for_actor');
            this.transition(id, 'waiting_for_input');
            return { requested: true, ...payload };
        }
        if (action.name === 'invoke_capability') {
            const runtime = this.capabilityRuntimes.get(action.capability);
            if (!runtime)
                throw new Error(`capability runtime is unavailable: ${action.capability}`);
            const context = {
                root: this.root,
                sessionId: this.sessionId,
                runId: id,
                workspacePath: paths.workspace,
            };
            const result = runtime.invoke(action.tool, action.input, context);
            if (action.capability === 'workspace-simulation') {
                const priorSimulation = readJsonl(paths.journal).some((entry) => entry.kind === 'tool' && entry.action === 'invoke_capability' && entry.result?.status !== undefined);
                this.setPhase(id, priorSimulation ? 'candidate_simulating' : 'baseline_simulating');
            }
            return result;
        }
        if (action.name === 'write_submission') {
            if (this.load(id).mode === 'diagnosis') {
                throw new Error('diagnosis pass cannot write a proposal; write a diagnosis report and await user direction');
            }
            atomicWriteJson(paths.submissionDraft, action.proposal);
            this.snapshot(id, 'submission/draft.json', action.proposal);
            const manifest = this.freezeSubmissionManifest(id, action.proposal);
            atomicWriteJson(paths.submissionManifest, manifest);
            this.snapshot(id, 'submission/manifest.json', manifest);
            this.emit(id, 'proposal_drafted', { proposalHash: manifest.proposalHash, manifestHash: sha256(manifest), keys: Object.keys(action.proposal).slice(0, 20) });
            this.setPhase(id, 'ready_to_submit');
            return { written: 'submission_draft', hash: manifest.proposalHash, manifestHash: sha256(manifest) };
        }
        if (action.name === 'compile_loop_submission') {
            if (this.load(id).kind !== 'loop_candidate')
                throw new Error('workspace loop compilation is only available to loop_candidate runs');
            const proposal = this.compileLoopWorkspaceProposal(id, action.rationale, action.expectedOutcome);
            atomicWriteJson(paths.submissionDraft, proposal);
            this.snapshot(id, 'submission/draft.json', proposal);
            const manifest = this.freezeSubmissionManifest(id, proposal);
            atomicWriteJson(paths.submissionManifest, manifest);
            this.snapshot(id, 'submission/manifest.json', manifest);
            this.emit(id, 'proposal_drafted', { proposalHash: manifest.proposalHash, manifestHash: sha256(manifest), keys: Object.keys(proposal) });
            this.setPhase(id, 'ready_to_submit');
            return { written: 'compiled_loop_submission', edits: proposal.payload.source.edits.length, hash: manifest.proposalHash, manifestHash: sha256(manifest) };
        }
        if (action.name === 'compile_config_submission') {
            const proposal = this.compileConfigWorkspaceProposal(id, action.rationale, action.expectedOutcome);
            atomicWriteJson(paths.submissionDraft, proposal);
            this.snapshot(id, 'submission/draft.json', proposal);
            const manifest = this.freezeSubmissionManifest(id, proposal);
            atomicWriteJson(paths.submissionManifest, manifest);
            this.snapshot(id, 'submission/manifest.json', manifest);
            this.emit(id, 'proposal_drafted', { proposalHash: manifest.proposalHash, manifestHash: sha256(manifest), keys: Object.keys(proposal) });
            this.setPhase(id, 'ready_to_submit');
            return { written: 'compiled_config_submission', targetId: proposal.payload.targetId, hash: manifest.proposalHash, manifestHash: sha256(manifest) };
        }
        if (action.name === 'compile_module_submission') {
            const proposal = this.compileModuleWorkspaceProposal(id, action.rationale, action.expectedOutcome);
            // Validator load/probe checks deliberately read a host-owned staging
            // area, never the runtime workspace. Copy the compiler's frozen bundle
            // there before any verifier can observe the envelope.
            const payload = proposal.payload;
            const staging = protocolPaths.staging(this.root, this.sessionId, payload.id);
            for (const file of payload.module.files) {
                const target = resolve(staging, file.path);
                if (relative(staging, target).startsWith('..'))
                    throw new Error(`compiled module staging path escapes root: ${file.path}`);
                mkdirSync(join(target, '..'), { recursive: true });
                writeFileSync(target, file.content, 'utf8');
            }
            atomicWriteJson(paths.submissionDraft, proposal);
            this.snapshot(id, 'submission/draft.json', proposal);
            const manifest = this.freezeSubmissionManifest(id, proposal);
            atomicWriteJson(paths.submissionManifest, manifest);
            this.snapshot(id, 'submission/manifest.json', manifest);
            this.emit(id, 'proposal_drafted', { proposalHash: manifest.proposalHash, manifestHash: sha256(manifest), keys: Object.keys(proposal) });
            this.setPhase(id, 'ready_to_submit');
            return { written: 'compiled_module_submission', targetId: proposal.payload.targetId, hash: manifest.proposalHash, manifestHash: sha256(manifest) };
        }
        if (action.name === 'write_candidate_draft') {
            if (!action.proposal || Array.isArray(action.proposal))
                throw new Error('candidate draft must be an object');
            const draft = join(paths.staging, 'candidate.json');
            const alreadyStaged = existsSync(draft);
            const priorPreflightError = readJsonl(paths.journal).some((entry) => entry.kind === 'error' && entry.action === 'preflight_staging_entry');
            if (alreadyStaged && !priorPreflightError) {
                throw new Error('candidate draft already exists; inspect or preflight it before rewriting');
            }
            atomicWriteJson(draft, action.proposal);
            this.snapshot(id, 'staging/candidate.json', action.proposal);
            const manifest = this.freezeSubmissionManifest(id, action.proposal);
            atomicWriteJson(paths.submissionManifest, manifest);
            this.snapshot(id, 'submission/manifest.json', manifest);
            return { written: 'candidate_draft', entry: 'candidate.json', hash: sha256(action.proposal), manifestHash: sha256(manifest) };
        }
        const requestedPath = action.name === 'preflight_staging_entry' ? action.entry : action.path;
        const candidate = resolve(paths.staging, requestedPath);
        if (relative(paths.staging, candidate).startsWith('..') || !existsSync(candidate) || !statSync(candidate).isFile())
            throw new Error('staging path is unavailable');
        if (action.name === 'preflight_staging_entry') {
            const source = readFileSync(candidate, 'utf8');
            if (!source.trim())
                throw new Error('staging entry is empty');
            if (action.entry === 'candidate.json') {
                const draft = readJson(candidate);
                if (!draft || Array.isArray(draft))
                    throw new Error('candidate draft must be an object');
                if (this.load(id).kind === 'loop_candidate') {
                    const loop = draft.candidate;
                    if (!loop || typeof loop !== 'object' || Array.isArray(loop))
                        throw new Error('loop candidate draft must contain a candidate object');
                }
                else if (!draft.patch || typeof draft.patch !== 'object') {
                    throw new Error('candidate draft must contain a patch object');
                }
                const patch = draft.patch;
                const module = patch?.module;
                if (module && typeof module === 'object' && !Array.isArray(module)) {
                    const files = module.files;
                    const entry = module.entry;
                    if (!Array.isArray(files) || typeof entry !== 'string' || !files.some((file) => {
                        if (!file || typeof file !== 'object')
                            return false;
                        const path = file.path;
                        const content = file.content;
                        return path === entry && typeof content === 'string' && content.trim().length > 0;
                    }))
                        throw new Error('candidate module entry is not present in the draft');
                }
                // Legacy staging drafts still have to cross the same immutable
                // proposal boundary as modern write_submission drafts.  Preflight is
                // the first point at which a hand-written staging file has been
                // structurally checked, so bind it here instead of allowing submit to
                // manufacture a manifest from a mutable file later.
                const manifest = this.freezeSubmissionManifest(id, draft);
                atomicWriteJson(paths.submissionManifest, manifest);
                this.snapshot(id, 'submission/manifest.json', manifest);
                this.emit(id, 'proposal_drafted', { proposalHash: manifest.proposalHash, manifestHash: sha256(manifest), keys: Object.keys(draft).slice(0, 20) });
            }
            this.snapshot(id, `preflight/${action.entry.replaceAll('/', '_')}.json`, { entry: action.entry, sourceHash: sha256(source), passed: true });
            this.transition(id, 'ready_to_submit');
            return { entry: action.entry, passed: true, sourceHash: sha256(source) };
        }
        return { path: action.path, content: readFileSync(candidate, 'utf8').slice(0, 16_000) };
    }
    provenance(id) {
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const graph = readJson(paths.provenance);
        if (graph?.schemaVersion === 1)
            return graph;
        const input = this.contextWithoutProgress(id).input;
        const created = createBuilderProvenance({
            runId: id, actorPath: paths.actor, targetBeforePath: paths.targetBefore,
            previousAttemptPath: paths.previousAttempt, previousRunPath: paths.previousRun,
            workspacePath: paths.workspace, proposalPath: paths.submissionDraft,
            submissionManifestPath: paths.submissionManifest, actor: input.actor,
            ...(input.previousAttempt ? { previousAttempt: input.previousAttempt } : {}),
            ...(input.previousRun ? { previousRun: input.previousRun } : {}),
        });
        atomicWriteJson(paths.provenance, created);
        return created;
    }
    observeArtifact(id, role, path, summary) {
        const graph = this.provenance(id);
        addObservedArtifact(graph, role, path, summary);
        atomicWriteJson(builderRunPaths(this.root, this.sessionId, id).provenance, graph);
    }
    snapshot(id, ref, value) {
        appendJsonl(builderRunPaths(this.root, this.sessionId, id).snapshots, {
            schemaVersion: 1,
            at: new Date().toISOString(),
            ref,
            hash: sha256(value),
        });
    }
    setPhase(id, phase) {
        const record = this.load(id);
        if (record.phase === phase || isTerminalState(record.state))
            return;
        const next = { ...record, phase, updatedAt: new Date().toISOString() };
        atomicWriteJson(builderRunPaths(this.root, this.sessionId, id).record, next);
        this.updateProgress(id, { phase, state: next.state, lastAction: `phase:${phase}` });
        this.append(id, 'state', `phase:${phase}`, { phase, state: next.state });
        this.emit(id, 'state_changed', { phase, state: next.state });
    }
    updateProgressAfterTool(id, action, result) {
        const progress = this.progressState(id);
        const observation = result.observation && typeof result.observation === 'object' && !Array.isArray(result.observation)
            ? result.observation
            : undefined;
        const observedHash = observation
            ? sha256(stripReadObservation(result))
            : undefined;
        const unchanged = observation?.newInformation === false;
        const isRead = isReadAction(action.name);
        const nextStreak = isRead
            ? unchanged ? progress.unchangedReadStreak + 1 : 0
            : 0;
        const pendingMessageIds = action.name === 'acknowledge_message'
            ? progress.pendingMessageIds.filter((messageId) => messageId !== action.messageId)
            : progress.pendingMessageIds;
        const nextIntent = action.name === 'request_input'
            ? 'wait for Actor/user input before resuming'
            : action.name === 'write_diagnosis_report'
                ? 'wait for Actor/user to choose an implementation direction'
                : action.name === 'write_submission' || action.name === 'write_candidate_draft'
                    ? 'submit the frozen proposal after any required preflight'
                    : action.name === 'invoke_capability'
                        ? 'inspect capability feedback and decide whether the hypothesis survived'
                        : action.name === 'write_world_model' || action.name === 'write_plan'
                            ? 'use the declared state to choose the next evidence-producing action'
                            : progress.nextIntent;
        // The no-progress breaker collects one public direction, then gets out
        // of the Builder's way. Requiring a particular *next* action would turn
        // this safety rail into a route planner and can block a necessary read.
        const nextRequirement = progress.progressRequirement === 'declare_direction'
            && satisfiesProgressRequirement('declare_direction', action.name)
            ? 'none'
            : progress.progressRequirement !== 'none'
                && satisfiesProgressRequirement(progress.progressRequirement, action.name)
                ? 'none'
                : progress.progressRequirement;
        this.updateProgress(id, {
            lastAction: action.name,
            ...(observedHash ? { lastObservationHash: observedHash } : {}),
            unchangedReadStreak: nextStreak,
            pendingMessageIds,
            progressRequirement: nextRequirement,
            ...(nextIntent ? { nextIntent } : {}),
            ...(action.name === 'write_world_model' ? extractWorldModelProgress(action.value, progress) : {}),
            ...(action.name === 'write_plan' ? extractPlanProgress(action.value, progress) : {}),
        });
    }
    updateProgress(id, patch) {
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const current = readJson(paths.progressState) ?? initialProgressState(this.load(id), this.contextWithoutProgress(id).input);
        const next = normalizeProgressState({
            ...current,
            ...patch,
            version: current.version + 1,
            updatedAt: new Date().toISOString(),
        }, this.load(id));
        atomicWriteJson(paths.progressState, next);
        return next;
    }
    unacknowledgedMessageIds(id) {
        const acknowledged = new Set(readJsonl(builderRunPaths(this.root, this.sessionId, id).events).filter((event) => event.kind === 'message_ack' && typeof event.payload.messageId === 'string')
            .map((event) => event.payload.messageId));
        return this.messages(id).filter((message) => !acknowledged.has(message.id)).map((message) => message.id);
    }
    freezeSubmissionManifest(id, proposal) {
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const run = this.load(id);
        const actor = readJson(paths.actor) ?? {};
        const context = actor.context && typeof actor.context === 'object' && !Array.isArray(actor.context)
            ? actor.context
            : {};
        const evidencePack = context.evidencePack && typeof context.evidencePack === 'object' && !Array.isArray(context.evidencePack)
            ? context.evidencePack
            : {};
        const evidencePaths = [
            ...(typeof evidencePack.manifestPath === 'string' ? [evidencePack.manifestPath] : []),
            ...this.messages(id).flatMap((message) => message.evidenceRefs ?? []),
        ];
        const artifactPaths = Array.isArray(proposal.artifacts) && proposal.artifacts.every((path) => typeof path === 'string')
            ? proposal.artifacts
            : [];
        return {
            schemaVersion: 1,
            runId: id,
            lineageId: run.lineageId,
            proposalHash: sha256(proposal),
            inputHash: run.inputHash,
            targetBeforeHash: sha256(readJson(paths.targetBefore) ?? {}),
            evidenceRefs: freezePathRefs(evidencePaths),
            artifactRefs: freezePathRefs(artifactPaths),
            createdAt: new Date().toISOString(),
        };
    }
    /** Preserve original bytes on the first workspace mutation only. */
    captureWorkspaceBaselineFile(baselineRoot, workspace, file) {
        if (!file.startsWith(`${resolve(workspace)}/`) || !existsSync(file) || !statSync(file).isFile())
            return;
        const relativePath = relative(workspace, file);
        const destination = resolve(baselineRoot, relativePath);
        if (existsSync(destination))
            return;
        mkdirSync(resolve(destination, '..'), { recursive: true });
        writeFileSync(destination, readFileSync(file));
    }
    /**
     * Turn captured workspace bytes into the audited builder-generated envelope.
     * The model supplies only intent; exact hashes and replacement text come from
     * Kernel-owned before/after files and remain independently revalidated by
     * CandidateImporter.
     */
    compileLoopWorkspaceProposal(id, rationale, expectedOutcome) {
        if (!rationale.trim())
            throw new Error('compiled loop submission requires a rationale');
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const target = readJson(paths.targetBefore) ?? {};
        const ref = typeof target.baselineCommit === 'string' ? target.baselineCommit : '';
        if (!/^[0-9a-f]{40}$/i.test(ref))
            throw new Error('compiled loop submission requires targetBefore.baselineCommit');
        const edits = [];
        const visit = (directory) => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                const file = join(directory, entry.name);
                if (entry.isDirectory())
                    visit(file);
                else if (entry.isFile()) {
                    const relativePath = relative(paths.workspaceBaseline, file);
                    if (!relativePath.startsWith('packages/core/agent-loop/src/') || !/\.tsx?$/.test(relativePath))
                        continue;
                    const current = resolve(paths.workspace, relativePath);
                    if (!existsSync(current) || !statSync(current).isFile())
                        throw new Error(`compiled loop edit is unavailable: ${relativePath}`);
                    const before = readFileSync(file, 'utf8');
                    const after = readFileSync(current, 'utf8');
                    // CandidateImporter validates a builder-generated beforeHash against
                    // the original file bytes.  `sha256()` is the protocol JSON-value
                    // digest (and intentionally quotes strings), so it must not be used
                    // for this cross-boundary file-content contract.
                    if (before !== after)
                        edits.push({ path: relativePath, beforeHash: fileContentHash(before), after });
                }
            }
        };
        if (existsSync(paths.workspaceBaseline))
            visit(paths.workspaceBaseline);
        if (edits.length === 0)
            throw new Error('compiled loop submission requires at least one captured agent-loop source edit');
        if (edits.length > 4)
            throw new Error('compiled loop submission exceeds the four-file edit limit');
        const candidateId = `builder-${id.slice('builder-'.length)}`;
        return {
            capability: 'loop-evolution',
            payload: {
                id: candidateId,
                displayName: `Builder workspace candidate ${id}`,
                source: { kind: 'builder-generated', baseline: { uri: 'https://github.com/deepseek-ai/deepseek-harness.git', ref }, edits },
                packageName: '@deepseek-ai/dsh-agent-loop',
                packagePath: 'packages/core/agent-loop',
                entry: 'lib/index.js',
                config: {},
                expectedOutcome: expectedOutcome?.trim() || 'Builder-tested workspace change',
                capabilities: [],
            },
            rationale: rationale.trim(),
        };
    }
    /**
     * Compile a single host-materialized config target. The external runtime
     * edits only actor-config.json; target identity, action and frozen envelope
     * remain Kernel-owned and feed the existing patch-evolution verifier/gate.
     */
    compileConfigWorkspaceProposal(id, rationale, expectedOutcome) {
        if (!rationale.trim())
            throw new Error('compiled config submission requires a rationale');
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const target = readJson(paths.targetBefore) ?? {};
        const targetId = typeof target.targetId === 'string' ? target.targetId : '';
        if (!targetId)
            throw new Error('compiled config submission requires targetBefore.targetId');
        if (target.targetKind !== 'config')
            throw new Error('compiled config submission requires targetBefore.targetKind=config');
        const baseline = join(paths.workspaceBaseline, 'actor-config.json');
        const current = join(paths.workspace, 'actor-config.json');
        if (!existsSync(baseline) || !existsSync(current))
            throw new Error('compiled config submission requires captured actor-config.json');
        const before = readJson(baseline);
        const after = readJson(current);
        if (!before || !after || Array.isArray(before) || Array.isArray(after))
            throw new Error('compiled config submission requires object config snapshots');
        if (sha256(before) === sha256(after))
            throw new Error('compiled config submission requires a config change');
        const expectedTrajectory = target.expectedTrajectory;
        if (expectedTrajectory !== undefined && (typeof expectedTrajectory !== 'object' || expectedTrajectory === null || Array.isArray(expectedTrajectory))) {
            throw new Error('compiled config submission expectedTrajectory must be an object');
        }
        const candidateId = `builder-${id.slice('builder-'.length)}`;
        return {
            capability: 'patch-evolution',
            payload: {
                id: candidateId,
                action: 'update',
                targetId,
                targetKind: 'config',
                config: after,
                dependencies: [],
                rationale: rationale.trim(),
                expectedOutcome: expectedOutcome?.trim() || 'Builder-tested config update',
                ...(expectedTrajectory ? { expectedTrajectory } : {}),
                version: 1,
                createdAt: new Date().toISOString(),
            },
            rationale: rationale.trim(),
        };
    }
    /** Compile an insert bundle while keeping identity and allowed target kind
     * out of the external runtime's control. */
    compileModuleWorkspaceProposal(id, rationale, expectedOutcome) {
        if (!rationale.trim())
            throw new Error('compiled module submission requires a rationale');
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const target = readJson(paths.targetBefore) ?? {};
        const targetId = typeof target.targetId === 'string' ? target.targetId : '';
        const targetName = typeof target.targetName === 'string' ? target.targetName : undefined;
        const targetKind = target.targetKind;
        const entry = typeof target.moduleEntry === 'string' ? target.moduleEntry : '';
        if (!targetId || (targetKind !== 'tool' && targetKind !== 'skill') || !entry)
            throw new Error('compiled module submission requires tool/skill target metadata and moduleEntry');
        const root = join(paths.workspace, 'actor-module');
        if (!existsSync(root) || !statSync(root).isDirectory())
            throw new Error('compiled module submission requires actor-module directory');
        const files = [];
        const visit = (directory) => {
            for (const item of readdirSync(directory, { withFileTypes: true })) {
                const file = join(directory, item.name);
                if (item.isDirectory())
                    visit(file);
                else if (item.isFile()) {
                    const path = relative(root, file).split('\\').join('/');
                    const content = readFileSync(file, 'utf8');
                    if (!path || path.startsWith('../') || content.length === 0 || Buffer.byteLength(content, 'utf8') > 256 * 1024)
                        throw new Error(`compiled module file is invalid: ${path}`);
                    files.push({ path, content });
                }
            }
        };
        visit(root);
        files.sort((left, right) => left.path.localeCompare(right.path));
        if (files.length === 0 || files.length > 16 || !files.some((file) => file.path === entry))
            throw new Error('compiled module submission requires a bounded bundle containing its declared entry');
        if (targetKind === 'skill') {
            const skill = files.find((file) => file.path === entry);
            if (!skill || !isValidSkillEntry(skill.content, targetId)) {
                throw new Error(`compiled skill submission requires ${entry} YAML frontmatter with name: ${targetId} and a non-empty description`);
            }
        }
        const expectedTrajectory = target.expectedTrajectory;
        if (expectedTrajectory !== undefined && (typeof expectedTrajectory !== 'object' || expectedTrajectory === null || Array.isArray(expectedTrajectory))) {
            throw new Error('compiled module submission expectedTrajectory must be an object');
        }
        const candidateId = `builder-${id.slice('builder-'.length)}`;
        return {
            capability: 'patch-evolution',
            payload: {
                id: candidateId,
                action: 'insert',
                targetId,
                ...(targetName ? { targetName } : {}),
                targetKind,
                config: {},
                module: { files, entry },
                dependencies: [],
                rationale: rationale.trim(),
                expectedOutcome: expectedOutcome?.trim() || 'Builder-tested module insert',
                ...(expectedTrajectory ? { expectedTrajectory } : {}),
                version: 1,
                createdAt: new Date().toISOString(),
            },
            rationale: rationale.trim(),
        };
    }
    /** Create a hash-bound, read-only reference for a fresh immutable attempt. */
    previousRunReference(id) {
        const paths = builderRunPaths(this.root, this.sessionId, id);
        const assets = [
            ['actor', paths.actor],
            ['messages', paths.messages],
            ['targetBefore', paths.targetBefore],
            ['previousAttempt', paths.previousAttempt],
            ['progressState', paths.progressState],
            ['worldModel', paths.worldModel],
            ['plan', paths.plan],
            ['journal', paths.journal],
            ['promptVisible', paths.promptVisible],
            ['events', paths.events],
            ['snapshots', paths.snapshots],
            ['proposal', paths.proposal],
            ['submissionDraft', paths.submissionDraft],
        ].map(([name, path]) => {
            const exists = existsSync(path);
            return {
                name,
                path,
                exists,
                ...(exists ? { hash: sha256(readFileSync(path, 'utf8')) } : {}),
            };
        });
        return { runId: id, lineageId: this.load(id).lineageId, workspacePath: paths.workspace, assets, createdAt: new Date().toISOString() };
    }
    emit(id, kind, payload) {
        const events = builderRunPaths(this.root, this.sessionId, id).events;
        const run = this.load(id);
        const event = {
            schemaVersion: 1,
            seq: readJsonl(events).length + 1,
            at: new Date().toISOString(),
            kind,
            lineageId: run.lineageId,
            runId: id,
            payload: boundedJournalValue(payload),
        };
        appendJsonl(events, event);
        return event;
    }
    submissionDraft(id) {
        const paths = builderRunPaths(this.root, this.sessionId, id);
        return readJson(paths.submissionDraft)
            ?? readJson(join(paths.staging, 'candidate.json'));
    }
    workspacePath(workspace, requestedPath) {
        // The tool is already scoped to the run workspace; a model that says
        // "workspace/actor-loop.mjs" means the same file as "actor-loop.mjs".
        const normalized = requestedPath === 'workspace' || requestedPath.startsWith('workspace/')
            ? requestedPath.slice('workspace'.length).replace(/^\/+/, '')
            : requestedPath;
        const path = resolve(workspace, normalized);
        if (relative(workspace, path).startsWith('..')) {
            const mapped = this.mapPriorWorkspacePath(requestedPath, workspace);
            if (mapped)
                return mapped;
            throw new Error('workspace path escapes builder workspace');
        }
        return path;
    }
    /** Relative read paths are Builder-workspace paths; absolute paths retain the
     * Builder's global read capability.  This matches command cwd and prevents
     * a model's normal package-relative path from accidentally resolving to the
     * host process checkout. */
    readablePath(workspace, requestedPath) {
        const normalized = requestedPath === 'workspace' || requestedPath.startsWith('workspace/')
            ? requestedPath.slice('workspace'.length).replace(/^\/+/, '')
            : requestedPath;
        return isAbsolute(normalized) ? resolve(normalized) : resolve(workspace, normalized);
    }
    /**
     * A read/write addressed at a prior run's workspace (absolute path from a
     * rejection) means the same relative file in this run's workspace during a
     * repair. Prior assets stay read-only; only the current workspace is writable.
     */
    mapPriorWorkspacePath(requestedPath, workspace) {
        const resolved = resolve(requestedPath);
        const marker = '/builder-runs/';
        const workspaceMarker = '/workspace/';
        const markerIndex = resolved.indexOf(marker);
        if (markerIndex < 0)
            return null;
        const afterRun = resolved.slice(markerIndex + marker.length);
        const workspaceIndex = afterRun.indexOf(workspaceMarker);
        if (workspaceIndex < 0)
            return null;
        const relativePath = afterRun.slice(workspaceIndex + workspaceMarker.length);
        if (!relativePath || relativePath.split('/').includes('..'))
            return null;
        const mapped = resolve(workspace, relativePath);
        if (relative(workspace, mapped).startsWith('..'))
            return null;
        return mapped;
    }
}
/** A skill bundle has an explicit DSH-compatible identity before verifier boot. */
function isValidSkillEntry(content, targetId) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!frontmatter)
        return false;
    const fields = frontmatter[1];
    const name = /^name:\s*([^\r\n#]+?)\s*$/m.exec(fields)?.[1]?.replace(/^['"]|['"]$/g, '');
    const description = /^description:\s*(\S[\s\S]*?)\s*$/m.exec(fields)?.[1];
    return name === targetId && Boolean(description);
}
function readTarget(result) {
    if (!result)
        return undefined;
    if (typeof result.path === 'string')
        return result.path;
    if (typeof result.document === 'string')
        return result.document;
    if (result.entries !== undefined)
        return 'journal';
    return undefined;
}
function initialProgressState(record, input) {
    const actorObjective = typeof input.actor.objective === 'string'
        ? input.actor.objective
        : typeof input.actor.requirements === 'string'
            ? input.actor.requirements
            : undefined;
    return {
        schemaVersion: 1,
        version: 0,
        state: record.state,
        phase: record.phase,
        ...(actorObjective?.trim() ? { objective: actorObjective.slice(0, 2_000) } : {}),
        known: [],
        unknowns: [],
        nextIntent: 'read the smallest relevant evidence, then state a falsifiable hypothesis',
        lastAction: 'create',
        unchangedReadStreak: 0,
        progressRequirement: 'none',
        pendingMessageIds: [],
        updatedAt: record.updatedAt,
    };
}
function normalizeProgressState(value, record) {
    return {
        schemaVersion: 1,
        version: Number.isFinite(value.version) ? Math.max(0, Math.floor(value.version)) : 0,
        state: value.state ?? record.state,
        phase: value.phase ?? record.phase,
        ...(typeof value.objective === 'string' && value.objective.trim() ? { objective: value.objective.slice(0, 2_000) } : {}),
        ...(typeof value.hypothesis === 'string' && value.hypothesis.trim() ? { hypothesis: value.hypothesis.slice(0, 2_000) } : {}),
        known: normalizeStringList(value.known),
        unknowns: normalizeStringList(value.unknowns),
        ...(typeof value.nextIntent === 'string' && value.nextIntent.trim() ? { nextIntent: value.nextIntent.slice(0, 2_000) } : {}),
        ...(typeof value.lastAction === 'string' ? { lastAction: value.lastAction.slice(0, 200) } : {}),
        ...(typeof value.lastObservationHash === 'string' ? { lastObservationHash: value.lastObservationHash } : {}),
        unchangedReadStreak: Number.isFinite(value.unchangedReadStreak) ? Math.max(0, Math.floor(value.unchangedReadStreak)) : 0,
        progressRequirement: isProgressRequirement(value.progressRequirement) ? value.progressRequirement : 'none',
        pendingMessageIds: normalizeStringList(value.pendingMessageIds),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : record.updatedAt,
    };
}
function normalizeStringList(value) {
    return Array.isArray(value)
        ? [...new Set(value.filter((item) => typeof item === 'string' && Boolean(item.trim())).map(item => item.slice(0, 2_000)))].slice(0, 64)
        : [];
}
function isProgressRequirement(value) {
    return value === 'none' || value === 'declare_direction' || value === 'produce_evidence' || value === 'write_submission';
}
function progressRequirementIntent(requirement) {
    return requirement === 'write_submission'
        ? 'write_submission with the concrete verified candidate proposal; submit only after the draft exists'
        : requirement === 'declare_direction'
            ? 'write a falsifiable hypothesis/world model or plan before reading again'
            : 'produce fresh evidence with simulation, a workspace command/edit, a question, submission, or abort';
}
/**
 * Keep the checkpoint intentionally small. It does not prescribe the
 * Builder's implementation; it only requires a public direction or a fresh
 * observation once the same evidence has already been returned.
 */
function satisfiesProgressRequirement(requirement, action) {
    if (requirement === 'none')
        return true;
    if (requirement === 'declare_direction') {
        return action === 'write_world_model'
            || action === 'write_plan'
            || action === 'request_input'
            || action === 'write_submission';
    }
    if (requirement === 'produce_evidence') {
        return action === 'invoke_capability'
            || action === 'run_workspace_command'
            || action === 'write_workspace_file'
            || action === 'request_input'
            || action === 'write_submission';
    }
    if (requirement === 'write_submission')
        return action === 'write_submission';
    return action === 'invoke_capability'
        || action === 'run_workspace_command'
        || action === 'write_workspace_file'
        || action === 'request_input'
        || action === 'write_submission';
}
function progressCheckpointValidation(action) {
    if (action.name === 'write_world_model') {
        if (typeof action.value.hypothesis !== 'string' || !action.value.hypothesis.trim())
            return 'world_model.hypothesis is required';
        if (typeof action.value.nextIntent !== 'string' || !action.value.nextIntent.trim())
            return 'world_model.nextIntent is required';
    }
    if (action.name === 'write_plan') {
        const hasIntent = typeof action.value.nextIntent === 'string' && Boolean(action.value.nextIntent.trim());
        const hasSteps = Array.isArray(action.value.steps) && action.value.steps.length > 0;
        if (!hasIntent && !hasSteps)
            return 'plan.nextIntent or a non-empty plan.steps is required';
    }
    return undefined;
}
function extractWorldModelProgress(value, prior) {
    const hypothesis = typeof value.hypothesis === 'string' ? value.hypothesis : prior.hypothesis;
    const known = Array.isArray(value.known) ? normalizeStringList(value.known) : Array.isArray(value.facts) ? normalizeStringList(value.facts) : prior.known;
    const unknowns = Array.isArray(value.unknowns) ? normalizeStringList(value.unknowns) : prior.unknowns;
    return {
        ...(hypothesis ? { hypothesis: hypothesis.slice(0, 2_000) } : {}),
        known,
        unknowns,
        nextIntent: typeof value.nextIntent === 'string' ? value.nextIntent.slice(0, 2_000) : prior.nextIntent,
    };
}
function extractPlanProgress(value, prior) {
    const objective = typeof value.objective === 'string' ? value.objective : prior.objective;
    const nextIntent = typeof value.nextIntent === 'string'
        ? value.nextIntent
        : Array.isArray(value.steps) && value.steps.length > 0
            ? JSON.stringify(value.steps[0]).slice(0, 2_000)
            : prior.nextIntent;
    return {
        ...(objective ? { objective: objective.slice(0, 2_000) } : {}),
        ...(nextIntent ? { nextIntent: nextIntent.slice(0, 2_000) } : {}),
    };
}
function stripReadObservation(value) {
    const copy = { ...value };
    delete copy.observation;
    return copy;
}
/** Keep feedback durable without allowing a tool to recursively journal itself. */
function boundedJournalValue(value) {
    const encoded = JSON.stringify(value);
    if (encoded.length <= 16_000)
        return value;
    return {
        truncated: true,
        originalBytes: Buffer.byteLength(encoded, 'utf8'),
        originalHash: sha256(value),
        preview: encoded.slice(0, 15_000),
    };
}
/** Keep prompt evidence useful without copying obvious credentials into it. */
function redactPrompt(prompt) {
    return prompt
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
        .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)([^\s,;"']+)/gi, '$1[REDACTED_SECRET]');
}
function freezePathRefs(paths) {
    return [...new Set(paths)].map((path) => {
        const exists = existsSync(path) && statSync(path).isFile();
        return { path, exists, ...(exists ? { hash: sha256(readFileSync(path, 'utf8')) } : {}) };
    });
}
/** A submitted handoff cannot silently point at content changed after freeze. */
function pathRefsStillBind(refs) {
    return refs.every((ref) => {
        const exists = existsSync(ref.path) && statSync(ref.path).isFile();
        if (exists !== ref.exists)
            return false;
        return !exists || (typeof ref.hash === 'string' && sha256(readFileSync(ref.path, 'utf8')) === ref.hash);
    });
}
function isTerminalState(state) {
    return state === 'submitted' || state === 'aborted' || state === 'cancelled';
}
function isReadAction(action) {
    return action === 'read_file' || action === 'read_input' || action === 'read_journal' || action === 'list_directory' || action === 'read_workspace_file';
}
function phaseForState(state, prior) {
    if (state === 'created')
        return 'observing';
    if (state === 'submitted')
        return 'submitted';
    if (state === 'aborted' || state === 'cancelled')
        return 'aborted';
    if (state === 'ready_to_submit' || state === 'preflighting')
        return 'ready_to_submit';
    if (state === 'waiting_for_input')
        return prior === 'waiting_for_verification' ? prior : 'waiting_for_actor';
    if (state === 'exploring')
        return prior === 'observing' ? 'exploring' : (prior ?? 'exploring');
    return prior ?? 'exploring';
}
/**
 * Structured requests are the one place where the Kernel rejects an
 * underspecified transition. Normal exploration remains unconstrained.
 */
function validateInputRequest(action) {
    if (!action.question.trim())
        throw new Error('request_input requires a non-empty question');
    if (action.kind === 'choice') {
        if (!action.options || action.options.length < 2) {
            throw new Error('choice request requires at least two options');
        }
        if (!action.whyNow?.trim())
            throw new Error('choice request requires whyNow');
        if (!action.evidenceRefs || action.evidenceRefs.length === 0) {
            throw new Error('choice request requires evidenceRefs');
        }
        const ids = action.options.map((option) => option.id.trim());
        if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
            throw new Error('choice request options require unique non-empty ids');
        }
    }
    if (action.kind === 'verification') {
        if (!action.whyNow?.trim())
            throw new Error('verification request requires whyNow');
        if (!action.evidenceRefs || action.evidenceRefs.length === 0) {
            throw new Error('verification request requires evidenceRefs');
        }
    }
}
function validateDiagnosisReport(report) {
    const directions = report.directions;
    if (!Array.isArray(directions) || directions.length < 1 || directions.length > 3) {
        throw new Error('diagnosis report requires 1-3 directions');
    }
    for (const direction of directions) {
        if (!direction || typeof direction !== 'object' || Array.isArray(direction))
            throw new Error('diagnosis direction must be an object');
        const value = direction;
        if (typeof value.id !== 'string' || !value.id.trim())
            throw new Error('diagnosis direction requires id');
        if (typeof value.goal !== 'string' || !value.goal.trim())
            throw new Error('diagnosis direction requires goal');
        if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.every((ref) => typeof ref === 'string')) {
            throw new Error('diagnosis direction requires evidenceRefs');
        }
        if (!Array.isArray(value.unknowns) || !value.unknowns.every((item) => typeof item === 'string')) {
            throw new Error('diagnosis direction requires unknowns');
        }
    }
    const question = report.question;
    if (!question || typeof question !== 'object' || Array.isArray(question))
        throw new Error('diagnosis report requires a blocking question');
    const questionValue = question;
    if (typeof questionValue.question !== 'string' || !questionValue.question.trim())
        throw new Error('diagnosis question requires question');
    if (!Array.isArray(questionValue.options) || questionValue.options.length < 2)
        throw new Error('diagnosis question requires at least two options');
    if (!questionValue.options.every((option) => option && typeof option === 'object' && !Array.isArray(option)
        && typeof option.id === 'string'
        && typeof option.label === 'string')) {
        throw new Error('diagnosis question options require id and label');
    }
    if (typeof questionValue.whyNow !== 'string' || !questionValue.whyNow.trim())
        throw new Error('diagnosis question requires whyNow');
    if (!Array.isArray(questionValue.evidenceRefs) || !questionValue.evidenceRefs.every((ref) => typeof ref === 'string')) {
        throw new Error('diagnosis question requires evidenceRefs');
    }
}
function buildContextIndex(paths, input, runId) {
    const entries = [
        { id: 'actor', path: paths.actor, summary: `Immutable actor handoff snapshot (keys: ${Object.keys(input.actor).slice(0, 20).join(', ') || 'none'}). Read with read_input(actor).` },
        { id: 'target_before', path: paths.targetBefore, summary: 'Immutable target/baseline snapshot captured at run creation. Read with read_input(target_before).' },
        { id: 'actor_messages', path: paths.messages, summary: 'Durable Actor/user inbox preserving original wording, memo, and evidence references.' },
        { id: 'journal', path: paths.journal, summary: 'Append-only tool/model feedback journal; read the tail with read_journal.' },
        { id: 'progress_state', path: paths.progressState, summary: 'Compact public working state: objective, hypothesis, known/unknowns, nextIntent and progress signals.' },
        { id: 'world_model', path: paths.worldModel, summary: 'Builder-declared facts and hypothesis artifact.' },
        { id: 'plan', path: paths.plan, summary: 'Builder-declared experiment plan artifact.' },
        { id: 'previous_attempt', path: paths.previousAttempt, summary: 'Verifier/gate rejection or host restart report, when present.' },
        { id: 'previous_run', path: paths.previousRun, summary: 'Read-only hash-bound assets from the prior immutable run, when present.' },
        { id: 'events', path: paths.events, summary: 'Actor-facing lifecycle/tool summary events.' },
        { id: 'provenance', path: paths.provenance, summary: 'Factual artifact graph: producer, consumer, test and report relations. Read with read_input(provenance) or trace_artifact; it contains no repair answer.' },
        { id: 'workspace', path: paths.workspace, summary: 'Persistent Builder-owned workspace for edits, fixtures, commands and candidate experiments.' },
        { id: 'submission', path: paths.submissionDraft, summary: 'Frozen proposal draft; only verifier/gate can approve or install it.' },
    ];
    return { schemaVersion: 1, runId, path: paths.contextIndex, generatedAt: new Date().toISOString(), instructions: 'This index is an address map, not a replacement for source evidence. Read only the entries needed for the next action.', entries };
}
/** Report only ordinary git diff targets; git apply remains the authority that
 * rejects unsafe paths and malformed hunks before any workspace mutation. */
function unifiedPatchFiles(patch) {
    return [...new Set(patch.split('\n')
            .filter(line => line.startsWith('+++ b/'))
            .map(line => line.slice('+++ b/'.length)))];
}
/**
 * Count only consecutive repetitions whose tool feedback is byte-for-byte
 * unchanged. A repeated read/build is legitimate when the workspace changed;
 * the guard is for a model spinning on the same action and same observation.
 */
function repeatedToolWithoutProgress(journal, actionHash) {
    const decisions = journal.filter((entry) => entry.kind === 'model' && entry.action === 'decision');
    if (decisions.length < 2)
        return 0;
    let count = 0;
    let feedbackHash;
    for (let index = decisions.length - 2; index >= 0; index--) {
        const decision = decisions[index];
        if (decision.result?.actionHash !== actionHash)
            break;
        const nextDecisionSeq = decisions[index + 1]?.seq ?? Number.POSITIVE_INFINITY;
        const feedback = journal.find((entry) => entry.seq > decision.seq && entry.seq < nextDecisionSeq && (entry.kind === 'tool' || entry.kind === 'error'));
        const currentHash = sha256(feedback ? { result: feedback.result ? stripReadObservation(feedback.result) : null, error: feedback.error ?? null } : null);
        if (feedbackHash === undefined)
            feedbackHash = currentHash;
        if (currentHash !== feedbackHash)
            break;
        count++;
    }
    return count;
}
