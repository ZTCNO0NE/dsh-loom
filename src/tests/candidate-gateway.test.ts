import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LoopCandidateGateway } from '../candidates/gateway.js'
import { BuilderKernel } from '../builder/kernel.js'

function submittingLlm() {
  let wroteSubmission = false
  return {
    async *stream(options: { prompt: string }) {
      const pendingMatch = options.prompt.match(/"pendingMessageIds":\[([^\]]*)\]/)
      const pendingIds = pendingMatch?.[1]
        ? (JSON.parse(`[${pendingMatch[1]}]`) as unknown[]).filter((value): value is string => typeof value === 'string')
        : []
      const decision = pendingIds[0]
        ? { kind: 'tool', action: { name: 'acknowledge_message', messageId: pendingIds[0], status: 'accepted', understanding: '已理解该消息并纳入本次探索。', nextAction: '准备提交可审计 proposal。' } }
        : !wroteSubmission
          ? (wroteSubmission = true, { kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'patch-evolution', patch: { id: 'p1', targetId: 'llm-deepseek', targetKind: 'config', config: {}, dependencies: [], rationale: 'x', expectedOutcome: 'y', version: 1, createdAt: new Date().toISOString() } } } })
          : { kind: 'submit' }
      yield { kind: 'block-start', type: 'text' }
      yield { kind: 'text-delta', text: JSON.stringify(decision) }
      yield { kind: 'block-end' }
    },
  }
}

describe('loop candidate gateway', () => {
  it('does not invoke a builder or write a registry while disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-'))
    const gateway = new LoopCandidateGateway({
      enabled: false, root, sessionId: 's', provider: 'x', model: 'y', maxTokens: 4096,
    })
    expect(gateway.startExploration('find a loop')).toMatchObject({ accepted: false, state: 'disabled' })
    expect(gateway.status().candidates).toEqual({})
  })

  it('runs actor-requested loop exploration as an observation-only builder run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-explore-'))
    const gateway = new LoopCandidateGateway({
      enabled: true,
      root,
      sessionId: 's',
      provider: 'test',
      model: 'test',
      maxTokens: 128,
      llm: {
        async *stream() {
          yield { kind: 'block-start', type: 'text' }
          yield { kind: 'text-delta', text: '{"kind":"abort","reason":"observation complete"}' }
          yield { kind: 'block-end' }
        },
      },
    })
    const result = await gateway.explore('换一个更强 loop 基座', { activeActorRequest: true })
    expect(result).toMatchObject({ mode: 'exploration', state: 'aborted', accepted: false })
    expect(result.runId).toMatch(/^builder-/)
  })

  it('creates an actor exploration before background execution and exposes its durable inbox to the next Builder turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-async-explore-'))
    let prompt = ''
    const gateway = new LoopCandidateGateway({
      enabled: true,
      root,
      sessionId: 's',
      provider: 'test',
      model: 'test',
      maxTokens: 128,
      llm: {
        async *stream(options: { prompt: string }) {
          prompt = options.prompt
          yield { kind: 'block-start', type: 'text' }
          yield { kind: 'text-delta', text: '{"kind":"abort","reason":"observation complete"}' }
          yield { kind: 'block-end' }
        },
      },
    })

    const started = gateway.startExploration('换一个更强 loop 基座')
    expect(started).toMatchObject({ accepted: true, state: 'created' })
    if (!started.accepted) throw new Error('test requires enabled exploration')
    expect(gateway.explorationStatus(started.runId)).toMatchObject({ state: 'created', inboxMessages: 1 })

    const queued = gateway.messageExploration(started.runId, {
      rawUserText: '优先检查并行安全工具的行为。',
      actorMemo: '这是用户的新优先级，不替代原始任务。',
      evidenceRefs: ['evidence/manifest.json'],
    })
    expect(queued).toMatchObject({ accepted: true, state: 'created', messageId: expect.any(String) })
    expect(gateway.explorationStatus(started.runId)).toMatchObject({ state: 'created', inboxMessages: 2 })
    expect(gateway.events(started.runId, { seq: 0 })).toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ kind: 'actor_message_received', payload: expect.objectContaining({ messageId: queued.messageId }) })]),
    })

    await expect(gateway.runExploration(started.runId)).resolves.toMatchObject({ state: 'aborted', runId: started.runId })
    expect(prompt).toContain('优先检查并行安全工具的行为。')
    expect(prompt).toContain('这是用户的新优先级，不替代原始任务。')
  })

  it('reopens a rejected submitted run with the verifier report and carries the actor inbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-reopen-'))
    const gateway = new LoopCandidateGateway({
      enabled: true,
      root,
      sessionId: 's',
      provider: 'test',
      model: 'test',
      maxTokens: 128,
      llm: submittingLlm(),
    })
    const started = gateway.startExploration('改 model 配置')
    if (!started.accepted) throw new Error('test requires enabled exploration')
    gateway.messageExploration(started.runId, '注意不要动其他配置')
    const submitted = await gateway.runExploration(started.runId)
    expect(submitted).toMatchObject({ state: 'submitted' })
    const nextRunId = gateway.reopenExploration(started.runId, {
      source: 'deliberation',
      verdict: 'rejected',
      failureSummary: 'expected trajectory diverged at tool/call 0',
    })
    expect(nextRunId).not.toBe(started.runId)
    const kernel = new BuilderKernel(root, 's:loop-exploration')
    const next = kernel.context(nextRunId)
    expect(next.input.previousAttempt).toMatchObject({ verdict: 'rejected', failureSummary: 'expected trajectory diverged at tool/call 0' })
    expect(next.messages.map((message) => message.text)).toContain('注意不要动其他配置')
  })

  it('creates a new immutable run with read-only references when resuming after a host interruption', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-resume-'))
    const gateway = new LoopCandidateGateway({
      enabled: true, root, sessionId: 's', provider: 'test', model: 'test', maxTokens: 128,
      llm: submittingLlm(),
    })
    const first = gateway.startExploration('检查并行')
    if (!first.accepted) throw new Error('test requires enabled exploration')
    const kernel = new BuilderKernel(root, 's:loop-exploration')
    kernel.decide(first.runId, { kind: 'tool', action: { name: 'write_workspace_file', path: 'notes/diagnosis.md', content: 'prior result' } })
    const resumed = gateway.startExploration('检查并行', { resumeFromRunId: first.runId })
    if (!resumed.accepted) throw new Error('test requires enabled exploration')
    expect(resumed.runId).not.toBe(first.runId)
    expect(kernel.context(resumed.runId).input.previousRun).toMatchObject({ runId: first.runId })
    expect(kernel.context(resumed.runId).input.previousAttempt).toMatchObject({ source: 'host-restart-resume', priorRunId: first.runId })
  })

  it('resets an actor event cursor when a rejection opens the next immutable run in its lineage', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-cursor-'))
    const gateway = new LoopCandidateGateway({
      enabled: true, root, sessionId: 's', provider: 'test', model: 'test', maxTokens: 128, llm: submittingLlm(),
    })
    const started = gateway.startExploration('改进 loop')
    if (!started.accepted) throw new Error('test requires enabled exploration')
    const kernel = new BuilderKernel(root, 's:loop-exploration')
    const initial = kernel.context(started.runId).messages[0]
    if (!initial) throw new Error('initial message is required')
    kernel.decide(started.runId, { kind: 'tool', action: { name: 'acknowledge_message', messageId: initial.id, status: 'accepted', understanding: '开始处理。' } })
    kernel.decide(started.runId, { kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'patch-evolution', payload: { id: 'p1' } } } })
    kernel.decide(started.runId, { kind: 'submit' })
    const old = gateway.events(started.runId, { seq: 0 })
    const nextRunId = gateway.reopenExploration(started.runId, { verdict: 'rejected', failureSummary: 'retry' })
    const next = gateway.events(nextRunId, { lineageId: old.lineageId, runId: started.runId, seq: Number(old.cursor.split(':').at(-1)) })
    expect(next).toMatchObject({ reset: true, runId: nextRunId, lineageId: old.lineageId })
    expect(next.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'run_created', runId: nextRunId })]))
    expect(next.cursor).toContain(nextRunId)
  })

  it('resumes paused exploration as a fresh immutable attempt with previous-run assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-control-'))
    const gateway = new LoopCandidateGateway({ enabled: true, root, sessionId: 's', provider: 'test', model: 'test', maxTokens: 128, llm: submittingLlm() })
    const started = gateway.startExploration('暂停后继续')
    if (!started.accepted) throw new Error('test requires enabled exploration')
    expect(gateway.controlExploration(started.runId, 'pause')).toMatchObject({ state: 'paused' })
    const resumed = gateway.resumeExploration(started.runId)
    if (!resumed.accepted) throw new Error('test requires enabled exploration')
    expect(resumed.runId).not.toBe(started.runId)
    const kernel = new BuilderKernel(root, 's:loop-exploration')
    expect(kernel.context(resumed.runId).input.previousRun).toMatchObject({ runId: started.runId, lineageId: expect.any(String) })
  })
})
