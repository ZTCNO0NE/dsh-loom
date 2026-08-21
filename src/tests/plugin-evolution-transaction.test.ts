import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pluginProposalHash } from '../plugin-evolution/compiler.js'
import { hashFile, profileStateHash } from '../plugin-evolution/source.js'
import { activatePluginTransaction, pluginProfileTransactionHash, PluginTransactionManager } from '../plugin-evolution/transaction.js'
import type { PluginEvolutionPlan, PluginEvolutionProposal, PluginEvolutionTargetPlan, PluginLifecyclePlan, PluginVerificationReport } from '../plugin-evolution/types.js'

function json(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T }

function transactionFixture(): {
  root: string
  dshHome: string
  profileDir: string
  dshCwd: string
  plan: PluginEvolutionPlan
  proposal: PluginEvolutionProposal
  report: PluginVerificationReport
  manager: PluginTransactionManager
} {
  const root = mkdtempSync(join(tmpdir(), 'loom-plugin-transaction-'))
  const dshHome = join(root, 'live-home')
  const profileDir = join(dshHome, 'profiles', 'loom')
  const dshCwd = join(root, 'dsh')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(dshCwd, { recursive: true })
  json(join(profileDir, 'package.json'), { private: true, dependencies: { 'loom-fixture-a': '1.0.0', 'loom-fixture-b': '1.0.0' } })
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'old-lock\n', 'utf8')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), 'old-bundles\n', 'utf8')
  for (const name of ['loom-fixture-a', 'loom-fixture-b']) json(join(profileDir, 'node_modules', name, 'package.json'), { name, version: '1.0.0', candidate: false })

  const fakeDsh = join(dshCwd, 'fake-dsh.mjs')
  writeFileSync(fakeDsh, `
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
const args = process.argv.slice(2)
if ((process.env.PATH ?? '').split(delimiter)[0] !== ${JSON.stringify(dshCwd)}) process.exit(41)
const profileAt = args.indexOf('--profile')
const profile = profileAt >= 0 ? args[profileAt + 1] : 'loom'
const profileDir = join(process.env.DSH_HOME, 'profiles', profile)
if (args[0] === 'cold-boot') process.exit(existsSync(join(profileDir, 'package.json')) ? 0 : 26)
if (args[0] === 'plugin' && args.includes('remove')) {
  const names = args.slice(args.indexOf('remove') + 1)
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const name of names) {
    delete manifest.dependencies[name]
    rmSync(join(profileDir, 'node_modules', name), { recursive: true, force: true })
  }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  process.exit(0)
}
if (args[0] === 'plugin' && args.includes('add')) {
  const artifacts = args.slice(args.indexOf('add') + 1).filter(arg => !arg.startsWith('--'))
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const artifact of artifacts) {
    const item = JSON.parse(readFileSync(artifact, 'utf8'))
    const target = join(profileDir, 'node_modules', item.name)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: item.name, version: item.version, candidate: true }))
    manifest.dependencies[item.name] = 'file:' + artifact
    if (item.failInstall) { writeFileSync(manifestPath, JSON.stringify(manifest)); process.exit(23) }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'candidate-lock\\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), 'candidate-bundles\\n')
  process.exit(0)
}
if (args[0] === 'plugin' && args.includes('install')) {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  for (const name of ['loom-fixture-a', 'loom-fixture-b', 'loom-fixture-c']) {
    if (manifest.dependencies?.[name] === undefined) rmSync(join(profileDir, 'node_modules', name), { recursive: true, force: true })
  }
  for (const [name, spec] of Object.entries(manifest.dependencies || {})) {
    const target = join(profileDir, 'node_modules', name)
    mkdirSync(target, { recursive: true })
    const item = typeof spec === 'string' && spec.startsWith('file:')
      ? JSON.parse(readFileSync(spec.slice('file:'.length), 'utf8'))
      : { name, version: '1.0.0', candidate: false }
    writeFileSync(join(target, 'package.json'), JSON.stringify(item))
  }
  process.exit(0)
}
if (args.includes('--dump-config')) {
  if (existsSync(join(process.cwd(), 'emit-loader-error'))) {
    console.error('dsh: [fixture] patch: entry "missing-fixture" not found')
    process.exit(0)
  }
  process.exit(existsSync(join(profileDir, 'package.json')) ? 0 : 24)
}
process.exit(25)
`, 'utf8')

  const fakePnpm = join(dshCwd, 'fake-pnpm')
  writeFileSync(fakePnpm, `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
for (const name of Object.keys(manifest.dependencies || {})) {
  const target = join(process.cwd(), 'node_modules', name)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0', candidate: false }))
}
`, 'utf8')
  chmodSync(fakePnpm, 0o755)

  const integrationCwd = join(root, 'integration-probe')
  mkdirSync(integrationCwd, { recursive: true })
  const integration = join(integrationCwd, 'integration.mjs')
  writeFileSync(integration, `
import { existsSync } from 'node:fs'
if (process.env.DSH_HOME.endsWith('live-home') && existsSync(${JSON.stringify(join(dshCwd, 'fail-live'))})) process.exit(31)
`, 'utf8')

  const state = profileStateHash(profileDir)
  const targets = ['loom-fixture-a', 'loom-fixture-b'].map((name, index): PluginEvolutionTargetPlan => {
    const source = join(root, `source-${index}`)
    mkdirSync(source, { recursive: true })
    json(join(source, 'package.json'), { name, version: '1.0.0' })
    return {
      id: index === 0 ? 'cost' : 'notify', dependsOn: index === 0 ? [] : ['cost'], packageName: name,
      installed: { packageName: name, version: '1.0.0', dependencySpec: '1.0.0', packagePath: join(profileDir, 'node_modules', name), artifactHash: 'installed', profileManifestHash: state.manifestHash, profileLockHash: state.lockHash },
      source: { kind: 'local', location: source, attestedBy: 'user', snapshotPath: source, treeHash: 'source', packageDir: '.' },
      prepareCommands: [], buildCommands: [], testCommands: [],
    }
  })
  const plan: PluginEvolutionPlan = {
    schemaVersion: 1, capability: 'plugin-evolution', id: 'plan-atomic', createdAt: new Date().toISOString(), profile: 'loom', profileDir,
    requirements: 'couple cost and notification', expectedOutcome: 'notification includes routed cost', targets,
    integrationCommand: { command: process.execPath, args: [integration], cwd: integrationCwd }, state: 'planned',
  }
  const artifacts = targets.map((target) => {
    const tarPath = join(root, `${target.packageName}.tgz`)
    json(tarPath, { name: target.packageName, version: '1.0.0' })
    return {
      targetId: target.id, packageName: target.packageName, version: '1.0.0', sourceBeforeHash: 'source', sourceAfterHash: 'candidate', workspacePath: join(root, 'workspace', target.id), diff: [{ path: 'index.js', kind: 'modified' as const }], commandEvidence: [], tarPath, tarHash: hashFile(tarPath), tarContentHash: 'content',
    }
  })
  const proposal: PluginEvolutionProposal = {
    schemaVersion: 1, capability: 'plugin-evolution', id: 'proposal-atomic', planId: plan.id, profile: 'loom', expectedOutcome: plan.expectedOutcome,
    targets: artifacts, graph: targets.map((target) => ({ id: target.id, dependsOn: target.dependsOn })), createdAt: new Date().toISOString(),
  }
  const report: PluginVerificationReport = { schemaVersion: 1, proposalId: proposal.id, proposalHash: pluginProposalHash(proposal), verdict: 'approved', checks: [], verifiedAt: new Date().toISOString() }
  const manager = new PluginTransactionManager({ root, dshHome, profile: 'loom', dshCommand: [process.execPath, fakeDsh], dshCwd, pnpmCommand: fakePnpm, coldBootCommand: [process.execPath, fakeDsh, 'cold-boot', '--profile', 'loom'], integrationCwd })
  return { root, dshHome, profileDir, dshCwd, plan, proposal, report, manager }
}

describe('package-aware plugin transaction', () => {
  it('stages and activates two frozen packages as one cold transaction', () => {
    const fixture = transactionFixture()
    const ready = fixture.manager.prepare(fixture.plan, fixture.proposal, fixture.report)
    expect(ready).toMatchObject({ state: 'ready_to_activate', verification: { verdict: 'approved' } })
    const completed = activatePluginTransaction(fixture.root, ready.id)
    expect(completed).toMatchObject({ state: 'completed', activation: { loaderPassed: true, integrationPassed: true } })
    for (const name of ['loom-fixture-a', 'loom-fixture-b']) {
      expect(readJson<{ candidate: boolean }>(join(fixture.profileDir, 'node_modules', name, 'package.json')).candidate).toBe(true)
    }
  })

  it('keeps an active owner lock fail-closed and reclaims a dead local owner lock', () => {
    const activeFixture = transactionFixture()
    const activeReady = activeFixture.manager.prepare(activeFixture.plan, activeFixture.proposal, activeFixture.report)
    const activeLock = join(activeFixture.root, 'plugin-transactions', '.activation.lock')
    json(activeLock, { schemaVersion: 1, pid: process.pid, hostname: hostname(), transactionId: 'other', createdAt: new Date(0).toISOString() })
    expect(() => activatePluginTransaction(activeFixture.root, activeReady.id)).toThrow('another plugin transaction activation is in progress')
    expect(activeFixture.manager.read(activeReady.id).state).toBe('ready_to_activate')

    const staleFixture = transactionFixture()
    const staleReady = staleFixture.manager.prepare(staleFixture.plan, staleFixture.proposal, staleFixture.report)
    const staleLock = join(staleFixture.root, 'plugin-transactions', '.activation.lock')
    json(staleLock, { schemaVersion: 1, pid: 2_147_483_647, hostname: hostname(), transactionId: 'crashed', createdAt: new Date(0).toISOString() })
    expect(activatePluginTransaction(staleFixture.root, staleReady.id).state).toBe('completed')
    expect(existsSync(staleLock)).toBe(false)
  })

  it('does not mutate the live profile when the second package fails in the shadow profile', () => {
    const fixture = transactionFixture()
    json(fixture.proposal.targets[1]!.tarPath, { name: 'loom-fixture-b', version: '1.0.0', failInstall: true })
    fixture.proposal.targets[1]!.tarHash = hashFile(fixture.proposal.targets[1]!.tarPath)
    fixture.report.proposalHash = pluginProposalHash(fixture.proposal)
    const failed = fixture.manager.prepare(fixture.plan, fixture.proposal, fixture.report)
    expect(failed.state).toBe('failed')
    for (const name of ['loom-fixture-a', 'loom-fixture-b']) {
      expect(readJson<{ candidate: boolean }>(join(fixture.profileDir, 'node_modules', name, 'package.json')).candidate).toBe(false)
    }
    expect(readFileSync(join(fixture.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('old-bundles\n')
  })

  it('rejects an integration cwd that differs from the host-owned transaction cwd', () => {
    const fixture = transactionFixture()
    fixture.plan.integrationCommand!.cwd = join(fixture.root, 'untrusted-probe')
    const failed = fixture.manager.prepare(fixture.plan, fixture.proposal, fixture.report)
    expect(failed).toMatchObject({ state: 'failed' })
    expect(failed.error).toContain('host-owned transaction cwd')
  })

  it('rejects Loader diagnostics even when the DSH dump command exits zero', () => {
    const fixture = transactionFixture()
    writeFileSync(join(fixture.dshCwd, 'emit-loader-error'), '1', 'utf8')
    const failed = fixture.manager.prepare(fixture.plan, fixture.proposal, fixture.report)
    expect(failed).toMatchObject({ state: 'failed', verification: { verdict: 'rejected' } })
    expect(failed.verification?.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cold-loader', verdict: 'rejected' }),
    ]))
  })

  it('restores the complete old profile when live integration rejects the coupled behavior', () => {
    const fixture = transactionFixture()
    const ready = fixture.manager.prepare(fixture.plan, fixture.proposal, fixture.report)
    writeFileSync(join(fixture.dshCwd, 'fail-live'), '1', 'utf8')
    const failed = activatePluginTransaction(fixture.root, ready.id)
    expect(failed).toMatchObject({ state: 'failed', rollback: { attempted: true, succeeded: true } })
    expect(readFileSync(join(fixture.profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe('old-lock\n')
    expect(readFileSync(join(fixture.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('old-bundles\n')
    for (const name of ['loom-fixture-a', 'loom-fixture-b']) {
      expect(readJson<{ candidate: boolean }>(join(fixture.profileDir, 'node_modules', name, 'package.json')).candidate).toBe(false)
    }
  })

  it('rejects Profile drift before activation without overwriting the external change', () => {
    const fixture = transactionFixture()
    const ready = fixture.manager.prepare(fixture.plan, fixture.proposal, fixture.report)
    writeFileSync(join(fixture.profileDir, 'cordis.patch.yml'), 'external-change\n', 'utf8')
    const failed = activatePluginTransaction(fixture.root, ready.id)
    expect(failed.error).toContain('live profile changed')
    expect(failed.rollback).toEqual({ attempted: false, succeeded: false })
    expect(readFileSync(join(fixture.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('external-change\n')
  })

  it('restores the old combination without reusing the upgrade-only integration expectation', () => {
    const fixture = transactionFixture()
    const install = fixture.manager.prepare(fixture.plan, fixture.proposal, fixture.report)
    expect(activatePluginTransaction(fixture.root, install.id).state).toBe('completed')
    writeFileSync(join(fixture.dshCwd, 'fail-live'), '1', 'utf8')
    const restore = fixture.manager.prepareRestore(install.id)
    expect(restore.integrationCommand).toBeUndefined()
    expect(activatePluginTransaction(fixture.root, restore.id).state).toBe('completed')
    expect(fixture.manager.read(install.id).state).toBe('rolled_back')
    for (const name of ['loom-fixture-a', 'loom-fixture-b']) {
      expect(readJson<{ candidate: boolean }>(join(fixture.profileDir, 'node_modules', name, 'package.json')).candidate).toBe(false)
    }
  })

  it('updates an installed plugin through deterministic staging without a Builder proposal', () => {
    const fixture = transactionFixture()
    const tarPath = join(fixture.root, 'lifecycle-update.tgz')
    json(tarPath, { name: 'loom-fixture-a', version: '1.0.0', candidate: true })
    const plan: PluginLifecyclePlan = {
      schemaVersion: 1, capability: 'plugin-lifecycle', id: 'lifecycle-update', createdAt: new Date().toISOString(),
      profile: 'loom', profileDir: fixture.profileDir, operation: 'update', packageName: 'loom-fixture-a',
      beforeProfileHash: pluginProfileTransactionHash(fixture.profileDir), beforeDependencySpec: '1.0.0',
      frozen: { packageName: 'loom-fixture-a', version: '1.0.0', dependencySpec: `file:${tarPath}`, tarPath, tarHash: hashFile(tarPath) }, state: 'planned',
    }
    const ready = fixture.manager.prepareLifecycle(plan)
    expect(ready).toMatchObject({ kind: 'lifecycle', state: 'ready_to_activate', verification: { verdict: 'approved' } })
    expect(readJson<{ candidate: boolean }>(join(fixture.profileDir, 'node_modules', 'loom-fixture-a', 'package.json')).candidate).toBe(false)
    const completed = activatePluginTransaction(fixture.root, ready.id)
    expect(completed.state).toBe('completed')
    expect(readJson<{ candidate: boolean }>(join(fixture.profileDir, 'node_modules', 'loom-fixture-a', 'package.json')).candidate).toBe(true)
    const restore = fixture.manager.prepareRestore(ready.id)
    expect(activatePluginTransaction(fixture.root, restore.id).state).toBe('completed')
    expect(readJson<{ candidate: boolean }>(join(fixture.profileDir, 'node_modules', 'loom-fixture-a', 'package.json')).candidate).toBe(false)
  })

  it('installs and removes plugins as cold lifecycle transactions with exact restore snapshots', () => {
    const fixture = transactionFixture()
    const tarPath = join(fixture.root, 'lifecycle-install.tgz')
    json(tarPath, { name: 'loom-fixture-c', version: '2.0.0', candidate: true })
    const install: PluginLifecyclePlan = {
      schemaVersion: 1, capability: 'plugin-lifecycle', id: 'lifecycle-install', createdAt: new Date().toISOString(),
      profile: 'loom', profileDir: fixture.profileDir, operation: 'install', packageName: 'loom-fixture-c',
      beforeProfileHash: pluginProfileTransactionHash(fixture.profileDir),
      frozen: { packageName: 'loom-fixture-c', version: '2.0.0', dependencySpec: `file:${tarPath}`, tarPath, tarHash: hashFile(tarPath) }, state: 'planned',
    }
    const installReady = fixture.manager.prepareLifecycle(install)
    expect(activatePluginTransaction(fixture.root, installReady.id).state).toBe('completed')
    expect(readJson<{ version: string }>(join(fixture.profileDir, 'node_modules', 'loom-fixture-c', 'package.json')).version).toBe('2.0.0')

    const remove: PluginLifecyclePlan = {
      schemaVersion: 1, capability: 'plugin-lifecycle', id: 'lifecycle-remove', createdAt: new Date().toISOString(),
      profile: 'loom', profileDir: fixture.profileDir, operation: 'remove', packageName: 'loom-fixture-c',
      beforeProfileHash: pluginProfileTransactionHash(fixture.profileDir), beforeDependencySpec: `file:${tarPath}`, state: 'planned',
    }
    const removeReady = fixture.manager.prepareLifecycle(remove)
    expect(activatePluginTransaction(fixture.root, removeReady.id).state).toBe('completed')
    expect(existsSync(join(fixture.profileDir, 'node_modules', 'loom-fixture-c'))).toBe(false)
    const restore = fixture.manager.prepareRestore(removeReady.id)
    expect(activatePluginTransaction(fixture.root, restore.id).state).toBe('completed')
    expect(readJson<{ version: string }>(join(fixture.profileDir, 'node_modules', 'loom-fixture-c', 'package.json')).version).toBe('2.0.0')
  })
})
