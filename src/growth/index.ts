import { appendJsonl, atomicWriteJson, paths, readJson } from '../protocol/index.js'
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'

export interface LedgerEntry {
  id: string
  triggeredBy: string
  problem: string
  changes: Array<{ target: string; kind: string; before: unknown; after: unknown }>
  verdict: string
  applied: boolean
  metricsBefore: Record<string, number | string | null>
  metricsAfter: Record<string, number | string | null>
  rolledBack: boolean
  appliedAt: string
}

export interface Preference {
  scope: string
  value: string
  sourceRef?: string
  at?: string
}

export function scenarioOf(signals: Array<{ kind: string }>): string {
  if (signals.some((signal) => signal.kind === 'repeated_failure')) return 'S1-repeated-failure'
  if (signals.some((signal) => signal.kind === 'regression_failure')) return 'S4-regression-failure'
  if (signals.some((signal) => signal.kind === 'user_correction')) return 'S3-user-correction'
  return 'S9-explicit-request'
}

export function appendLedger(root: string, sessionId: string, entry: LedgerEntry): void {
  appendJsonl(paths.growthLedger(root, sessionId), entry)
}

export function readLedger(root: string, sessionId: string): LedgerEntry[] {
  const file = paths.growthLedger(root, sessionId)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry)
}

export function mergePreferences(root: string, sessionId: string, prefs: Preference[]): void {
  if (prefs.length === 0) return
  const file = paths.growthPreferences(root, sessionId)
  const existing = readJson<Preference[]>(file) ?? []
  const byKey = new Map(existing.map((item) => [`${item.scope}|${item.value}`, item]))
  const now = new Date().toISOString()
  for (const pref of prefs) {
    const key = `${pref.scope}|${pref.value}`
    byKey.set(key, { ...pref, at: pref.at ?? now })
  }
  atomicWriteJson(file, [...byKey.values()])
}

export function readPreferences(root: string, sessionId: string): Preference[] {
  return readJson<Preference[]>(paths.growthPreferences(root, sessionId)) ?? []
}

export function appendReport(root: string, sessionId: string, line: string): void {
  const file = paths.growthReport(root, sessionId)
  const dir = file.slice(0, file.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  appendFileSync(file, `- ${new Date().toISOString()} ${line}\n`, 'utf8')
}
