import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuilderDriver } from '../builder/driver.js'
import { BuilderKernel, builderRunPaths } from '../builder/kernel.js'
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
  it('accepts a native function-call decision envelope through the same tool allowlist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-native-envelope-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([{ decision: { kind: 'tool', action: { tool: 'write_submission', proposal: { capability: 'patch-evolution' } } } }, { decision: { kind: 'submit' } }]),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', compactPrompt: true,
    }).run(kernel, run.id)
    expect(outcome.state).toBe('submitted')
    expect(kernel.proposal(run.id)).toEqual({ capability: 'patch-evolution' })
  })

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
    const visiblePrompts = readFileSync(builderRunPaths(root, 's', run.id).promptVisible, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { promptHash: string; prompt: string; seq: number })
    expect(visiblePrompts).toHaveLength(5)
    expect(visiblePrompts[0]).toMatchObject({ seq: 1, promptHash: expect.stringMatching(/^[a-f0-9]{64}$/), prompt: expect.stringContaining('test') })
  })

  it('starts each turn from compact progress state and references raw inputs by hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-state-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { privateDetail: 'large actor transcript' }, targetBefore: { version: 'before' } })
    const prompts: string[] = []
    await new BuilderDriver({
      llm: decisionsLlm([{ kind: 'abort', reason: 'state prompt inspected' }], prompts),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task',
    }).run(kernel, run.id)
    expect(prompts[0]).toContain('compact progress-state')
    expect(prompts[0]).toContain('"available":true')
    expect(prompts[0]).toContain('"keys":["privateDetail"]')
    expect(prompts[0]).not.toContain('large actor transcript')
    expect(kernel.progressState(run.id)).toMatchObject({ state: 'aborted', lastAction: 'abort' })
  })

  it('gives a diagnosis pass one non-conflicting completion contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-diagnosis-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ mode: 'diagnosis', actor: {}, targetBefore: {} })
    const prompts: string[] = []
    const report = {
      directions: [{ id: 'task-success', goal: 'measure the failing actor contract', evidenceRefs: ['actor-handoff.md'], unknowns: ['priority'], cost: 'low' }],
      question: { question: 'Which direction?', options: [{ id: 'task-success', label: 'Task success' }, { id: 'convergence', label: 'Convergence' }], whyNow: 'evidence cannot infer priority', evidenceRefs: ['actor-handoff.md'] },
    }
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([{ kind: 'tool', action: { name: 'write_diagnosis_report', report } }], prompts),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task',
    }).run(kernel, run.id)
    expect(outcome).toMatchObject({ state: 'waiting_for_input' })
    expect(prompts[0]).toContain('完成定义只有 write_diagnosis_report')
    expect(prompts[0]).not.toContain('完成最小必要探索后应 write_submission')
    expect(prompts[0]).not.toContain('"action":{"name":"write_submission"')
    expect(prompts[0]).not.toContain('"kind":"submit"')
  })

  it('can use a compact prompt with a durable context index instead of the full exemplar block', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-compact-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { veryLargeRawContext: 'x'.repeat(20_000) }, targetBefore: {} })
    const prompts: string[] = []
    await new BuilderDriver({
      llm: decisionsLlm([{ kind: 'abort', reason: 'compact prompt inspected' }], prompts),
      provider: 'test', model: 'test', systemPrompt: 'flow and communication', taskContext: 'short task', compactPrompt: true,
    }).run(kernel, run.id)
    expect(prompts[0]).toContain('Durable context index')
    expect(prompts[0]).toContain('Task objective and entry points')
    expect(prompts[0]).toContain('short task')
    expect(prompts[0]).toContain('context_index')
    expect(prompts[0]).not.toContain('veryLargeRawContext')
    expect(prompts[0]).not.toContain('x'.repeat(1_000))
    expect(prompts[0]).not.toContain('"action":{"name":"write_submission"')
    expect(prompts[0].length).toBeLessThan(5_000)
  })

  it('keeps only the latest compressed tool observation in a compact prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-compact-feedback-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { sourcePath: '/fixture/actor-loop.mjs', veryLargeRawContext: 'x'.repeat(20_000) }, targetBefore: {} })
    const prompts: string[] = []
    await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { name: 'read_input', document: 'actor' } },
        { kind: 'abort', reason: 'feedback inspected' },
      ], prompts),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', compactPrompt: true,
    }).run(kernel, run.id)
    expect(prompts[1]).toContain('Latest observable tool feedback')
    expect(prompts[1]).toContain('/fixture/actor-loop.mjs')
    expect(prompts[1]).not.toContain('x'.repeat(2_000))
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

  it('can append a textual progress banner after unchanged read feedback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-banner-'))
    const kernel = new BuilderKernel(root, 's')
    const source = join(root, 'stable.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(source, 'stable\n', 'utf8')
    const prompts: string[] = []
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { name: 'read_file', path: source } },
        { kind: 'tool', action: { name: 'read_file', path: source } },
        { kind: 'abort', reason: 'banner observed' },
      ], prompts),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', progressBanner: true,
    }).run(kernel, run.id)
    expect(outcome.state).toBe('aborted')
    expect(prompts[2]).toContain('PROGRESS BANNER')
    expect(prompts[2]).toContain('Do not repeat that same read')
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

  it('accepts the compact-protocol tool/input wrapper emitted by a model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-tool-wrapper-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { task: 'read index' }, targetBefore: {} })
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { tool: 'read_input', input: { document: 'context_index' } } },
        { kind: 'abort', reason: 'wrapper accepted' },
      ]),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', compactPrompt: true,
    }).run(kernel, run.id)
    expect(outcome.state).toBe('aborted')
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', action: 'read_input', result: expect.objectContaining({ document: 'context_index' }) }),
    ]))
  })

  it('accepts the name/input wrapper emitted by compact protocol models', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-name-input-wrapper-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { task: 'read actor' }, targetBefore: {} })
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { name: 'read_input', input: { document: 'actor' } } },
        { kind: 'abort', reason: 'wrapper accepted' },
      ]),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', compactPrompt: true,
    }).run(kernel, run.id)
    expect(outcome.state).toBe('aborted')
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', action: 'read_input', result: expect.objectContaining({ document: 'actor' }) }),
    ]))
  })

  it('documents and accepts schema-first provenance navigation in the compact protocol', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-provenance-'))
    const source = join(root, 'candidate.mjs')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(source, 'export function runActorLoop() {}\n', 'utf8')
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {}, previousAttempt: { candidatePath: source, error: 'run is not a function' } })
    const prompts: string[] = []
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { name: 'search_text', input: { query: 'runActorLoop', roots: [root], maxResults: 10 } } },
        { kind: 'tool', action: { name: 'inspect_file', path: source } },
        { kind: 'abort', reason: 'navigation protocol inspected' },
      ], prompts),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', compactPrompt: true,
    }).run(kernel, run.id)
    expect(outcome.state).toBe('aborted')
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', action: 'search_text' }),
      expect.objectContaining({ kind: 'tool', action: 'inspect_file' }),
    ]))
    expect(prompts[0]).toContain('trace_artifact {artifact: id|absolutePath}')
    expect(prompts[0]).toContain('Artifact/provenance graph')
    expect(prompts[0]).toContain('read-only argv search')
  })

  it('accepts the equivalent name/params wrapper emitted by compact protocol models', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-name-params-wrapper-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { task: 'read actor' }, targetBefore: {} })
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { name: 'read_input', params: { document: 'actor' } } },
        { kind: 'abort', reason: 'wrapper accepted' },
      ]),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', compactPrompt: true,
    }).run(kernel, run.id)
    expect(outcome.state).toBe('aborted')
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', action: 'read_input', result: expect.objectContaining({ document: 'actor' }) }),
    ]))
  })

  it('recovers one complete decision when a provider appends a stray closing brace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-trailing-brace-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { task: 'read actor' }, targetBefore: {} })
    let call = 0
    const llm: LlmStreamLike = {
      async *stream() {
        yield { kind: 'block-start', type: 'text' }
        yield { kind: 'text-delta', text: call++ === 0
          ? '{"kind":"tool","action":"read_input","document":"actor"}}'
          : '{"kind":"abort","reason":"done"}' }
        yield { kind: 'block-end', type: 'text' }
      },
    }
    const outcome = await new BuilderDriver({
      llm, provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', compactPrompt: true,
    }).run(kernel, run.id)
    expect(outcome.state).toBe('aborted')
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', action: 'read_input', result: expect.objectContaining({ document: 'actor' }) }),
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

  it('puts rejection failure facts in the compact prompt instead of only graph pointers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-rejection-facts-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({
      actor: { objective: 'Create a dependency-order actor loop candidate.' },
      targetBefore: {},
      previousAttempt: {
        source: 'workspace-oracle',
        verdict: 'rejected',
        failureSummary: 'TypeError: candidate.run is not a function\n    at strict-order-oracle.mjs:10:32',
        firstDivergence: { exitCode: 1 },
        previousCandidatePath: '/fixture/actor-loop.mjs',
        oraclePath: '/fixture/strict-order-oracle.mjs',
      },
    })
    const prompts: string[] = []
    await new BuilderDriver({
      llm: decisionsLlm([{ kind: 'abort', reason: 'rejection facts inspected' }], prompts),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', compactPrompt: true,
    }).run(kernel, run.id)
    expect(prompts[0]).toContain('Previous attempt rejection (facts, not pointers)')
    expect(prompts[0]).toContain('candidate.run is not a function')
    expect(prompts[0]).toContain('/fixture/actor-loop.mjs')
    expect(prompts[0]).toContain('/fixture/strict-order-oracle.mjs')
    expect(prompts[0]).toContain('YOUR OWN workspace')
  })

  it('marks a run ready_to_submit on a passing oracle marker and submits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-success-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { objective: 'fix candidate' }, targetBefore: {} })
    const prompts: string[] = []
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { name: 'run_workspace_command', command: 'node', args: ['-e', "console.log('strict-order-pass')"] } },
        { kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'patch-evolution', patch: { id: 'p1', targetId: 'x', targetKind: 'config', config: {}, dependencies: [], rationale: 'r', expectedOutcome: 'o', version: 1, createdAt: new Date().toISOString() } } } },
        { kind: 'submit' },
      ], prompts),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', compactPrompt: true,
      successMarker: 'strict-order-pass',
    }).run(kernel, run.id)
    expect(outcome.state).toBe('submitted')
    expect(kernel.load(run.id).state).toBe('submitted')
    expect(prompts[1]).toContain('Oracle evidence satisfied')
  })

  it('preserves a marker-verified candidate by refusing further exploration until it is finalized', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-completion-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { objective: 'fix candidate' }, targetBefore: {} })
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'tool', action: { name: 'run_workspace_command', command: 'node', args: ['-e', "console.log('strict-order-pass')"] } },
        { kind: 'tool', action: { name: 'write_workspace_file', path: 'actor-loop.mjs', content: 'broken overwrite' } },
        { kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'patch-evolution', patch: { id: 'p1', targetId: 'x', targetKind: 'config', config: {}, dependencies: [], rationale: 'r', expectedOutcome: 'o', version: 1, createdAt: new Date().toISOString() } } } },
        { kind: 'submit' },
      ]),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', compactPrompt: true,
      successMarker: 'strict-order-pass',
    }).run(kernel, run.id)
    expect(outcome).toMatchObject({ state: 'submitted', modelTurns: 4 })
    expect(() => readFileSync(join(builderRunPaths(root, 's', run.id).workspace, 'actor-loop.mjs'), 'utf8')).toThrow()
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', action: 'write_workspace_file', error: expect.stringContaining('verified completion requires') }),
    ]))
  })

  it('surfaces a rejected submit (missing draft) as visible feedback and recovers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-driver-submit-feedback-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const prompts: string[] = []
    const proposal = { capability: 'patch-evolution', patch: { id: 'p1', targetId: 'x', targetKind: 'config', config: {}, dependencies: [], rationale: 'r', expectedOutcome: 'o', version: 1, createdAt: new Date().toISOString() } }
    const outcome = await new BuilderDriver({
      llm: decisionsLlm([
        { kind: 'submit' },
        { kind: 'tool', action: { name: 'write_submission', proposal } },
        { kind: 'submit' },
      ], prompts),
      provider: 'test', model: 'test', systemPrompt: 'test', taskContext: 'task', compactPrompt: true,
    }).run(kernel, run.id)
    expect(outcome.state).toBe('submitted')
    expect(kernel.proposal(run.id)).toEqual(proposal)
    expect(prompts[1]).toContain('builder submission requires a proposal draft')
  })
})
