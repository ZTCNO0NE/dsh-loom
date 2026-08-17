import { appendJsonl, atomicWriteJson, ensureWorkspace, paths, PROTOCOL_VERSION } from '../protocol/index.js';
function preview(value, max = 600) {
    if (typeof value === 'string')
        return value.length > max ? `${value.slice(0, max)}…` : value;
    const text = JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
function userMessageText(data) {
    if (typeof data.text === 'string' && data.text.trim())
        return data.text;
    if (Array.isArray(data.content)) {
        const text = data.content
            .filter((block) => Boolean(block) && typeof block === 'object')
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n');
        if (text.trim())
            return text;
    }
    return undefined;
}
function signatureOf(event) {
    switch (event.kind) {
        case 'tool-error':
            return `${event.tool}:${event.code ?? 'unknown'}`;
        case 'agent-error':
            return `agent:${event.error.slice(0, 120)}`;
        default:
            return event.kind;
    }
}
export function mapAgentErrorEvent(payload) {
    if (!payload || typeof payload !== 'object')
        return null;
    const p = payload;
    return {
        kind: 'agent-error',
        turn: typeof p.turn === 'number' ? p.turn : 0,
        step: typeof p.step === 'number' ? p.step : 0,
        error: typeof p.error === 'string' ? p.error : String(p.error ?? 'unknown'),
    };
}
export function mapToolResultEvent(exec, result) {
    if (!result || typeof result !== 'object')
        return null;
    const r = result;
    if (r.isError !== true)
        return null;
    const e = exec;
    const code = r.error && typeof r.error.code === 'string' ? r.error.code : 'tool-error';
    const message = r.error && typeof r.error.message === 'string' ? r.error.message : 'tool call failed';
    return {
        kind: 'tool-error',
        turn: 0,
        step: 0,
        tool: typeof e.name === 'string' ? e.name : 'unknown',
        code,
        evidence: message,
    };
}
export class Observer {
    ctx;
    options;
    events = [];
    turnStarts = new Map();
    toolStarts = new Map();
    turns = [];
    tools = new Map();
    lastFrameAt = null;
    currentTurnStartAt = null;
    currentStep = 0;
    lastText = null;
    repeatedText = 0;
    constructor(ctx, options) {
        this.ctx = ctx;
        this.options = options;
        ensureWorkspace(options.root, options.sessionId);
    }
    /** Normalized entry point; dsh wiring and synthetic tests both use this. */
    ingest(event) {
        this.events.push(event);
        appendJsonl(paths.events(this.options.root, this.options.sessionId), {
            ...event,
            observedAt: new Date().toISOString(),
        });
    }
    /** Best-effort dsh event wiring: agent/error (emit) and tools/result (emit). */
    subscribe() {
        if (!this.ctx)
            return;
        const on = this.ctx.on;
        if (!on)
            return;
        on('agent/error', (payload) => {
            const event = mapAgentErrorEvent(payload);
            if (event)
                this.ingest(event);
        });
        on('tools/result', (exec, result) => {
            const event = mapToolResultEvent(exec, result);
            if (event)
                this.ingest(event);
        });
        on('session/event', (session, frame) => {
            const f = frame;
            if (!f || typeof f.time !== 'number' || typeof f.type !== 'string')
                return;
            const sessionId = String(session?.id ?? 'default');
            this.recordFrame(f.type, f.data ?? {}, f.time, sessionId);
            const source = (f.data ?? {}).source;
            const isPluginNotice = source?.kind === 'plugin';
            if (f.type === 'user/message' && this.options.autoIngestUserMessages !== false && !isPluginNotice) {
                const text = userMessageText(f.data ?? {});
                if (text)
                    this.ingest({ kind: 'user-message', turn: Number(f.data?.turn ?? 0), text });
            }
        }, { global: true });
    }
    /** Raw frame recorder for telemetry (turn/tool latency + errors). */
    recordFrame(type, data, time, sessionId = 'default') {
        this.processFrame(type, data, time, sessionId, true);
    }
    /** Rebuild in-memory telemetry from a persisted frame without appending it. */
    replayFrame(type, data, time, sessionId = 'default') {
        this.processFrame(type, data, time, sessionId, false);
    }
    processFrame(type, data, time, sessionId, persist) {
        this.lastFrameAt = time;
        if (type === 'turn/start') {
            this.currentTurnStartAt = time;
            this.currentStep = 0;
        }
        if (type === 'turn/end') {
            // A closed turn must not keep inflating turnAge for the next turn;
            // otherwise the stall supervisor aborts every subsequent turn.
            this.currentTurnStartAt = null;
        }
        if (type === 'step/start')
            this.currentStep = Number(data.step ?? this.currentStep + 1);
        const frame = {
            schemaVersion: PROTOCOL_VERSION,
            ts: new Date(time).toISOString(),
            sessionId,
            type,
            data: {
                turn: data.turn,
                step: data.step,
                name: data.name,
                callId: data.callId,
                reason: data.reason === undefined ? undefined : preview(data.reason),
                error: data.error === undefined ? undefined : preview(data.error),
                args: data.arguments === undefined ? undefined : preview(data.arguments),
                result: data.value === undefined ? undefined : preview(data.value),
                text: data.text !== undefined ? preview(data.text) : data.content !== undefined ? preview(data.content) : undefined,
            },
        };
        if (persist)
            appendJsonl(paths.frames(this.options.root, this.options.sessionId), frame);
        if (type === 'assistant/message' && typeof frame.data.text === 'string') {
            if (frame.data.text === this.lastText)
                this.repeatedText += 1;
            else {
                this.lastText = frame.data.text;
                this.repeatedText = 1;
            }
        }
        if (type === 'turn/start') {
            this.turnStarts.set(`${sessionId}:${String(data.turn ?? 0)}`, time);
        }
        else if (type === 'turn/end') {
            const key = `${sessionId}:${String(data.turn ?? 0)}`;
            const start = this.turnStarts.get(key);
            if (start !== undefined) {
                this.turns.push({ turn: Number(data.turn ?? 0), durationMs: time - start, reason: String(data.reason ?? '') });
            }
        }
        else if (type === 'tool/call') {
            const callId = String(data.callId ?? `${data.turn ?? 0}:${data.step ?? 0}`);
            this.toolStarts.set(`${sessionId}:${callId}`, { name: String(data.name ?? 'unknown'), at: time });
        }
        else if (type === 'tool/result') {
            const callId = String(data.callId ?? `${data.turn ?? 0}:${data.step ?? 0}`);
            const start = this.toolStarts.get(`${sessionId}:${callId}`);
            const name = String(data.name ?? start?.name ?? 'unknown');
            const sample = this.tools.get(name) ?? { name, calls: 0, errors: 0, totalMs: 0 };
            sample.calls += 1;
            if (start)
                sample.totalMs += time - start.at;
            const isError = Boolean(data.error);
            if (isError)
                sample.errors += 1;
            this.tools.set(name, sample);
        }
    }
    /** Aggregated actor telemetry (08 §12 I13 extension): latency, errors, calls. */
    collectTelemetry(model) {
        const turnMs = this.turns.map((sample) => sample.durationMs);
        const avgTurnMs = turnMs.length > 0 ? turnMs.reduce((a, b) => a + b, 0) / turnMs.length : null;
        const perTool = [...this.tools.values()]
            .map((sample) => ({
            name: sample.name,
            calls: sample.calls,
            errors: sample.errors,
            avgMs: sample.calls > 0 ? sample.totalMs / sample.calls : null,
        }))
            .sort((a, b) => b.calls - a.calls);
        const toolCalls = perTool.reduce((sum, item) => sum + item.calls, 0);
        const toolErrors = perTool.reduce((sum, item) => sum + item.errors, 0);
        const profile = {
            schemaVersion: PROTOCOL_VERSION,
            model,
            turns: this.turns.length,
            avgTurnMs,
            maxTurnMs: turnMs.length > 0 ? Math.max(...turnMs) : null,
            toolCalls,
            toolErrors,
            toolErrorRate: toolCalls > 0 ? toolErrors / toolCalls : null,
            perTool,
            at: new Date().toISOString(),
        };
        atomicWriteJson(paths.actorProfile(this.options.root, this.options.sessionId), profile);
        return profile;
    }
    lastFrameTime() {
        return this.lastFrameAt;
    }
    currentTurnStart() {
        return this.currentTurnStartAt;
    }
    currentStepCount() {
        return this.currentStep;
    }
    repeatedTextCount() {
        return this.repeatedText;
    }
    static mapAgentError(payload) {
        return mapAgentErrorEvent(payload);
    }
    static mapToolResult(exec, result) {
        return mapToolResultEvent(exec, result);
    }
    /** Threshold filtering; repeated failures are grouped per signature. */
    collect(thresholds) {
        const ready = [];
        const failures = new Map();
        const corrections = [];
        const regressions = [];
        for (const event of this.events) {
            if (event.kind === 'tool-error' || event.kind === 'agent-error') {
                const key = signatureOf(event);
                const list = failures.get(key) ?? [];
                list.push({
                    kind: 'repeated_failure',
                    evidence: [event.kind === 'tool-error' ? event.evidence : event.error],
                    actorTurnIds: [`${event.turn}`],
                    severity: 1,
                });
                failures.set(key, list);
            }
            else if (event.kind === 'user-message') {
                corrections.push({
                    kind: 'user_correction',
                    evidence: [event.text],
                    actorTurnIds: [`${event.turn}`],
                    severity: 2,
                });
            }
            else if (event.kind === 'regression-fail') {
                regressions.push({
                    kind: 'regression_failure',
                    evidence: [`case ${event.caseId}: ${event.detail}`],
                    actorTurnIds: [],
                    severity: 3,
                });
            }
        }
        for (const [, list] of failures) {
            if (list.length >= thresholds.repeatedFailureCount) {
                ready.push({
                    ...list[list.length - 1],
                    evidence: list.flatMap((signal) => signal.evidence),
                    actorTurnIds: [...new Set(list.flatMap((signal) => signal.actorTurnIds))],
                });
            }
        }
        if (corrections.length > 0) {
            ready.push({
                ...corrections[corrections.length - 1],
                evidence: corrections.map((signal) => signal.evidence[0]),
            });
        }
        if (regressions.length >= thresholds.regressionFailureCount) {
            ready.push(...regressions);
        }
        return ready;
    }
    /**
     * M3 host hard trigger (L2): deterministic rules evaluated at turn boundaries.
     * No model judgment is involved; the actor cannot suppress these.
     */
    evaluateHardTriggers(thresholds) {
        const triggers = [];
        const ready = this.collect(thresholds);
        for (const signal of ready) {
            if (signal.kind === 'repeated_failure') {
                triggers.push({ kind: 'host_rule', rule: `repeated_failure >= ${thresholds.repeatedFailureCount}`, evidenceRefs: signal.actorTurnIds });
            }
            else if (signal.kind === 'user_correction') {
                triggers.push({ kind: 'host_rule', rule: 'user_correction', evidenceRefs: signal.actorTurnIds });
            }
            else if (signal.kind === 'regression_failure') {
                triggers.push({ kind: 'host_rule', rule: 'regression_failure', evidenceRefs: signal.evidence });
            }
        }
        const errorTurns = this.events.filter((event) => event.kind === 'turn-end' && event.reason === 'error').length;
        if (errorTurns >= 2) {
            triggers.push({ kind: 'host_rule', rule: 'turn_end_error', evidenceRefs: [`errorTurns=${errorTurns}`] });
        }
        for (const trigger of triggers) {
            this.persistTrigger(trigger.kind, trigger.rule, trigger.evidenceRefs);
        }
        return triggers;
    }
    persistRequirements(text, goalRefs = [], feedbackRefs = []) {
        const doc = {
            schemaVersion: PROTOCOL_VERSION,
            sessionId: this.options.sessionId,
            text,
            goalRefs,
            feedbackRefs,
            createdAt: new Date().toISOString(),
        };
        atomicWriteJson(paths.requirements(this.options.root, this.options.sessionId), doc);
    }
    persistTrigger(kind, rule, evidenceRefs = []) {
        const record = {
            schemaVersion: PROTOCOL_VERSION,
            sessionId: this.options.sessionId,
            kind,
            rule,
            evidenceRefs,
            createdAt: new Date().toISOString(),
        };
        appendJsonl(paths.triggers(this.options.root, this.options.sessionId), record);
    }
    persistSignals() {
        for (const event of this.events) {
            appendJsonl(paths.signals(this.options.root, this.options.sessionId), {
                ...event,
                persistedAt: new Date().toISOString(),
            });
        }
    }
    reset() {
        this.events = [];
    }
}
