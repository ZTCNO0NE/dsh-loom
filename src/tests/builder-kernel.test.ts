import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuilderKernel, builderRunPaths } from '../builder/kernel.js'

describe('BuilderKernel', () => {
  it('persists immutable inputs and core-authored tool feedback for a resumed run', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { frameWatermark: 4 }, targetBefore: { entry: 'base' }, previousAttempt: { verdict: 'rejected' } })
    kernel.transition(run.id, 'exploring')
    kernel.append(run.id, 'tool', 'inspect-entry', { exitCode: 1 }, 'missing entry')
    const resumed = new BuilderKernel(root, 's').context(run.id)
    expect(resumed.run.state).toBe('exploring')
    expect(resumed.input).toMatchObject({ actor: { frameWatermark: 4 }, targetBefore: { entry: 'base' }, previousAttempt: { verdict: 'rejected' } })
    expect(resumed.journal).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool', action: 'inspect-entry', error: 'missing entry' })]))
  })

  it('does not permit a terminal builder run to be reopened', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    kernel.transition(run.id, 'aborted')
    expect(() => kernel.transition(run.id, 'exploring')).toThrow(/terminal/)
  })

  it('gives the base builder global read, a persistent workspace, command feedback, and a generic frozen submission', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-'))
    const source = join(root, 'actor-state.txt')
    writeFileSync(source, 'actor failed at step 2\n', 'utf8')
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { task: 'repair' }, targetBefore: { version: 'before' } })

    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'read_file', path: source } })).toMatchObject({
      path: source,
      content: 'actor failed at step 2\n',
    })
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'list_directory', path: root } })).toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ name: 'actor-state.txt', type: 'file' })]),
    })
    kernel.decide(run.id, { kind: 'tool', action: { name: 'write_workspace_file', path: 'notes/diagnosis.txt', content: 'inspect actor trace' } })
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'read_workspace_file', path: 'notes/diagnosis.txt' } })).toMatchObject({
      content: 'inspect actor trace',
    })
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'run_workspace_command', command: process.execPath, args: ['-e', 'console.log("probe-ok")'] } })).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('probe-ok'),
    })
    const proposal = { capability: 'loop-evolution', changes: [{ kind: 'candidate-diff', path: 'src/index.ts' }] }
    kernel.decide(run.id, { kind: 'tool', action: { name: 'write_submission', proposal } })
    expect(kernel.decide(run.id, { kind: 'submit' })).toMatchObject({ state: 'submitted' })
    expect(kernel.proposal(run.id)).toEqual(proposal)
  })

  it('records allowlisted tool feedback, freezes submission, and hands rejection to a fresh run', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { frameWatermark: 9 }, targetBefore: { entry: 'base' } })
    const paths = builderRunPaths(root, 's', run.id)
    mkdirSync(paths.staging, { recursive: true })
    const proposal = { patch: { targetId: 'safe', targetKind: 'config', config: { safe: true } } }
    writeFileSync(join(paths.staging, 'candidate.json'), JSON.stringify(proposal))
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'inspect_staging', path: 'candidate.json' } })).toMatchObject({ content: JSON.stringify(proposal) })
    kernel.decide(run.id, { kind: 'tool', action: { name: 'write_plan', value: { next: 'preflight' } } })
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'preflight_staging_entry', entry: 'candidate.json' } })).toMatchObject({ passed: true })
    kernel.decide(run.id, { kind: 'submit' })
    const next = kernel.reopenFromRejection(run.id, { verdict: 'rejected', firstDivergence: 'entry' })
    expect(kernel.context(next.id).input.previousAttempt).toMatchObject({ verdict: 'rejected' })
    expect(kernel.context(next.id).input.previousRun).toMatchObject({
      runId: run.id,
      workspacePath: paths.workspace,
      assets: expect.arrayContaining([expect.objectContaining({ name: 'journal', exists: true, hash: expect.any(String) })]),
    })
    expect(kernel.decide(next.id, { kind: 'tool', action: { name: 'read_input', document: 'previous_run' } })).toMatchObject({
      value: expect.objectContaining({ runId: run.id }),
    })
    expect(() => kernel.decide(next.id, { kind: 'tool', action: { name: 'inspect_staging', path: '../outside' } })).toThrow(/unavailable/)
  })

  it('aborts a repeated tool only when feedback makes no progress', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-journal-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { task: 'journal' }, targetBefore: {} })
    const source = join(root, 'stable.txt')
    writeFileSync(source, 'stable feedback\n', 'utf8')
    for (let i = 0; i < 40 && kernel.load(run.id).state !== 'aborted'; i++) {
      kernel.decide(run.id, { kind: 'tool', action: { name: 'read_file', path: source } })
    }
    const journalPath = builderRunPaths(root, 's', run.id).journal
    expect(statSync(journalPath).size).toBeLessThan(1_000_000)
    expect(kernel.load(run.id).state).toBe('aborted')
  })

  it('allows a repeated read when the workspace feedback changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-progress-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const source = join(root, 'changing.txt')
    for (let i = 0; i < 12; i++) {
      writeFileSync(source, `iteration ${i}\n`, 'utf8')
      expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'read_file', path: source } })).toMatchObject({
        content: `iteration ${i}\n`,
      })
    }
    expect(kernel.load(run.id).state).not.toBe('aborted')
  })

  it('preserves user wording, actor interpretation, and Builder acknowledgement in durable events', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-conversation-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const message = kernel.receiveActorMessage(run.id, {
      rawUserText: '优先改进并行，但不要降低安全性。',
      actorMemo: '吞吐是优先级；安全契约不可放松。',
      evidenceRefs: ['evidence/session/manifest.json'],
    })
    expect(kernel.messages(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: message.id, rawUserText: '优先改进并行，但不要降低安全性。', actorMemo: '吞吐是优先级；安全契约不可放松。' }),
    ]))
    kernel.decide(run.id, {
      kind: 'tool',
      action: {
        name: 'acknowledge_message',
        messageId: message.id,
        status: 'accepted',
        understanding: '先验证并行安全，再评估吞吐。',
        nextAction: '读取调度路径并运行最小并发实验。',
      },
    })
    kernel.decide(run.id, {
      kind: 'tool',
      action: { name: 'publish_progress', phase: 'diagnosis', summary: '已开始检查调度路径。', question: '是否优先覆盖 12 工具场景？' },
    })
    expect(kernel.decide(run.id, {
      kind: 'tool',
      action: { name: 'acknowledge_message', messageId: message.id, status: 'accepted', understanding: '重复回执不应增加事件。' },
    })).toMatchObject({ acknowledged: message.id, deduplicated: true })
    expect(kernel.events(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'actor_message_received', payload: expect.objectContaining({ messageId: message.id }) }),
      expect.objectContaining({ kind: 'message_ack', payload: expect.objectContaining({ messageId: message.id, status: 'accepted' }) }),
      expect.objectContaining({ kind: 'builder_update', payload: expect.objectContaining({ phase: 'diagnosis', question: '是否优先覆盖 12 工具场景？' }) }),
    ]))
    expect(kernel.events(run.id).filter((event) => event.kind === 'message_ack' && event.payload.messageId === message.id)).toHaveLength(1)
  })

  it('deduplicates retried actor delivery, rejects conflicting reuse, and requires acknowledgement before submit', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-idempotency-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const input = { rawUserText: '请保留证据并优先检查失败原因。', actorMemo: '这是重试消息。', idempotencyKey: 'user-turn-42' }
    const first = kernel.receiveActorMessage(run.id, input)
    const retried = kernel.receiveActorMessage(run.id, input)
    expect(retried).toMatchObject({ id: first.id, deduplicated: true })
    expect(kernel.messages(run.id)).toHaveLength(1)
    expect(() => kernel.receiveActorMessage(run.id, { ...input, rawUserText: '内容已经变了。' })).toThrow(/conflicts/)

    const proposal = { capability: 'patch-evolution', payload: { id: 'p1' } }
    kernel.decide(run.id, { kind: 'tool', action: { name: 'write_submission', proposal } })
    expect(() => kernel.decide(run.id, { kind: 'submit' })).toThrow(/acknowledgement/)
    kernel.decide(run.id, { kind: 'tool', action: { name: 'acknowledge_message', messageId: first.id, status: 'accepted', understanding: '已理解。' } })
    expect(kernel.decide(run.id, { kind: 'submit' })).toMatchObject({ state: 'submitted' })
    const manifest = JSON.parse(readFileSync(builderRunPaths(root, 's', run.id).submissionManifest, 'utf8')) as { proposalHash?: string; inputHash?: string }
    expect(manifest).toMatchObject({ proposalHash: expect.any(String), inputHash: kernel.load(run.id).inputHash })
  })

  it('rejects a submission when a declared frozen artifact changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-manifest-'))
    const artifact = join(root, 'artifact.txt')
    writeFileSync(artifact, 'checked content', 'utf8')
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    kernel.decide(run.id, { kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'patch-evolution', artifacts: [artifact] } } })
    writeFileSync(artifact, 'mutated content', 'utf8')
    expect(() => kernel.decide(run.id, { kind: 'submit' })).toThrow(/changed after freeze/)
  })

  it('pauses, cancels, and exposes a typed needs_input boundary without allowing tool execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-control-'))
    const kernel = new BuilderKernel(root, 's')
    const waiting = kernel.create({ actor: {}, targetBefore: {} })
    const question = kernel.decide(waiting.id, { kind: 'tool', action: { name: 'request_input', question: '优先保留吞吐还是严格顺序？', context: '两个候选都能通过契约。' } })
    expect(question).toMatchObject({ requested: true })
    expect(kernel.load(waiting.id).state).toBe('waiting_for_input')
    expect(kernel.events(waiting.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'needs_input', payload: expect.objectContaining({ question: '优先保留吞吐还是严格顺序？' }) }),
    ]))
    expect(() => kernel.decide(waiting.id, { kind: 'tool', action: { name: 'read_journal', limit: 1 } })).toThrow(/not runnable/)
    kernel.receiveActorMessage(waiting.id, '用户确认保留严格顺序。')
    expect(kernel.load(waiting.id).state).toBe('waiting_for_input')

    const paused = kernel.create({ actor: {}, targetBefore: {} })
    expect(kernel.control(paused.id, 'pause').state).toBe('paused')
    expect(() => kernel.decide(paused.id, { kind: 'tool', action: { name: 'read_journal', limit: 1 } })).toThrow(/not runnable/)
    expect(kernel.control(paused.id, 'cancel').state).toBe('cancelled')
    expect(() => kernel.control(paused.id, 'pause')).toThrow(/terminal/)
  })
})
