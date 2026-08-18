import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeActorComparison } from '../evidence/comparison.js'

function sample(label: 'baseline' | 'installed') {
  return {
    label,
    task: 'reply ok',
    command: ['node', '-e', 'process.stdout.write("ok")'],
    cwd: process.cwd(),
    exitCode: 0,
    durationMs: 10,
    outputPath: join(tmpdir(), `${label}.stdout`),
    outputSha256: 'a'.repeat(64),
    outputTail: 'ok',
    taskSuccess: true,
  }
}

describe('actor comparison admissibility', () => {
  it('does not imply rollback evidence when rollback is required but absent', () => {
    const report = writeActorComparison({
      root: mkdtempSync(join(tmpdir(), 'dsh-loom-comparison-')),
      sessionId: 's',
      id: 'missing-rollback',
      task: 'reply ok',
      baseline: sample('baseline'),
      installed: sample('installed'),
      contractPass: true,
      regressionPass: true,
      gatePass: true,
      rollbackRequired: true,
    })
    expect(report.admissible).toBe(false)
    expect(report.rollbackRequired).toBe(true)
  })

  it('permits a causal replay when rollback is explicitly out of scope', () => {
    const report = writeActorComparison({
      root: mkdtempSync(join(tmpdir(), 'dsh-loom-comparison-')),
      sessionId: 's',
      id: 'replay-only',
      task: 'reply ok',
      baseline: sample('baseline'),
      installed: sample('installed'),
      contractPass: true,
      regressionPass: true,
      gatePass: true,
      rollbackRequired: false,
    })
    expect(report.admissible).toBe(true)
    expect(report.claimLevel).toBe('causal-workload')
  })
})
