import { describe, expect, it } from 'vitest'
import {
  buildCandidateOverlay,
  childEnv,
  findChangedRows,
  parseDump,
  runIsolation,
  runOverlayIsolation,
} from '../isolation/runner.js'
import type { MetaPatch } from '../types.js'

const BASE = `# == @deepseek-ai/dsh-base
- id: row-a
  name: '@deepseek-ai/dsh-tool-bash-persistent'
  config:
    timeoutMs: 5000
# == @deepseek-ai/dsh-llm
- id: row-b
  name: '@deepseek-ai/dsh-llm'
  config:
    maxTokens: 8192
`

const PATCHED_OK = BASE.replace('timeoutMs: 5000', 'timeoutMs: 30000')

function patch(overrides: Partial<MetaPatch> = {}): MetaPatch {
  return {
    id: 'p1',
    targetId: 'row-a',
    targetKind: 'config',
    config: { timeoutMs: 30000 },
    dependencies: [],
    rationale: 'x',
    expectedOutcome: 'ok',
    version: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('isolation runner', () => {
  it('marks verifier-owned DSH subprocesses as non-interactive', () => {
    expect(childEnv().CI).toBe('true')
  })

  it('parses dump rows and strips comments', () => {
    const rows = parseDump(BASE)
    expect(rows.map((row) => row.id)).toEqual(['row-a', 'row-b'])
    expect(rows[0]?.raw).not.toContain('# ==')
    expect(rows[0]?.raw).toContain('timeoutMs: 5000')
  })

  it('detects changes only in unrelated rows', () => {
    const baseline = parseDump(BASE)
    const patched = parseDump(PATCHED_OK)
    expect(findChangedRows(baseline, patched, 'row-a')).toEqual([])
    const patchedOther = PATCHED_OK.replace('maxTokens: 8192', 'maxTokens: 4096')
    expect(findChangedRows(baseline, parseDump(patchedOther), 'row-a')).toEqual(['row-b'])
  })

  it('builds an id-targeted overlay without touching other rows', () => {
    const overlay = buildCandidateOverlay(patch())
    expect(overlay).toContain('- id: row-a')
    expect(overlay).toContain('"timeoutMs": 30000')
  })

  it('builds an insert overlay for new rows (M4)', () => {
    const overlay = buildCandidateOverlay(patch({ action: 'insert', targetName: 'my-tool' }), '/tmp/staging')
    expect(overlay).toContain('- insert:')
    expect(overlay).toContain('id: row-a')
    expect(overlay).toContain("name: 'my-tool'")
  })

  it('composed=true when only the candidate row changes', () => {
    const result = runIsolation(patch(), {
      dshCommand: ['dsh'],
      cwd: '/tmp',
      profile: 'headless',
      baseOverlays: [],
      dumpRunner: (overlays) => (overlays.length === 0 ? BASE : PATCHED_OK),
    })
    expect(result.composed).toBe(true)
    expect(result.candidateRowPresent).toBe(true)
    expect(result.changedRows).toEqual([])
  })

  it('cold-replays the exact persisted Gate overlay', () => {
    const overlay = '/state/overlays/s1/p1.yml'
    const result = runOverlayIsolation(patch(), {
      dshCommand: ['dsh'], cwd: '/tmp', profile: 'headless', baseOverlays: [],
      dumpRunner: (overlays) => overlays.includes(overlay) ? PATCHED_OK : BASE,
    }, overlay)
    expect(result.composed).toBe(true)
    expect(result.commands?.patchedDump).toContain(overlay)
  })

  it('composed=false when an unrelated row changed', () => {
    const result = runIsolation(patch(), {
      dshCommand: ['dsh'],
      cwd: '/tmp',
      profile: 'headless',
      baseOverlays: [],
      dumpRunner: (overlays) => (overlays.length === 0 ? BASE : PATCHED_OK.replace('maxTokens: 8192', 'maxTokens: 4096')),
    })
    expect(result.composed).toBe(false)
    expect(result.changedRows).toEqual(['row-b'])
  })

  it('composed=false with dumpError when dump fails', () => {
    const result = runIsolation(patch(), {
      dshCommand: ['dsh'],
      cwd: '/tmp',
      profile: 'headless',
      baseOverlays: [],
      dumpRunner: () => { throw new Error('compose failed') },
    })
    expect(result.composed).toBe(false)
    expect(result.dumpError).toContain('compose failed')
  })
})
