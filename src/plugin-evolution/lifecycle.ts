import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { atomicWriteJson, readJson, sha256 } from '../protocol/index.js'
import { hashFile } from './source.js'
import { hashTarContents, pluginTarDependencySpec } from './compiler.js'
import { resolvePluginCommandInvocation } from './command.js'
import { isProtectedPluginName } from './source.js'
import { pluginProfileTransactionHash, PluginTransactionManager } from './transaction.js'
import type { FrozenPluginDependency, PluginLifecycleOperation, PluginLifecyclePlan, PluginTransactionRecord } from './types.js'

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const REGISTRY_SPEC = /^[a-z0-9][a-z0-9._-]*$/i

export interface PluginLifecycleControllerOptions {
  root: string
  sessionId: string
  profile: string
  profileDir: string
  pnpmCommand: string
  transactions: PluginTransactionManager
}

export interface CreatePluginLifecyclePlan {
  operation: PluginLifecycleOperation
  packageName: string
  versionSpec?: string
  localTarPath?: string
}

interface LifecycleSession {
  schemaVersion: 1
  currentPlanId?: string
  restoreTransactionId?: string
  updatedAt: string
}

function manifestDependencies(profileDir: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  return manifest.dependencies ?? {}
}

function resolveRegistryDependency(pnpmCommand: string, packageName: string, requested: string): FrozenPluginDependency {
  if (!REGISTRY_SPEC.test(requested)) throw new Error('registry version must be an exact version or a simple dist-tag')
  const invocation = resolvePluginCommandInvocation(pnpmCommand, ['view', `${packageName}@${requested}`, 'version', 'dist.integrity', '--json'])
  const result = spawnSync(invocation.executable, invocation.args, {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  })
  if (result.error || result.status !== 0) throw new Error(`unable to resolve registry package: ${result.error?.message ?? result.stderr}`)
  const parsed = JSON.parse(result.stdout) as ({ version?: string; dist?: { integrity?: string }; 'dist.integrity'?: string } | Array<{ version?: string; dist?: { integrity?: string }; 'dist.integrity'?: string }>)
  const value = Array.isArray(parsed) ? parsed.at(-1) : parsed
  if (!value?.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) throw new Error('registry did not resolve an exact package version')
  const integrity = value.dist?.integrity ?? value['dist.integrity']
  if (!integrity || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity)) throw new Error('registry did not return a supported package integrity')
  return { packageName, version: value.version, dependencySpec: value.version, integrity }
}

function resolveLocalTar(packageName: string, localTarPath: string): FrozenPluginDependency {
  const tarPath = resolve(localTarPath)
  if (!existsSync(tarPath) || !/\.tgz$/i.test(tarPath)) throw new Error('local plugin artifact must be an existing .tgz')
  hashTarContents(tarPath)
  const directory = mkdtempSync(join(tmpdir(), 'loom-plugin-lifecycle-tar-'))
  try {
    const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'
    const extracted = spawnSync(tar, ['-xf', tarPath, '-C', directory], { encoding: 'utf8', windowsHide: true })
    if (extracted.error || extracted.status !== 0) throw new Error(`unable to inspect local plugin artifact: ${extracted.error?.message ?? extracted.stderr}`)
    const root = existsSync(join(directory, 'package')) ? join(directory, 'package') : directory
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string; dsh?: { bundle?: { patch?: string } } }
    if (manifest.name !== packageName || !manifest.version) throw new Error('local plugin artifact identity does not match the requested package')
    const patch = manifest.dsh?.bundle?.patch
    if (!patch || patch.startsWith('/') || patch.includes('..') || !existsSync(join(root, patch))) throw new Error('local plugin artifact lacks a valid dsh.bundle patch')
    return { packageName, version: manifest.version, dependencySpec: pluginTarDependencySpec(tarPath), tarPath, tarHash: hashFile(tarPath) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export class PluginLifecycleController {
  constructor(private readonly options: PluginLifecycleControllerOptions) {}

  plan(input: CreatePluginLifecyclePlan): PluginLifecyclePlan {
    if (!PACKAGE_NAME.test(input.packageName) || isProtectedPluginName(input.packageName)) throw new Error('plugin lifecycle target is invalid or protected')
    const existingSession = this.session()
    if (existingSession.currentPlanId) {
      const existing = this.reconcile()
      if (['planned', 'ready_to_activate'].includes(existing.state)) throw new Error('该会话已有待确认或待激活的插件生命周期任务')
      if (existingSession.restoreTransactionId) {
        const restore = this.options.transactions.read(existingSession.restoreTransactionId)
        if (restore.state === 'ready_to_activate' || restore.state === 'activating') throw new Error('该会话已有待激活的插件恢复事务')
      }
    }
    const dependencies = manifestDependencies(this.options.profileDir)
    const beforeDependencySpec = dependencies[input.packageName]
    if (input.operation === 'install' && beforeDependencySpec !== undefined) throw new Error('plugin is already installed; use exact update')
    if (input.operation !== 'install' && beforeDependencySpec === undefined) throw new Error('plugin is not installed in the current Profile')
    let frozen: FrozenPluginDependency | undefined
    if (input.operation !== 'remove') {
      frozen = input.localTarPath
        ? resolveLocalTar(input.packageName, input.localTarPath)
        : resolveRegistryDependency(this.options.pnpmCommand, input.packageName, input.versionSpec ?? 'latest')
    }
    const id = `plugin-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const plan: PluginLifecyclePlan = {
      schemaVersion: 1,
      capability: 'plugin-lifecycle',
      id,
      createdAt: new Date().toISOString(),
      profile: this.options.profile,
      profileDir: this.options.profileDir,
      operation: input.operation,
      packageName: input.packageName,
      ...(input.versionSpec ? { requestedSpec: input.versionSpec } : {}),
      beforeProfileHash: pluginProfileTransactionHash(this.options.profileDir),
      ...(beforeDependencySpec ? { beforeDependencySpec } : {}),
      ...(frozen ? { frozen } : {}),
      state: 'planned',
    }
    this.write(plan)
    this.setSession({ schemaVersion: 1, currentPlanId: plan.id, updatedAt: new Date().toISOString() })
    return plan
  }

  execute(): PluginLifecyclePlan {
    const session = this.session()
    if (!session.currentPlanId) throw new Error('current session has no plugin lifecycle plan')
    const plan = this.read(session.currentPlanId)
    if (plan.state !== 'planned') throw new Error(`plugin lifecycle plan is not executable: ${plan.state}`)
    const transaction = this.options.transactions.prepareLifecycle(plan)
    plan.transactionId = transaction.id
    if (transaction.state === 'ready_to_activate') {
      plan.state = 'ready_to_activate'
      plan.result = {
        verdict: 'approved', applied: false, effective: false, restartRequired: true,
        summary: '确定性插件操作已通过 Shadow Profile 冷验证；将在下一次 Loom 冷启动前生效',
        limitations: ['No Builder was invoked.', 'The live Profile is unchanged until cold activation.'],
      }
    } else {
      plan.state = 'rejected'
      plan.result = {
        verdict: 'rejected', applied: false, effective: false, restartRequired: false,
        summary: '插件生命周期操作未通过独立 staging；live Profile 未改变',
        limitations: ['No partial package change was activated.'],
      }
    }
    this.write(plan)
    return plan
  }

  reconcile(): PluginLifecyclePlan {
    const session = this.session()
    if (!session.currentPlanId) throw new Error('current session has no plugin lifecycle plan')
    const plan = this.read(session.currentPlanId)
    if (!plan.transactionId) return plan
    const transaction = this.options.transactions.read(plan.transactionId)
    if (transaction.state === 'completed') {
      plan.state = 'completed'
      plan.result = { verdict: 'approved', applied: true, effective: true, restartRequired: false, summary: '确定性插件操作已整体生效并通过冷 Loader 对账', limitations: ['No Builder was invoked.'] }
    } else if (transaction.state === 'rolled_back') {
      plan.state = 'completed'
      plan.result = { verdict: 'approved', applied: false, effective: false, restartRequired: false, summary: '插件操作已通过独立恢复事务还原', limitations: ['The original lifecycle receipt remains immutable.'] }
    } else if (transaction.state === 'failed') {
      plan.state = 'rejected'
      plan.result = { verdict: 'rejected', applied: false, effective: false, restartRequired: false, summary: transaction.rollback?.succeeded ? '冷激活失败，已完整保持原插件组合' : '插件事务未完成，需要检查受控 receipt', limitations: ['No partial state is claimed.'] }
    }
    this.write(plan)
    return plan
  }

  cancel(): PluginLifecyclePlan {
    const plan = this.reconcile()
    if (plan.state === 'planned') plan.state = 'cancelled'
    else if (plan.state === 'ready_to_activate' && plan.transactionId) {
      this.options.transactions.cancelReady(plan.transactionId)
      plan.state = 'cancelled'
    } else throw new Error(`plugin lifecycle task is not cancellable: ${plan.state}`)
    plan.result = { verdict: 'aborted', applied: false, effective: false, restartRequired: false, summary: '插件操作已在激活前取消', limitations: ['The live Profile was not changed.'] }
    this.write(plan)
    return plan
  }

  restore(): PluginTransactionRecord {
    const plan = this.reconcile()
    if (plan.state !== 'completed' || !plan.transactionId || !plan.result?.effective) throw new Error('only an effective plugin lifecycle task can be restored')
    const transaction = this.options.transactions.prepareRestore(plan.transactionId)
    this.setSession({ ...this.session(), restoreTransactionId: transaction.id, updatedAt: new Date().toISOString() })
    return transaction
  }

  read(planId: string): PluginLifecyclePlan {
    const plan = readJson<PluginLifecyclePlan>(this.planPath(planId))
    if (!plan || plan.capability !== 'plugin-lifecycle') throw new Error('unknown plugin lifecycle plan')
    return plan
  }

  status(): { plan?: PluginLifecyclePlan; restore?: PluginTransactionRecord } {
    const session = this.session()
    const plan = session.currentPlanId ? this.reconcile() : undefined
    const restore = session.restoreTransactionId ? this.options.transactions.read(session.restoreTransactionId) : undefined
    return { ...(plan ? { plan } : {}), ...(restore ? { restore } : {}) }
  }

  private key(): string { return sha256(this.options.sessionId).slice(0, 24) }
  private directory(): string { return join(this.options.root, 'plugin-lifecycle', this.key()) }
  private planPath(id: string): string { return join(this.directory(), `${id}.json`) }
  private write(plan: PluginLifecyclePlan): void { mkdirSync(this.directory(), { recursive: true }); atomicWriteJson(this.planPath(plan.id), plan) }
  private sessionPath(): string { return join(this.options.root, 'plugin-lifecycle-sessions', `${this.key()}.json`) }
  private session(): LifecycleSession { return readJson<LifecycleSession>(this.sessionPath()) ?? { schemaVersion: 1, updatedAt: new Date().toISOString() } }
  private setSession(session: LifecycleSession): void { atomicWriteJson(this.sessionPath(), session) }
}
