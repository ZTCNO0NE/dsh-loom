/** Restore safe confirmation context after another turn or host interaction. */
export function evolutionTaskCardExtras(session, planId) {
    if (session.pending?.planId !== planId)
        return {};
    return {
        suggestions: session.pending.suggestions.map(({ key, title, summary }) => ({ key, title, summary })),
        confirmation: '这个候选仍在等待确认。是否开始隔离实现，并交给独立 Verifier/Gate 裁决？',
    };
}
/** Latest immutable tasks, stripped of all routing ids and filesystem details. */
export function userEvolutionHistoryView(plans, limit = 5) {
    return [...plans]
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, Math.max(0, limit))
        .map((plan) => {
        const card = userEvolutionTaskCard(plan);
        return {
            createdAt: plan.createdAt,
            headline: card.headline,
            phase: card.phase,
            outcome: card.result?.outcome ?? '尚未裁决',
            verdict: card.result?.verdict ?? null,
        };
    });
}
/** Stable Actor-facing task card; it deliberately excludes before snapshots and raw paths. */
export function userEvolutionTaskCard(plan, jobStatus, extras = {}) {
    const result = plan.result;
    const phase = plan.state === 'planned'
        ? 'waiting_for_confirmation'
        : plan.state === 'queued'
            ? 'queued'
            : plan.state === 'verifying'
                ? 'verifying'
                : plan.state === 'executing'
                    ? 'implementing'
                    : plan.state === 'completed'
                        ? 'completed'
                        : plan.state === 'cancelled'
                            ? 'cancelled'
                            : plan.state === 'aborted' || plan.state === 'interrupted'
                                ? 'not_completed'
                                : jobStatus === 'scheduled'
                                    ? 'queued'
                                    : jobStatus === 'running'
                                        ? 'implementing'
                                        : 'not_applied';
    const progress = phase === 'waiting_for_confirmation'
        ? { current: '方案与证据已冻结，尚未修改任何内容。', next: '等待用户确认执行。' }
        : phase === 'queued'
            ? { current: '任务已排队，Actor 可以继续当前对话。', next: '将在隔离 workspace 中启动实现。' }
            : phase === 'implementing'
                ? { current: 'Builder 正在隔离 workspace 实现并准备独立验证。', next: 'Verifier 与 Gate 将决定是否生效或回滚。' }
                : phase === 'verifying'
                    ? { current: '候选已冻结，正在由独立 Verifier 与 Gate 裁决。', next: '裁决完成前不会生效。' }
                    : phase === 'completed'
                        ? result?.rolledBack
                            ? { current: '已通过 Gate 恢复安装前快照。', next: '当前任务不再有待重启生效的变更。' }
                            : { current: '已通过独立裁决并完成安装。', next: '可按同任务报告观察效果和限制。' }
                        : phase === 'not_completed'
                            ? { current: '实现未形成可裁决提交。', next: '检查原因后创建新的 immutable plan。' }
                            : phase === 'cancelled'
                                ? { current: '任务在开始实现前已取消。', next: '如仍需要，可基于原请求创建新的 immutable 任务。' }
                                : { current: '候选未获独立裁决放行。', next: '查看拒绝原因；不会静默绕过或重试。' };
    const controls = phase === 'waiting_for_confirmation'
        ? ['confirm', 'cancel_pending', 'view_evidence']
        : phase === 'queued' ? ['cancel_queued', 'view_status', 'view_evidence']
            : phase === 'not_applied' || phase === 'not_completed' || phase === 'cancelled'
                ? ['redo', 'view_status', 'view_evidence'] : ['view_status', 'view_evidence'];
    return {
        schemaVersion: 1, id: 'current-evolution-task', phase,
        headline: `${plan.target.kind === 'config' ? '配置' : '技能'}演进：${plan.target.summary}`,
        target: { summary: plan.target.summary },
        ...(extras.suggestions?.length ? { suggestions: extras.suggestions } : {}),
        ...(phase === 'waiting_for_confirmation' ? { confirmation: extras.confirmation ?? '是否按此方向开始隔离实现并交由独立裁决？' } : {}),
        progress, verification: plan.target.verification, risks: plan.target.risks,
        evidence: { summary: plan.evidence.summary, artifactCount: plan.evidence.refs.length },
        controls,
        actions: phase === 'waiting_for_confirmation' ? ['confirm_execute', 'view_evidence'] : ['view_status', 'view_evidence'],
        timeline: [
            { event: 'planned', at: plan.createdAt, label: '方案与证据已冻结' },
            ...(plan.execution ? [{ event: 'started', at: plan.execution.at, label: '已进入隔离实现' }] : []),
            ...(plan.state === 'verifying' ? [{ event: 'verifying', label: '独立裁决中' }] : []),
            ...(result ? [{ event: 'finished', label: result.rolledBack ? '已通过 Gate 回滚' : result.restartRequired ? '裁决完成，待重启生效' : result.applied ? '裁决完成，已生效' : '裁决完成，未生效' }] : []),
        ],
        retryable: phase === 'not_applied' || phase === 'not_completed' || phase === 'cancelled',
        ...(result ? { result: presentResult(result) } : {}),
    };
}
/**
 * User-visible proof inventory. It reports what was frozen and what the
 * independent boundary decided, while deliberately omitting raw content,
 * hashes, local paths, snapshots, credentials, and hidden model reasoning.
 */
export function userEvolutionEvidenceView(plan, pack) {
    const digest = pack.deterministicDigest;
    return {
        schemaVersion: 1,
        frozen: true,
        frozenAt: pack.createdAt,
        target: plan.target.summary,
        coverage: {
            actorFrames: pack.watermark.frameCount,
            actorEvents: pack.watermark.eventCount,
            lastFrameAt: pack.watermark.lastFrameAt,
            sources: pack.rawRefs.map((ref) => ({ name: ref.name, present: ref.exists, lineCount: ref.lineCount })),
        },
        observations: {
            turns: digest.turns,
            toolCalls: digest.toolCalls,
            toolErrors: digest.toolErrors,
            toolErrorRate: digest.toolErrorRate,
            signals: [...new Set(digest.signals.map((signal) => signal.kind))],
            actorAssessmentIncluded: pack.actorHandoff.supplied,
        },
        ...(plan.result ? {
            adjudication: {
                verdict: plan.result.verdict,
                applied: plan.result.applied,
                effective: plan.result.effective ?? null,
                restartRequired: plan.result.restartRequired ?? false,
                rolledBack: plan.result.rolledBack ?? false,
            },
        } : {}),
        privacy: '这里只展示冻结证据的类型、数量和裁决状态；原始内容、绝对路径、快照、凭据及隐藏推理不会返回对话。',
    };
}
/** One low-frequency, state-backed progress notice; never a model-authored claim. */
export function userEvolutionProgressNotice(plan, jobStatus) {
    const card = userEvolutionTaskCard(plan, jobStatus);
    return {
        text: `演进仍在进行：${card.progress.current} 下一步：${card.progress.next}`,
        summary: card.phase === 'verifying' ? '用户演进裁决中' : card.phase === 'queued' ? '用户演进排队中' : '用户演进实现中',
    };
}
function presentResult(result) {
    const limitations = result.rolledBack
        ? result.limitations.filter((item) => !/cold host restart|requires a cold host restart|宿主重启/i.test(item))
        : result.limitations;
    return {
        outcome: result.rolledBack ? '已回滚' : result.restartRequired ? '待重启生效' : result.applied ? '已生效' : result.summary.includes('取消') ? '已取消' : result.verdict === 'aborted' ? '未完成' : '未生效',
        verdict: result.verdict, summary: result.summary, limitations,
    };
}
