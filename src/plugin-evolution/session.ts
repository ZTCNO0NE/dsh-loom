import { join } from 'node:path'
import { atomicWriteJson, readJson, sha256 } from '../protocol/index.js'

export interface PluginEvolutionSession {
  schemaVersion: 1
  currentPlanId?: string
  restoreTransactionId?: string
  updatedAt: string
}

export class PluginEvolutionSessionStore {
  constructor(private readonly root: string, private readonly sessionId: string) {}

  read(): PluginEvolutionSession {
    return readJson<PluginEvolutionSession>(this.file()) ?? { schemaVersion: 1, updatedAt: new Date().toISOString() }
  }

  setPlan(planId: string): PluginEvolutionSession {
    const current = this.read()
    const next: PluginEvolutionSession = { schemaVersion: 1, currentPlanId: planId, updatedAt: new Date().toISOString() }
    if (current.currentPlanId && current.currentPlanId !== planId) throw new Error('该会话已有插件演进任务；请先查看、取消或完成当前任务')
    atomicWriteJson(this.file(), next)
    return next
  }

  setRestore(transactionId: string): PluginEvolutionSession {
    const current = this.read()
    const next = { ...current, restoreTransactionId: transactionId, updatedAt: new Date().toISOString() }
    atomicWriteJson(this.file(), next)
    return next
  }

  clear(): void {
    atomicWriteJson(this.file(), { schemaVersion: 1, updatedAt: new Date().toISOString() } satisfies PluginEvolutionSession)
  }

  private file(): string { return join(this.root, 'plugin-evolution-sessions', `${sha256(this.sessionId).slice(0, 24)}.json`) }
}
