import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
    expect(() => kernel.decide(next.id, { kind: 'tool', action: { name: 'inspect_staging', path: '../outside' } })).toThrow(/unavailable/)
  })
})
