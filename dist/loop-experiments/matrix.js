/**
 * The v1.2 Loop research ledger.  It deliberately records every slot, including
 * failed attempts; no evaluator may turn an absent submission into a success.
 */
export const LOOP_EXPERIMENT_TASKS = [
    'scheduler-prepare-overlap',
    'oracle-rejection-repair',
    'cross-file-semantic-repair',
];
/** A complete closed loop is intentionally stricter than a passing unit test. */
export function isCompleteLoopAttempt(record) {
    return Boolean(record.firstEditAt
        && record.tests.length > 0 && record.tests.every((test) => test.passed)
        && record.submission.submitted
        && record.adjudication.verdict === 'approved'
        && record.coldReplay.passed
        && record.rollback.performed && record.rollback.passed);
}
export function classifyLoopFailure(record) {
    if (record.failure)
        return record.failure.classification;
    if (!record.firstEditAt && record.toolCalls === 0)
        return 'workspace-tool-disconnect';
    if (!record.firstEditAt)
        return 'hypothesis-to-edit-stall';
    if (record.tests.some((test) => !test.passed))
        return 'test-failure';
    if (!record.submission.submitted)
        return 'submission-or-adjudication-disconnect';
    if (record.adjudication.verdict === 'rejected')
        return 'verification-rejected';
    if (record.rollback.performed && !record.rollback.passed)
        return 'install-rollback';
    return undefined;
}
export function summarizeLoopExperimentMatrix(attempts, generatedAt = new Date().toISOString()) {
    const seen = new Set();
    for (const record of attempts) {
        const key = `${record.taskId}:${record.attempt}`;
        if (seen.has(key))
            throw new Error(`duplicate immutable matrix slot: ${key}`);
        seen.add(key);
    }
    const byTask = {};
    const incompleteSlots = [];
    for (const taskId of LOOP_EXPERIMENT_TASKS) {
        const group = attempts.filter((record) => record.taskId === taskId);
        const completed = group.filter(isCompleteLoopAttempt).length;
        byTask[taskId] = { completed, total: group.length, thresholdMet: completed >= 1 };
        for (const attempt of [1, 2, 3]) {
            if (!group.some((record) => record.attempt === attempt))
                incompleteSlots.push({ taskId, attempt });
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
    };
}
