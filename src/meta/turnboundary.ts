import type { Context } from '@deepseek-ai/cordis'
import type { Observer } from '../observer/index.js'
import type { SignalThresholds } from '../types.js'
import { appendJsonl, paths } from '../protocol/index.js'

export interface TurnBoundaryDeps {
  observer: Observer
  thresholds: SignalThresholds
  onTrigger: (turn: number) => Promise<void>
  /** Active pause: abort a turn that exceeds time/step limits so the invoker can run. */
  stallAbort?: {
    enabled: boolean
    maxTurnSeconds: number
    maxStepsPerTurn: number
    checkIntervalMs: number
  }
  /** True while the refine loop is running (skip stall abort during our own work). */
  refineRunning?: () => boolean
  root: string
  sessionId: string
}

/**
 * M3.6: hooks the host hard trigger onto dsh's real turn boundary.
 *
 * - `agent/turn-stopping` (serial, turn about to close): cheap deterministic
 *   hard-trigger check; if fired, mark pending. Never blocks the boundary.
 * - `agent/status -> idle`: safe window (no driver active) to run the
 *   AutoPilot loop asynchronously, guarded by a busy flag.
 */
export class TurnBoundaryHook {
  private lastTurn = 0
  private pending = false
  private busy = false
  private timer: ReturnType<typeof setInterval> | null = null
  private lastAbortAt = 0

  constructor(
    private ctx: Context,
    private deps: TurnBoundaryDeps,
  ) {}

  attach(): void {
    const on = (this.ctx as unknown as {
      on?: (name: string, listener: (payload: unknown) => void) => unknown
    }).on
    if (!on) return

    on('agent/turn-stopping', (payload) => {
      const turn = (payload as { turn?: unknown } | null)?.turn
      if (typeof turn === 'number') this.lastTurn = turn
      const triggers = this.deps.observer.evaluateHardTriggers(this.deps.thresholds)
      if (triggers.length > 0 && !this.busy) this.pending = true
    })

    on('agent/status', (payload) => {
      const status = (payload as { status?: unknown } | null)?.status
      if (status === 'idle' && this.pending && !this.busy) {
        this.busy = true
        this.pending = false
        void this.deps.onTrigger(this.lastTurn).finally(() => {
          this.busy = false
        })
      }
    })

    const stallAbort = this.deps.stallAbort
    if (stallAbort?.enabled && stallAbort.checkIntervalMs > 0) {
      this.timer = setInterval(() => { void this.checkStall() }, stallAbort.checkIntervalMs)
    }
  }

  /** Public check for tests: abort the active turn when time/step limits are exceeded. */
  checkStall(): boolean {
    try {
      const stallAbort = this.deps.stallAbort
      if (!stallAbort?.enabled) return false
      if (this.deps.refineRunning?.()) return false
      const turnStart = this.deps.observer.currentTurnStart()
      const turnAgeSeconds = turnStart === null ? 0 : (Date.now() - turnStart) / 1000
      const steps = this.deps.observer.currentStepCount()
      const exceeded = turnStart !== null && (
        (stallAbort.maxTurnSeconds > 0 && turnAgeSeconds > stallAbort.maxTurnSeconds)
        || (stallAbort.maxStepsPerTurn > 0 && steps >= stallAbort.maxStepsPerTurn)
      )
      if (!exceeded) return false
      const now = Date.now()
      if (now - this.lastAbortAt < 30_000) return false
      this.lastAbortAt = now
      try {
        const agents = (this.ctx as unknown as {
          agents?: { list?: () => Array<{ cancel(cause: unknown, options?: unknown): void }> }
        }).agents
        for (const agent of agents?.list?.() ?? []) {
          agent.cancel({ kind: 'hook', reason: 'dsh-meta-validate:stall-abort' }, { keepInbox: true })
        }
      } catch {
        // Context may already be inactive; abort is best-effort.
      }
      const lastFrame = this.deps.observer.lastFrameTime()
      appendJsonl(paths.handoff(this.deps.root, this.deps.sessionId), {
        schemaVersion: 1,
        kind: 'stall-handoff',
        turnAgeSeconds: Math.round(turnAgeSeconds),
        steps,
        repeatedTextCount: this.deps.observer.repeatedTextCount(),
        lastFrameAgeMs: lastFrame === null ? null : Date.now() - lastFrame,
        at: new Date().toISOString(),
      })
      this.deps.observer.ingest({
        kind: 'agent-error',
        turn: this.lastTurn,
        step: 0,
        error: `stall-abort: turnAge=${Math.round(turnAgeSeconds)}s steps=${steps}`,
      })
      return true
    } catch {
      return false
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Direct injection point for tests and manual turn simulation. */
  simulateTurnEnd(turn: number): boolean {
    this.lastTurn = turn
    const triggers = this.deps.observer.evaluateHardTriggers(this.deps.thresholds)
    if (triggers.length > 0 && !this.busy) {
      this.pending = true
      return true
    }
    return false
  }

  /** Direct injection point for tests: pretend the agent became idle. */
  simulateIdle(): boolean {
    if (this.pending && !this.busy) {
      this.busy = true
      this.pending = false
      void this.deps.onTrigger(this.lastTurn).finally(() => {
        this.busy = false
      })
      return true
    }
    return false
  }

  get isBusy(): boolean {
    return this.busy
  }
}
