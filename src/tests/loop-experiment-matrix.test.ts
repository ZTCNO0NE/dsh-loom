import { describe, expect, it } from 'vitest'
import { classifyLoopFailure, summarizeLoopExperimentMatrix, type LoopExperimentAttempt } from '../loop-experiments/matrix.js'

const base = (taskId: LoopExperimentAttempt['taskId'], attempt: 1 | 2 | 3): LoopExperimentAttempt => ({
  schemaVersion: 1, taskId, attempt, runId: `${taskId}-${attempt}`, specification: 'real immutable task', runtime: { name: 'mini-swe', model: 'test' }, startedAt: '2026-08-19T00:00:00.000Z', modelTurns: 3, toolCalls: 2,
  firstEditAt: '2026-08-19T00:00:01.000Z', tests: [{ name: 'required', passed: true }], submission: { submitted: true }, adjudication: { verdict: 'approved' }, coldReplay: { passed: true }, rollback: { performed: true, passed: true }, wallTimeMs: 10,
})

describe('loop experiment matrix', () => {
  it('requires all nine immutable slots and one end-to-end completion per layer', () => {
    const tasks = ['scheduler-prepare-overlap', 'oracle-rejection-repair', 'cross-file-semantic-repair'] as const
    const records = tasks.flatMap((task) => [1, 2, 3].map((attempt) => attempt === 1 ? base(task, attempt as 1 | 2 | 3) : { ...base(task, attempt as 1 | 2 | 3), submission: { submitted: false } }))
    const report = summarizeLoopExperimentMatrix(records, '2026-08-19T00:01:00.000Z')
    expect(report.releaseEligible).toBe(true)
    expect(report.attempts).toHaveLength(9)
    expect(report.attempts.filter((record) => record.failure).length).toBe(6)
  })

  it('does not erase stalls and classifies them deterministically', () => {
    const stalled = { ...base('oracle-rejection-repair', 1), firstEditAt: undefined, toolCalls: 4 }
    expect(classifyLoopFailure(stalled)).toBe('hypothesis-to-edit-stall')
    const report = summarizeLoopExperimentMatrix([stalled])
    expect(report.releaseEligible).toBe(false)
    expect(report.incompleteSlots).toHaveLength(8)
    expect(report.attempts[0]?.failure?.classification).toBe('hypothesis-to-edit-stall')
  })
})
