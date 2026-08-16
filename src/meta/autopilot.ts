import type { AutopilotState, SignalThresholds } from '../types.js'
import type { ReviewDecision } from '../types.js'
import { atomicWriteJson, paths, PROTOCOL_VERSION, readJson } from '../protocol/index.js'
import type { Observer } from '../observer/index.js'
import type { ReviewGate } from './review.js'
import { buildRuntimeDigest, type RuntimeDigest } from './digest.js'
import type { IterationLoop, LoopResult } from './loop.js'
import type { ApplyOps } from '../gate/index.js'
import type { VerifierInput } from '../validate/index.js'

export interface AutoPilotDeps {
  gate: Pick<ReviewGate, 'decide'> & Partial<Pick<ReviewGate, 'decideOnDigest'>>
  loop: IterationLoop
  observer: Observer
  root: string
  sessionId: string
  thresholds: SignalThresholds
  minIntervalTurns: number
  maxIterationsPerEpoch: number
  /** Post-loop re-invocation rounds: after an apply, the supervisor is woken again. */
  postLoopMaxRounds?: number
}

export type AutoPilotOutcome =
  | { fired: false; reason: 'no_hard_trigger' | 'cooldown' | 'epoch_budget' | 'gate_declined'; decision?: ReviewDecision }
  | { fired: true; reason: 'gate_approved'; decision: ReviewDecision; result: LoopResult }

/**
 * Two-stage frequency control (08 §15):
 * stage 0 = free deterministic hard triggers; stage 1 = independent LLM review gate;
 * stage 2 = builder+verifier loop. Cooldown + per-epoch budget cap the frequency.
 */
export class AutoPilot {
  constructor(private deps: AutoPilotDeps) {}

  async step(
    turn: number,
    currentConfig: Record<string, unknown>,
    requirements?: string,
    verifierInput?: VerifierInput,
    applyOps?: ApplyOps,
  ): Promise<AutoPilotOutcome> {
    const { gate, loop, observer, root, sessionId, thresholds, minIntervalTurns, maxIterationsPerEpoch } = this.deps
    const triggers = observer.evaluateHardTriggers(thresholds)
    const signals0 = observer.collect(thresholds)
    const state = readJson<AutopilotState>(paths.autopilotState(root, sessionId))
      ?? { schemaVersion: PROTOCOL_VERSION, epoch: 0, iterationsThisEpoch: 0, lastIterationTurn: 0, lastApplyTurn: 0 }
    const digest: RuntimeDigest = buildRuntimeDigest({
      observer,
      root,
      sessionId,
      currentConfig,
      signals: signals0,
      state,
    })
    const stalled = digest.stall.noFrameSeconds > 60
      || digest.stall.turnOlderThanSeconds > 120
      || digest.stall.repeatedTextCount >= 3
      || digest.stall.noToolProgress
    if (triggers.length === 0 && !stalled) {
      return { fired: false, reason: 'no_hard_trigger' }
    }

    if (turn > 0 && state.lastIterationTurn > 0 && turn - state.lastIterationTurn < minIntervalTurns) {
      return { fired: false, reason: 'cooldown' }
    }
    if (state.iterationsThisEpoch >= maxIterationsPerEpoch) {
      return { fired: false, reason: 'epoch_budget' }
    }

    const signals = observer.collect(thresholds)
    const actorModel = (currentConfig['agent-default-model'] as { config?: { model?: unknown } } | undefined)?.config?.model
    observer.collectTelemetry(typeof actorModel === 'string' ? actorModel : undefined)
    let decision: ReviewDecision
    try {
      decision = gate.decideOnDigest
        ? await gate.decideOnDigest(digest)
        : await gate.decide(
            signals,
            `最近 ${Math.min(signals.length, 5)} 条信号；硬触发规则：${triggers.map((trigger) => trigger.rule).join(', ')}`,
            `epoch=${state.epoch} iterationsThisEpoch=${state.iterationsThisEpoch} lastApplyTurn=${state.lastApplyTurn}`,
            triggers.flatMap((trigger) => trigger.evidenceRefs),
          )
    } catch (error) {
      // Supervisor is advisory: if it cannot decide, bias to invoking the
      // builder (the verifier still guards quality downstream).
      decision = {
        schemaVersion: PROTOCOL_VERSION,
        shouldRefine: true,
        rationale: `supervisor unavailable, bias to fire: ${String(error)}`,
        evidenceRefs: [],
        createdAt: new Date().toISOString(),
      }
    }
    // User messages alone go through the supervisor (filtered); runtime
    // malfunction evidence (failures/regression/stall) forces the wake.
    // Explicit requirements (meta.auto with text / meta.iterate) are S9:
    // the user asked directly, so the supervisor cannot veto.
    const forcedEvidence = stalled || Boolean(requirements) || triggers.some((trigger) => trigger.rule !== 'user_correction')
    const hasEvidence = triggers.length > 0 || stalled
    if (!decision.shouldRefine && forcedEvidence) {
      // Bias: deterministic evidence always wakes the builder; the one-shot
      // supervisor can only veto in ambiguous cases.
      decision = { ...decision, shouldRefine: true, rationale: `${decision.rationale}；确定性证据存在，强制唤起 builder` }
    }
    if (!decision.shouldRefine) {
      return { fired: false, reason: 'gate_declined', decision }
    }

    let result = await loop.run(signals, currentConfig, requirements, verifierInput, applyOps)
    const postRounds = this.deps.postLoopMaxRounds ?? 0
    for (let round = 1; round <= postRounds && result.applied?.applied; round++) {
      const nextState: AutopilotState = {
        ...state,
        iterationsThisEpoch: state.iterationsThisEpoch + round,
      }
      const nextDigest = buildRuntimeDigest({
        observer,
        root,
        sessionId,
        currentConfig,
        signals: observer.collect(thresholds),
        state: nextState,
      })
      const nextDecision = gate.decideOnDigest
        ? await gate.decideOnDigest(nextDigest)
        : decision
      if (!nextDecision.shouldRefine) break
      result = await loop.run(observer.collect(thresholds), currentConfig, requirements, verifierInput, applyOps)
    }
    const next: AutopilotState = {
      ...state,
      iterationsThisEpoch: state.iterationsThisEpoch + 1,
      lastIterationTurn: turn,
    }
    if (result.applied?.applied) {
      next.epoch += 1
      next.iterationsThisEpoch = 0
      next.lastApplyTurn = turn
    }
    atomicWriteJson(paths.autopilotState(root, sessionId), next)
    return { fired: true, reason: 'gate_approved', decision, result }
  }
}
