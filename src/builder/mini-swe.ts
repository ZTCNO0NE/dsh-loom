import { execFile, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Explicit host-owned configuration for the optional mini-SWE execution runtime. */
export interface MiniSweRuntimeOptions {
  executable: string
  configPath: string
  baselineRoot: string
  dependencySnapshot: string
  model: string
  stepLimit: number
  timeoutMs: number
  /** Host-owned runtime environment (for example an OpenAI-compatible route). */
  env?: NodeJS.ProcessEnv
  /** Resolves a fresh host-only environment immediately before spawning. */
  resolveEnv?: () => Promise<NodeJS.ProcessEnv>
}

export interface MiniSweExecution {
  submitted: boolean
  trajectoryPath: string
  modelTurns: number
  toolSteps: number
  error?: string
}

/** Resolve the exact audited commit before a Builder workspace is materialized. */
export function miniSweBaselineCommit(baselineRoot: string): string {
  return execFileSync('git', ['-C', baselineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim()
}

/** Materialize a complete immutable source workspace owned by this Builder run. */
export function materializeMiniSweWorkspace(options: Pick<MiniSweRuntimeOptions, 'baselineRoot' | 'dependencySnapshot'> & {
  commit: string
  workspace: string
}): void {
  if (!/^[0-9a-f]{40}$/i.test(options.commit)) throw new Error('mini-SWE baseline commit must be a 40-character SHA')
  if (!existsSync(options.dependencySnapshot)) throw new Error('mini-SWE dependency snapshot is unavailable')
  mkdirSync(options.workspace, { recursive: true })
  const archive = execFileSync('git', ['-C', options.baselineRoot, 'archive', '--format=tar', options.commit], {
    maxBuffer: 512 * 1024 * 1024,
    timeout: 120_000,
  })
  execFileSync('tar', ['-xf', '-', '-C', options.workspace], { input: archive, timeout: 120_000 })
  // The snapshot is host-owned and prepared before model execution.  It is
  // copied into the run rather than linked, so a Builder cannot mutate future
  // runs or the verified build dependency root.
  cpSync(options.dependencySnapshot, join(options.workspace, 'node_modules'), { recursive: true, dereference: false })
}

/** Run mini-SWE in the Builder workspace and read only its durable trajectory. */
export async function runMiniSwe(options: Omit<MiniSweRuntimeOptions, 'baselineRoot' | 'dependencySnapshot'>
  & Partial<Pick<MiniSweRuntimeOptions, 'baselineRoot' | 'dependencySnapshot'>>
  & { workspace: string; task: string; trajectoryPath: string }): Promise<MiniSweExecution> {
  let error: string | undefined
  try {
    const env = options.resolveEnv ? await options.resolveEnv() : options.env
    await execFileAsync(options.executable, [
      '-m', options.model, '-y', '--exit-immediately', '-l', '0', '-o', options.trajectoryPath,
      '-c', options.configPath,
      '-c', `environment.cwd=${options.workspace}`,
      '-c', `environment.timeout=${Math.ceil(options.timeoutMs / 1000)}`,
      '-c', `agent.step_limit=${options.stepLimit}`,
      '-t', options.task,
    ], {
      cwd: options.workspace,
      timeout: options.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      ...(env ? { env } : {}),
    })
  } catch (caught) {
    error = String((caught as { message?: string }).message ?? caught)
  }
  if (!existsSync(options.trajectoryPath)) return { submitted: false, trajectoryPath: options.trajectoryPath, modelTurns: 0, toolSteps: 0, error: error ?? 'mini-SWE produced no trajectory' }
  let trajectory: { messages?: Array<{ role?: string; content?: string; extra?: { exit_status?: string }; tool_calls?: unknown[] }> }
  try {
    trajectory = JSON.parse(readFileSync(options.trajectoryPath, 'utf8')) as typeof trajectory
  } catch (caught) {
    return {
      submitted: false,
      trajectoryPath: options.trajectoryPath,
      modelTurns: 0,
      toolSteps: 0,
      error: `mini-SWE trajectory is unreadable: ${String((caught as { message?: string }).message ?? caught)}`,
    }
  }
  const messages = trajectory.messages ?? []
  return {
    submitted: messages.some((message) => message.role === 'exit' && message.extra?.exit_status === 'Submitted'),
    trajectoryPath: options.trajectoryPath,
    modelTurns: messages.filter((message) => message.role === 'assistant').length,
    toolSteps: messages.filter((message) => Array.isArray(message.tool_calls) && message.tool_calls.length > 0).length,
    ...(error ? { error } : {}),
  }
}
