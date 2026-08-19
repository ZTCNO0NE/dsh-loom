import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, readJson } from '../protocol/index.js'

export interface EvolutionTaskSuggestion {
  key: string
  title: string
  summary: string
  /** Actor-only routing information; never returned in a task card. */
  target: { kind: 'config' | 'skill'; id: string }
}

export interface EvolutionTaskSession {
  schemaVersion: 1
  sessionId: string
  updatedAt: string
  pending?: { planId: string; userRequest: string; actorExplanation: string; suggestions: EvolutionTaskSuggestion[] }
  active?: { planId: string; jobId: string; cursor: 'queued' | 'implementing' | 'verifying' }
  recent?: { planId: string; jobId?: string; state: 'completed' | 'rejected' | 'aborted' | 'cancelled' | 'interrupted' }
}

/**
 * A deliberately small, durable projection of a conversation's evolution
 * task. Plans/runs remain immutable records; this file only says which one is
 * currently being discussed so a new request cannot silently replace it.
 */
export class EvolutionTaskSessionStore {
  constructor(private readonly root: string, private readonly sessionId: string) {}

  read(): EvolutionTaskSession {
    return readJson<EvolutionTaskSession>(this.file()) ?? {
      schemaVersion: 1, sessionId: this.sessionId, updatedAt: new Date(0).toISOString(),
    }
  }

  beginPending(value: NonNullable<EvolutionTaskSession['pending']>): EvolutionTaskSession {
    const state = this.read()
    if (state.pending || state.active) throw new Error('该会话已有等待确认或进行中的演进任务；请保留、取消后替换，或先查看状态')
    state.pending = structuredClone(value)
    state.updatedAt = new Date().toISOString()
    this.write(state)
    return state
  }

  beginActive(planId: string, jobId: string): EvolutionTaskSession {
    const state = this.read()
    if (!state.pending || state.pending.planId !== planId) throw new Error('只能确认当前等待确认的任务')
    state.active = { planId, jobId, cursor: 'queued' }
    delete state.pending
    state.updatedAt = new Date().toISOString()
    this.write(state)
    return state
  }

  setCursor(planId: string, cursor: EvolutionTaskSession['active'] extends infer T ? T extends { cursor: infer C } ? C : never : never): EvolutionTaskSession {
    const state = this.read()
    if (state.active?.planId === planId) state.active.cursor = cursor
    state.updatedAt = new Date().toISOString()
    this.write(state)
    return state
  }

  finish(planId: string, stateName: NonNullable<EvolutionTaskSession['recent']>['state']): EvolutionTaskSession {
    const state = this.read()
    const jobId = state.active?.planId === planId ? state.active.jobId : undefined
    if (state.pending?.planId === planId) delete state.pending
    if (state.active?.planId === planId) delete state.active
    state.recent = { planId, ...(jobId ? { jobId } : {}), state: stateName }
    state.updatedAt = new Date().toISOString()
    this.write(state)
    return state
  }

  currentPlanId(): string | undefined { const state = this.read(); return state.pending?.planId ?? state.active?.planId ?? state.recent?.planId }
  private file(): string { return join(this.root, 'user-evolution', this.sessionId, 'task-session.json') }
  private write(value: EvolutionTaskSession): void { mkdirSync(join(this.root, 'user-evolution', this.sessionId), { recursive: true }); atomicWriteJson(this.file(), value) }
}
