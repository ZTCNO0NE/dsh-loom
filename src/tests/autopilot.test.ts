import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoPilot } from '../meta/autopilot.js'
import { ReviewGate } from '../meta/review.js'
import { IterationLoop } from '../meta/loop.js'
import { Proposer } from '../meta/propose.js'
import { Observer } from '../observer/index.js'
import { Gate } from '../gate/index.js'
import { atomicWriteJson, paths, readJson } from '../protocol/index.js'
import type { AutopilotState, RegressionCase, ValidationReport } from '../types.js'

function stubLlm(json: string) {
  return {
    async *stream() {
      yield { kind: 'block-start', type: 'text' }
      yield { kind: 'text-delta', text: json }
      yield { kind: 'block-end', type: 'text' }
    },
  }
}

const VALID = JSON.stringify({
  patch: { targetId: 'row-a', targetKind: 'config', config: { timeoutMs: 30000 }, dependencies: [], rationale: 'x', expectedOutcome: 'ok', version: 1 },
  expectedTrajectory: { events: [{ type: 'turn/start' }, { type: 'turn/end', reason: 'success' }], coverage: { claimedBehaviors: [] } },
  selfCheck: { confidence: 0.9, completeness: 0.8 },
})

function setup(gateJson: string, opts: Partial<{ minIntervalTurns: number; maxIterationsPerEpoch: number }> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mv-auto-'))
  const sessionId = 's1'
  const observer = new Observer(null, { root, sessionId })
  for (let i = 1; i <= 3; i++) {
    observer.ingest({ kind: 'tool-error', turn: i, step: 1, tool: 'bash', code: 'E1', evidence: 'boom' })
  }
  const gate = new ReviewGate(null, {
    enabled: true,
    prompt: 'x',
    root,
    sessionId,
    provider: 'p',
    model: 'm',
    llm: stubLlm(gateJson),
  })
  const proposer = new Proposer(null, {
    systemPrompt: 'x',
    maxSignals: 5,
    provider: 'p',
    model: 'm',
    root,
    sessionId,
    llm: stubLlm(VALID),
  })
  const gateImpl = new Gate(null, { root, sessionId })
  const validator = {
    async loadRegressionCases(): Promise<RegressionCase[]> { return [] },
    async run(): Promise<ValidationReport> {
      return { patchId: 'p1', verdict: 'approved', score: 1, evidence: [], validatedAt: new Date().toISOString() }
    },
    persistReport(): void {},
  } as unknown as ConstructorParameters<typeof IterationLoop>[0]['validator']
  const loop = new IterationLoop({
    proposer,
    validator,
    gate: gateImpl,
    root,
    sessionId,
    maxIterations: 3,
    confirm: async () => false,
    autoConfirm: true,
  })
  const autopilot = new AutoPilot({
    gate,
    loop,
    observer,
    root,
    sessionId,
    thresholds: { repeatedFailureCount: 3, regressionFailureCount: 1 },
    minIntervalTurns: opts.minIntervalTurns ?? 10,
    maxIterationsPerEpoch: opts.maxIterationsPerEpoch ?? 2,
  })
  const ops = {
    readConfig: () => ({ timeoutMs: 5000 }),
    writeConfig: () => {},
    smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: true, checks: [], ranAt: new Date().toISOString() }),
  }
  return { root, sessionId, autopilot, ops }
}

describe('autopilot (two-stage frequency control)', () => {
  it('fires via hard trigger + gate, applies, and starts a new epoch', async () => {
    const { root, sessionId, autopilot, ops } = setup('{"shouldRefine": true, "rationale": "值得"}')
    const outcome = await autopilot.step(1, {}, undefined, { actualEvents: [] }, ops)
    expect(outcome.fired).toBe(true)
    if (!outcome.fired) return
    expect(outcome.result.applied?.applied).toBe(true)
    const state = readJson<AutopilotState>(paths.autopilotState(root, sessionId))
    expect(state?.epoch).toBe(1)
    expect(state?.iterationsThisEpoch).toBe(0)
    expect(state?.lastApplyTurn).toBe(1)
  })

  it('respects cooldown between iterations', async () => {
    const { autopilot, ops } = setup('{"shouldRefine": true, "rationale": "值得"}', { minIntervalTurns: 10 })
    await autopilot.step(1, {}, undefined, { actualEvents: [] }, ops)
    const second = await autopilot.step(2, {}, undefined, { actualEvents: [] }, ops)
    expect(second.fired).toBe(false)
    if (!second.fired) expect(second.reason).toBe('cooldown')
  })

  it('forces fire when the gate says no but deterministic evidence exists (bias)', async () => {
    const { autopilot, ops } = setup('{"shouldRefine": false, "rationale": "噪音"}')
    const outcome = await autopilot.step(1, {}, undefined, { actualEvents: [] }, ops)
    expect(outcome.fired).toBe(true)
    if (outcome.fired) expect(outcome.result.applied?.applied).toBe(true)
  })

  it('lets the supervisor veto a user-message-only wake', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-auto-'))
    const sessionId = 's1'
    const observer = new Observer(null, { root, sessionId })
    observer.ingest({ kind: 'user-message', turn: 1, text: '随便聊聊' })
    const gate = new ReviewGate(null, {
      enabled: true,
      prompt: 'x',
      root,
      sessionId,
      provider: 'p',
      model: 'm',
      llm: stubLlm('{"shouldRefine": false, "rationale": "无需迭代"}'),
    })
    const autopilot = new AutoPilot({
      gate,
      loop: {} as never,
      observer,
      root,
      sessionId,
      thresholds: { repeatedFailureCount: 3, regressionFailureCount: 1 },
      minIntervalTurns: 10,
      maxIterationsPerEpoch: 2,
    })
    const outcome = await autopilot.step(1, {})
    expect(outcome.fired).toBe(false)
    if (!outcome.fired) expect(outcome.reason).toBe('gate_declined')
  })

  it('forces fire on explicit requirements even when the gate declines (S9)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-auto-'))
    const sessionId = 's1'
    const observer = new Observer(null, { root, sessionId })
    observer.ingest({ kind: 'user-message', turn: 1, text: '把超时调大' })
    const gate = new ReviewGate(null, {
      enabled: true,
      prompt: 'x',
      root,
      sessionId,
      provider: 'p',
      model: 'm',
      llm: stubLlm('{"shouldRefine": false, "rationale": "噪音"}'),
    })
    const loop = {
      run: async () => ({
        patch: null,
        report: { patchId: 'p', verdict: 'approved', score: 1, evidence: [], validatedAt: new Date().toISOString() },
        applied: { patch: {}, before: {}, after: {}, applied: true },
        iterations: 1,
        escalated: false,
      }),
    }
    const autopilot = new AutoPilot({
      gate,
      loop: loop as never,
      observer,
      root,
      sessionId,
      thresholds: { repeatedFailureCount: 3, regressionFailureCount: 1 },
      minIntervalTurns: 10,
      maxIterationsPerEpoch: 2,
    })
    const outcome = await autopilot.step(1, {}, '请修复 bash 超时问题')
    expect(outcome.fired).toBe(true)
  })

  it('blocks when the per-epoch budget is exhausted', async () => {
    const { root, sessionId, autopilot, ops } = setup('{"shouldRefine": true, "rationale": "值得"}', { maxIterationsPerEpoch: 1 })
    atomicWriteJson(paths.autopilotState(root, sessionId), {
      schemaVersion: 1,
      epoch: 0,
      iterationsThisEpoch: 1,
      lastIterationTurn: 0,
      lastApplyTurn: 0,
    })
    const outcome = await autopilot.step(1, {}, undefined, { actualEvents: [] }, ops)
    expect(outcome.fired).toBe(false)
    if (!outcome.fired) expect(outcome.reason).toBe('epoch_budget')
  })

  it('does not fire without a hard trigger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-auto-'))
    const sessionId = 's2'
    const observer = new Observer(null, { root, sessionId })
    const gate = new ReviewGate(null, {
      enabled: true,
      prompt: 'x',
      root,
      sessionId,
      provider: 'p',
      model: 'm',
      llm: stubLlm('{"shouldRefine": true}'),
    })
    const autopilot = new AutoPilot({
      gate,
      loop: {} as never,
      observer,
      root,
      sessionId,
      thresholds: { repeatedFailureCount: 3, regressionFailureCount: 1 },
      minIntervalTurns: 10,
      maxIterationsPerEpoch: 2,
    })
    const outcome = await autopilot.step(1, {})
    expect(outcome.fired).toBe(false)
    if (!outcome.fired) expect(outcome.reason).toBe('no_hard_trigger')
  })

  it('re-wakes the supervisor after an apply and stops when it declines (post-loop)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-auto-post-'))
    const sessionId = 's1'
    const observer = new Observer(null, { root, sessionId })
    for (let i = 1; i <= 3; i++) {
      observer.ingest({ kind: 'tool-error', turn: i, step: 1, tool: 'bash', code: 'E1', evidence: 'boom' })
    }
    const decisions = [true, true, false]
    const gate = {
      decide: async () => ({ schemaVersion: 1, shouldRefine: true, rationale: 'x', evidenceRefs: [], createdAt: new Date().toISOString() }),
      decideOnDigest: async () => {
        const value = decisions.shift() ?? false
        return { schemaVersion: 1, shouldRefine: value, rationale: 'x', evidenceRefs: [], createdAt: new Date().toISOString() }
      },
    }
    let runs = 0
    const loop = {
      run: async () => {
        runs += 1
        return {
          patch: null,
          report: { patchId: 'p', verdict: 'approved', score: 1, evidence: [], validatedAt: new Date().toISOString() },
          applied: { patch: {}, before: {}, after: {}, applied: true },
          iterations: 1,
          escalated: false,
        }
      },
    }
    const autopilot = new AutoPilot({
      gate,
      loop: loop as never,
      observer,
      root,
      sessionId,
      thresholds: { repeatedFailureCount: 3, regressionFailureCount: 1 },
      minIntervalTurns: 10,
      maxIterationsPerEpoch: 5,
      postLoopMaxRounds: 2,
    })
    const ops = {
      readConfig: () => ({}),
      writeConfig: () => {},
      smoke: () => ({ schemaVersion: 1, patchId: 'p', passed: true, checks: [], ranAt: new Date().toISOString() }),
    }
    const outcome = await autopilot.step(1, {}, undefined, { actualEvents: [] }, ops)
    expect(outcome.fired).toBe(true)
    expect(runs).toBe(2)
  })
})
