import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuilderDriver } from '../builder/driver.js'
import { BuilderKernel } from '../builder/kernel.js'
import type { LlmCallOptions, LlmStreamLike } from '../meta/propose.js'

function decisionsLlm(decisions: unknown[], prompts: string[] = []): LlmStreamLike {
  let index = 0
  return {
    async *stream(options: LlmCallOptions) {
      prompts.push(options.prompt)
      yield { kind: 'block-start', type: 'text' }
      yield { kind: 'text-delta', text: JSON.stringify(decisions[Math.min(index++, decisions.length - 1)]) }
      yield { kind: 'block-end', type: 'text' }
    },
  }
}

describe('BuilderDriver', () => {
  it('feeds core-authored tool results back through a bounded multi-step run before submit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { turn: 3 }, targetBefore: { timeoutMs: 5 } })
    const proposal = {
      patch: { targetId: 'row-a', targetKind: 'config', config: { timeoutMs: 30 }, dependencies: [], rationale: 'timeout', expectedOutcome: 'ok', version: 1 },
      expectedTrajectory: { events: [], coverage: { claimedBehaviors: [] } },
      selfCheck: { confidence: 0.8, completeness: 0.8 },
    }
    const prompts: string[] = []
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { name: 'read_input', document: 'actor' } },
        { kind: 'tool', action: { name: 'write_candidate_draft', proposal } },
        { kind: 'tool', action: { name: 'inspect_staging', path: 'candidate.json' } },
        { kind: 'tool', action: { name: 'preflight_staging_entry', entry: 'candidate.json' } },
        { kind: 'submit' },
      ], prompts),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task',
    }).run(kernel, run.id)

    expect(outcome).toMatchObject({ state: 'submitted', modelTurns: 5, toolSteps: 4, proposal })
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', action: 'read_input' }),
      expect.objectContaining({ kind: 'tool', action: 'write_candidate_draft' }),
      expect.objectContaining({ kind: 'tool', action: 'preflight_staging_entry', result: expect.objectContaining({ passed: true }) }),
      expect.objectContaining({ kind: 'state', action: 'submit' }),
    ]))
    expect(prompts[1]).toContain('"action":"read_input"')
    expect(prompts[2]).toContain('"written":"candidate_draft"')
    expect(kernel.proposal(run.id)).toEqual(proposal)
  })

  it('logs an escaping tool error as feedback and aborts only when the builder chooses to abort', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { name: 'inspect_staging', path: '../outside' } },
        { kind: 'abort', reason: 'staging path denied' },
      ]),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task',
    }).run(kernel, run.id)
    expect(outcome).toMatchObject({ state: 'aborted', modelTurns: 2, toolSteps: 1 })
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', action: 'inspect_staging', error: 'Error: staging path is unavailable' }),
    ]))
  })

  it('aborts on the configured model-turn budget and never writes a proposal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([{ kind: 'continue', summary: 'need one more turn' }]),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', maxModelTurns: 2,
    }).run(kernel, run.id)
    expect(outcome).toMatchObject({ state: 'aborted', modelTurns: 2 })
    expect(kernel.proposal(run.id)).toBeNull()
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', action: 'budget' }),
    ]))
  })

  it('lets a reopened builder choose its own response to failure feedback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-'))
    const kernel = new BuilderKernel(root, 's')
    const prompts: string[] = []
    const run = kernel.create({ actor: {}, targetBefore: {}, previousAttempt: { failureClass: 'source_rate_limited', retryable: true } })
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([{ kind: 'abort', reason: 'switch strategy requires a suitable source' }], prompts),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task',
    }).run(kernel, run.id)
    expect(outcome.state).toBe('aborted')
    expect(prompts[0]).not.toContain('switch_git_source、builder_generated 或 abort')
  })

  it('accepts the equivalent tool-name wrapper emitted by a model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-wrapper-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { action: 'write_world_model', value: { observed: true } }, note: 'metadata' },
        { kind: 'abort', reason: 'done' },
      ]),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task',
    }).run(kernel, run.id)
    expect(outcome.state).toBe('aborted')
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', action: 'write_world_model' }),
    ]))
  })

  it('lets Builder acknowledge an Actor-mediated user message without exposing hidden reasoning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-message-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const message = kernel.receiveActorMessage(run.id, {
      rawUserText: '请优先检查安全边界。',
      actorMemo: '用户要求优先级调整。',
    })
    const prompts: string[] = []
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { name: 'acknowledge_message', messageId: message.id, status: 'accepted', understanding: '先检查安全边界。', nextAction: '读取相关源码。' } },
        { kind: 'abort', reason: 'test complete' },
      ], prompts),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task',
    }).run(kernel, run.id)
    expect(outcome.state).toBe('aborted')
    expect(kernel.events(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message_ack', payload: expect.objectContaining({ messageId: message.id, understanding: '先检查安全边界。' }) }),
    ]))
    expect(prompts[0]).toContain('请优先检查安全边界。')
    expect(prompts[0]).toContain('用户要求优先级调整。')
    expect(prompts[0]).toContain(message.id)
  })

  it('returns a typed waiting_for_input outcome and persists the question', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-input-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([{ kind: 'tool', action: { name: 'request_input', question: '请确认目标优先级。' } }]),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task',
    }).run(kernel, run.id)
    expect(outcome).toMatchObject({ state: 'waiting_for_input', runId: run.id })
    expect(kernel.events(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'needs_input', payload: expect.objectContaining({ question: '请确认目标优先级。' }) }),
    ]))
  })
})
