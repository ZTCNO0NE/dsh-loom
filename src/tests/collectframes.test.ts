import { describe, expect, it } from 'vitest'
import { collectFramesForPatch } from '../meta/collectFrames.js'
import type { MetaPatch } from '../types.js'

function toolPatch() {
  const p: MetaPatch = {
    id: 'p1',
    action: 'insert',
    targetId: 'fs-write',
    targetName: 'fs-write',
    targetKind: 'tool',
    config: {},
    module: { files: [{ path: 'index.mjs', content: 'x' }], entry: 'index.mjs' },
    dependencies: [],
    rationale: 'x',
    expectedOutcome: 'x',
    expectedTrajectory: {
      schemaVersion: 1,
      patchId: 'p1',
      events: [
        { type: 'turn/start', turn: 1 },
        { type: 'tool/result', turn: 1, step: 1, name: 'fs-write', error: null },
        { type: 'turn/end', turn: 1, reason: 'success' },
      ],
      coverage: { claimedBehaviors: ['fs-write'] },
    },
    version: 1,
    createdAt: new Date().toISOString(),
  }
  return p
}

function options(runner: (patch: MetaPatch, opts: unknown) => unknown) {
  return {
    enabled: true,
    dshCommand: ['dsh'],
    cwd: '/tmp',
    profile: 'headless',
    baseOverlays: [],
    probe: 'probe task',
    probeTimeoutMs: 1000,
    stagingRootFor: () => '/tmp/staging',
    isolationRunner: runner as never,
  }
}

describe('collectFramesForPatch', () => {
  it('maps probe success to frames aligned with the expected trajectory', async () => {
    const frames = await collectFramesForPatch(toolPatch(), { actualEvents: [] }, options(() => ({
      composed: true,
      candidateRowPresent: true,
      changedRows: [],
      probe: { ran: true, exitCode: 0, outputTail: 'ok' },
    })))
    expect(frames.actualEvents).toHaveLength(3)
    expect(frames.actualEvents[1]?.name).toBe('fs-write')
    expect(frames.nameAliases).toEqual(['fs-write'])
  })

  it('maps probe failure to an error frame', async () => {
    const frames = await collectFramesForPatch(toolPatch(), { actualEvents: [] }, options(() => ({
      composed: true,
      candidateRowPresent: true,
      changedRows: [],
      probe: { ran: false, exitCode: 1, outputTail: 'boot failed' },
    })))
    expect(frames.actualEvents[0]?.error).toContain('boot failed')
  })

  it('passes skill patches through unchanged (verifier skillIsolation handles them)', async () => {
    const skill: MetaPatch = { ...toolPatch(), targetKind: 'skill', targetId: 'edit-verify', module: { files: [{ path: 'edit-verify/SKILL.md', content: 'x' }], entry: 'edit-verify/SKILL.md' } }
    const frames = await collectFramesForPatch(skill, { actualEvents: [{ type: 'x' }] }, options(() => { throw new Error('should not run') }))
    expect(frames.actualEvents).toEqual([{ type: 'x' }])
  })

  it('maps a successful verifier skill probe to frames', async () => {
    const skill: MetaPatch = { ...toolPatch(), targetKind: 'skill', targetId: 'refine-escalation', module: { files: [{ path: 'refine-escalation/SKILL.md', content: 'x' }], entry: 'refine-escalation/SKILL.md' } }
    const frames = await collectFramesForPatch(skill, { actualEvents: [] }, {
      ...options(() => { throw new Error('should not run') }),
      skillProbe: () => ({ passed: true, name: 'refine-escalation' }),
    })
    expect(frames.actualEvents).toHaveLength(3)
    expect(frames.nameAliases).toEqual(['refine-escalation'])
  })

  it('maps a failed verifier skill probe to an error frame', async () => {
    const skill: MetaPatch = { ...toolPatch(), targetKind: 'skill', targetId: 'refine-escalation', module: { files: [{ path: 'refine-escalation/SKILL.md', content: 'x' }], entry: 'refine-escalation/SKILL.md' } }
    const frames = await collectFramesForPatch(skill, { actualEvents: [] }, {
      ...options(() => { throw new Error('should not run') }),
      skillProbe: () => ({ passed: false }),
    })
    expect(frames.actualEvents[0]?.error).toContain('skill probe failed')
  })

  it('passes through unchanged when disabled', async () => {
    const frames = await collectFramesForPatch(toolPatch(), { actualEvents: [] }, { ...options(() => { throw new Error('no') }), enabled: false })
    expect(frames.actualEvents).toEqual([])
  })
})
