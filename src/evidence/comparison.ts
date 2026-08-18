import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteJson, sha256 } from '../protocol/index.js'

/** A replay sample is an observation, not a verifier verdict. */
export interface ReplaySample {
  label: 'baseline' | 'installed'
  task: string
  command: string[]
  cwd: string
  exitCode: number
  durationMs: number
  outputPath: string
  outputSha256: string
  outputTail: string
  taskSuccess: boolean
  error?: string
}

export interface ComparisonOptions {
  root: string
  sessionId: string
  id: string
  task: string
  baseline: ReplaySample
  installed: ReplaySample
  contractPass: boolean
  regressionPass: boolean
  gatePass: boolean
  rollbackPass?: boolean
  beforeSnapshot?: unknown
  afterSnapshot?: unknown
  extra?: Record<string, unknown>
}

export interface ActorComparison {
  schemaVersion: 1
  id: string
  task: string
  baseline: ReplaySample
  installed: ReplaySample
  delta: {
    durationMs: number
    durationRatio: number | null
  }
  admissible: boolean
  claimLevel: 'not-established' | 'causal-workload'
  contractPass: boolean
  regressionPass: boolean
  gatePass: boolean
  rollbackPass?: boolean
  beforeSnapshot?: unknown
  afterSnapshot?: unknown
  extra?: Record<string, unknown>
  createdAt: string
}

/** Execute exactly one isolated actor task and persist stdout/stderr as evidence. */
export function runActorReplay(options: {
  label: ReplaySample['label']
  command: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  task: string
  outputPath: string
  timeoutMs?: number
}): ReplaySample {
  const started = Date.now()
  let exitCode = 0
  let output = ''
  let error: string | undefined
  try {
    output = execFileSync(options.command[0]!, [...options.command.slice(1), options.task], {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 300_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (caught) {
    const detail = caught as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
    exitCode = detail.status ?? 1
    output = `${String(detail.stdout ?? '')}${String(detail.stderr ?? '')}`
    error = String(detail.message ?? `exit ${exitCode}`)
  }
  mkdirSync(dirname(options.outputPath), { recursive: true })
  writeFileSync(options.outputPath, output, 'utf8')
  const durationMs = Date.now() - started
  return {
    label: options.label,
    task: options.task,
    command: options.command,
    cwd: options.cwd,
    exitCode,
    durationMs,
    outputPath: options.outputPath,
    outputSha256: sha256(output),
    outputTail: output.slice(-2_000),
    taskSuccess: exitCode === 0,
    ...(error ? { error } : {}),
  }
}

/** Persist the same-task comparison without turning a single exit code into a performance claim. */
export function writeActorComparison(options: ComparisonOptions): ActorComparison {
  const admissible = options.contractPass
    && options.regressionPass
    && options.gatePass
    && (options.rollbackPass ?? true)
    && options.baseline.taskSuccess
    && options.installed.taskSuccess
  const ratio = options.baseline.durationMs > 0 ? options.installed.durationMs / options.baseline.durationMs : null
  const report: ActorComparison = {
    schemaVersion: 1,
    id: options.id,
    task: options.task,
    baseline: options.baseline,
    installed: options.installed,
    delta: { durationMs: options.installed.durationMs - options.baseline.durationMs, durationRatio: ratio },
    admissible,
    claimLevel: admissible ? 'causal-workload' : 'not-established',
    contractPass: options.contractPass,
    regressionPass: options.regressionPass,
    gatePass: options.gatePass,
    ...(options.rollbackPass === undefined ? {} : { rollbackPass: options.rollbackPass }),
    ...(options.beforeSnapshot === undefined ? {} : { beforeSnapshot: options.beforeSnapshot }),
    ...(options.afterSnapshot === undefined ? {} : { afterSnapshot: options.afterSnapshot }),
    ...(options.extra ? { extra: options.extra } : {}),
    createdAt: new Date().toISOString(),
  }
  atomicWriteJson(join(options.root, 'workspace', options.sessionId, 'comparisons', `${options.id}.json`), report)
  return report
}
