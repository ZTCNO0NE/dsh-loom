import { paths, PROTOCOL_VERSION, readJsonl } from '../protocol/index.js';
export function buildRuntimeDigest(options) {
    const now = options.now ?? Date.now();
    const actorModel = options.currentConfig['agent-default-model']?.config?.model;
    const telemetry = options.observer.collectTelemetry(typeof actorModel === 'string' ? actorModel : undefined);
    const frames = readJsonl(paths.frames(options.root, options.sessionId));
    const lastTs = frames.length > 0 ? Date.parse(frames[frames.length - 1]?.ts ?? '') : NaN;
    const lastFrameAt = Number.isFinite(lastTs) ? lastTs : options.observer.lastFrameTime() ?? null;
    const turnStartAt = options.observer.currentTurnStart();
    return {
        schemaVersion: PROTOCOL_VERSION,
        at: new Date(now).toISOString(),
        model: telemetry.model,
        turns: telemetry.turns,
        avgTurnMs: telemetry.avgTurnMs,
        maxTurnMs: telemetry.maxTurnMs,
        lastFrameAgeMs: lastFrameAt === null ? null : now - lastFrameAt,
        turnAgeMs: turnStartAt === null ? null : now - turnStartAt,
        toolCalls: telemetry.toolCalls,
        toolErrors: telemetry.toolErrors,
        toolErrorRate: telemetry.toolErrorRate,
        topTools: telemetry.perTool.slice(0, 5),
        stall: {
            noFrameSeconds: lastFrameAt === null ? 0 : Math.round((now - lastFrameAt) / 1000),
            turnOlderThanSeconds: turnStartAt === null ? 0 : Math.round((now - turnStartAt) / 1000),
            repeatedTextCount: options.observer.repeatedTextCount(),
            noToolProgress: false,
        },
        signals: options.signals.map((signal) => ({ kind: signal.kind, evidence: signal.evidence })),
        epoch: options.state.epoch,
        iterationsThisEpoch: options.state.iterationsThisEpoch,
        lastApplyTurn: options.state.lastApplyTurn,
    };
}
