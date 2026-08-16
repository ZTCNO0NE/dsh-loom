import { atomicWriteJson, paths, PROTOCOL_VERSION, readJson } from '../protocol/index.js';
import { buildRuntimeDigest } from './digest.js';
/**
 * Two-stage frequency control (08 §15):
 * stage 0 = free deterministic hard triggers; stage 1 = independent LLM review gate;
 * stage 2 = builder+verifier loop. Cooldown + per-epoch budget cap the frequency.
 */
export class AutoPilot {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async step(turn, currentConfig, requirements, verifierInput, applyOps) {
        const { gate, loop, observer, root, sessionId, thresholds, minIntervalTurns, maxIterationsPerEpoch } = this.deps;
        const triggers = observer.evaluateHardTriggers(thresholds);
        const signals0 = observer.collect(thresholds);
        const state = readJson(paths.autopilotState(root, sessionId))
            ?? { schemaVersion: PROTOCOL_VERSION, epoch: 0, iterationsThisEpoch: 0, lastIterationTurn: 0, lastApplyTurn: 0 };
        const digest = buildRuntimeDigest({
            observer,
            root,
            sessionId,
            currentConfig,
            signals: signals0,
            state,
        });
        const stalled = digest.stall.noFrameSeconds > 60
            || digest.stall.turnOlderThanSeconds > 120
            || digest.stall.repeatedTextCount >= 3
            || digest.stall.noToolProgress;
        if (triggers.length === 0 && !stalled) {
            return { fired: false, reason: 'no_hard_trigger' };
        }
        if (turn > 0 && state.lastIterationTurn > 0 && turn - state.lastIterationTurn < minIntervalTurns) {
            return { fired: false, reason: 'cooldown' };
        }
        if (state.iterationsThisEpoch >= maxIterationsPerEpoch) {
            return { fired: false, reason: 'epoch_budget' };
        }
        const signals = observer.collect(thresholds);
        const actorModel = currentConfig['agent-default-model']?.config?.model;
        observer.collectTelemetry(typeof actorModel === 'string' ? actorModel : undefined);
        let decision = gate.decideOnDigest
            ? await gate.decideOnDigest(digest)
            : await gate.decide(signals, `最近 ${Math.min(signals.length, 5)} 条信号；硬触发规则：${triggers.map((trigger) => trigger.rule).join(', ')}`, `epoch=${state.epoch} iterationsThisEpoch=${state.iterationsThisEpoch} lastApplyTurn=${state.lastApplyTurn}`, triggers.flatMap((trigger) => trigger.evidenceRefs));
        // User messages alone go through the supervisor (filtered); runtime
        // malfunction evidence (failures/regression/stall) forces the wake.
        // Explicit requirements (meta.auto with text / meta.iterate) are S9:
        // the user asked directly, so the supervisor cannot veto.
        const forcedEvidence = stalled || Boolean(requirements) || triggers.some((trigger) => trigger.rule !== 'user_correction');
        const hasEvidence = triggers.length > 0 || stalled;
        if (!decision.shouldRefine && forcedEvidence) {
            // Bias: deterministic evidence always wakes the builder; the one-shot
            // supervisor can only veto in ambiguous cases.
            decision = { ...decision, shouldRefine: true, rationale: `${decision.rationale}；确定性证据存在，强制唤起 builder` };
        }
        if (!decision.shouldRefine) {
            return { fired: false, reason: 'gate_declined', decision };
        }
        let result = await loop.run(signals, currentConfig, requirements, verifierInput, applyOps);
        const postRounds = this.deps.postLoopMaxRounds ?? 0;
        for (let round = 1; round <= postRounds && result.applied?.applied; round++) {
            const nextState = {
                ...state,
                iterationsThisEpoch: state.iterationsThisEpoch + round,
            };
            const nextDigest = buildRuntimeDigest({
                observer,
                root,
                sessionId,
                currentConfig,
                signals: observer.collect(thresholds),
                state: nextState,
            });
            const nextDecision = gate.decideOnDigest
                ? await gate.decideOnDigest(nextDigest)
                : decision;
            if (!nextDecision.shouldRefine)
                break;
            result = await loop.run(observer.collect(thresholds), currentConfig, requirements, verifierInput, applyOps);
        }
        const next = {
            ...state,
            iterationsThisEpoch: state.iterationsThisEpoch + 1,
            lastIterationTurn: turn,
        };
        if (result.applied?.applied) {
            next.epoch += 1;
            next.iterationsThisEpoch = 0;
            next.lastApplyTurn = turn;
        }
        atomicWriteJson(paths.autopilotState(root, sessionId), next);
        return { fired: true, reason: 'gate_approved', decision, result };
    }
}
