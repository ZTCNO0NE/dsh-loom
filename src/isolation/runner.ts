import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MetaPatch } from '../types.js'

export interface DumpRow {
  id: string
  raw: string
}

export interface IsolationOptions {
  dshCommand: string[]
  cwd: string
  profile: string
  baseOverlays: string[]
  probe?: string
  probeTimeoutMs?: number
  dumpRunner?: (overlays: string[]) => string
  stagingRoot?: string
}

export interface IsolationResult {
  composed: boolean
  dumpError?: string
  candidateRowPresent: boolean
  changedRows: string[]
  probe?: { ran: boolean; exitCode: number; outputTail: string }
  commands?: { baselineDump: string[]; patchedDump: string[]; probe: string[] }
}

export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (
      /^(TSX|TS_NODE|NODE_OPTIONS|NODE_PATH|npm_|NPM_CONFIG_|PNPM_|INIT_CWD|npm_lifecycle_|npm_command|npm_execpath)/i.test(key)
      || key.startsWith('DSH_META_')
    ) continue
    env[key] = value
  }
  return env
}

/** Minimal dump parser: `- id: <id>` rows; comments stripped; raw = lines until next row/comment/EOF. */
export function parseDump(dump: string): DumpRow[] {
  const rows: DumpRow[] = []
  const lines = dump.split('\n')
  let current: { id: string; lines: string[] } | null = null
  for (const line of lines) {
    if (line.startsWith('#')) {
      if (current) {
        rows.push({ id: current.id, raw: current.lines.join('\n').replace(/\n+$/, '') })
        current = null
      }
      continue
    }
    const match = /^- id: (\S+)/.exec(line)
    if (match) {
      if (current) rows.push({ id: current.id, raw: current.lines.join('\n').replace(/\n+$/, '') })
      current = { id: match[1]!, lines: [] }
      continue
    }
    if (current) current.lines.push(line.replace(/\s+$/, ''))
  }
  if (current) rows.push({ id: current.id, raw: current.lines.join('\n').replace(/\n+$/, '') })
  return rows
}

/** Rows whose raw text differs between baseline and patched dumps, excluding the candidate row. */
export function findChangedRows(baseline: DumpRow[], patched: DumpRow[], targetId: string): string[] {
  const baselineMap = new Map(baseline.map((row) => [row.id, row.raw]))
  const patchedMap = new Map(patched.map((row) => [row.id, row.raw]))
  const ids = new Set([...baselineMap.keys(), ...patchedMap.keys()])
  const changed: string[] = []
  for (const id of ids) {
    if (id === targetId) continue
    if (baselineMap.get(id) !== patchedMap.get(id)) changed.push(id)
  }
  return changed.sort()
}

export function buildCandidateOverlay(patch: MetaPatch, stagingRoot = ''): string {
  if (patch.action === 'insert') {
    const entry = patch.module ? join(stagingRoot, patch.module.entry) : ''
    const name = entry || patch.targetName || ''
    return [
      '- insert:',
      `    - id: ${patch.targetId}`,
      `      name: '${name}'`,
      `      config: ${JSON.stringify(patch.config, null, 2)}`,
    ].join('\n')
  }
  return `- id: ${patch.targetId}\n  config: ${JSON.stringify(patch.config, null, 2)}\n`
}

/**
 * M2.6 isolation executor (minimal scope, 2026-08-16):
 * validates the CANDIDATE's basic errors only — composed tree loads, target row
 * present, unrelated rows unchanged; optional probe runs the patched profile.
 * It does NOT sense the actor (no session/context copying).
 */
export function runIsolation(patch: MetaPatch, options: IsolationOptions): IsolationResult {
  const overlayDir = mkdtempSync(join(tmpdir(), 'dsh-mv-isolation-'))
  const overlayPath = join(overlayDir, 'candidate-overlay.yml')
  writeFileSync(overlayPath, buildCandidateOverlay(patch, options.stagingRoot ?? ''), 'utf8')

  const overlays = [...options.baseOverlays]
  const patchedOverlays = [...options.baseOverlays, overlayPath]
  const commands = {
    baselineDump: [
      ...options.dshCommand,
      '--profile',
      options.profile,
      ...overlays.flatMap((overlay) => ['--patch', overlay]),
      '--dump-config',
    ],
    patchedDump: [
      ...options.dshCommand,
      '--profile',
      options.profile,
      ...patchedOverlays.flatMap((overlay) => ['--patch', overlay]),
      '--dump-config',
    ],
    probe: options.probe
      ? [
          ...options.dshCommand,
          '--profile',
          options.profile,
          ...patchedOverlays.flatMap((overlay) => ['--patch', overlay]),
          options.probe,
        ]
      : [],
  }
  const dumpRunner = options.dumpRunner ?? defaultDumpRunner(options)

  let baselineDump: string
  let patchedDump: string
  try {
    baselineDump = dumpRunner(overlays)
    patchedDump = dumpRunner(patchedOverlays)
  } catch (error) {
    return {
      composed: false,
      dumpError: String(error),
      candidateRowPresent: false,
      changedRows: [],
      commands,
    }
  }

  const baselineRows = parseDump(baselineDump)
  const patchedRows = parseDump(patchedDump)
  const candidateRowPresent = patchedRows.some((row) => row.id === patch.targetId)
  const changedRows = findChangedRows(baselineRows, patchedRows, patch.targetId)

  const result: IsolationResult = {
    composed: candidateRowPresent && changedRows.length === 0,
    candidateRowPresent,
    changedRows,
    commands,
  }

  if (options.probe) {
    try {
      const stdout = execFileSync(commands.probe[0]!, commands.probe.slice(1), {
        cwd: options.cwd,
        encoding: 'utf8',
        timeout: options.probeTimeoutMs ?? 120_000,
        env: childEnv(),
      })
      result.probe = { ran: true, exitCode: 0, outputTail: stdout.slice(-1000) }
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string; message?: string }
      result.probe = {
        ran: false,
        exitCode: e.status ?? -1,
        outputTail: `${String(`${e.stderr ?? ''}${e.stdout ?? ''}${e.message ?? ''}`).slice(0, 2000)}…${String(`${e.stderr ?? ''}${e.stdout ?? ''}${e.message ?? ''}`).slice(-300)}`,
      }
    }
  }
  return result
}

function defaultDumpRunner(options: IsolationOptions): (overlays: string[]) => string {
  return (overlays: string[]) => {
    const command = [
      ...options.dshCommand,
      '--profile',
      options.profile,
      ...overlays.flatMap((overlay) => ['--patch', overlay]),
      '--dump-config',
    ]
    return execFileSync(command[0]!, command.slice(1), {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: childEnv(),
    })
  }
}
