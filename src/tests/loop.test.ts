import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IterationLoop } from '../meta/loop.js'
import { Proposer, type LlmStreamLike } from '../meta/propose.js'
import { Gate } from '../gate/index.js'
import type { ApplyOps } from '../gate/index.js'
import { paths, readJson } from '../protocol/index.js'
import type { MetaPatch, PatchStatus, RegressionCase, ValidationReport } from '../types.js'
import type { VerifierInput } from '../validate/index.js'

function stubLlm(json: string): LlmStreamLike {
  return {
    async *stream() {
      yield { kind: 'block-start', type: 'text' }
      yield { kind: 'text-delta', text: json }
      yield { kind: 'block-end', type: 'text' }
    },
  }
}

const VALID = JSON.stringify({
  patch: { targetId: 'row-a', targetKind: 'config', config: { timeoutMs: 30000 }, dependencies: [], rationale: 'x', expectedOutcome: 'ok', version: 1 },
  expectedTrajectory: { events: [{ type: 'turn/start' }, { type: 'turn/end', reason: 'success' }], coverage: { claimedBehaviors: [] } },
  selfCheck: { confidence: 0.9, completeness: 0.8 },
})

const INSERT_TOOL = JSON.stringify({
  patch: {
    action: 'insert',
    targetId: 'fs-write',
    targetName: 'fs-write',
    targetKind: 'tool',
    config: {},
    module: { files: [{ path: 'index.mjs', content: 'export const name = "fs-write"\n' }], entry: 'index.mjs' },
    dependencies: [],
    rationale: 'from-zero L1',
    expectedOutcome: 'fs-write 可加载',
    version: 1,
  },
  expectedTrajectory: {
    events: [{ type: 'turn/start' }, { type: 'tool/result', name: 'fs-write', error: null }, { type: 'turn/end', reason: 'success' }],
    coverage: { claimedBehaviors: ['fs-write'] },
  },
  selfCheck: { confidence: 0.9, completeness: 0.8 },
})

const INSERT_SKILL = JSON.stringify({
  patch: {
    action: 'insert',
    targetId: 'edit-verify',
    targetKind: 'skill',
    config: {},
    module: { files: [{ path: 'edit-verify/SKILL.md', content: '---\nname: edit-verify\n---\nwc -l body\n' }], entry: 'edit-verify/SKILL.md' },
    dependencies: [],
    rationale: 'from-zero L4',
    expectedOutcome: '编辑后验证',
    version: 1,
  },
  expectedTrajectory: {
    events: [{ type: 'turn/start' }, { type: 'tool/result', name: 'edit-verify', error: null }, { type: 'turn/end', reason: 'success' }],
    coverage: { claimedBehaviors: ['edit-verify'] },
  },
  selfCheck: { confidence: 0.9, completeness: 0.9 },
})

function makeLoop(
  verdicts: ValidationReport[],
  autoConfirm = false,
  confirm: () => Promise<boolean> = async () => true,
  proposerOverride?: Proposer,
  collectFrames?: (patch: MetaPatch, baseInput: VerifierInput) => Promise<VerifierInput>,
  probeRunner?: (patch: MetaPatch, task: string) => { exit: number; outputTail: string } | Promise<{ exit: number; outputTail: string }>,
) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mv-loop-'))
  const sessionId = 's1'
  const captured = { input: null as VerifierInput | null }
  const proposer = proposerOverride ?? new Proposer(null, {
    systemPrompt: 'x',
    maxSignals: 5,
    provider: 'p',
    model: 'm',
    root,
    sessionId,
    llm: stubLlm(VALID),
  })
  const gate = new Gate(null, { root, sessionId })
  let call = 0
  const validator = {
    async loadRegressionCases(): Promise<RegressionCase[]> { return [] },
    async run(_patch: MetaPatch, _cases: RegressionCase[], input?: VerifierInput): Promise<ValidationReport> {
      captured.input = input ?? null
      const report = verdicts[Math.min(call, verdicts.length - 1)]!
      call++
      return report
    },
    persistReport(_root: string, _session: string, _patchId: string, _report: ValidationReport): void {},
  } as unknown as ConstructorParameters<typeof IterationLoop>[0]['validator']
  const loop = new IterationLoop({
    proposer,
    validator,
    gate,
    root,
    sessionId,
    maxIterations: 3,
    confirm,
    autoConfirm,
    collectFrames,
    probeRunner,
  })
  return { loop, root, sessionId, gate, captured }
}

function rejectedReport(patchId: string): ValidationReport {
  return {
    patchId,
    verdict: 'rejected',
    score: 0,
    evidence: ['first divergence'],
    failureSummary: 'alignment mismatch',
    alignment: { accuracy: 0.5, strictAccuracy: 0.5, coverage: 0.5, nGraded: 2, nMatched: 1, firstDivergence: { index: 1, expected: { type: 'turn/end' }, actual: { type: 'turn/start' }, fields: ['type'] } },
    validatedAt: new Date().toISOString(),
  }
}

describe('iteration loop', () => {
  it('re-iterates after rejection and applies after approval (回炉闭环)', async () => {
    const { loop, root, sessionId } = makeLoop([rejectedReport('p1'), { patchId: 'p1', verdict: 'approved', score: 1, evidence: [], validatedAt: new Date().toISOString() }])
    const result = await loop.run([], {})
    expect(result.iterations).toBe(2)
    expect(result.report.verdict).toBe('approved')
    const status = readJson<PatchStatus>(paths.status(root, sessionId, result.patch!.id))
    expect(status?.state).toBe('approved')
    expect(result.escalated).toBe(false)
  })

  it('escalates after maxIterations without approval', async () => {
    const { loop } = makeLoop([rejectedReport('p1'), rejectedReport('p2'), rejectedReport('p3')])
    const result = await loop.run([], {})
    expect(result.escalated).toBe(true)
    expect(result.iterations).toBe(3)
    expect(result.patch).toBeNull()
  })

  it('auto-applies without confirmation in apply mode', async () => {
    const { loop } = makeLoop([{ patchId: 'p1', verdict: 'approved', score: 1, evidence: [], validatedAt: new Date().toISOString() }], true)
    const ops: ApplyOps = {
      readConfig: () => ({ timeoutMs: 5000 }),
      writeConfig: () => {},
      smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: true, checks: [], ranAt: new Date().toISOString() }),
    }
    const result = await loop.run([], {}, undefined, { actualEvents: [] }, ops)
    expect(result.applied?.applied).toBe(true)
    expect(result.iterations).toBe(1)
  })

  it('does not apply when confirmation is refused in propose mode', async () => {
    const { loop } = makeLoop(
      [{ patchId: 'p1', verdict: 'approved', score: 1, evidence: [], validatedAt: new Date().toISOString() }],
      false,
      async () => false,
    )
    const ops: ApplyOps = {
      readConfig: () => ({ timeoutMs: 5000 }),
      writeConfig: () => {},
      smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: true, checks: [], ranAt: new Date().toISOString() }),
    }
    const result = await loop.run([], {}, undefined, { actualEvents: [] }, ops)
    expect(result.applied).toBeNull()
    expect(result.report.verdict).toBe('approved')
  })

  it('applies a tool insert through the generic loop (from-zero path, M4)', async () => {
    const toolRoot = mkdtempSync(join(tmpdir(), 'dsh-mv-loop-tool-'))
    const { loop } = makeLoop(
      [{ patchId: 'p1', verdict: 'approved', score: 1, evidence: [], validatedAt: new Date().toISOString() }],
      true,
      async () => true,
      new Proposer(null, { systemPrompt: 'x', maxSignals: 5, provider: 'p', model: 'm', root: toolRoot, sessionId: 's1', llm: stubLlm(INSERT_TOOL) }),
    )
    const inserted: string[] = []
    const ops: ApplyOps = {
      readConfig: () => ({}),
      writeConfig: () => {},
      smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: true, checks: [], ranAt: new Date().toISOString() }),
      rowExists: () => false,
      insertRow: (p) => { inserted.push(p.targetId) },
      removeRow: () => {},
    }
    const result = await loop.run([], {}, undefined, { actualEvents: [] }, ops)
    expect(result.applied?.applied).toBe(true)
    expect(inserted).toEqual(['fs-write'])
  })

  it('applies a skill insert through the generic loop (from-zero path, M4)', async () => {
    const skillRoot = mkdtempSync(join(tmpdir(), 'dsh-mv-loop-skill-'))
    const { loop } = makeLoop(
      [{ patchId: 'p1', verdict: 'approved', score: 1, evidence: [], validatedAt: new Date().toISOString() }],
      true,
      async () => true,
      new Proposer(null, { systemPrompt: 'x', maxSignals: 5, provider: 'p', model: 'm', root: skillRoot, sessionId: 's1', llm: stubLlm(INSERT_SKILL) }),
    )
    const installed: string[] = []
    const ops: ApplyOps = {
      readConfig: () => ({}),
      writeConfig: () => {},
      smoke: () => ({ schemaVersion: 1, patchId: 'p1', passed: true, checks: [], ranAt: new Date().toISOString() }),
      skillExists: () => false,
      installSkill: (p) => { installed.push(p.targetId) },
      removeSkill: () => {},
    }
    const result = await loop.run([], {}, undefined, { actualEvents: [] }, ops)
    expect(result.applied?.applied).toBe(true)
    expect(installed).toEqual(['edit-verify'])
  })

  it('collects real frames after builder and feeds them to the verifier (M4 generic path)', async () => {
    const { loop, captured } = makeLoop(
      [{ patchId: 'p1', verdict: 'approved', score: 1, evidence: [], validatedAt: new Date().toISOString() }],
      true,
      async () => true,
      undefined,
      async (_patch, base) => ({ ...base, actualEvents: [{ type: 'tool/result', name: 'fs-write', error: null }] }),
    )
    await loop.run([], {}, undefined, { actualEvents: [] })
    expect(captured.input?.actualEvents?.[0]?.name).toBe('fs-write')
  })

  it('re-proposes with probe results when a builder-requested probe fails (A)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-loop-probe-'))
    const sessionId = 's1'
    const first = JSON.stringify({
      patch: { targetId: 'bad', targetKind: 'config', config: { a: 1 }, probes: [{ task: 'run x' }], dependencies: [], rationale: 'x', expectedOutcome: 'x', version: 1 },
      expectedTrajectory: { events: [{ type: 'turn/start' }, { type: 'turn/end' }], coverage: { claimedBehaviors: [] } },
      selfCheck: { confidence: 0.9, completeness: 0.8 },
    })
    const second = JSON.stringify({
      patch: { targetId: 'good', targetKind: 'config', config: { a: 2 }, dependencies: [], rationale: 'x', expectedOutcome: 'x', version: 1 },
      expectedTrajectory: { events: [{ type: 'turn/start' }, { type: 'turn/end' }], coverage: { claimedBehaviors: [] } },
      selfCheck: { confidence: 0.9, completeness: 0.8 },
    })
    let calls = 0
    const llm: LlmStreamLike = {
      async *stream(options) {
        calls++
        yield { kind: 'block-start', type: 'text' }
        yield { kind: 'text-delta', text: String(options.prompt).includes('上一轮隔离探测结果') ? second : first }
        yield { kind: 'block-end', type: 'text' }
      },
    }
    const proposer = new Proposer(null, { systemPrompt: 'x', maxSignals: 5, provider: 'p', model: 'm', root, sessionId, llm })
    const probeCalls: string[] = []
    const { loop } = makeLoop(
      [{ patchId: 'p2', verdict: 'approved', score: 1, evidence: [], validatedAt: new Date().toISOString() }],
      true,
      async () => true,
      proposer,
      undefined,
      async (_patch, task) => { probeCalls.push(task); return { exit: task === 'run x' ? 1 : 0, outputTail: 'boom' } },
    )
    const result = await loop.run([], {})
    expect(calls).toBe(2)
    expect(probeCalls).toEqual(['run x'])
    expect(result.iterations).toBe(2)
    expect(result.report.verdict).toBe('approved')
  })
})
