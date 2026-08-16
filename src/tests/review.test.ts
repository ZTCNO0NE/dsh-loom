import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReviewGate } from '../meta/review.js'
import { paths, readJsonl } from '../protocol/index.js'

function stubLlm(json: string) {
  return {
    async *stream() {
      yield { kind: 'block-start', type: 'text' }
      yield { kind: 'text-delta', text: json }
      yield { kind: 'block-end', type: 'text' }
    },
  }
}

function setup(llm?: unknown, enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mv-review-'))
  const sessionId = 's1'
  const gate = new ReviewGate(null, {
    enabled,
    prompt: 'review prompt',
    root,
    sessionId,
    provider: 'p',
    model: 'm',
    llm: llm as never,
  })
  return { root, sessionId, gate }
}

describe('review gate', () => {
  it('approves startup with shouldRefine=true and persists the decision', async () => {
    const { root, sessionId, gate } = setup(stubLlm('{"shouldRefine": true, "rationale": "连续失败", "focus": "bash timeout"}'))
    const decision = await gate.decide([], 'trajectory', 'history', ['t1'])
    expect(decision.shouldRefine).toBe(true)
    expect(decision.focus).toBe('bash timeout')
    const records = readJsonl<{ shouldRefine: boolean }>(paths.gateDecisions(root, sessionId))
    expect(records[0]?.shouldRefine).toBe(true)
    const triggers = readJsonl<{ rule: string }>(paths.triggers(root, sessionId))
    expect(triggers.some((trigger) => trigger.rule === 'review_gate')).toBe(true)
  })

  it('declines startup with shouldRefine=false', async () => {
    const { gate } = setup(stubLlm('{"shouldRefine": false, "rationale": "一次性噪音"}'))
    const decision = await gate.decide([], '', '', [])
    expect(decision.shouldRefine).toBe(false)
  })

  it('stays disabled without an llm', async () => {
    const { gate } = setup(undefined, false)
    const decision = await gate.decide([], '', '', [])
    expect(decision.shouldRefine).toBe(false)
    expect(decision.rationale).toContain('disabled')
  })

  it('decides from the compact runtime digest (one-shot supervision)', async () => {
    const { root, sessionId, gate } = setup(stubLlm('{"shouldRefine": true, "rationale": "空转", "focus": "stall"}'))
    const digest = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      model: 'qwen/qwen3.6-27b',
      turns: 4,
      avgTurnMs: 45000,
      maxTurnMs: 90000,
      lastFrameAgeMs: 120000,
      turnAgeMs: 200000,
      toolCalls: 8,
      toolErrors: 3,
      toolErrorRate: 0.375,
      topTools: [],
      stall: { noFrameSeconds: 120, turnOlderThanSeconds: 200, repeatedTextCount: 3, noToolProgress: true },
      signals: [],
      epoch: 0,
      iterationsThisEpoch: 0,
      lastApplyTurn: 0,
    }
    const decision = await gate.decideOnDigest(digest)
    expect(decision.shouldRefine).toBe(true)
    expect(decision.focus).toBe('stall')
    const records = readJsonl<{ shouldRefine: boolean }>(paths.gateDecisions(root, sessionId))
    expect(records[0]?.shouldRefine).toBe(true)
  })
})
