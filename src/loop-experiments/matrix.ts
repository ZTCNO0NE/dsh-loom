/**
 * The v1.2 Loop research ledger.  It deliberately records every slot, including
 * failed attempts; no evaluator may turn an absent submission into a success.
 */
export const LOOP_EXPERIMENT_TASKS = [
  'scheduler-prepare-overlap',
  'oracle-rejection-repair',
  'cross-file-semantic-repair',
] as const

export type LoopExperimentTaskId = typeof LOOP_EXPERIMENT_TASKS[number]
export type LoopFailureClass =
  | 'task-underspecified'
  | 'workspace-tool-disconnect'
  | 'failure-untraceable'
  | 'hypothesis-to-edit-stall'
  | 'submission-or-adjudication-disconnect'
  | 'test-failure'
  | 'verification-rejected'
  | 'install-rollback'

export interface LoopExperimentAttempt {
  schemaVersion: 1
  taskId: LoopExperimentTaskId
  attempt: 1 | 2 | 3
  runId: string
  specification: string
  runtime: { name: string; model: string; version?: string }
  startedAt: string
  finishedAt?: string
  modelTurns: number
  toolCalls: number
  firstEditAt?: string
  tests: Array<{ name: string; passed: boolean; detail?: string }>
  submission: { submitted: boolean; id?: string; detail?: string }
  adjudication: { verdict?: 'approved' | 'rejected'; detail?: string }
  coldReplay: { passed?: boolean; detail?: string }
  rollback: { performed?: boolean; passed?: boolean; detail?: string }
  wallTimeMs?: number
  tokenCost?: { prompt: number; completion: number; currency?: string; amount?: number }
  failure?: { classification: LoopFailureClass; detail: string }
}

export interface LoopExperimentMatrixReport {
  schemaVersion: 1
  generatedAt: string
  attempts: LoopExperimentAttempt[]
  byTask: Record<LoopExperimentTaskId, { completed: number; total: number; thresholdMet: boolean }>
  releaseEligible: boolean
  incompleteSlots: Array<{ taskId: LoopExperimentTaskId; attempt: 1 | 2 | 3 }>
}

/** A complete closed loop is intentionally stricter than a passing unit test. */
export function isCompleteLoopAttempt(record: LoopExperimentAttempt): boolean {
  return Boolean(
    record.firstEditAt
    && record.tests.length > 0 && record.tests.every((test) => test.passed)
    && record.submission.submitted
    && record.adjudication.verdict === 'approved'
    && record.coldReplay.passed
    && record.rollback.performed && record.rollback.passed,
  )
}

export function classifyLoopFailure(record: LoopExperimentAttempt): LoopFailureClass | undefined {
  if (record.failure) return record.failure.classification
  if (!record.firstEditAt && record.toolCalls === 0) return 'workspace-tool-disconnect'
  if (!record.firstEditAt) return 'hypothesis-to-edit-stall'
  if (record.tests.some((test) => !test.passed)) return 'test-failure'
  if (!record.submission.submitted) return 'submission-or-adjudication-disconnect'
  if (record.adjudication.verdict === 'rejected') return 'verification-rejected'
  if (record.rollback.performed && !record.rollback.passed) return 'install-rollback'
  return undefined
}

export function summarizeLoopExperimentMatrix(attempts: LoopExperimentAttempt[], generatedAt = new Date().toISOString()): LoopExperimentMatrixReport {
  const seen = new Set<string>()
  for (const record of attempts) {
    const key = `${record.taskId}:${record.attempt}`
    if (seen.has(key)) throw new Error(`duplicate immutable matrix slot: ${key}`)
    seen.add(key)
  }
  const byTask = {} as LoopExperimentMatrixReport['byTask']
  const incompleteSlots: LoopExperimentMatrixReport['incompleteSlots'] = []
  for (const taskId of LOOP_EXPERIMENT_TASKS) {
    const group = attempts.filter((record) => record.taskId === taskId)
    const completed = group.filter(isCompleteLoopAttempt).length
    byTask[taskId] = { completed, total: group.length, thresholdMet: completed >= 1 }
    for (const attempt of [1, 2, 3] as const) {
      if (!group.some((record) => record.attempt === attempt)) incompleteSlots.push({ taskId, attempt })
    }
  }
  return {
    schemaVersion: 1, generatedAt, attempts: attempts.map((record) => ({
      ...record,
      ...(record.failure || isCompleteLoopAttempt(record) ? {} : { failure: { classification: classifyLoopFailure(record) ?? 'submission-or-adjudication-disconnect', detail: 'derived from durable attempt fields' } }),
    })),
    byTask,
    releaseEligible: incompleteSlots.length === 0 && LOOP_EXPERIMENT_TASKS.every((taskId) => byTask[taskId].thresholdMet),
    incompleteSlots,
  }
}
