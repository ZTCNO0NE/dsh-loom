import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendLedger,
  readLedger,
  mergePreferences,
  readPreferences,
  appendReport,
  scenarioOf,
} from '../growth/index.js'
import { paths } from '../protocol/index.js'

describe('growth sedimentation (进化通讯与沉淀)', () => {
  it('maps signals to trigger scenario ids', () => {
    expect(scenarioOf([{ kind: 'repeated_failure' }])).toBe('S1-repeated-failure')
    expect(scenarioOf([{ kind: 'user_correction' }])).toBe('S3-user-correction')
    expect(scenarioOf([{ kind: 'regression_failure' }])).toBe('S4-regression-failure')
    expect(scenarioOf([])).toBe('S9-explicit-request')
  })

  it('appends and reads the growth ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-growth-'))
    const sessionId = 's1'
    appendLedger(root, sessionId, {
      id: 'e1',
      triggeredBy: 'S2-progress-deficit',
      problem: 'stage over budget',
      changes: [],
      verdict: 'approved',
      applied: true,
      metricsBefore: {},
      metricsAfter: {},
      rolledBack: false,
      appliedAt: new Date().toISOString(),
    })
    expect(readLedger(root, sessionId)).toHaveLength(1)
  })

  it('merges preferences by scope+value', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-growth-'))
    const sessionId = 's1'
    mergePreferences(root, sessionId, [{ scope: 'output-format', value: '不带 markdown' }])
    mergePreferences(root, sessionId, [{ scope: 'output-format', value: '不带 markdown' }])
    mergePreferences(root, sessionId, [{ scope: 'output-format', value: '先跑测试' }])
    expect(readPreferences(root, sessionId)).toHaveLength(2)
  })

  it('appends a human-readable report line', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-growth-'))
    const sessionId = 's1'
    appendReport(root, sessionId, '进化 S1: tool bash 修复')
    expect(existsSync(paths.growthReport(root, sessionId))).toBe(true)
  })
})
