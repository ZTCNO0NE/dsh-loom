import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Proposer, type LlmStreamLike } from '../meta/propose.js'
import { Observer } from '../observer/index.js'
import { existsSync } from 'node:fs'
import { paths, readJson } from '../protocol/index.js'
import type { MetaPatch, PatchStatus, WorldModel } from '../types.js'
import { BuilderKernel } from '../builder/kernel.js'

function stubLlm(json: string): LlmStreamLike {
  return {
    async *stream(options) {
      const prompt = String(options.prompt)
      const decision = prompt.includes('"passed":true')
        ? { kind: 'submit' }
        : prompt.includes('"written":"candidate_draft"')
          ? { kind: 'tool', action: { name: 'preflight_staging_entry', entry: 'candidate.json' } }
          : { kind: 'tool', action: { name: 'write_candidate_draft', proposal: JSON.parse(json) } }
      yield { kind: 'block-start', type: 'text' }
      yield { kind: 'text-delta', text: JSON.stringify(decision) }
      yield { kind: 'block-end', type: 'text' }
    },
  }
}

const VALID_JSON = JSON.stringify({
  patch: {
    targetId: 'dsh-tool-bash-persistent',
    targetKind: 'config',
    config: { timeoutMs: 30000 },
    dependencies: [],
    rationale: '用户要求放宽 bash 超时',
    expectedOutcome: 'bash 工具在 30s 内返回 tool/result',
    version: 1,
  },
  expectedTrajectory: {
    events: [
      { type: 'turn/start', turn: 1 },
      { type: 'tool/call', turn: 1, step: 1, name: 'bash', argsHash: 'h1' },
      { type: 'tool/result', turn: 1, step: 1, name: 'bash', error: null, resultHash: 'h2' },
      { type: 'turn/end', turn: 1, reason: 'success' },
    ],
    coverage: { claimedBehaviors: ['bash'] },
  },
  selfCheck: { confidence: 0.9, completeness: 0.8, summary: '自检通过' },
  worldModel: {
    invariants: ['未涉及配置行逐字节不变'],
    expectedEventPatterns: [{ event: 'tool/result', name: 'bash', ok: true }],
    configDependencies: ['timeoutMs'],
  },
})

function setup(llm: LlmStreamLike) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mv-prop-'))
  const sessionId = 's1'
  const proposer = new Proposer(null, {
    systemPrompt: 'builder prompt',
    maxSignals: 10,
    provider: 'deepseek-official',
    model: 'qwen/qwen3.6-27b',
    root,
    sessionId,
    llm,
  })
  const observer = new Observer(null, { root, sessionId })
  return { root, sessionId, proposer, observer }
}

describe('proposer A2', () => {
  it('produces a valid single-variable patch with self-check and expected trajectory', async () => {
    const { root, sessionId, proposer, observer } = setup(stubLlm(VALID_JSON))
    for (let i = 1; i <= 3; i++) {
      observer.ingest({ kind: 'tool-error', turn: i, step: 1, tool: 'bash', code: 'E1', evidence: 'timeout' })
    }
    const signals = observer.collect({ repeatedFailureCount: 3, regressionFailureCount: 1 })
    const patches = await proposer.propose(signals, { llm: { provider: 'deepseek-official' } }, '请把 bash 超时调大')

    expect(patches).toHaveLength(1)
    const patch: MetaPatch = patches[0]!
    expect(patch.targetKind).toBe('config')
    expect(patch.targetId).toBe('dsh-tool-bash-persistent')
    expect(patch.selfCheck?.confidence).toBe(0.9)
    expect(patch.expectedTrajectory?.events.length).toBeGreaterThan(0)

    const candidate = readJson<MetaPatch>(paths.candidate(root, sessionId, patch.id))
    expect(candidate?.targetId).toBe(patch.targetId)
    const status = readJson<PatchStatus>(paths.status(root, sessionId, patch.id))
    expect(status?.state).toBe('submitted')
    const model = readJson<WorldModel>(paths.worldModel(root, sessionId))
    expect(model?.version).toBe(1)
    expect(model?.behavior.invariants).toContain('未涉及配置行逐字节不变')
  })

  it('rejects disallowed targetKind', async () => {
    const bad = VALID_JSON.replace('"config"', '"loop"')
    const { proposer, root, sessionId } = setup(stubLlm(bad))
    await expect(proposer.propose([], {})).rejects.toThrow(/targetKind/)
    const resume = readJson<{ runId?: string }>(paths.builderResume(root, sessionId))
    expect(new BuilderKernel(root, sessionId).context(resume!.runId!).input.previousAttempt).toMatchObject({
      source: 'proposal_normalization',
      verdict: 'rejected',
    })
  })

  it('rejects loop-layer rows even when targetKind is config', async () => {
    const bad = VALID_JSON.replace('dsh-tool-bash-persistent', 'agent-loop')
    const { proposer } = setup(stubLlm(bad))
    await expect(proposer.propose([], {})).rejects.toThrow(/locked/)
  })

  it('rejects builder self-modification (meta-validate row)', async () => {
    const bad = VALID_JSON.replace('dsh-tool-bash-persistent', 'meta-validate')
    const { proposer } = setup(stubLlm(bad))
    await expect(proposer.propose([], {})).rejects.toThrow(/locked/)
  })

  it('rejects non-JSON model output', async () => {
    const { proposer } = setup(stubLlm('很抱歉，我无法生成 JSON。'))
    await expect(proposer.propose([], {})).rejects.toThrow(/ended aborted/)
  })

  it('supports insert patches with module files written to staging', async () => {
    const insertJson = JSON.stringify({
      patch: {
        action: 'insert',
        targetId: 'my-tool',
        targetName: 'my-tool',
        targetKind: 'tool',
        config: { timeoutMs: 5000 },
        module: {
          files: [{ path: 'index.mjs', content: 'export const name = "my-tool"\n' }],
          entry: 'index.mjs',
        },
        dependencies: [],
        rationale: '从零实验：新增工具',
        expectedOutcome: 'my-tool 可加载',
        version: 1,
      },
      expectedTrajectory: {
        events: [{ type: 'turn/start' }, { type: 'turn/end', reason: 'success' }],
        coverage: { claimedBehaviors: ['my-tool'] },
      },
      selfCheck: { confidence: 0.9, completeness: 0.8 },
    })
    const { root, sessionId, proposer } = setup(stubLlm(insertJson))
    const patches = await proposer.propose([], {})
    const patch = patches[0]!
    expect(patch.action).toBe('insert')
    expect(patch.module?.entry).toBe('index.mjs')
    expect(existsSync(join(paths.staging(root, sessionId, patch.id), 'index.mjs'))).toBe(true)
  })

  it('normalizes builder-requested probes (A)', async () => {
    const json = JSON.stringify({
      patch: {
        targetId: 'row-a',
        targetKind: 'config',
        config: { timeoutMs: 30000 },
        probes: [
          { task: 'run sleep 1 and report ok' },
          { task: 'x'.repeat(400), description: 'too long' },
          { task: 'second probe', description: 'd' },
        ],
        dependencies: [],
        rationale: 'x',
        expectedOutcome: 'ok',
        version: 1,
      },
      expectedTrajectory: { events: [{ type: 'turn/start' }, { type: 'turn/end', reason: 'success' }], coverage: { claimedBehaviors: [] } },
      selfCheck: { confidence: 0.9, completeness: 0.8 },
    })
    const { proposer } = setup(stubLlm(json))
    const patches = await proposer.propose([], {})
    expect(patches[0]!.probes).toEqual([
      { task: 'run sleep 1 and report ok', description: undefined },
      { task: 'second probe', description: 'd' },
    ])
  })

  it('persists builder-declared preferences to growth/preferences.json', async () => {
    const json = JSON.stringify({
      patch: {
        targetId: 'row-a',
        targetKind: 'config',
        config: { timeoutMs: 30000 },
        dependencies: [],
        rationale: 'x',
        expectedOutcome: 'ok',
        version: 1,
      },
      expectedTrajectory: { events: [{ type: 'turn/start' }, { type: 'turn/end', reason: 'success' }], coverage: { claimedBehaviors: [] } },
      selfCheck: { confidence: 0.9, completeness: 0.8 },
      preferences: [{ scope: 'output-format', value: '不带 markdown' }],
    })
    const { root, sessionId, proposer } = setup(stubLlm(json))
    await proposer.propose([], {})
    const prefs = readJson<Array<{ scope: string; value: string }>>(paths.growthPreferences(root, sessionId))
    expect(prefs?.[0]).toMatchObject({ scope: 'output-format', value: '不带 markdown' })
  })
})
