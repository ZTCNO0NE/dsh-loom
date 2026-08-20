import type { UserEvolutionPlan, UserEvolutionReport } from './controller.js'

export type EvolutionTaskPhase = 'waiting_for_confirmation' | 'queued' | 'implementing' | 'verifying' | 'completed' | 'not_applied' | 'not_completed' | 'cancelled'

export interface EvolutionTaskCard {
  schemaVersion: 1
  /** Stable display id, intentionally not the immutable plan id. */
  id: 'current-evolution-task'
  phase: EvolutionTaskPhase
  headline: string
  target: { summary: string }
  progress: { current: string; next: string }
  verification: string
  risks: string[]
  evidence: { summary: string; artifactCount: number }
  suggestions?: Array<{ key: string; title: string; summary: string }>
  confirmation?: string
  controls: Array<'confirm' | 'cancel_queued' | 'view_status' | 'view_evidence' | 'redo'>
  /** Compatibility alias for earlier Actor integrations. */
  actions: Array<'confirm_execute' | 'view_status' | 'view_evidence'>
  timeline: Array<{ event: 'planned' | 'started' | 'verifying' | 'finished'; at?: string; label: string }>
  retryable: boolean
  result?: { outcome: '已生效' | '待重启生效' | '已回滚' | '未生效' | '未完成' | '已取消'; verdict: UserEvolutionReport['verdict']; summary: string; limitations: string[] }
}

export interface EvolutionTaskCardExtras {
  suggestions?: Array<{ key: string; title: string; summary: string }>
  confirmation?: string
}

/** Stable Actor-facing task card; it deliberately excludes before snapshots and raw paths. */
export function userEvolutionTaskCard(plan: UserEvolutionPlan, jobStatus?: string, extras: EvolutionTaskCardExtras = {}): EvolutionTaskCard {
  const result = plan.result
  const phase: EvolutionTaskPhase = plan.state === 'planned'
    ? 'waiting_for_confirmation'
    : plan.state === 'queued' || jobStatus === 'scheduled'
      ? 'queued'
        : plan.state === 'executing' || jobStatus === 'running'
          ? 'implementing'
          : plan.state === 'verifying'
            ? 'verifying'
          : plan.state === 'completed'
            ? 'completed'
            : plan.state === 'cancelled'
              ? 'cancelled'
            : plan.state === 'aborted' || plan.state === 'interrupted'
              ? 'not_completed'
            : 'not_applied'
  const progress = phase === 'waiting_for_confirmation'
    ? { current: '方案与证据已冻结，尚未修改任何内容。', next: '等待用户确认执行。' }
    : phase === 'queued'
      ? { current: '任务已排队，Actor 可以继续当前对话。', next: '将在隔离 workspace 中启动实现。' }
      : phase === 'implementing'
          ? { current: 'Builder 正在隔离 workspace 实现并准备独立验证。', next: 'Verifier 与 Gate 将决定是否生效或回滚。' }
          : phase === 'verifying'
            ? { current: '候选已冻结，正在由独立 Verifier 与 Gate 裁决。', next: '裁决完成前不会生效。' }
        : phase === 'completed'
          ? { current: '已通过独立裁决并完成安装。', next: '可按同任务报告观察效果和限制。' }
          : phase === 'not_completed'
            ? { current: '实现未形成可裁决提交。', next: '检查原因后创建新的 immutable plan。' }
            : phase === 'cancelled'
              ? { current: '任务在开始实现前已取消。', next: '如仍需要，可基于原请求创建新的 immutable 任务。' }
              : { current: '候选未获独立裁决放行。', next: '查看拒绝原因；不会静默绕过或重试。' }
  const controls: EvolutionTaskCard['controls'] = phase === 'waiting_for_confirmation'
    ? ['confirm', 'view_evidence']
    : phase === 'queued' ? ['cancel_queued', 'view_status', 'view_evidence']
      : phase === 'not_applied' || phase === 'not_completed' || phase === 'cancelled'
        ? ['redo', 'view_status', 'view_evidence'] : ['view_status', 'view_evidence']
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
      ...(plan.execution ? [{ event: 'started' as const, at: plan.execution.at, label: '已进入隔离实现' }] : []),
      ...(plan.state === 'verifying' ? [{ event: 'verifying' as const, label: '独立裁决中' }] : []),
      ...(result ? [{ event: 'finished' as const, label: result.rolledBack ? '已通过 Gate 回滚' : result.restartRequired ? '裁决完成，待重启生效' : result.applied ? '裁决完成，已生效' : '裁决完成，未生效' }] : []),
    ],
    retryable: phase === 'not_applied' || phase === 'not_completed' || phase === 'cancelled',
    ...(result ? { result: presentResult(result) } : {}),
  }
}

function presentResult(result: UserEvolutionReport): EvolutionTaskCard['result'] {
  return {
    outcome: result.rolledBack ? '已回滚' : result.restartRequired ? '待重启生效' : result.applied ? '已生效' : result.summary.includes('取消') ? '已取消' : result.verdict === 'aborted' ? '未完成' : '未生效',
    verdict: result.verdict, summary: result.summary, limitations: result.limitations,
  }
}
