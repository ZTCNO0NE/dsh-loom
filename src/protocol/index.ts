import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * Durable meta workspace (08 §11-§12). File-first: no role trusts context;
 * every artifact is written atomically and carries a schemaVersion.
 */
export const PROTOCOL_VERSION = 1

export function metaRoot(): string {
  return process.env.DSH_META_VALIDATE_ROOT
    ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'meta-validate') : join(process.cwd(), '.meta-validate'))
}

export function workspaceDir(root: string, sessionId: string): string {
  return join(root, 'workspace', sessionId)
}

/**
 * A filesystem-safe child session namespace for Builder-owned workspaces.
 * Colons are useful in trace labels but illegal in Windows path components;
 * use this fixed portable delimiter for all persisted role scopes instead.
 */
export function scopedSessionId(sessionId: string, scope: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(scope)) throw new Error(`invalid Builder session scope: ${scope}`)
  return `${sessionId}--${scope}`
}

export function patchDir(root: string, sessionId: string, patchId: string): string {
  return join(workspaceDir(root, sessionId), 'patches', patchId)
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function atomicWriteJson(path: string, value: unknown): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) {
      unlinkSync(tmp)
    }
  }
}

export function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const out: T[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // Unknown/malformed lines are skipped and warned by the caller.
    }
  }
  return out
}

export interface ProtocolFile {
  schemaVersion: number
  name: string
}

export function ensureWorkspace(root: string, sessionId: string): void {
  const dir = workspaceDir(root, sessionId)
  mkdirSync(join(dir, 'trajectory'), { recursive: true })
  mkdirSync(join(dir, 'builder'), { recursive: true })
  mkdirSync(join(dir, 'patches'), { recursive: true })
  mkdirSync(join(root, 'regressions'), { recursive: true })
  const protocol: ProtocolFile = { schemaVersion: PROTOCOL_VERSION, name: 'dsh-meta-validate' }
  atomicWriteJson(join(dir, 'protocol.json'), protocol)
}

export const paths = {
  requirements: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'requirements.json'),
  triggers: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'triggers.jsonl'),
  signals: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'signals.jsonl'),
  events: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'trajectory', 'events.jsonl'),
  frames: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'trajectory', 'frames.jsonl'),
  handoff: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'handoff', 'stall.jsonl'),
  errors: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'errors.jsonl'),
  notices: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'notices.jsonl'),
  worldState: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'trajectory', 'world-state.json'),
  actorProfile: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'trajectory', 'actor-profile.json'),
  worldModel: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'builder', 'world-model.json'),
  selfCheck: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'builder', 'self-check.json'),
  candidate: (root: string, sessionId: string, patchId: string) => join(patchDir(root, sessionId, patchId), 'candidate.json'),
  expectedTrajectory: (root: string, sessionId: string, patchId: string) => join(patchDir(root, sessionId, patchId), 'expected-trajectory.json'),
  report: (root: string, sessionId: string, patchId: string) => join(patchDir(root, sessionId, patchId), 'report.json'),
  status: (root: string, sessionId: string, patchId: string) => join(patchDir(root, sessionId, patchId), 'status.json'),
  smoke: (root: string, sessionId: string, patchId: string) => join(patchDir(root, sessionId, patchId), 'smoke.json'),
  runEvents: (root: string, sessionId: string, patchId: string) => join(patchDir(root, sessionId, patchId), 'run', 'events.jsonl'),
  probes: (root: string, sessionId: string, patchId: string) => join(patchDir(root, sessionId, patchId), 'probes.jsonl'),
  builderRun: (root: string, sessionId: string, patchId: string) => join(patchDir(root, sessionId, patchId), 'builder-run.json'),
  builderResume: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'builder', 'resume.json'),
  history: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'history.jsonl'),
  gateDecisions: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'gate-decisions.jsonl'),
  autopilotState: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'autopilot-state.json'),
  costLog: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'cost-log.jsonl'),
  ledger: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'ledger.jsonl'),
  growthLedger: (root: string, sessionId: string) => join(root, 'growth', sessionId, 'ledger.jsonl'),
  growthPreferences: (root: string, sessionId: string) => join(root, 'growth', sessionId, 'preferences.json'),
  growthReport: (root: string, sessionId: string) => join(root, 'growth', sessionId, 'report.md'),
  harnessState: (root: string, sessionId: string) => join(workspaceDir(root, sessionId), 'harness-state.json'),
  overlays: (root: string, sessionId: string) => join(root, 'overlays', sessionId),
  overlayFile: (root: string, sessionId: string, patchId: string) =>
    join(root, 'overlays', sessionId, `${patchId}.yml`),
  staging: (root: string, sessionId: string, patchId: string) =>
    join(workspaceDir(root, sessionId), 'builder', 'staging', patchId),
} as const
