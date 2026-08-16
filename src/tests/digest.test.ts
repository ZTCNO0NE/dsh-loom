import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Observer } from '../observer/index.js'
import { buildRuntimeDigest } from '../meta/digest.js'
import type { AutopilotState } from '../types.js'

function state(): AutopilotState {
  return { schemaVersion: 1, epoch: 2, iterationsThisEpoch: 1, lastIterationTurn: 5, lastApplyTurn: 3 }
}

describe('runtime digest (route A supervisor)', () => {
  it('flags repeated text and an old turn as stall', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-digest-'))
    const sessionId = 's1'
    const observer = new Observer(null, { root, sessionId })
    const now = Date.now()
    observer.recordFrame('turn/start', { turn: 1 }, now - 200_000)
    for (let i = 0; i < 3; i++) {
      observer.recordFrame('assistant/message', { turn: 1, text: '还是不行' }, now - 1000 + i)
    }
    const digest = buildRuntimeDigest({
      observer,
      root,
      sessionId,
      currentConfig: { 'agent-default-model': { config: { model: 'qwen/qwen3.6-27b' } } },
      signals: [],
      state: state(),
      now,
    })
    expect(digest.model).toBe('qwen/qwen3.6-27b')
    expect(digest.stall.repeatedTextCount).toBe(3)
    expect(digest.stall.turnOlderThanSeconds).toBeGreaterThanOrEqual(199)
    expect(digest.epoch).toBe(2)
  })

  it('does not flag stall when frames are fresh', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-digest-'))
    const sessionId = 's1'
    const observer = new Observer(null, { root, sessionId })
    const now = Date.now()
    observer.recordFrame('turn/start', { turn: 1 }, now - 1000)
    observer.recordFrame('tool/result', { turn: 1, step: 1, name: 'bash', value: 'ok' }, now - 500)
    const digest = buildRuntimeDigest({ observer, root, sessionId, currentConfig: {}, signals: [], state: state(), now })
    expect(digest.stall.noFrameSeconds).toBeLessThan(10)
    expect(digest.toolCalls).toBe(1)
  })
})
