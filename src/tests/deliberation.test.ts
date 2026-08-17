import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MetaPatch, ValidationReport } from '../types.js'
import { adjudicate, adjudicateLoop, adjudicatePatch, type BuilderProposal, type LoopEvolutionProposal } from '../deliberation/index.js'
import type { CandidateManifest } from '../candidates/index.js'

function patchProposal(overrides: Partial<MetaPatch> = {}): BuilderProposal {
  const patch: MetaPatch = {
    id: 'p1',
    action: 'update',
    targetId: 'llm-deepseek',
    targetKind: 'config',
    config: { baseURL: 'http://x', maxTokens: 1024 },
    dependencies: [],
    rationale: 'fix endpoint',
    expectedOutcome: 'ok',
    version: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
  return { capability: 'patch-evolution', patch, rationale: 'test' }
}

function approvedReport(patchId: string): ValidationReport {
  return { patchId, verdict: 'approved', score: 1, evidence: [], validatedAt: new Date().toISOString() }
}

function rejectedReport(patchId: string): ValidationReport {
  return {
    patchId,
    verdict: 'rejected',
    score: 0,
    evidence: [],
    validatedAt: new Date().toISOString(),
    failureSummary: 'expected trajectory diverged',
  }
}

function loopProposal(): BuilderProposal {
  const loop: LoopEvolutionProposal = {
    id: 'serial-loop-edit',
    displayName: 'Serial edit',
    source: {
      kind: 'builder-generated',
      baseline: { uri: 'https://github.com/deepseek-ai/deepseek-harness.git', ref: 'a'.repeat(40) },
      edits: [{
        path: 'packages/core/agent-loop/src/constants.ts',
        beforeHash: 'b'.repeat(64),
        after: 'export const X = 1',
      }],
    },
    packageName: '@deepseek-ai/dsh-agent-loop',
    packagePath: 'packages/core/agent-loop',
    entry: 'lib/index.js',
    config: { agents: [] },
    expectedOutcome: 'contract preserved',
    capabilities: ['serial-tool-calls'],
  }
  return { capability: 'loop-evolution', loop, rationale: 'test' }
}

const fakeManifest: CandidateManifest = {
  schemaVersion: 1,
  id: 'serial-loop-edit',
  displayName: 'Serial edit',
  targetId: 'agent-loop',
  packageName: '@deepseek-ai/dsh-agent-loop',
  artifactPath: '/tmp/r/candidates/staging/serial-loop-edit',
  entry: 'lib/index.js',
  build: { method: 'sandboxed-dsh-workspace', command: 'audited recipe' },
  source: {
    kind: 'builder-generated',
    uri: 'https://github.com/deepseek-ai/deepseek-harness.git',
    ref: 'a'.repeat(40),
    contentHash: 'c'.repeat(64),
    generated: {
      baselineUri: 'https://github.com/deepseek-ai/deepseek-harness.git',
      baselineRef: 'a'.repeat(40),
      editPlanHash: 'd'.repeat(64),
      edits: [{ path: 'packages/core/agent-loop/src/constants.ts', beforeHash: 'b'.repeat(64), afterHash: 'e'.repeat(64) }],
    },
  },
  config: { agents: [] },
  expectedOutcome: 'contract preserved',
  capabilities: ['serial-tool-calls'],
  createdAt: new Date().toISOString(),
  createdBy: 'builder',
}

describe('deliberation', () => {
  it('applies an approved patch proposal through gate', async () => {
    const proposal = patchProposal()
    const patch = (proposal as { patch: MetaPatch }).patch
    const result = await adjudicatePatch(proposal as never, {
      root: '/tmp/r',
      sessionId: 's',
      validator: {
        loadRegressionCases: async () => [],
        run: async () => approvedReport(patch.id),
        persistReport: () => {},
      } as never,
      gate: {
        markStatus: () => {},
        applyWithRollback: async () => ({ patch, applied: true, before: {}, after: patch.config }),
      } as never,
      applyOps: {} as never,
    })
    expect(result.verdict).toBe('approved')
    expect(result.applied?.applied).toBe(true)
  })

  it('rejects a patch proposal when the fixed verifier diverges', async () => {
    const proposal = patchProposal()
    const patch = (proposal as { patch: MetaPatch }).patch
    let gateCalled = false
    const result = await adjudicatePatch(proposal as never, {
      root: '/tmp/r',
      sessionId: 's',
      validator: {
        loadRegressionCases: async () => [],
        run: async () => rejectedReport(patch.id),
        persistReport: () => {},
      } as never,
      gate: {
        markStatus: () => {},
        applyWithRollback: async () => { gateCalled = true; return { patch, applied: true, before: {}, after: patch.config } },
      } as never,
      applyOps: {} as never,
    })
    expect(result.verdict).toBe('rejected')
    expect(gateCalled).toBe(false)
  })

  it('rejects a loop proposal when staging fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-delib-'))
    const result = await adjudicateLoop(loopProposal() as never, {
      root,
      importer: { acquire: () => { throw new Error('baseline mismatch') } } as never,
      verifyContract: async () => ({ passed: true }),
    })
    expect(result).toMatchObject({ kind: 'loop', verdict: 'rejected', reason: expect.stringContaining('baseline mismatch') })
  })

  it('rejects a loop proposal when contract verification fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-delib-'))
    const result = await adjudicateLoop(loopProposal() as never, {
      root,
      importer: { acquire: () => fakeManifest } as never,
      verifyContract: async () => ({ passed: false, reason: 'C8 failed' }),
    })
    expect(result).toMatchObject({ kind: 'loop', verdict: 'rejected', reason: 'C8 failed' })
  })

  it('installs an approved loop proposal through the gate and reports state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-delib-'))
    const result = await adjudicateLoop(loopProposal() as never, {
      root,
      importer: { acquire: () => fakeManifest } as never,
      verifyContract: async () => ({
        passed: true,
        evidence: { contractReport: '/ev/contract.json', regressionReport: '/ev/regression.json', verifiedAt: new Date().toISOString() },
      }),
      install: async () => ({
        schemaVersion: 1,
        candidateId: 'serial-loop-edit',
        state: 'installed',
        before: {},
        after: {},
        smoke: { passed: true, checks: [{ name: 'C0', passed: true }] },
        createdAt: new Date().toISOString(),
      }),
    })
    expect(result.verdict).toBe('approved')
    expect(result.install?.state).toBe('installed')
  })

  it('dispatches patch and loop proposals by capability', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-delib-'))
    const patch = patchProposal()
    const p = (patch as { patch: MetaPatch }).patch
    const patchResult = await adjudicate(patch, {
      root,
      sessionId: 's',
      validator: {
        loadRegressionCases: async () => [],
        run: async () => approvedReport(p.id),
        persistReport: () => {},
      } as never,
      gate: {
        markStatus: () => {},
        applyWithRollback: async () => ({ patch: p, applied: true, before: {}, after: p.config }),
      } as never,
      applyOps: {} as never,
      importer: { acquire: () => fakeManifest } as never,
      verifyContract: async () => ({ passed: false, reason: 'unused' }),
    })
    expect(patchResult.kind).toBe('patch')
    const loopResult = await adjudicate(loopProposal(), {
      root,
      sessionId: 's',
      validator: {} as never,
      gate: {} as never,
      importer: { acquire: () => fakeManifest } as never,
      verifyContract: async () => ({ passed: false, reason: 'C1 failed' }),
    })
    expect(loopResult).toMatchObject({ kind: 'loop', verdict: 'rejected', reason: 'C1 failed' })
  })
})
