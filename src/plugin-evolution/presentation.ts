import type { PluginEvolutionPlan, PluginLifecyclePlan, PluginTransactionRecord } from './types.js'

export interface PluginEvolutionTaskCard {
  capability: 'plugin-evolution'
  phase: 'waiting_for_confirmation' | 'implementing' | 'verifying' | 'ready_to_activate' | 'completed' | 'not_applied' | 'not_completed' | 'cancelled'
  headline: string
  targets: string[]
  goal: string
  expectedOutcome: string
  progress: { current: string; next: string }
  verification: string[]
  controls: string[]
  result?: { outcome: '已生效' | '待冷启动生效' | '未生效' | '未完成' | '已取消'; summary: string }
}

export function pluginEvolutionTaskCard(plan: PluginEvolutionPlan): PluginEvolutionTaskCard {
  const phase = plan.state === 'planned' ? 'waiting_for_confirmation'
    : plan.state === 'implementing' ? 'implementing'
      : plan.state === 'verifying' ? 'verifying'
        : plan.state === 'ready_to_activate' ? 'ready_to_activate'
          : plan.state === 'completed' ? 'completed'
            : plan.state === 'rejected' ? 'not_applied'
              : plan.state === 'aborted' ? 'not_completed'
                : 'cancelled'
  const progress = phase === 'waiting_for_confirmation'
    ? { current: '已冻结目标插件、可信源码与验收条件，尚未启动 Builder', next: '用户确认后在隔离工作区联合实现' }
    : phase === 'implementing'
      ? { current: 'Builder 正在已确认的插件源码副本中实现', next: '宿主重跑 build/test 并交给独立 Verifier' }
      : phase === 'verifying'
        ? { current: '正在验证源码来源、包合同、组合行为与 Shadow Profile', next: '全部通过后生成待冷启动原子事务' }
        : phase === 'ready_to_activate'
          ? { current: '所有验证已通过，live Profile 尚未改变', next: '下一次 dsh-loom start 在宿主启动前整体激活' }
          : phase === 'completed'
            ? { current: '目标插件已整体生效并完成 Loader 对账', next: '可观察实际效果，或创建独立恢复事务' }
            : { current: plan.result?.summary ?? '本轮未产生已生效的插件组合', next: '保留原始记录；修正原因后创建新的 immutable plan' }
  const controls = phase === 'waiting_for_confirmation' ? ['confirm_execute', 'cancel', 'status']
    : phase === 'ready_to_activate' ? ['status', 'cancel_ready']
      : phase === 'completed' ? ['status', 'restore'] : ['status']
  const outcome = phase === 'completed' ? '已生效'
    : phase === 'ready_to_activate' ? '待冷启动生效'
      : phase === 'cancelled' ? '已取消'
        : phase === 'not_completed' ? '未完成' : phase === 'not_applied' ? '未生效' : undefined
  return {
    capability: 'plugin-evolution', phase,
    headline: plan.targets.length > 1 ? `${plan.targets.length} 个插件的原子协同演进` : `${plan.targets[0]?.packageName ?? '插件'} 的受控演进`,
    targets: plan.targets.map((target) => target.packageName), goal: plan.requirements, expectedOutcome: plan.expectedOutcome,
    progress,
    verification: ['每插件 host-owned build/test', '源码与 package identity', 'Shadow Profile 冷启动', ...(plan.targets.length > 1 ? ['组合 integration probe'] : []), '激活失败整体恢复'],
    controls,
    ...(outcome ? { result: { outcome, summary: plan.result?.summary ?? progress.current } } : {}),
  }
}

export function pluginRestoreCard(transaction: PluginTransactionRecord): { phase: string; outcome: string; next: string } {
  return transaction.state === 'ready_to_activate'
    ? { phase: 'ready_to_activate', outcome: '恢复事务已冻结，尚未改变当前 Profile', next: '下一次 dsh-loom start 在宿主启动前整体恢复上一组合' }
    : transaction.state === 'completed'
      ? { phase: 'completed', outcome: '上一插件组合已整体恢复', next: '可重新观察原始行为' }
      : { phase: transaction.state, outcome: transaction.rollback?.succeeded ? '恢复未完成，已保持恢复前组合' : '恢复事务未完成', next: '查看受控事务记录' }
}

export function pluginLifecycleCard(plan: PluginLifecyclePlan): {
  capability: 'plugin-lifecycle'
  phase: string
  operation: string
  target: string
  version: string | null
  current: string
  next: string
  controls: string[]
  result?: { outcome: string; summary: string }
} {
  const phase = plan.state === 'planned' ? 'waiting_for_confirmation'
    : plan.state === 'ready_to_activate' ? 'ready_to_activate'
      : plan.state === 'completed' ? 'completed'
        : plan.state === 'cancelled' ? 'cancelled' : 'not_applied'
  const controls = phase === 'waiting_for_confirmation' ? ['confirm_execute', 'cancel', 'status']
    : phase === 'ready_to_activate' ? ['cancel_ready', 'status']
      : phase === 'completed' && plan.result?.effective ? ['restore', 'status'] : ['status']
  return {
    capability: 'plugin-lifecycle', phase, operation: plan.operation, target: plan.packageName,
    version: plan.frozen?.version ?? null,
    current: phase === 'waiting_for_confirmation' ? '版本/完整性与 Profile before 已冻结，尚未修改 live Profile'
      : phase === 'ready_to_activate' ? 'Shadow Profile 冷验证已通过，等待下一次冷启动整体生效'
        : plan.result?.summary ?? '本轮没有已生效的插件操作',
    next: phase === 'waiting_for_confirmation' ? '用户确认后执行确定性 staging（不调用 Builder）'
      : phase === 'ready_to_activate' ? '下一次 dsh-loom start 在宿主启动前提交事务'
        : phase === 'completed' && plan.result?.effective ? '可观察插件行为或创建独立恢复事务' : '保留 receipt，必要时创建新计划',
    controls,
    ...(plan.result ? { result: { outcome: plan.result.effective ? '已生效' : plan.result.restartRequired ? '待冷启动生效' : plan.state === 'cancelled' ? '已取消' : '未生效', summary: plan.result.summary } } : {}),
  }
}
