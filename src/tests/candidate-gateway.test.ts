import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LoopCandidateGateway } from '../candidates/gateway.js'

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
    expect(gateway.explorationStatus(started.runId)).toMatchObject({ state: 'created', inboxMessages: 0 })

    const queued = gateway.messageExploration(started.runId, '优先检查并行安全工具的行为。')
    expect(queued).toMatchObject({ accepted: true, state: 'created' })
    expect(gateway.explorationStatus(started.runId)).toMatchObject({ state: 'created', inboxMessages: 1 })

    await expect(gateway.runExploration(started.runId)).resolves.toMatchObject({ state: 'aborted', runId: started.runId })
    expect(prompt).toContain('优先检查并行安全工具的行为。')
  })
})
