import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendJsonl,
  atomicWriteJson,
  ensureWorkspace,
  paths,
  readJson,
  readJsonl,
  scopedSessionId,
  sha256,
  workspaceDir,
} from '../protocol/index.js'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-mv-test-'))
}

describe('protocol', () => {
  it('atomic write + read roundtrip', () => {
    const root = tmpRoot()
    const file = join(root, 'a.json')
    atomicWriteJson(file, { value: 1 })
    expect(readJson<{ value: number }>(file)).toEqual({ value: 1 })
    atomicWriteJson(file, { value: 2 })
    expect(readJson<{ value: number }>(file)).toEqual({ value: 2 })
  })

  it('jsonl append and malformed-line tolerance', () => {
    const root = tmpRoot()
    const file = join(root, 'x.jsonl')
    appendJsonl(file, { a: 1 })
    appendJsonl(file, { a: 2 })
    expect(readJsonl<{ a: number }>(file)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('ensureWorkspace creates the v1 protocol skeleton', () => {
    const root = tmpRoot()
    ensureWorkspace(root, 's1')
    const dir = workspaceDir(root, 's1')
    expect(existsSync(join(dir, 'protocol.json'))).toBe(true)
    expect(existsSync(join(dir, 'trajectory'))).toBe(true)
    expect(existsSync(join(dir, 'builder'))).toBe(true)
    expect(existsSync(join(root, 'regressions'))).toBe(true)
    const protocol = readJson<{ schemaVersion: number }>(join(dir, 'protocol.json'))
    expect(protocol?.schemaVersion).toBe(1)
  })

  it('sha256 is stable', () => {
    expect(sha256({ a: 1 })).toBe(sha256({ a: 1 }))
    expect(sha256({ a: 1 })).not.toBe(sha256({ a: 2 }))
  })

  it('uses a portable delimiter for persisted Builder role scopes', () => {
    const scoped = scopedSessionId('default-session', 'actor-evolution')
    expect(scoped).toBe('default-session--actor-evolution')
    expect(scoped).not.toMatch(/[:<>"/\\|?*]/)
  })

  it('paths cover the v1 information catalog', () => {
    const root = tmpRoot()
    const session = 's1'
    expect(paths.requirements(root, session)).toContain('requirements.json')
    expect(paths.worldModel(root, session)).toContain('world-model.json')
    expect(paths.candidate(root, session, 'p1')).toContain(join('patches', 'p1', 'candidate.json'))
    expect(paths.runEvents(root, session, 'p1')).toContain(join('run', 'events.jsonl'))
  })
})
