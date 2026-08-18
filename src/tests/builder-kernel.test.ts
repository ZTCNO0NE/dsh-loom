import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
    expect(resumed.progressState).toMatchObject({ state: 'exploring', phase: 'exploring', known: [], unknowns: [] })
  })

  it('maintains a compact progress state without replacing the full evidence files', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-progress-state-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { requirements: '提高真实任务成功率' }, targetBefore: { version: 1 } })
    expect(kernel.progressState(run.id)).toMatchObject({
      objective: '提高真实任务成功率', phase: 'observing', unchangedReadStreak: 0,
      nextIntent: expect.stringContaining('falsifiable hypothesis'),
    })
    kernel.decide(run.id, { kind: 'tool', action: { name: 'write_world_model', value: {
      hypothesis: '减少重复读取可提高有效探索率', known: ['源码已可读'], unknowns: ['仿真是否复现'], nextIntent: '运行最小仿真',
    } } })
    expect(kernel.progressState(run.id)).toMatchObject({
      phase: 'hypothesizing', hypothesis: '减少重复读取可提高有效探索率', known: ['源码已可读'], unknowns: ['仿真是否复现'], nextIntent: '运行最小仿真',
    })
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'read_input', document: 'progress_state' } })).toMatchObject({
      document: 'progress_state', value: expect.objectContaining({ hypothesis: '减少重复读取可提高有效探索率' }),
    })
    expect(readFileSync(builderRunPaths(root, 's', run.id).progressState, 'utf8')).toContain('减少重复读取可提高有效探索率')
  })

  it('persists a durable context index that maps prompt references to full evidence files', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-context-index-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: { requirements: 'inspect a real failure', sourcePath: '/tmp/source.ts' }, targetBefore: { baseline: 'before' } })
    const index = kernel.context(run.id).contextIndex
    expect(index).toMatchObject({ runId: run.id, entries: expect.arrayContaining([
      expect.objectContaining({ id: 'actor', path: builderRunPaths(root, 's', run.id).actor }),
      expect.objectContaining({ id: 'journal', path: builderRunPaths(root, 's', run.id).journal }),
      expect.objectContaining({ id: 'workspace', path: builderRunPaths(root, 's', run.id).workspace }),
    ]) })
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'read_input', document: 'context_index' } })).toMatchObject({
      document: 'context_index', value: expect.objectContaining({ runId: run.id }),
    })
  })

  it('persists an evidence-backed diagnosis report, waits for user direction, and forbids proposal submission', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-diagnosis-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ mode: 'diagnosis', actor: { requirements: '让 loop 更智能' }, targetBefore: {} })
    const report = {
      observations: [{ fact: 'recent runs repeatedly reread unchanged source', evidenceRefs: ['journal:18'] }],
      directions: [
        { id: 'convergence', goal: 'reduce repeated unchanged reads before a candidate is formed', evidenceRefs: ['journal:18'], unknowns: ['whether the user prioritizes reliability or latency'], cost: 'low' },
        { id: 'task-success', goal: 'measure a concrete actor task failure before changing the loop', evidenceRefs: ['actor-handoff.md'], unknowns: ['which task matters most'], cost: 'medium' },
      ],
      question: {
        question: 'Which direction should the next implementation pass prioritize?',
        options: [{ id: 'convergence', label: 'Convergence' }, { id: 'task-success', label: 'Task success' }],
        whyNow: 'The available evidence shows both problems but cannot infer the product priority.',
        evidenceRefs: ['journal:18', 'actor-handoff.md'],
      },
    }

    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'write_diagnosis_report', report } })).toMatchObject({
      written: 'diagnosis_report', waitingFor: 'user_direction',
    })
    expect(kernel.load(run.id)).toMatchObject({ mode: 'diagnosis', state: 'waiting_for_input', phase: 'waiting_for_actor' })
    expect(kernel.context(run.id).diagnosisReport).toEqual(report)
    expect(kernel.events(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'diagnosis_report', payload: expect.objectContaining({ directions: 2 }) }),
    ]))
    expect(() => kernel.decide(run.id, { kind: 'submit' })).toThrow(/not runnable/)

    const prohibited = kernel.create({ mode: 'diagnosis', actor: {}, targetBefore: {} })
    expect(() => kernel.decide(prohibited.id, { kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'patch-evolution', payload: { id: 'must-not-submit' } } } })).toThrow(/diagnosis pass cannot write a proposal/)
    expect(kernel.proposal(prohibited.id)).toBeNull()

    const malformed = kernel.create({ mode: 'diagnosis', actor: {}, targetBefore: {} })
    expect(() => kernel.decide(malformed.id, {
      kind: 'tool', action: { name: 'write_diagnosis_report', report: { directions: [{ id: 'only' }] } },
    })).toThrow(/diagnosis direction requires goal/)
    expect(kernel.load(malformed.id).state).toBe('exploring')
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
      observation: { newInformation: true },
    })
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'read_file', path: source } })).toMatchObject({
      observation: { newInformation: false, unchangedSinceSeq: expect.any(Number) },
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

  it('builds a factual rejection-to-candidate provenance route and exposes read-only causal navigation tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-provenance-'))
    const candidate = join(root, 'candidate.mjs')
    const oracle = join(root, 'oracle.mjs')
    writeFileSync(candidate, 'export async function runActorLoop() { return 1 }\n', 'utf8')
    writeFileSync(oracle, 'import { run } from "./candidate.mjs"\nawait run()\n', 'utf8')
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({
      actor: { objective: 'repair the rejected candidate' }, targetBefore: {},
      previousAttempt: { verdict: 'rejected', failureSummary: 'TypeError: run is not a function', candidatePath: candidate, oraclePath: oracle },
    })
    const graph = kernel.context(run.id).provenance
    const failure = graph.artifacts.find((artifact) => artifact.role === 'failure_report')
    expect(failure).toBeDefined()
    const traced = kernel.decide(run.id, { kind: 'tool', action: { name: 'trace_artifact', artifact: failure!.id } })
    expect(traced).toMatchObject({
      found: true,
      relatedArtifacts: expect.arrayContaining([expect.objectContaining({ path: candidate, role: 'candidate' })]),
      edges: expect.arrayContaining([expect.objectContaining({ relation: 'consumes' })]),
    })
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'inspect_file', path: candidate } })).toMatchObject({
      path: candidate,
      exports: expect.arrayContaining(['runActorLoop']),
      language: 'javascript',
    })
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'search_text', query: 'runActorLoop', roots: [root] } })).toMatchObject({
      matches: expect.arrayContaining([expect.objectContaining({ path: candidate })]),
    })
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'read_input', document: 'provenance' } })).toMatchObject({
      value: expect.objectContaining({ artifacts: expect.arrayContaining([expect.objectContaining({ path: candidate })]) }),
    })
  })

  it('persists a structured clarification request without granting verification authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    expect(kernel.decide(run.id, {
      kind: 'tool',
      action: {
        name: 'request_input', kind: 'choice',
        question: '并发安全和吞吐应优先哪一个？',
        options: [{ id: 'safe', label: '优先安全' }, { id: 'throughput', label: '优先吞吐', description: '需要真实性能 probe' }],
        whyNow: '两个本地模拟均通过，无法确定产品取舍。',
        evidenceRefs: ['artifact/sim-1.json'],
      },
    })).toMatchObject({ requested: true, kind: 'choice', blocking: true })
    expect(kernel.load(run.id).state).toBe('waiting_for_input')
    expect(kernel.events(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'needs_input', payload: expect.objectContaining({ options: expect.arrayContaining([expect.objectContaining({ id: 'safe' })]), whyNow: expect.any(String) }) }),
    ]))
    expect(kernel.load(run.id).phase).toBe('waiting_for_actor')
  })

  it('rejects malformed choice and verification requests without changing the run phase', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-input-guards-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    expect(() => kernel.decide(run.id, {
      kind: 'tool', action: { name: 'request_input', kind: 'choice', question: '选择？', options: [{ id: 'only', label: '只有一个' }] },
    })).toThrow(/at least two options/)
    expect(kernel.load(run.id).phase).toBe('exploring')
    expect(() => kernel.decide(run.id, {
      kind: 'tool', action: { name: 'request_input', kind: 'verification', question: '请做真实验证。', whyNow: '仿真不足' },
    })).toThrow(/evidenceRefs/)
    expect(kernel.load(run.id).phase).toBe('exploring')
    expect(kernel.decide(run.id, {
      kind: 'tool', action: { name: 'request_input', kind: 'verification', question: '请做真实验证。', whyNow: '仿真不足', evidenceRefs: ['state/sim.json'] },
    })).toMatchObject({ requested: true, kind: 'verification' })
    expect(kernel.load(run.id).phase).toBe('waiting_for_verification')
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

  it('can reject unchanged reads at an experimental deterministic threshold without aborting the run', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-progress-guard-'))
    const kernel = new BuilderKernel(root, 's', undefined, { repeatReadRejectAfter: 2 })
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const source = join(root, 'stable.txt')
    writeFileSync(source, 'stable feedback\n', 'utf8')
    kernel.decide(run.id, { kind: 'tool', action: { name: 'read_file', path: source } })
    kernel.decide(run.id, { kind: 'tool', action: { name: 'read_file', path: source } })
    expect(() => kernel.decide(run.id, { kind: 'tool', action: { name: 'read_file', path: source } })).toThrow(/unchanged read rejected/)
    expect(kernel.load(run.id).state).toBe('exploring')
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', action: 'read_file', result: expect.objectContaining({ guard: 'repeatReadRejectAfter' }) }),
    ]))
  })

  it('turns a no-progress rejection into public direction and evidence checkpoints when enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-checkpoint-'))
    const kernel = new BuilderKernel(root, 's', undefined, {
      repeatReadRejectAfter: 2,
      enforceProgressCheckpoints: true,
    })
    const run = kernel.create({ actor: {}, targetBefore: {} })
    const source = join(root, 'stable.txt')
    writeFileSync(source, 'stable feedback\n', 'utf8')

    kernel.decide(run.id, { kind: 'tool', action: { name: 'read_file', path: source } })
    kernel.decide(run.id, { kind: 'tool', action: { name: 'read_file', path: source } })
    expect(() => kernel.decide(run.id, { kind: 'tool', action: { name: 'read_file', path: join(root, 'another.txt') } })).toThrow(/unchanged read rejected/)
    expect(kernel.progressState(run.id)).toMatchObject({ progressRequirement: 'declare_direction' })

    expect(() => kernel.decide(run.id, { kind: 'tool', action: { name: 'read_journal', limit: 5 } })).toThrow(/progress checkpoint required/)
    expect(() => kernel.decide(run.id, { kind: 'tool', action: { name: 'write_world_model', value: {} } })).toThrow(/hypothesis is required/)
    kernel.decide(run.id, { kind: 'tool', action: { name: 'write_world_model', value: {
      hypothesis: '公开假设后才能区分重复事实和新证据', known: ['稳定文件内容未变化'], unknowns: ['仿真是否能复现'], nextIntent: '运行一次最小仿真',
    } } })
    expect(kernel.progressState(run.id)).toMatchObject({ progressRequirement: 'none' })
    expect(kernel.decide(run.id, { kind: 'tool', action: { name: 'read_file', path: source } })).toMatchObject({ content: 'stable feedback\n' })
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', result: expect.objectContaining({ guard: 'progressCheckpoint', progressRequirement: 'declare_direction' }) }),
    ]))
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

  it('maps a prior-run workspace absolute path to the current repair workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-workspace-map-'))
    const kernel = new BuilderKernel(root, 's')
    const prior = kernel.create({ actor: { objective: 'seed' }, targetBefore: {} })
    const priorPaths = builderRunPaths(root, 's', prior.id)
    kernel.decide(prior.id, { kind: 'tool', action: { name: 'write_workspace_file', path: 'actor-loop.mjs', content: 'export async function runActorLoop() {}' } })
    const priorFile = join(priorPaths.workspace, 'actor-loop.mjs')
    expect(existsSync(priorFile)).toBe(true)

    const repair = kernel.create({ actor: { objective: 'fix' }, targetBefore: {} })
    const repairPaths = builderRunPaths(root, 's', repair.id)
    kernel.decide(repair.id, { kind: 'tool', action: { name: 'write_workspace_file', path: priorFile, content: 'export async function run(tools) { return [] }' } })
    const repaired = join(repairPaths.workspace, 'actor-loop.mjs')
    expect(readFileSync(repaired, 'utf8')).toContain('export async function run(tools)')
    expect(readFileSync(priorFile, 'utf8')).toContain('runActorLoop')

    expect(() => kernel.decide(repair.id, { kind: 'tool', action: { name: 'write_workspace_file', path: '/etc/passwd', content: 'x' } })).toThrow(/escapes builder workspace/)
  })

  it('normalizes a workspace-prefixed relative path to the run workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-builder-workspace-prefix-'))
    const kernel = new BuilderKernel(root, 's')
    const run = kernel.create({ actor: {}, targetBefore: {} })
    kernel.decide(run.id, { kind: 'tool', action: { name: 'write_workspace_file', path: 'workspace/actor-loop.mjs', content: 'export async function run(tools) { return [] }' } })
    const runPaths = builderRunPaths(root, 's', run.id)
    expect(readFileSync(join(runPaths.workspace, 'actor-loop.mjs'), 'utf8')).toContain('export async function run(tools)')
    expect(existsSync(join(runPaths.workspace, 'workspace', 'actor-loop.mjs'))).toBe(false)
    const read = kernel.decide(run.id, { kind: 'tool', action: { name: 'read_workspace_file', path: 'workspace/actor-loop.mjs' } })
    expect(read).toMatchObject({ path: 'actor-loop.mjs' })
  })
})
