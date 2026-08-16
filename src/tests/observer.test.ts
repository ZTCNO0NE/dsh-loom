import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Observer, type MetaEvent } from '../observer/index.js'
import { paths, readJsonl } from '../protocol/index.js'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mv-obs-'))
  const observer = new Observer(null, { root, sessionId: 's1' })
  return { root, observer }
}

describe('observer A1', () => {
  it('repeated failure reaches threshold only at count', () => {
    const { observer } = setup()
    const err: MetaEvent = { kind: 'tool-error', turn: 1, step: 1, tool: 'bash', code: 'E1', evidence: 'boom' }
    observer.ingest(err)
    observer.ingest({ ...err, turn: 2 })
    expect(observer.collect({ repeatedFailureCount: 3, regressionFailureCount: 1 })).toHaveLength(0)
    observer.ingest({ ...err, turn: 3 })
    const signals = observer.collect({ repeatedFailureCount: 3, regressionFailureCount: 1 })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.kind).toBe('repeated_failure')
    expect(signals[0]?.evidence).toHaveLength(3)
  })

  it('classifies user correction and regression failure', () => {
    const { observer } = setup()
    observer.ingest({ kind: 'user-message', turn: 1, text: '不对，按我给的格式来' })
    observer.ingest({ kind: 'regression-fail', caseId: 'c1', detail: 'snapshot mismatch' })
    const signals = observer.collect({ repeatedFailureCount: 3, regressionFailureCount: 1 })
    expect(signals.map((signal) => signal.kind).sort()).toEqual(['regression_failure', 'user_correction'])
  })

  it('persists events, requirements and triggers to files', () => {
    const { root, observer } = setup()
    observer.ingest({ kind: 'agent-error', turn: 1, step: 0, error: 'loop failed' })
    observer.persistRequirements('请把 bash 超时调大', ['goal:g1'])
    observer.persistTrigger('user', 'user request', ['sig:1'])
    observer.persistSignals()
    expect(existsSync(paths.events(root, 's1'))).toBe(true)
    expect(existsSync(paths.requirements(root, 's1'))).toBe(true)
    expect(readJsonl<{ kind: string }>(paths.triggers(root, 's1'))[0]?.kind).toBe('user')
    expect(readJsonl(paths.signals(root, 's1'))).toHaveLength(1)
  })

  it('evaluates deterministic hard triggers at turn boundaries', () => {
    const { root, observer } = setup()
    for (let i = 1; i <= 3; i++) {
      observer.ingest({ kind: 'tool-error', turn: i, step: 1, tool: 'bash', code: 'E1', evidence: 'boom' })
    }
    observer.ingest({ kind: 'turn-end', turn: 3, reason: 'error' })
    observer.ingest({ kind: 'turn-end', turn: 4, reason: 'error' })
    const triggers = observer.evaluateHardTriggers({ repeatedFailureCount: 3, regressionFailureCount: 1 })
    expect(triggers.some((trigger) => trigger.rule.startsWith('repeated_failure'))).toBe(true)
    expect(triggers.some((trigger) => trigger.rule === 'turn_end_error')).toBe(true)
    expect(readJsonl<{ rule: string }>(paths.triggers(root, 's1')).length).toBeGreaterThanOrEqual(2)
  })

  it('maps real dsh payloads: agent/error and tools/result', () => {
    const agentError = Observer.mapAgentError({ turn: 2, step: 1, error: 'boom' })
    expect(agentError).toMatchObject({ kind: 'agent-error', turn: 2, error: 'boom' })
    const toolError = Observer.mapToolResult(
      { name: 'bash' },
      { isError: true, error: { code: 'TIMEOUT', message: 'timeout after 5s' } },
    )
    expect(toolError).toMatchObject({ kind: 'tool-error', tool: 'bash', code: 'TIMEOUT', evidence: 'timeout after 5s' })
    expect(Observer.mapToolResult({ name: 'bash' }, { isError: false, value: 1 })).toBeNull()
    expect(Observer.mapAgentError(null)).toBeNull()
  })

  it('records turn/tool latency and errors into actor telemetry', () => {
    const { root, observer } = setup()
    observer.recordFrame('turn/start', { turn: 1 }, 1000)
    observer.recordFrame('tool/call', { turn: 1, step: 1, name: 'bash', callId: 'c1' }, 1100)
    observer.recordFrame('tool/result', { turn: 1, step: 1, name: 'bash', callId: 'c1', error: { message: 'x' } }, 1500)
    observer.recordFrame('turn/end', { turn: 1, reason: 'error' }, 2000)
    const summary = observer.collectTelemetry()
    expect(summary.turns).toBe(1)
    expect(summary.avgTurnMs).toBe(1000)
    expect(summary.maxTurnMs).toBe(1000)
    expect(summary.toolCalls).toBe(1)
    expect(summary.toolErrors).toBe(1)
    expect(summary.toolErrorRate).toBe(1)
    expect(summary.perTool[0]?.name).toBe('bash')
    expect(summary.perTool[0]?.avgMs).toBe(400)
    expect(existsSync(paths.actorProfile(root, 's1'))).toBe(true)
    expect(readJsonl<{ type: string }>(paths.frames(root, 's1'))).toHaveLength(4)
  })

  it('auto-ingests user/message frames into user_correction signals', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-obs-'))
    const listeners: Record<string, (...args: unknown[]) => void> = {}
    const ctx = { on: (name: string, listener: (...args: unknown[]) => void) => { listeners[name] = listener } }
    const observer = new Observer(ctx as never, { root, sessionId: 's1' })
    observer.subscribe()
    listeners['session/event']?.({ id: 's' }, { type: 'user/message', time: Date.now(), data: { turn: 1, text: '把模型换成 v4flash', source: 'user' } })
    const signals = observer.collect({ repeatedFailureCount: 3, regressionFailureCount: 1 })
    expect(signals.map((signal) => signal.kind)).toContain('user_correction')
  })

  it('does not auto-ingest user messages when disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-obs-'))
    const listeners: Record<string, (...args: unknown[]) => void> = {}
    const ctx = { on: (name: string, listener: (...args: unknown[]) => void) => { listeners[name] = listener } }
    const observer = new Observer(ctx as never, { root, sessionId: 's1', autoIngestUserMessages: false })
    observer.subscribe()
    listeners['session/event']?.({ id: 's' }, { type: 'user/message', time: Date.now(), data: { turn: 1, text: 'hello' } })
    const signals = observer.collect({ repeatedFailureCount: 3, regressionFailureCount: 1 })
    expect(signals).toHaveLength(0)
  })

  it('skips plugin notices so completion notifications do not retrigger evolution', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-obs-'))
    const listeners: Record<string, (...args: unknown[]) => void> = {}
    const ctx = { on: (name: string, listener: (...args: unknown[]) => void) => { listeners[name] = listener } }
    const observer = new Observer(ctx as never, { root, sessionId: 's1' })
    observer.subscribe()
    listeners['session/event']?.({ id: 's' }, {
      type: 'user/message',
      time: Date.now(),
      data: { turn: 1, text: '优化完成：… reload 后生效', source: { kind: 'plugin', plugin: 'dsh-meta-validate', form: 'notice' } },
    })
    const signals = observer.collect({ repeatedFailureCount: 3, regressionFailureCount: 1 })
    expect(signals).toHaveLength(0)
  })

  it('resets turn age on turn/end so the next turn is not treated as stalled', () => {
    const { observer } = setup()
    observer.recordFrame('turn/start', { turn: 1 }, Date.now() - 400_000)
    observer.recordFrame('turn/end', { turn: 1, reason: { kind: 'completed' } }, Date.now() - 100)
    expect(observer.currentTurnStart()).toBeNull()
  })
})
