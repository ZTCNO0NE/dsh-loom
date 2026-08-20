/** Project an immutable terminal plan back onto a stale process-owned job. */
export function terminalJobFromPlan(plan) {
    const status = plan.state === 'completed'
        ? 'finished'
        : plan.state === 'cancelled'
            ? 'cancelled'
            : plan.state === 'interrupted'
                ? 'interrupted'
                : plan.state === 'rejected' || plan.state === 'aborted'
                    ? 'failed'
                    : null;
    if (!status)
        return null;
    const outcome = plan.result?.rolledBack
        ? '已回滚'
        : plan.result?.restartRequired
            ? '待重启生效'
            : plan.result?.applied
                ? '已生效'
                : plan.result?.summary ?? plan.state;
    return {
        status,
        summary: `用户委托 ${plan.target.kind}/${plan.target.plan.targetId}：${outcome}`,
    };
}
