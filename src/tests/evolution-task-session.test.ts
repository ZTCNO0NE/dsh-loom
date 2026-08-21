import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EvolutionTaskSessionStore } from '../evolution/task-session.js'

describe('evolution task session', () => {
  it('keeps one pending task and never lets a later request overwrite it', () => {
    const store = new EvolutionTaskSessionStore(mkdtempSync(join(tmpdir(), 'dsh-loom-task-session-')), 'actor')
    store.beginPending({ planId: 'plan-a', userRequest: 'first', actorExplanation: 'first direction', suggestions: [] })
    expect(() => store.beginPending({ planId: 'plan-b', userRequest: 'second', actorExplanation: 'second direction', suggestions: [] })).toThrow('已有等待确认')
    expect(store.read().pending?.planId).toBe('plan-a')
  })

  it('moves only the conversation pointer; immutable plan ids remain history', () => {
    const store = new EvolutionTaskSessionStore(mkdtempSync(join(tmpdir(), 'dsh-loom-task-session-')), 'actor')
    store.beginPending({ planId: 'plan-a', userRequest: 'first', actorExplanation: 'first direction', suggestions: [] })
    store.beginActive('plan-a', 'job-a')
    store.setCursor('plan-a', 'implementing')
    store.finish('plan-a', 'aborted')
    expect(store.read()).toMatchObject({ recent: { planId: 'plan-a', jobId: 'job-a', state: 'aborted' } })
  })

  it('can release a pending conversation pointer without inventing a job', () => {
    const store = new EvolutionTaskSessionStore(mkdtempSync(join(tmpdir(), 'dsh-loom-task-session-')), 'actor')
    store.beginPending({ planId: 'plan-a', userRequest: 'first', actorExplanation: 'first direction', suggestions: [] })
    store.finish('plan-a', 'cancelled')
    expect(store.read()).toMatchObject({ recent: { planId: 'plan-a', state: 'cancelled' } })
    expect(store.read().pending).toBeUndefined()
    expect(() => store.beginPending({ planId: 'plan-b', userRequest: 'second', actorExplanation: 'second direction', suggestions: [] })).not.toThrow()
  })
})
