import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LoopCandidateGateway } from '../candidates/gateway.js'
import { CandidateImporter } from '../candidates/index.js'
import { BuilderKernel, builderRunPaths } from '../builder/kernel.js'

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

function diagnosisThenImplementationLlm() {
  let wroteSubmission = false
  return {
    async *stream(options: { prompt: string }) {
      const pendingMatch = options.prompt.match(/"pendingMessageIds":\[([^\]]*)\]/)
      const pendingIds = pendingMatch?.[1]
        ? (JSON.parse(`[${pendingMatch[1]}]`) as unknown[]).filter((value): value is string => typeof value === 'string')
        : []
      const diagnosis = options.prompt.includes('当前是 diagnosis-first 对齐 pass')
      const decision = pendingIds[0]
        ? { kind: 'tool', action: { name: 'acknowledge_message', messageId: pendingIds[0], status: 'accepted', understanding: diagnosis ? '先基于证据整理方向，再交由用户选择。' : '已收到用户选择：优先收敛，同时保留安全契约。', nextAction: diagnosis ? '写入诊断报告。' : '冻结一个可验证的候选。' } }
        : diagnosis
          ? {
              kind: 'tool', action: { name: 'write_diagnosis_report', report: {
                observations: [{ fact: 'existing evidence contains both convergence and task-success signals', evidenceRefs: ['evidence/manifest.json'] }],
                directions: [
                  { id: 'convergence', goal: 'reduce repeated unchanged exploration', evidenceRefs: ['evidence/manifest.json'], unknowns: ['whether it is the user priority'], cost: 'low' },
                  { id: 'task-success', goal: 'target a concrete actor failure first', evidenceRefs: ['evidence/manifest.json'], unknowns: ['which workload matters most'], cost: 'medium' },
                ],
                question: {
                  question: 'Which improvement direction should the implementation pass take?',
                  options: [{ id: 'convergence', label: 'Convergence' }, { id: 'task-success', label: 'Task success' }],
                  whyNow: 'The evidence does not establish which product tradeoff the user prefers.',
                  evidenceRefs: ['evidence/manifest.json'],
                },
              } },
            }
          : !wroteSubmission
            ? (wroteSubmission = true, { kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'patch-evolution', payload: { id: 'implementation-p1', targetId: 'candidate', targetKind: 'config', config: {}, dependencies: [], rationale: 'selected direction', expectedOutcome: 'test-only frozen proposal', version: 1, createdAt: new Date().toISOString() } } } })
            : { kind: 'submit' }
      yield { kind: 'block-start', type: 'text' }
      yield { kind: 'text-delta', text: JSON.stringify(decision) }
      yield { kind: 'block-end' }
    },
  }
}

function miniRuntimeFixture(root: string, program: string) {
  const baseline = join(root, 'baseline')
  const snapshot = join(root, 'dependency-snapshot')
  const executable = join(root, 'mini-fixture.sh')
  mkdirSync(join(baseline, 'packages/core/agent-loop/src'), { recursive: true })
  mkdirSync(snapshot, { recursive: true })
  writeFileSync(join(baseline, 'packages/core/agent-loop/src/tool-calls.ts'), 'export const baseline = true\n', 'utf8')
  execFileSync('git', ['init'], { cwd: baseline, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: baseline })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: baseline })
  execFileSync('git', ['add', '.'], { cwd: baseline })
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: baseline, stdio: 'ignore' })
  writeFileSync(executable, program, 'utf8')
  chmodSync(executable, 0o755)
  return { baseline, snapshot, executable }
}

function importerFixture(root: string) {
  const baseline = join(root, 'importer-baseline')
  const dependencies = join(root, 'importer-dependencies')
  const executable = join(root, 'mini-adversarial.sh')
  mkdirSync(join(baseline, 'packages/core/agent-loop/src'), { recursive: true })
  mkdirSync(join(baseline, 'packages/core/agent-loop/lib'), { recursive: true })
  writeFileSync(join(baseline, 'packages/core/agent-loop/src/tool-calls.ts'), 'export const baseline = true\n')
  writeFileSync(join(baseline, 'packages/core/agent-loop/lib/index.js'), 'export const entry = true\n')
  writeFileSync(join(baseline, 'packages/core/agent-loop/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent-loop' }))
  writeFileSync(join(baseline, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  execFileSync('git', ['init'], { cwd: baseline, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: baseline })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: baseline })
  execFileSync('git', ['add', '.'], { cwd: baseline }); execFileSync('git', ['commit', '-m', 'baseline'], { cwd: baseline, stdio: 'ignore' })
  mkdirSync(join(dependencies, 'node_modules', '.bin'), { recursive: true }); mkdirSync(join(dependencies, 'vendor'), { recursive: true })
  for (const tool of ['tsc', 'tsdown']) {
    const script = join(dependencies, 'node_modules', '.bin', tool)
    writeFileSync(script, tool === 'tsc'
      ? '#!/bin/sh\nmkdir -p packages/core/agent-loop/lib\nprintf \'export const candidate = true\\n\' > packages/core/agent-loop/lib/tool-calls.js\n'
      : '#!/bin/sh\nexit 0\n'); chmodSync(script, 0o755)
  }
  writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi\n  if [ "$1" = "-c" ] && case "$2" in environment.cwd=*) true;; *) false;; esac; then work="${2#environment.cwd=}"; shift 2; continue; fi\n  shift\ndone\nprintf \'export const candidate = true\\n\' > "$work/packages/core/agent-loop/src/tool-calls.ts"\nprintf \'runtime scratch\' > "$work/outside.txt"\nprintf \'{"messages":[{"role":"assistant","tool_calls":[{}]},{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
  chmodSync(executable, 0o755)
  return { baseline, dependencies, executable }
}

describe('loop candidate gateway', () => {
  it('uses Loom-native only for a diagnosis pass when mini-SWE is selected for implementation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-mini-diagnosis-'))
    const fixture = miniRuntimeFixture(root, '#!/bin/sh\nexit 1\n')
    const gateway = new LoopCandidateGateway({
      enabled: true, root, sessionId: 's', provider: 'test', model: 'test', maxTokens: 128,
      llm: diagnosisThenImplementationLlm(), executionRuntime: 'mini-swe', diagnosisFirst: true,
      miniSwe: { executable: fixture.executable, configPath: 'ignored', baselineRoot: fixture.baseline, dependencySnapshot: fixture.snapshot, stepLimit: 3, timeoutMs: 5_000 },
    })
    const started = gateway.startExploration('先诊断再实现', { evidencePack: { manifestPath: 'evidence/manifest.json' } })
    if (!started.accepted) throw new Error('test requires an enabled exploration')
    expect(started.passMode).toBe('diagnosis')
    await expect(gateway.runExploration(started.runId)).resolves.toMatchObject({ state: 'waiting_for_input', passMode: 'diagnosis' })
  })

  it('keeps an adversarial runtime outside write out of the archive→Importer candidate artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-adversarial-importer-'))
    const fixture = importerFixture(root)
    const gateway = new LoopCandidateGateway({
      enabled: true, root, sessionId: 's', provider: 'test', model: 'test', maxTokens: 128, llm: submittingLlm(), executionRuntime: 'mini-swe',
      miniSwe: { executable: fixture.executable, configPath: 'ignored', baselineRoot: fixture.baseline, dependencySnapshot: join(fixture.dependencies, 'node_modules'), stepLimit: 3, timeoutMs: 5_000 },
    })
    const started = gateway.startExploration('make one permitted loop change')
    if (!started.accepted) throw new Error('test requires enabled exploration')
    const result = await gateway.runExploration(started.runId)
    if (!result.proposal) throw new Error('test requires a compiler proposal')
    const loop = result.proposal.payload as { source: { kind: 'builder-generated'; baseline: { uri: string; ref: string }; edits: Array<{ path: string; beforeHash: string; after: string }> }; packageName: string; packagePath: string; entry: string; config: Record<string, unknown>; expectedOutcome: string; capabilities: string[] }
    const manifest = new CandidateImporter({ root, baselineRoot: fixture.baseline, buildDependencyRoot: join(fixture.dependencies, 'node_modules') }).acquire({
      id: 'adversarial-loop', displayName: 'adversarial fixture', source: loop.source, packageName: loop.packageName, packagePath: loop.packagePath,
      entry: loop.entry, build: { method: 'sandboxed-dsh-workspace' }, config: loop.config, expectedOutcome: loop.expectedOutcome, capabilities: loop.capabilities,
    })
    expect(readFileSync(join(manifest.artifactPath, 'lib', 'tool-calls.js'), 'utf8')).toContain('candidate = true')
    expect(existsSync(join(manifest.artifactPath, 'node_modules'))).toBe(false)
    expect(existsSync(join(manifest.artifactPath, '..', '..', 'staging', 'adversarial-loop', 'outside.txt'))).toBe(false)
    expect(existsSync(join(builderRunPaths(root, 's--loop-exploration', started.runId).workspace, 'outside.txt'))).toBe(true)
  })

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

  it('aborts a mini-SWE execution with a malformed trajectory without creating a proposal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-mini-malformed-'))
    const mini = miniRuntimeFixture(root, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\nprintf \'not-json\' > "$out"\n')
    const gateway = new LoopCandidateGateway({
      enabled: true, root, sessionId: 's', provider: 'test', model: 'test', maxTokens: 128,
      llm: submittingLlm(), executionRuntime: 'mini-swe',
      miniSwe: { executable: mini.executable, configPath: 'ignored', baselineRoot: mini.baseline, dependencySnapshot: mini.snapshot, stepLimit: 3, timeoutMs: 5_000 },
    })
    const started = gateway.startExploration('修复真实 loop')
    if (!started.accepted) throw new Error('test requires enabled exploration')
    await expect(gateway.runExploration(started.runId)).resolves.toMatchObject({ state: 'aborted', accepted: false, reason: expect.stringContaining('trajectory is unreadable') })
    expect(gateway.explorationStatus(started.runId)).toMatchObject({ state: 'aborted', proposal: { available: false } })
  })

  it('re-materializes a fresh mini-SWE workspace after verifier rejection so the next immutable run can execute', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-mini-reopen-'))
    const mini = miniRuntimeFixture(root, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi\n  if [ "$1" = "-c" ] && case "$2" in environment.cwd=*) true;; *) false;; esac; then work="${2#environment.cwd=}"; shift 2; continue; fi\n  shift\ndone\nprintf \'export const candidate = true\\n\' > "$work/packages/core/agent-loop/src/tool-calls.ts"\nprintf \'{"messages":[{"role":"assistant","tool_calls":[{}]},{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n')
    const gateway = new LoopCandidateGateway({
      enabled: true, root, sessionId: 's', provider: 'test', model: 'test', maxTokens: 128,
      llm: submittingLlm(), executionRuntime: 'mini-swe',
      miniSwe: { executable: mini.executable, configPath: 'ignored', baselineRoot: mini.baseline, dependencySnapshot: mini.snapshot, stepLimit: 3, timeoutMs: 5_000 },
    })
    const started = gateway.startExploration('修复真实 loop')
    if (!started.accepted) throw new Error('test requires enabled exploration')
    await expect(gateway.runExploration(started.runId)).resolves.toMatchObject({ state: 'submitted', accepted: true })
    const nextRunId = gateway.reopenExploration(started.runId, { verdict: 'rejected', failureSummary: 'independent verifier rejected first attempt' })
    const nextWorkspace = builderRunPaths(root, 's--loop-exploration', nextRunId).workspace
    expect(readFileSync(join(nextWorkspace, 'packages/core/agent-loop/src/tool-calls.ts'), 'utf8')).toContain('baseline = true')
    await expect(gateway.runExploration(nextRunId)).resolves.toMatchObject({ state: 'submitted', accepted: true })
  })

  it('uses diagnosis-first to obtain a user choice, then resumes as a fresh immutable implementation pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-diagnosis-first-'))
    const gateway = new LoopCandidateGateway({
      enabled: true, diagnosisFirst: true, root, sessionId: 's', provider: 'test', model: 'test', maxTokens: 128,
      builderMaxModelTurns: 8, builderMaxToolSteps: 12, llm: diagnosisThenImplementationLlm(),
    })
    const diagnosis = gateway.startExploration('让 actor 的 loop 更智能', { evidencePack: { manifestPath: 'evidence/manifest.json' } })
    if (!diagnosis.accepted) throw new Error('test requires enabled exploration')
    expect(diagnosis).toMatchObject({ passMode: 'diagnosis' })
    await expect(gateway.runExploration(diagnosis.runId)).resolves.toMatchObject({ state: 'waiting_for_input', passMode: 'diagnosis' })
    expect(gateway.explorationStatus(diagnosis.runId)).toMatchObject({
      passMode: 'diagnosis', state: 'waiting_for_input',
      diagnosisReport: {
        available: true,
        directions: expect.arrayContaining([expect.objectContaining({ id: 'convergence' })]),
        question: expect.objectContaining({ options: expect.arrayContaining([expect.objectContaining({ id: 'convergence' })]) }),
      },
    })

    gateway.messageExploration(diagnosis.runId, {
      rawUserText: '选择 convergence：先减少重复读取，但不能牺牲安全契约。',
      actorMemo: 'selectedOption=convergence；保持安全边界。',
      idempotencyKey: 'choice-1',
    })
    const implementation = gateway.resumeExploration(diagnosis.runId)
    if (!implementation.accepted) throw new Error('test requires enabled exploration')
    expect(implementation).toMatchObject({ passMode: 'implementation' })
    expect(implementation.runId).not.toBe(diagnosis.runId)

    const kernel = new BuilderKernel(root, 's--loop-exploration')
    const next = kernel.context(implementation.runId)
    expect(next.run).toMatchObject({ mode: 'implementation', lineageId: kernel.load(diagnosis.runId).lineageId, parentRunId: diagnosis.runId })
    expect(next.input.previousRun).toMatchObject({ runId: diagnosis.runId })
    expect(next.messages.map((message) => message.rawUserText)).toContain('选择 convergence：先减少重复读取，但不能牺牲安全契约。')

    await expect(gateway.runExploration(implementation.runId)).resolves.toMatchObject({ state: 'submitted', passMode: 'implementation' })
    expect(gateway.explorationStatus(implementation.runId)).toMatchObject({ proposal: { available: true } })
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
    const kernel = new BuilderKernel(root, 's--loop-exploration')
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
    const kernel = new BuilderKernel(root, 's--loop-exploration')
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
    const kernel = new BuilderKernel(root, 's--loop-exploration')
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
    const kernel = new BuilderKernel(root, 's--loop-exploration')
    expect(kernel.context(resumed.runId).input.previousRun).toMatchObject({ runId: started.runId, lineageId: expect.any(String) })
  })
})
