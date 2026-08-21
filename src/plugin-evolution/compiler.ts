import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { hashDirectory, hashFile } from './source.js'
import { resolvePluginCommandInvocation } from './command.js'
import type {
  PluginCandidateArtifact,
  PluginCommand,
  PluginCommandEvidence,
  PluginDiffEntry,
  PluginEvolutionPlan,
  PluginEvolutionProposal,
} from './types.js'

const OMIT_DIRECTORIES = new Set(['.git', 'node_modules'])
const SECRET_TEXT = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|npm)_[A-Za-z0-9]{16,}|\bsk-[A-Za-z0-9]{16,})/

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function pluginTarDependencySpec(tarPath: string): string {
  return `file:${tarPath.replaceAll('\\', '/')}`
}

export { resolvePluginCommandInvocation } from './command.js'

function commandCwd(sourceRoot: string, packageDir: string, command: PluginCommand): string {
  const rel = command.cwd ?? packageDir
  const cwd = rel === '.' ? sourceRoot : resolve(sourceRoot, rel)
  if (!pathInside(sourceRoot, cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`plugin command cwd escapes source root: ${rel}`)
  return cwd
}

export function sanitizedPluginCommandEnv(sourceRoot: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const allow = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR', 'LANG', 'LC_ALL']
  const runtime = join(tmpdir(), 'dsh-loom-plugin-build', String(process.pid))
  mkdirSync(runtime, { recursive: true })
  const env: NodeJS.ProcessEnv = { CI: 'true', NO_COLOR: '1', HOME: runtime, npm_config_cache: join(runtime, 'npm-cache'), LOOM_PLUGIN_SOURCE_ROOT: sourceRoot }
  for (const key of allow) if (process.env[key]) env[key] = process.env[key]
  for (const [key, value] of Object.entries(overrides)) {
    if (!value || /(key|token|secret|password|credential|authorization)/i.test(key)) continue
    if (allow.includes(key) || key === 'CI' || key === 'NO_COLOR') env[key] = value
  }
  return env
}

export function runPluginCommands(
  sourceRoot: string,
  packageDir: string,
  phase: PluginCommandEvidence['phase'],
  commands: PluginCommand[],
  env?: NodeJS.ProcessEnv,
): PluginCommandEvidence[] {
  const commandEnv = sanitizedPluginCommandEnv(sourceRoot, env)
  return commands.map((command) => {
    if (command.args.some((arg) => arg.includes('\0') || arg.includes('\n') || arg.includes('\r'))) throw new Error('plugin command arguments must not contain control characters')
    const started = Date.now()
    const invocation = resolvePluginCommandInvocation(command.command, command.args)
    const result = spawnSync(invocation.executable, invocation.args, {
      cwd: commandCwd(sourceRoot, packageDir, command),
      env: commandEnv,
      encoding: 'utf8',
      timeout: command.timeoutMs ?? 300_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const exitCode = result.status ?? (result.error ? 1 : 0)
    const evidence: PluginCommandEvidence = {
      phase,
      command: command.command,
      args: [...command.args],
      exitCode,
      outputTail: output.slice(-8_000),
      durationMs: Date.now() - started,
    }
    if (result.error || exitCode !== 0) throw new PluginCommandError(evidence, result.error?.message)
    return evidence
  })
}

export class PluginCommandError extends Error {
  constructor(readonly evidence: PluginCommandEvidence, detail?: string) {
    super(`plugin ${evidence.phase} command failed: ${evidence.command} ${evidence.args.join(' ')}${detail ? ` (${detail})` : ''}\n${evidence.outputTail}`)
  }
}

interface FileState { hash: string; size: number }

function fileMap(directory: string): Map<string, FileState> {
  const root = resolve(directory)
  const files = new Map<string, FileState>()
  const visit = (current: string): void => {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isDirectory() && OMIT_DIRECTORIES.has(item.name)) continue
      const path = join(current, item.name)
      const rel = relative(root, path).split(sep).join('/')
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`plugin candidate contains symlink: ${rel}`)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) {
        const content = readFileSync(path)
        if (SECRET_TEXT.test(content.toString('utf8'))) throw new Error(`plugin candidate contains credential-like text: ${rel}`)
        files.set(rel, { hash: createHash('sha256').update(content).digest('hex'), size: stat.size })
      }
    }
  }
  visit(root)
  return files
}

export function diffPluginTrees(beforeDirectory: string, afterDirectory: string): PluginDiffEntry[] {
  const before = fileMap(beforeDirectory)
  const after = fileMap(afterDirectory)
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  const diff: PluginDiffEntry[] = []
  for (const path of paths) {
    const left = before.get(path)
    const right = after.get(path)
    if (left?.hash === right?.hash) continue
    if (!left && right) diff.push({ path, kind: 'added', afterHash: right.hash, size: right.size })
    else if (left && !right) diff.push({ path, kind: 'deleted', beforeHash: left.hash })
    else diff.push({ path, kind: 'modified', beforeHash: left!.hash, afterHash: right!.hash, size: right!.size })
  }
  return diff
}

export function hashTarContents(tarPath: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'loom-plugin-tar-'))
  try {
    const invocation = resolvePluginCommandInvocation('tar', ['-xf', tarPath, '-C', directory])
    const result = spawnSync(invocation.executable, invocation.args, { encoding: 'utf8', windowsHide: true })
    if (result.error || result.status !== 0) throw new Error(`unable to inspect plugin tar: ${result.error?.message ?? result.stderr}`)
    const packageRoot = join(directory, 'package')
    return hashDirectory(existsSync(packageRoot) ? packageRoot : directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function packPlugin(sourceRoot: string, packageDir: string, artifactsRoot: string, targetId: string, env?: NodeJS.ProcessEnv): { tarPath: string; tarHash: string; tarContentHash: string } {
  const destination = join(artifactsRoot, targetId)
  mkdirSync(destination, { recursive: true })
  const cwd = packageDir === '.' ? sourceRoot : join(sourceRoot, packageDir)
  const invocation = resolvePluginCommandInvocation('npm', ['pack', '--json', '--pack-destination', destination])
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd, env: sanitizedPluginCommandEnv(sourceRoot, env), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw new Error(`npm pack failed for ${targetId}: ${result.error?.message ?? result.stderr}`)
  let filename: string | undefined
  try {
    const parsed = JSON.parse(result.stdout) as Array<{ filename?: string }>
    filename = parsed[0]?.filename
  } catch { /* handled below */ }
  if (!filename) throw new Error(`npm pack did not report an artifact for ${targetId}`)
  const tarPath = join(destination, filename)
  if (!existsSync(tarPath)) throw new Error(`npm pack artifact is missing for ${targetId}`)
  return { tarPath, tarHash: hashFile(tarPath), tarContentHash: hashTarContents(tarPath) }
}

function readPackageIdentity(sourceRoot: string, packageDir: string): { name: string; version: string } {
  const manifest = JSON.parse(readFileSync(join(packageDir === '.' ? sourceRoot : join(sourceRoot, packageDir), 'package.json'), 'utf8')) as { name?: string; version?: string }
  if (!manifest.name || !manifest.version) throw new Error('plugin candidate package.json lacks name/version')
  return { name: manifest.name, version: manifest.version }
}

export function pluginProposalHash(proposal: PluginEvolutionProposal): string {
  return createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
}

export function compilePluginEvolutionProposal(options: {
  plan: PluginEvolutionPlan
  workspace: string
  artifactsRoot: string
  env?: NodeJS.ProcessEnv
}): PluginEvolutionProposal {
  const targets: PluginCandidateArtifact[] = options.plan.targets.map((target) => {
    const sourceRoot = join(options.workspace, 'plugins', target.id)
    if (!existsSync(sourceRoot)) throw new Error(`plugin workspace target is missing: ${target.id}`)
    const commandEvidence = [
      ...runPluginCommands(sourceRoot, target.source.packageDir, 'prepare', target.prepareCommands, options.env),
      ...runPluginCommands(sourceRoot, target.source.packageDir, 'build', target.buildCommands, options.env),
      ...runPluginCommands(sourceRoot, target.source.packageDir, 'test', target.testCommands, options.env),
    ]
    if (target.buildCommands.length + target.testCommands.length === 0) throw new Error(`plugin target requires at least one host-owned build/test command: ${target.id}`)
    const identity = readPackageIdentity(sourceRoot, target.source.packageDir)
    if (identity.name !== target.packageName || identity.version !== target.installed.version) throw new Error(`plugin candidate changed package identity: ${target.id}`)
    const diff = diffPluginTrees(target.source.snapshotPath, sourceRoot)
    if (diff.length === 0) throw new Error(`plugin candidate has no source change: ${target.id}`)
    if (diff.length > 128 || diff.reduce((total, item) => total + (item.size ?? 0), 0) > 4 * 1024 * 1024) throw new Error(`plugin candidate diff exceeds bounded scope: ${target.id}`)
    const packed = packPlugin(sourceRoot, target.source.packageDir, options.artifactsRoot, target.id, options.env)
    return {
      targetId: target.id,
      packageName: identity.name,
      version: identity.version,
      sourceBeforeHash: target.source.treeHash,
      sourceAfterHash: hashDirectory(sourceRoot),
      workspacePath: sourceRoot,
      diff,
      commandEvidence,
      ...packed,
    }
  })
  return {
    schemaVersion: 1,
    capability: 'plugin-evolution',
    id: `plugin-proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    planId: options.plan.id,
    profile: options.plan.profile,
    expectedOutcome: options.plan.expectedOutcome,
    targets,
    graph: options.plan.targets.map((target) => ({ id: target.id, dependsOn: [...target.dependsOn] })),
    createdAt: new Date().toISOString(),
  }
}
