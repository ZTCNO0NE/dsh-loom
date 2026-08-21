import { describe, expect, it } from 'vitest'
import { evolutionTaskCardExtras, userEvolutionEvidenceView, userEvolutionHistoryView, userEvolutionProgressNotice, userEvolutionTaskCard } from '../evolution/presentation.js'
import type { UserEvolutionPlan } from '../evolution/controller.js'
import type { ActorEvidencePack } from '../evidence/index.js'

const plan = (state: UserEvolutionPlan['state']): UserEvolutionPlan => ({
  schemaVersion: 1, id: 'evolution-test', createdAt: '2026-08-20T00:00:00.000Z', requirements: 'add refine', state,
  target: { kind: 'skill', plan: { capability: 'skill-evolution', targetId: 'refine', targetKind: 'skill', entry: 'refine/SKILL.md' }, summary: '添加 refine 技能', verification: 'cold load and rollback', risks: ['instruction adherence'] },
  evidence: { refs: ['/secret/internal/path', '/another/internal/path'], summary: 'frozen evidence' },
})

describe('user evolution task card', () => {
  it('gives a confirmation card without exposing the plan workspace or before snapshot', () => {
    const card = userEvolutionTaskCard(plan('planned'))
    expect(card).toMatchObject({ phase: 'waiting_for_confirmation', actions: ['confirm_execute', 'view_evidence'], controls: ['confirm', 'cancel_pending', 'view_evidence'], evidence: { artifactCount: 2 }, confirmation: expect.any(String) })
    expect(JSON.stringify(card)).not.toContain('/secret/internal/path')
    expect(JSON.stringify(card)).not.toContain('refine/SKILL.md')
    expect(JSON.stringify(card)).not.toContain('targetKind')
  })

  it('shows independent non-application as a user-visible terminal state', () => {
    const rejected = plan('rejected')
    rejected.result = { runId: 'r', targetKind: 'skill', targetId: 'refine', verdict: 'rejected', applied: false, summary: 'cold smoke failed', limitations: ['Gate remains final'] }
    expect(userEvolutionTaskCard(rejected)).toMatchObject({ phase: 'not_applied', result: { outcome: '未生效', summary: 'cold smoke failed' } })
  })

  it('distinguishes a verified config overlay awaiting restart from an effective skill install', () => {
    const config = plan('completed')
    config.target.kind = 'config'
    config.result = {
      runId: 'config-run', targetKind: 'config', targetId: 'agent-default-model', verdict: 'approved',
      applied: true, effective: false, restartRequired: true,
      summary: '配置 overlay 已通过冷启动验证，宿主重启后生效', limitations: [],
    }
    expect(userEvolutionTaskCard(config)).toMatchObject({
      phase: 'completed',
      result: { outcome: '待重启生效' },
      timeline: expect.arrayContaining([{ event: 'finished', label: '裁决完成，待重启生效' }]),
    })

    const skill = plan('completed')
    skill.result = {
      runId: 'skill-run', targetKind: 'skill', targetId: 'refine', verdict: 'approved',
      applied: true, effective: true, restartRequired: false, summary: '技能已冷加载', limitations: [],
    }
    expect(userEvolutionTaskCard(skill)).toMatchObject({ phase: 'completed', result: { outcome: '已生效' } })
  })

  it('keeps legacy stored reports without the new effectiveness fields readable', () => {
    const legacy = plan('completed')
    legacy.result = {
      runId: 'legacy-run', targetKind: 'skill', targetId: 'refine', verdict: 'approved',
      applied: true, summary: 'legacy success', limitations: [],
    }
    expect(userEvolutionTaskCard(legacy)).toMatchObject({ phase: 'completed', result: { outcome: '已生效' } })
  })

  it('shows a Gate-owned rollback without exposing its receipt path', () => {
    const rolledBack = plan('completed')
    rolledBack.result = {
      runId: 'config-run', targetKind: 'config', targetId: 'agent-default-model', verdict: 'approved',
      applied: false, effective: false, restartRequired: false, rolledBack: true,
      rollbackReceipt: 'C:/secret/internal/rollback.json', summary: '已通过 Gate 回滚',
      limitations: ['The verified config overlay requires a cold host restart before it affects Actor sessions.', 'Rollback is auditable.'],
    }
    const card = userEvolutionTaskCard(rolledBack)
    expect(card).toMatchObject({
      phase: 'completed',
      progress: { current: '已通过 Gate 恢复安装前快照。', next: '当前任务不再有待重启生效的变更。' },
      result: { outcome: '已回滚', limitations: ['Rollback is auditable.'] },
    })
    expect(JSON.stringify(card)).not.toContain('rollback.json')
  })

  it('presents frozen evidence counts and adjudication without exposing raw paths or contents', () => {
    const completed = plan('completed')
    completed.result = {
      runId: 'skill-run', targetKind: 'skill', targetId: 'refine', verdict: 'approved',
      applied: true, effective: true, restartRequired: false, summary: 'cold load passed', limitations: [],
    }
    const pack: ActorEvidencePack = {
      schemaVersion: 1,
      id: 'evidence-test',
      sessionId: 'actor',
      createdAt: '2026-08-20T00:00:00.000Z',
      watermark: { frameCount: 7, eventCount: 3, lastFrameAt: '2026-08-19T23:59:00.000Z' },
      rawRefs: [
        { name: 'frames', path: 'C:/secret/frames.jsonl', snapshotPath: 'C:/secret/raw/frames.snapshot', exists: true, bytes: 999, lineCount: 7, sha256: 'secret-hash' },
        { name: 'signals', path: 'C:/secret/signals.jsonl', exists: false, bytes: 0, lineCount: 0 },
      ],
      deterministicDigest: {
        schemaVersion: 1, at: '2026-08-20T00:00:00.000Z', turns: 2, avgTurnMs: 10, maxTurnMs: 12,
        lastFrameAgeMs: 1, turnAgeMs: null, toolCalls: 4, toolErrors: 1, toolErrorRate: 0.25,
        topTools: [{ name: 'bash', calls: 4, errors: 1, avgMs: 2 }],
        stall: { noFrameSeconds: 0, turnOlderThanSeconds: 0, repeatedTextCount: 0, noToolProgress: false },
        signals: [{ kind: 'repeated-failure', evidence: ['C:/secret/error and API_KEY=do-not-show'] }],
        epoch: 0, iterationsThisEpoch: 0, lastApplyTurn: 0,
      },
      actorHandoff: { path: 'C:/secret/handoff.md', sha256: 'handoff-secret', supplied: true },
      configSnapshot: { path: 'C:/secret/config.json', sha256: 'config-secret' },
      manifestPath: 'C:/secret/manifest.json',
    }

    const view = userEvolutionEvidenceView(completed, pack)
    expect(view).toMatchObject({
      frozen: true,
      coverage: { actorFrames: 7, actorEvents: 3, sources: [{ name: 'frames', present: true, lineCount: 7 }, { name: 'signals', present: false, lineCount: 0 }] },
      observations: { turns: 2, toolCalls: 4, toolErrors: 1, signals: ['repeated-failure'], actorAssessmentIncluded: true },
      adjudication: { verdict: 'approved', applied: true, effective: true, restartRequired: false, rolledBack: false },
    })
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('C:/secret')
    expect(serialized).not.toContain('do-not-show')
    expect(serialized).not.toContain('secret-hash')
  })

  it('uses the persisted phase for a concise non-spam progress notice', () => {
    const implementing = plan('executing')
    expect(userEvolutionProgressNotice(implementing, 'running')).toMatchObject({
      summary: '用户演进实现中',
      text: expect.stringContaining('Builder 正在隔离 workspace 实现'),
    })

    const verifying = plan('verifying')
    const notice = userEvolutionProgressNotice(verifying, 'running')
    expect(notice.summary).toBe('用户演进裁决中')
    expect(notice.text).toContain('独立 Verifier 与 Gate')
    expect(notice.text).toContain('裁决完成前不会生效')
  })

  it('restores safe candidate context from the durable conversation pointer', () => {
    const extras = evolutionTaskCardExtras({
      schemaVersion: 1,
      sessionId: 'actor',
      updatedAt: '2026-08-20T00:00:00.000Z',
      pending: {
        planId: 'evolution-test',
        userRequest: 'raw user request',
        actorExplanation: 'private actor explanation',
        suggestions: [{ key: 'selected', title: '添加 refine 技能', summary: 'cold load and rollback', target: { kind: 'skill', id: 'refine' } }],
      },
    }, 'evolution-test')
    const card = userEvolutionTaskCard(plan('planned'), undefined, extras)
    expect(card.suggestions).toEqual([{ key: 'selected', title: '添加 refine 技能', summary: 'cold load and rollback' }])
    expect(card.confirmation).toContain('仍在等待确认')
    expect(JSON.stringify(card)).not.toContain('raw user request')
    expect(JSON.stringify(card)).not.toContain('private actor explanation')
    expect(JSON.stringify(card)).not.toContain('"id":"refine"')
  })

  it('lists recent immutable tasks without returning internal ids or evidence paths', () => {
    const older = plan('rejected')
    older.id = 'secret-plan-id'
    older.createdAt = '2026-08-19T00:00:00.000Z'
    older.result = { runId: 'secret-run-id', targetKind: 'skill', targetId: 'refine', verdict: 'rejected', applied: false, summary: 'internal failure', limitations: [] }
    const newer = plan('completed')
    newer.id = 'new-secret-plan-id'
    newer.createdAt = '2026-08-20T00:00:00.000Z'
    newer.result = { runId: 'new-secret-run-id', targetKind: 'skill', targetId: 'refine', verdict: 'approved', applied: true, effective: true, summary: 'pass', limitations: [] }

    const history = userEvolutionHistoryView([older, newer])
    expect(history).toMatchObject([
      { createdAt: newer.createdAt, phase: 'completed', outcome: '已生效', verdict: 'approved' },
      { createdAt: older.createdAt, phase: 'not_applied', outcome: '未生效', verdict: 'rejected' },
    ])
    expect(JSON.stringify(history)).not.toContain('secret-plan-id')
    expect(JSON.stringify(history)).not.toContain('secret-run-id')
    expect(JSON.stringify(history)).not.toContain('/secret/internal/path')
  })
})
