import type { Observer } from '../observer/index.js'
import type { AutopilotState, EvolutionSignal } from '../types.js'
import { paths, PROTOCOL_VERSION, readJsonl } from '../protocol/index.js'

/**
 * Compact actor-runtime digest for the one-shot supervision detector (route A):
 * key metrics only (model, latency, errors, stall signals) — NOT the full
 * frames. The builder receives full perception only after the detector says so.
 */
export interface StallIndicators {
  noFrameSeconds: number
  turnOlderThanSeconds: number
  repeatedTextCount: number
  noToolProgress: boolean
}

export interface RuntimeDigest {
  schemaVersion: number
  at: string
  model?: string
  turns: number
  avgTurnMs: number | null
  maxTurnMs: number | null
  lastFrameAgeMs: number | null
  turnAgeMs: number | null
  toolCalls: number
  toolErrors: number
  toolErrorRate: number | null
  topTools: Array<{ name: string; calls: number; errors: number; avgMs: number | null }>
  stall: StallIndicators
  signals: Array<{ kind: string; evidence: string[] }>
  epoch: number
  iterationsThisEpoch: number
  lastApplyTurn: number
}

export function buildRuntimeDigest(options: {
  observer: Observer
  root: string
  sessionId: string
  currentConfig: Record<string, unknown>
  signals: EvolutionSignal[]
  state: AutopilotState
  now?: number
}): RuntimeDigest {
  const now = options.now ?? Date.now()
  const actorModel = (options.currentConfig['agent-default-model'] as { config?: { model?: unknown } } | undefined)?.config?.model
  const telemetry = options.observer.collectTelemetry(typeof actorModel === 'string' ? actorModel : undefined)

  const frames = readJsonl<{ ts?: string }>(paths.frames(options.root, options.sessionId))
  const lastTs = frames.length > 0 ? Date.parse(frames[frames.length - 1]?.ts ?? '') : NaN
  const lastFrameAt = Number.isFinite(lastTs) ? lastTs : options.observer.lastFrameTime() ?? null
  const turnStartAt = options.observer.currentTurnStart()

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
  }
}
