import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PluginLifecycleController } from '../plugin-evolution/lifecycle.js'
import type { PluginLifecyclePlan, PluginTransactionRecord } from '../plugin-evolution/types.js'
import type { PluginTransactionManager } from '../plugin-evolution/transaction.js'

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function fixtureTar(root: string): string {
  const source = join(root, 'source')
  mkdirSync(source, { recursive: true })
  writeJson(join(source, 'package.json'), {
    name: 'loom-lifecycle-fixture', version: '1.0.0', files: ['index.js', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(join(source, 'index.js'), 'export const value = 1\n', 'utf8')
  writeFileSync(join(source, 'cordis.patch.yml'), '- id: lifecycle-fixture\n  name: ./index.js\n', 'utf8')
  const result = spawnSync('npm', ['pack', '--json', '--pack-destination', root], { cwd: source, encoding: 'utf8' })
  expect(result.status).toBe(0)
  const filename = (JSON.parse(result.stdout) as Array<{ filename: string }>)[0]!.filename
  return join(root, filename)
}

function transaction(plan: PluginLifecyclePlan, state: PluginTransactionRecord['state'] = 'ready_to_activate'): PluginTransactionRecord {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1, id: 'lifecycle-transaction', kind: 'lifecycle', planId: plan.id, proposalHash: 'hash',
    profile: plan.profile, profileDir: plan.profileDir, dshHome: join(plan.profileDir, '..', '..'), dshCommand: ['dsh'], dshCwd: process.cwd(),
    pnpmCommand: 'pnpm', coldBootCommand: ['cold'], state, createdAt: now, updatedAt: now,
    beforeProfileHash: plan.beforeProfileHash, beforeFiles: [], artifacts: [],
    lifecycle: { operation: plan.operation, packageName: plan.packageName, dependencySpec: plan.frozen?.dependencySpec, version: plan.frozen?.version },
  }
}

describe('deterministic plugin lifecycle controller', () => {
  it('freezes a local tar and reaches ready_to_activate without invoking a Builder', () => {
    const root = mkdtempSync(join(tmpdir(), 'loom-plugin-lifecycle-controller-'))
    const profileDir = join(root, 'home', 'profiles', 'loom')
    writeJson(join(profileDir, 'package.json'), { private: true, dependencies: {} })
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: base\n', 'utf8')
    const tarPath = fixtureTar(root)
    let prepared: PluginLifecyclePlan | undefined
    const transactions = {
      prepareLifecycle(plan: PluginLifecyclePlan) { prepared = plan; return transaction(plan) },
      read() { if (!prepared) throw new Error('missing'); return transaction(prepared) },
    } as unknown as PluginTransactionManager
    const controller = new PluginLifecycleController({ root, sessionId: 'session', profile: 'loom', profileDir, pnpmCommand: 'pnpm', transactions })
    const plan = controller.plan({ operation: 'install', packageName: 'loom-lifecycle-fixture', localTarPath: tarPath })
    expect(plan).toMatchObject({ state: 'planned', frozen: { version: '1.0.0', dependencySpec: `file:${tarPath}` } })
    expect(plan.frozen?.tarHash).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(tarPath)).toBe(true)
    const ready = controller.execute()
    expect(ready).toMatchObject({ state: 'ready_to_activate', result: { restartRequired: true } })
    expect(prepared?.id).toBe(plan.id)
  })

  it('fails closed for protected targets and ambiguous registry ranges before running pnpm', () => {
    const root = mkdtempSync(join(tmpdir(), 'loom-plugin-lifecycle-policy-'))
    const profileDir = join(root, 'home', 'profiles', 'loom')
    writeJson(join(profileDir, 'package.json'), { private: true, dependencies: {} })
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lock\n', 'utf8')
    const controller = new PluginLifecycleController({ root, sessionId: 'session', profile: 'loom', profileDir, pnpmCommand: 'definitely-not-called', transactions: {} as PluginTransactionManager })
    expect(() => controller.plan({ operation: 'install', packageName: 'dsh-loom', versionSpec: '1.2.3' })).toThrow(/protected/)
    expect(() => controller.plan({ operation: 'install', packageName: 'safe-plugin', versionSpec: '^1.0.0' })).toThrow(/exact version|dist-tag/)
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toContain('"dependencies": {}')
  })
})
