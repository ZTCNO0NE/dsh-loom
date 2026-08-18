import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Observer } from '../observer/index.js'
import { createActorEvidencePack } from '../evidence/index.js'

describe('actor evidence pack', () => {
  it('keeps raw refs, deterministic digest, and free-form actor handoff together', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-evidence-'))
    const observer = new Observer(null, { root, sessionId: 's' })
    observer.recordFrame('turn/start', { turn: 1 }, 1000)
    observer.recordFrame('tool/call', { turn: 1, step: 1, name: 'bash' }, 1100)
    observer.recordFrame('tool/result', { turn: 1, step: 1, name: 'bash', error: 'ENOENT' }, 1200)
    observer.ingest({ kind: 'tool-error', turn: 1, step: 1, tool: 'bash', code: 'ENOENT', evidence: 'command missing' })
    observer.ingest({ kind: 'user-message', turn: 2, text: '不要只调参数，看看 loop 基座' })
    const pack = createActorEvidencePack({
      root,
      sessionId: 's',
      observer,
      currentConfig: { 'agent-default-model': { config: { model: 'test' } } },
      signals: observer.collect({ repeatedFailureCount: 3, regressionFailureCount: 1 }),
      state: { schemaVersion: 1, epoch: 0, iterationsThisEpoch: 0, lastIterationTurn: 0, lastApplyTurn: 0 },
      requirements: '请尝试演进 actor',
      actorAssessment: '连续出现工具错误，用户明确要求检查 loop，而不是只修改业务参数。',
    })

    expect(pack.watermark.frameCount).toBe(3)
    expect(pack.watermark.eventCount).toBe(2)
    expect(pack.actorHandoff.supplied).toBe(true)
    expect(pack.deterministicDigest.toolErrors).toBe(1)
    const framesRef = pack.rawRefs.find((ref) => ref.name === 'frames')
    expect(framesRef).toMatchObject({ exists: true, lineCount: 3 })
    expect(framesRef?.snapshotPath).toBeTruthy()
    observer.recordFrame('turn/end', { turn: 1 }, 1300)
    expect(readFileSync(framesRef!.snapshotPath!, 'utf8').split('\n').filter(Boolean)).toHaveLength(3)
    expect(readFileSync(framesRef!.path, 'utf8').split('\n').filter(Boolean)).toHaveLength(4)
    expect(existsSync(pack.manifestPath)).toBe(true)
    expect(readFileSync(pack.actorHandoff.path, 'utf8')).toContain('连续出现工具错误')
  })
})
