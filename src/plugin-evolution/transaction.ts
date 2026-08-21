import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { atomicWriteJson, readJson } from '../protocol/index.js'
import { hashFile } from './source.js'
import { pluginProposalHash, pluginTarDependencySpec } from './compiler.js'
import type {
  PluginCommand,
  PluginEvolutionPlan,
  PluginEvolutionProposal,
  PluginLifecyclePlan,
  PluginTransactionRecord,
  PluginVerificationReport,
  ProfileFileSnapshot,
} from './types.js'

const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml'] as const

export interface PluginTransactionOptions {
  root: string
  dshHome: string
  profile: string
  dshCommand: string[]
  dshCwd: string
  pnpmCommand?: string
  coldBootCommand: string[]
  integrationCwd?: string
}

interface CommandResult { exitCode: number; output: string; error?: string }
const LOADER_FAILURE = /(?:plugin tree failed to load|failed to apply loader entry|patch:\s+entry\s+.+\s+not found|cannot find module|ERR_MODULE_NOT_FOUND)/i

function loaderPassed(result: CommandResult): boolean { return result.exitCode === 0 && !LOADER_FAILURE.test(result.output) }

function pathInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('/'))
}

function executable(command: string): string {
  if (!/^[A-Za-z0-9._/@:+\\-]+$/.test(command)) throw new Error(`unsafe transaction executable: ${command}`)
  if (process.platform === 'win32' && ['npm', 'pnpm', 'npx', 'dsh'].includes(command)) return `${command}.cmd`
  return command
}

function run(command: string[], args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): CommandResult {
  if (command.length === 0) throw new Error('transaction command is empty')
  if ([...command.slice(1), ...args].some((arg) => arg.includes('\0') || arg.includes('\n') || arg.includes('\r'))) throw new Error('transaction arguments contain control characters')
  const result = spawnSync(executable(command[0]!), [...command.slice(1), ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 600_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-32_000),
    ...(result.error ? { error: result.error.message } : {}),
  }
}

function profileDirOf(dshHome: string, profile: string): string { return join(dshHome, 'profiles', profile) }

function transactionEnv(record: Pick<PluginTransactionRecord, 'dshHome' | 'pnpmCommand'>, dshHome = record.dshHome): NodeJS.ProcessEnv {
  const currentPath = process.env.PATH ?? ''
  const managerDir = isAbsolute(record.pnpmCommand) ? dirname(record.pnpmCommand) : undefined
  return {
    ...process.env,
    DSH_HOME: dshHome,
    CI: 'true',
    ...(managerDir ? { PATH: currentPath ? `${managerDir}${delimiter}${currentPath}` : managerDir } : {}),
  }
}

function snapshotFiles(profileDir: string): ProfileFileSnapshot[] {
  return PROFILE_FILES.map((relativePath) => {
    const path = join(profileDir, relativePath)
    if (!existsSync(path)) return { relativePath, exists: false }
    return { relativePath, exists: true, contentBase64: readFileSync(path).toString('base64'), hash: hashFile(path) }
  })
}

function transactionProfileHash(profileDir: string): string {
  const digest = createHash('sha256')
  for (const name of PROFILE_FILES) {
    const path = join(profileDir, name)
    digest.update(`${name}\0`)
    if (existsSync(path)) digest.update(readFileSync(path))
    else digest.update('<missing>')
    digest.update('\0')
  }
  return digest.digest('hex')
}

export function pluginProfileTransactionHash(profileDir: string): string { return transactionProfileHash(profileDir) }

function applyFiles(profileDir: string, files: ProfileFileSnapshot[]): void {
  for (const file of files) {
    if (!PROFILE_FILES.includes(file.relativePath as typeof PROFILE_FILES[number])) throw new Error(`transaction snapshot contains unsupported profile file: ${file.relativePath}`)
    const path = join(profileDir, file.relativePath)
    if (!pathInside(profileDir, path)) throw new Error(`transaction profile file escapes profile: ${file.relativePath}`)
    if (!file.exists) rmSync(path, { force: true })
    else {
      if (!file.contentBase64) throw new Error(`transaction snapshot lacks content: ${file.relativePath}`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, Buffer.from(file.contentBase64, 'base64'))
      if (file.hash && hashFile(path) !== file.hash) throw new Error(`transaction snapshot write hash mismatch: ${file.relativePath}`)
    }
  }
}

function copyProfileSeed(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const name of PROFILE_FILES) if (existsSync(join(source, name))) copyFileSync(join(source, name), join(destination, name))
}

function commandForIntegration(record: PluginTransactionRecord, dshHome: string): CommandResult | null {
  const command = record.integrationCommand
  if (!command) return null
  const cwd = command.cwd ? resolve(record.dshCwd, command.cwd) : record.dshCwd
  const allowed = resolve(record.integrationCwd ?? record.dshCwd)
  if (resolve(cwd) !== allowed) throw new Error('integration command cwd differs from the host-owned transaction cwd')
  return run([command.command], command.args, { cwd, env: transactionEnv(record, dshHome), timeoutMs: command.timeoutMs })
}

function commandForColdBoot(record: PluginTransactionRecord, dshHome: string): CommandResult {
  if (!record.coldBootCommand?.length) return { exitCode: 1, output: 'cold boot command is not configured' }
  return run([record.coldBootCommand[0]!], record.coldBootCommand.slice(1), {
    cwd: record.dshCwd,
    env: transactionEnv(record, dshHome),
    timeoutMs: 180_000,
  })
}

function recordPath(root: string, id: string): string { return join(root, 'plugin-transactions', `${id}.json`) }

interface ActivationLockOwner {
  schemaVersion: 1
  pid: number
  hostname: string
  transactionId: string
  createdAt: string
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function staleActivationLock(lockPath: string): boolean {
  let modifiedAt: number
  try { modifiedAt = statSync(lockPath).mtimeMs } catch { return false }
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<ActivationLockOwner>
    return owner.schemaVersion === 1
      && owner.hostname === hostname()
      && typeof owner.pid === 'number'
      && !processIsAlive(owner.pid)
  } catch {
    // Compatibility for an empty lock left by an older Loom process. Never
    // reclaim a recent or foreign/structured lock whose owner is uncertain.
    return Date.now() - modifiedAt > 15 * 60_000
  }
}

function acquireActivationLock(lockPath: string, transactionId: string): number {
  mkdirSync(dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, 'wx')
      const owner: ActivationLockOwner = {
        schemaVersion: 1,
        pid: process.pid,
        hostname: hostname(),
        transactionId,
        createdAt: new Date().toISOString(),
      }
      try {
        writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8')
      } catch (error) {
        closeSync(descriptor)
        try { unlinkSync(lockPath) } catch { /* preserve the original initialization failure */ }
        throw error
      }
      return descriptor
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0 || !staleActivationLock(lockPath)) {
        throw new Error('another plugin transaction activation is in progress')
      }
      const quarantine = `${lockPath}.stale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      try {
        renameSync(lockPath, quarantine)
        rmSync(quarantine, { force: true })
      } catch {
        throw new Error('another plugin transaction activation is in progress')
      }
    }
  }
  throw new Error('another plugin transaction activation is in progress')
}

function persist(root: string, record: PluginTransactionRecord): void {
  record.updatedAt = new Date().toISOString()
  mkdirSync(join(root, 'plugin-transactions'), { recursive: true })
  atomicWriteJson(recordPath(root, record.id), record)
}

function requireRecord(root: string, id: string): PluginTransactionRecord {
  const record = readJson<PluginTransactionRecord>(recordPath(root, id))
  if (!record || record.schemaVersion !== 1) throw new Error(`unknown plugin transaction: ${id}`)
  return record
}

function validateOptions(options: PluginTransactionOptions, profileDir: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.profile)) throw new Error('plugin transaction profile is invalid')
  if (resolve(profileDirOf(options.dshHome, options.profile)) !== resolve(profileDir)) throw new Error('plugin transaction profileDir does not match DSH_HOME/profile')
  if (options.dshCommand.length === 0) throw new Error('plugin transaction requires dshCommand')
  if (options.coldBootCommand.length === 0) throw new Error('plugin transaction requires a real coldBootCommand; dump-config is composition-only')
  if (options.integrationCwd && !isAbsolute(options.integrationCwd)) throw new Error('plugin transaction integrationCwd must be absolute')
}

function appendStageChecks(report: PluginVerificationReport, values: Array<{ id: string; passed: boolean; detail?: string }>): PluginVerificationReport {
  const checks = [...report.checks, ...values.map((value) => ({
    id: value.id,
    required: true as const,
    verdict: value.passed ? 'passed' as const : 'rejected' as const,
    ...(value.detail ? { detail: value.detail } : {}),
  }))]
  const failed = checks.filter((check) => check.verdict !== 'passed')
  return { ...report, checks, verdict: failed.length === 0 ? 'approved' : 'rejected', ...(failed.length ? { failureSummary: failed.map((check) => check.id).join(', ') } : { failureSummary: undefined }) }
}

function installedPackagesMatch(profileDir: string, artifacts: PluginTransactionRecord['artifacts']): boolean {
  let dependencies: Record<string, string> = {}
  try {
    dependencies = (JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}
  } catch { return false }
  return artifacts.every((artifact) => {
    const path = join(profileDir, 'node_modules', ...artifact.packageName.split('/'), 'package.json')
    const packageRoot = dirname(path)
    if (!existsSync(path) || lstatSync(packageRoot).isSymbolicLink()) return false
    if (dependencies[artifact.packageName] !== pluginTarDependencySpec(artifact.tarPath)) return false
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string }
      return manifest.name === artifact.packageName && manifest.version === artifact.version
    } catch {
      return false
    }
  })
}

function lifecycleMatches(profileDir: string, lifecycle: NonNullable<PluginTransactionRecord['lifecycle']>): boolean {
  let dependencies: Record<string, string> = {}
  try {
    dependencies = (JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}
  } catch { return false }
  const packageRoot = join(profileDir, 'node_modules', ...lifecycle.packageName.split('/'))
  if (lifecycle.operation === 'remove') return dependencies[lifecycle.packageName] === undefined && !existsSync(packageRoot)
  if (!lifecycle.dependencySpec || dependencies[lifecycle.packageName] !== lifecycle.dependencySpec) return false
  const manifestPath = join(packageRoot, 'package.json')
  if (!existsSync(manifestPath) || lstatSync(packageRoot).isSymbolicLink()) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string }
    return manifest.name === lifecycle.packageName && manifest.version === lifecycle.version
  } catch { return false }
}

function replaceCandidatePackages(record: PluginTransactionRecord, dshHome: string): CommandResult {
  const env = transactionEnv(record, dshHome)
  const names = record.artifacts.map((item) => item.packageName)
  // pnpm may retain a previous link: resolution when a tar candidate keeps
  // the same package name/version. Remove only the frozen targets first so the
  // subsequent add must resolve each exact tar spec. This happens in a Shadow
  // Profile or while the live host is stopped under the activation lock.
  const remove = run(record.dshCommand, ['plugin', '--profile', record.profile, 'remove', ...names], {
    cwd: record.dshCwd, env,
  })
  if (remove.exitCode !== 0) return remove
  const add = run(record.dshCommand, ['plugin', '--profile', record.profile, 'add', ...record.artifacts.map((item) => item.tarPath)], {
    cwd: record.dshCwd, env,
  })
  return { ...add, output: `${remove.output}${add.output}`.slice(-32_000) }
}

function mutateLifecycle(record: PluginTransactionRecord, dshHome: string): CommandResult {
  const lifecycle = record.lifecycle
  if (!lifecycle) return { exitCode: 1, output: 'lifecycle transaction lacks frozen operation' }
  const env = transactionEnv(record, dshHome)
  const profileDir = profileDirOf(dshHome, record.profile)
  let dependencies: Record<string, string> = {}
  try {
    dependencies = (JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}
  } catch { return { exitCode: 1, output: 'lifecycle profile manifest is unavailable' } }
  let output = ''
  if (dependencies[lifecycle.packageName] !== undefined) {
    const removed = run(record.dshCommand, ['plugin', '--profile', record.profile, 'remove', lifecycle.packageName], { cwd: record.dshCwd, env })
    output += removed.output
    if (removed.exitCode !== 0) return { ...removed, output }
  }
  if (lifecycle.operation === 'remove') return { exitCode: 0, output }
  const artifact = record.artifacts[0]
  const installSpec = artifact?.tarPath ?? (lifecycle.version ? `${lifecycle.packageName}@${lifecycle.version}` : undefined)
  if (!installSpec) return { exitCode: 1, output: `${output}lifecycle install/update lacks a frozen package spec` }
  const added = run(record.dshCommand, ['plugin', '--profile', record.profile, 'add', '--save-exact', installSpec], { cwd: record.dshCwd, env })
  return { ...added, output: `${output}${added.output}`.slice(-32_000) }
}

export class PluginTransactionManager {
  constructor(private readonly options: PluginTransactionOptions) {}

  prepareLifecycle(plan: PluginLifecyclePlan): PluginTransactionRecord {
    validateOptions(this.options, plan.profileDir)
    if (plan.profile !== this.options.profile) throw new Error('plugin lifecycle profile mismatch')
    if (plan.state !== 'planned') throw new Error(`plugin lifecycle plan is not executable: ${plan.state}`)
    const liveState = transactionProfileHash(plan.profileDir)
    if (liveState !== plan.beforeProfileHash) throw new Error('live profile changed after plugin lifecycle planning')
    if (plan.operation !== 'remove' && (!plan.frozen?.version || !plan.frozen.dependencySpec)) throw new Error('plugin lifecycle install/update lacks a frozen dependency')
    if (plan.frozen?.packageName && plan.frozen.packageName !== plan.packageName) throw new Error('plugin lifecycle frozen package identity mismatch')
    const createdAt = new Date().toISOString()
    const proposalHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
    const id = `plugin-lifecycle-tx-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const artifacts = plan.frozen?.tarPath && plan.frozen.tarHash && plan.frozen.version
      ? [{ packageName: plan.packageName, version: plan.frozen.version, tarPath: resolve(plan.frozen.tarPath), tarHash: plan.frozen.tarHash }]
      : []
    const report: PluginVerificationReport = {
      schemaVersion: 1,
      proposalId: `plugin-lifecycle:${plan.id}`,
      proposalHash,
      verdict: 'approved',
      checks: [{ id: 'profile-before-unchanged', required: true, verdict: 'passed', detail: liveState }],
      verifiedAt: new Date().toISOString(),
    }
    const record: PluginTransactionRecord = {
      schemaVersion: 1,
      id,
      kind: 'lifecycle',
      planId: plan.id,
      proposalHash,
      profile: plan.profile,
      profileDir: plan.profileDir,
      dshHome: resolve(this.options.dshHome),
      dshCommand: [...this.options.dshCommand],
      dshCwd: resolve(this.options.dshCwd),
      pnpmCommand: this.options.pnpmCommand ?? 'pnpm',
      coldBootCommand: [...this.options.coldBootCommand],
      state: 'preparing',
      createdAt,
      updatedAt: createdAt,
      beforeProfileHash: liveState,
      beforeFiles: snapshotFiles(plan.profileDir),
      artifacts,
      lifecycle: {
        operation: plan.operation,
        packageName: plan.packageName,
        ...(plan.frozen?.dependencySpec ? { dependencySpec: plan.frozen.dependencySpec } : {}),
        ...(plan.frozen?.version ? { version: plan.frozen.version } : {}),
        ...(plan.frozen?.integrity ? { integrity: plan.frozen.integrity } : {}),
      },
      verification: report,
    }
    persist(this.options.root, record)
    const shadowHome = join(this.options.root, 'plugin-transactions', id, 'shadow-home')
    const shadowProfile = profileDirOf(shadowHome, plan.profile)
    try {
      for (const artifact of artifacts) {
        if (!existsSync(artifact.tarPath) || hashFile(artifact.tarPath) !== artifact.tarHash) throw new Error(`plugin lifecycle tar changed: ${artifact.packageName}`)
      }
      copyProfileSeed(plan.profileDir, shadowProfile)
      const mutation = mutateLifecycle(record, shadowHome)
      const mutated = mutation.exitCode === 0 && lifecycleMatches(shadowProfile, record.lifecycle!)
      const lockText = existsSync(join(shadowProfile, 'pnpm-lock.yaml')) ? readFileSync(join(shadowProfile, 'pnpm-lock.yaml'), 'utf8') : ''
      const integrityPassed = !record.lifecycle!.integrity || lockText.includes(record.lifecycle!.integrity)
      const env = transactionEnv(record, shadowHome)
      const dump = mutated ? run(record.dshCommand, ['--profile', plan.profile, '--dump-config'], { cwd: record.dshCwd, env }) : { exitCode: 1, output: mutation.output }
      const compositionPassed = loaderPassed(dump)
      const boot = mutated && compositionPassed ? commandForColdBoot(record, shadowHome) : { exitCode: 1, output: dump.output }
      const staged = appendStageChecks(report, [
        { id: 'staged-lifecycle-mutation', passed: mutated, detail: mutation.output.slice(-2_000) },
        { id: 'frozen-dependency-integrity', passed: integrityPassed, detail: record.lifecycle!.integrity ? 'registry integrity present in frozen lockfile' : artifacts.length ? 'local tar hash verified' : 'remove has no incoming artifact' },
        { id: 'profile-composition', passed: compositionPassed, detail: dump.output.slice(-2_000) },
        { id: 'cold-loader', passed: boot.exitCode === 0, detail: boot.output.slice(-2_000) },
      ])
      record.verification = staged
      record.shadowHome = shadowHome
      if (staged.verdict !== 'approved') {
        record.state = 'failed'
        record.error = staged.failureSummary ?? 'staged lifecycle verification failed'
      } else {
        record.desiredFiles = snapshotFiles(shadowProfile)
        record.state = 'ready_to_activate'
      }
      persist(this.options.root, record)
      return record
    } catch (error) {
      record.state = 'failed'
      record.error = String(error)
      persist(this.options.root, record)
      return record
    }
  }

  prepare(plan: PluginEvolutionPlan, proposal: PluginEvolutionProposal, report: PluginVerificationReport): PluginTransactionRecord {
    validateOptions(this.options, plan.profileDir)
    const hash = pluginProposalHash(proposal)
    if (report.verdict !== 'approved' || report.proposalId !== proposal.id || report.proposalHash !== hash) throw new Error('plugin transaction requires an approved hash-bound verifier report')
    if (proposal.targets.length !== plan.targets.length) throw new Error('plugin transaction target count mismatch')
    const createdAt = new Date().toISOString()
    const id = `plugin-tx-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const liveState = transactionProfileHash(plan.profileDir)
    const record: PluginTransactionRecord = {
      schemaVersion: 1,
      id,
      kind: 'install',
      planId: plan.id,
      proposalHash: hash,
      profile: plan.profile,
      profileDir: plan.profileDir,
      dshHome: resolve(this.options.dshHome),
      dshCommand: [...this.options.dshCommand],
      dshCwd: resolve(this.options.dshCwd),
      pnpmCommand: this.options.pnpmCommand ?? 'pnpm',
      coldBootCommand: [...this.options.coldBootCommand],
      ...(this.options.integrationCwd ? { integrationCwd: resolve(this.options.integrationCwd) } : {}),
      state: 'preparing',
      createdAt,
      updatedAt: createdAt,
      beforeProfileHash: liveState,
      beforeFiles: snapshotFiles(plan.profileDir),
      artifacts: proposal.targets.map((target) => ({ packageName: target.packageName, version: target.version, tarPath: resolve(target.tarPath), tarHash: target.tarHash })),
      ...(plan.integrationCommand ? { integrationCommand: structuredClone(plan.integrationCommand) } : {}),
      verification: report,
    }
    persist(this.options.root, record)

    const shadowHome = join(this.options.root, 'plugin-transactions', id, 'shadow-home')
    const shadowProfile = profileDirOf(shadowHome, plan.profile)
    try {
      copyProfileSeed(plan.profileDir, shadowProfile)
      const env = transactionEnv(record, shadowHome)
      const install = replaceCandidatePackages(record, shadowHome)
      const installed = install.exitCode === 0 && installedPackagesMatch(shadowProfile, record.artifacts)
      const dump = installed ? run(record.dshCommand, ['--profile', plan.profile, '--dump-config'], { cwd: record.dshCwd, env }) : { exitCode: 1, output: install.output }
      const compositionPassed = loaderPassed(dump)
      const boot = installed && compositionPassed ? commandForColdBoot(record, shadowHome) : { exitCode: 1, output: dump.output }
      const coldLoaderPassed = boot.exitCode === 0
      const integration = installed && compositionPassed && coldLoaderPassed ? commandForIntegration(record, shadowHome) : null
      const stagedReport = appendStageChecks(report, [
        { id: 'staged-profile-install', passed: installed, detail: install.output.slice(-2_000) },
        { id: 'profile-composition', passed: compositionPassed, detail: dump.output.slice(-2_000) },
        { id: 'cold-loader', passed: coldLoaderPassed, detail: boot.output.slice(-2_000) },
        { id: 'integration-probe', passed: integration === null || integration.exitCode === 0, detail: integration?.output.slice(-2_000) ?? 'not configured' },
      ])
      record.verification = stagedReport
      record.shadowHome = shadowHome
      if (stagedReport.verdict !== 'approved') {
        record.state = 'failed'
        record.error = stagedReport.failureSummary ?? 'staged profile verification failed'
        persist(this.options.root, record)
        return record
      }
      record.state = 'ready_to_activate'
      persist(this.options.root, record)
      return record
    } catch (error) {
      record.state = 'failed'
      record.error = String(error)
      persist(this.options.root, record)
      return record
    }
  }

  cancelReady(id: string): PluginTransactionRecord {
    const record = requireRecord(this.options.root, id)
    if (record.state !== 'ready_to_activate') throw new Error(`plugin transaction is not cancellable: ${record.state}`)
    record.state = 'cancelled'
    persist(this.options.root, record)
    return record
  }

  prepareRestore(sourceId: string): PluginTransactionRecord {
    const source = requireRecord(this.options.root, sourceId)
    if (source.state !== 'completed' || !['install', 'lifecycle'].includes(source.kind)) throw new Error('only a completed install/lifecycle transaction can be restored')
    const profileDir = profileDirOf(source.dshHome, source.profile)
    const state = transactionProfileHash(profileDir)
    const createdAt = new Date().toISOString()
    const record: PluginTransactionRecord = {
      schemaVersion: 1,
      id: `plugin-restore-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      kind: 'restore',
      sourceTransactionId: source.id,
      planId: source.planId,
      proposalHash: source.proposalHash,
      profile: source.profile,
      profileDir,
      dshHome: source.dshHome,
      dshCommand: [...source.dshCommand],
      dshCwd: source.dshCwd,
      pnpmCommand: source.pnpmCommand,
      coldBootCommand: [...(source.coldBootCommand ?? [])],
      ...(source.integrationCwd ? { integrationCwd: source.integrationCwd } : {}),
      state: 'ready_to_activate',
      createdAt,
      updatedAt: createdAt,
      beforeProfileHash: state,
      beforeFiles: snapshotFiles(profileDir),
      desiredFiles: structuredClone(source.beforeFiles),
      artifacts: [],
    }
    persist(this.options.root, record)
    return record
  }

  read(id: string): PluginTransactionRecord { return requireRecord(this.options.root, id) }
}

function reinstallFromSnapshot(record: PluginTransactionRecord): CommandResult {
  // Go through the DSH plugin lifecycle adapter instead of spawning a .cmd
  // package-manager shim ourselves. DSH already owns the Windows-safe shell
  // boundary and reconciles the bundle list after install; transactionEnv
  // pins which pnpm directory that adapter resolves from.
  return run(record.dshCommand, ['plugin', '--profile', record.profile, 'install', '--frozen-lockfile'], {
    cwd: record.dshCwd,
    env: transactionEnv(record),
  })
}

function activateInstall(record: PluginTransactionRecord): CommandResult {
  return replaceCandidatePackages(record, record.dshHome)
}

function coldDump(record: PluginTransactionRecord): CommandResult {
  return run(record.dshCommand, ['--profile', record.profile, '--dump-config'], {
    cwd: record.dshCwd,
    env: transactionEnv(record),
  })
}

export function activatePluginTransaction(root: string, id: string): PluginTransactionRecord {
  const record = requireRecord(root, id)
  if (record.state !== 'ready_to_activate') throw new Error(`plugin transaction is not ready: ${record.state}`)
  const lockPath = join(root, 'plugin-transactions', '.activation.lock')
  const lock = acquireActivationLock(lockPath, record.id)
  let mutationStarted = false
  try {
    const current = transactionProfileHash(record.profileDir)
    if (current !== record.beforeProfileHash) throw new Error('live profile changed after plugin transaction planning')
    for (const artifact of record.artifacts) if (!existsSync(artifact.tarPath) || hashFile(artifact.tarPath) !== artifact.tarHash) throw new Error(`plugin transaction artifact changed: ${artifact.packageName}`)
    record.state = 'activating'
    persist(root, record)
    // From this point a package-manager command or exact snapshot restore may
    // have changed part of the live Profile even when it returns a failure.
    // Preflight failures above must never overwrite independent Profile drift.
    mutationStarted = true
    let mutation: CommandResult
    if (record.kind === 'restore') {
      if (!record.desiredFiles) throw new Error('restore transaction lacks desired profile snapshot')
      applyFiles(record.profileDir, record.desiredFiles)
      mutation = reinstallFromSnapshot(record)
    } else if (record.kind === 'lifecycle') mutation = mutateLifecycle(record, record.dshHome)
    else mutation = activateInstall(record)
    if (mutation.exitCode !== 0) throw new Error(`profile mutation failed: ${mutation.error ?? mutation.output}`)
    if (record.kind === 'install' && !installedPackagesMatch(record.profileDir, record.artifacts)) throw new Error('profile mutation did not install the exact candidate package identities')
    if (record.kind === 'lifecycle') {
      if (!record.lifecycle || !lifecycleMatches(record.profileDir, record.lifecycle)) throw new Error('profile mutation did not apply the frozen lifecycle dependency')
      if (record.lifecycle.integrity) {
        const lockPath = join(record.profileDir, 'pnpm-lock.yaml')
        const lockText = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : ''
        if (!lockText.includes(record.lifecycle.integrity)) throw new Error('live lifecycle lockfile does not contain the frozen registry integrity')
      }
    }
    const dump = coldDump(record)
    if (!loaderPassed(dump)) throw new Error(`cold profile Loader failed: ${dump.error ?? dump.output}`)
    const boot = commandForColdBoot(record, record.dshHome)
    if (boot.exitCode !== 0) throw new Error(`cold profile boot failed: ${boot.error ?? boot.output}`)
    const integration = commandForIntegration(record, record.dshHome)
    if (integration && integration.exitCode !== 0) throw new Error(`live integration probe failed: ${integration.error ?? integration.output}`)
    record.activation = {
      activatedAt: new Date().toISOString(),
      profileHash: transactionProfileHash(record.profileDir),
      loaderPassed: true,
      integrationPassed: true,
    }
    record.state = 'completed'
    persist(root, record)
    if (record.kind === 'restore' && record.sourceTransactionId) {
      const source = requireRecord(root, record.sourceTransactionId)
      source.state = 'rolled_back'
      persist(root, source)
    }
    return record
  } catch (error) {
    if (!mutationStarted) {
      record.rollback = { attempted: false, succeeded: false }
    } else {
      record.rollback = { attempted: true, succeeded: false }
      try {
        applyFiles(record.profileDir, record.beforeFiles)
        const restored = reinstallFromSnapshot(record)
        if (restored.exitCode !== 0) throw new Error(restored.error ?? restored.output)
        if (transactionProfileHash(record.profileDir) !== record.beforeProfileHash) throw new Error('restored profile files do not match the frozen snapshot')
        const restoredDump = coldDump(record)
        if (!loaderPassed(restoredDump)) throw new Error(restoredDump.error ?? restoredDump.output)
        const restoredBoot = commandForColdBoot(record, record.dshHome)
        if (restoredBoot.exitCode !== 0) throw new Error(restoredBoot.error ?? restoredBoot.output)
        record.rollback = { attempted: true, succeeded: true }
      } catch (rollbackError) {
        record.rollback = { attempted: true, succeeded: false, error: String(rollbackError) }
      }
    }
    record.state = 'failed'
    record.error = String(error)
    persist(root, record)
    return record
  } finally {
    closeSync(lock)
    try { unlinkSync(lockPath) } catch { /* another diagnostic will expose a stale lock */ }
  }
}

export function activatePendingPluginTransactions(root: string): PluginTransactionRecord[] {
  const directory = join(root, 'plugin-transactions')
  if (!existsSync(directory)) return []
  const pending = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson<PluginTransactionRecord>(join(directory, name)))
    .filter((record): record is PluginTransactionRecord => record?.schemaVersion === 1 && record.state === 'ready_to_activate')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (pending.length > 1) throw new Error('multiple plugin transactions are ready; cancel or activate one explicitly')
  return pending.map((record) => activatePluginTransaction(root, record.id))
}
