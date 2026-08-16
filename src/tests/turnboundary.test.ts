import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Observer } from '../observer/index.js'
import { TurnBoundaryHook } from '../meta/turnboundary.js'
import { paths } from '../protocol/index.js'

function setup(
  onTrigger: (turn: number) => Promise<void> = async () => {},
  ctxExtra: Record<string, unknown> = {},
  refineRunning: () => boolean = () => false,
) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mv-boundary-'))
  const sessionId = 's1'
  const listeners = new Map<string, (payload: unknown) => void>()
  const ctx = {
    on: (name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener)
    },
    ...ctxExtra,
  } as never
  const observer = new Observer(null, { root, sessionId })
  const hook = new TurnBoundaryHook(ctx, {
    observer,
    thresholds: { repeatedFailureCount: 3, regressionFailureCount: 1 },
    onTrigger,
    root,
    sessionId,
    refineRunning,
    stallAbort: { enabled: true, maxTurnSeconds: 300, maxStepsPerTurn: 30, checkIntervalMs: 30000 },
  })
  return { root, sessionId, observer, hook, listeners }
}

describe('turn boundary hook (M3.6)', () => {
  it('attaches listeners to agent/turn-stopping and agent/status', () => {
    const { hook, listeners } = setup()
    hook.attach()
    expect(listeners.has('agent/turn-stopping')).toBe(true)
    expect(listeners.has('agent/status')).toBe(true)
  })

  it('runs the trigger only at idle after a fired hard trigger', async () => {
    let turns: number[] = []
    const { hook, observer } = setup(async (turn) => {
      turns.push(turn)
    })
    for (let i = 1; i <= 3; i++) {
      observer.ingest({ kind: 'tool-error', turn: i, step: 1, tool: 'bash', code: 'E1', evidence: 'boom' })
    }
    expect(hook.simulateTurnEnd(5)).toBe(true)
    expect(turns).toHaveLength(0)
    expect(hook.simulateIdle()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(turns).toEqual([5])
  })

  it('does not fire without a hard trigger', () => {
    const { hook } = setup()
    expect(hook.simulateTurnEnd(1)).toBe(false)
  })

  it('guards against reentrancy while the loop is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started = 0
    const { hook, observer } = setup(async () => {
      started++
      await gate
    })
    for (let i = 1; i <= 3; i++) {
      observer.ingest({ kind: 'tool-error', turn: i, step: 1, tool: 'bash', code: 'E1', evidence: 'boom' })
    }
    expect(hook.simulateTurnEnd(1)).toBe(true)
    expect(hook.simulateIdle()).toBe(true)
    expect(hook.isBusy).toBe(true)
    expect(hook.simulateIdle()).toBe(false)
    expect(hook.simulateTurnEnd(2)).toBe(false)
    release()
    await gate
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(started).toBe(1)
    expect(hook.isBusy).toBe(false)
  })

  it('aborts a stalled turn and writes a handoff (active pause)', () => {
    const cancelled: string[] = []
    const agent = { cancel: (cause: { reason?: string }) => { cancelled.push(String(cause.reason)) } }
    const { root, sessionId, observer, hook } = setup(async () => {}, {
      agents: { list: () => [agent] },
    })
    const now = Date.now()
    observer.recordFrame('turn/start', { turn: 1 }, now - 400_000)
    observer.recordFrame('step/start', { turn: 1, step: 1 }, now - 300_000)
    expect(hook.checkStall()).toBe(true)
    expect(cancelled).toEqual(['dsh-meta-validate:stall-abort'])
    expect(existsSync(paths.handoff(root, sessionId))).toBe(true)
  })

  it('skips stall abort while the refine loop is running', () => {
    const { observer, hook } = setup(async () => {}, {}, () => true)
    observer.recordFrame('turn/start', { turn: 1 }, Date.now() - 400_000)
    expect(hook.checkStall()).toBe(false)
  })
})
