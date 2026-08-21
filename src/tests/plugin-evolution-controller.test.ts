import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PluginEvolutionController } from '../plugin-evolution/controller.js'
import type { PluginEvolutionPlan, PluginEvolutionProposal, PluginTransactionRecord, PluginVerificationReport } from '../plugin-evolution/types.js'

function json(path: string, value: unknown): void { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value), 'utf8') }

function fixture(): {
  controller: PluginEvolutionController
  transaction: PluginTransactionRecord
  input: Parameters<PluginEvolutionController['plan']>[0]
} {
  const root = mkdtempSync(join(tmpdir(), 'loom-plugin-controller-'))
  const profileDir = join(root, 'home', 'profiles', 'loom')
  const source = join(root, 'source')
  json(join(profileDir, 'package.json'), { dependencies: { 'loom-fixture-a': '1.0.0' } })
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lock', 'utf8')
  json(join(profileDir, 'node_modules', 'loom-fixture-a', 'package.json'), { name: 'loom-fixture-a', version: '1.0.0' })
  json(join(source, 'package.json'), { name: 'loom-fixture-a', version: '1.0.0' })
  writeFileSync(join(source, 'index.js'), 'export const x = 1', 'utf8')
  let latestPlan: PluginEvolutionPlan | undefined
  const gateway = {
    start: (plan: PluginEvolutionPlan) => { latestPlan = plan; return { runId: 'builder-run' } },
    run: async (): Promise<{ runId: string; state: 'submitted'; proposal: PluginEvolutionProposal }> => ({
      runId: 'builder-run', state: 'submitted', proposal: {
        schemaVersion: 1, capability: 'plugin-evolution', id: 'proposal', planId: latestPlan!.id, profile: 'loom',
        expectedOutcome: latestPlan!.expectedOutcome, targets: [], graph: [], createdAt: new Date().toISOString(),
      },
    }),
  }
  const transaction: PluginTransactionRecord = {
    schemaVersion: 1, id: 'tx', kind: 'install', planId: 'dynamic', proposalHash: 'hash', profile: 'loom', profileDir,
    dshHome: join(root, 'home'), dshCommand: ['dsh'], dshCwd: root, pnpmCommand: 'pnpm', state: 'ready_to_activate',
    coldBootCommand: ['cold-boot'],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), beforeProfileHash: 'before', beforeFiles: [], artifacts: [],
  }
  const approved: PluginVerificationReport = { schemaVersion: 1, proposalId: 'proposal', proposalHash: 'hash', verdict: 'approved', checks: [], verifiedAt: new Date().toISOString() }
  const transactions = {
    prepare: () => transaction,
    cancelReady: () => { transaction.state = 'cancelled'; return transaction },
    prepareRestore: () => ({ ...transaction, id: 'restore', kind: 'restore' as const, state: 'ready_to_activate' as const }),
    read: () => transaction,
  }
  const controller = new PluginEvolutionController({ root, sessionId: 'windows:session/unsafe', profile: 'loom', profileDir, gateway, transactions, verify: () => approved })
  return {
    controller, transaction,
    input: {
      requirements: 'add model-aware cost output', expectedOutcome: 'cost event includes model',
      targets: [{ id: 'cost', packageName: 'loom-fixture-a', source: { kind: 'local', location: source, attestedBy: 'user' }, testCommands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }] }],
    },
  }
}

describe('PluginEvolutionController', () => {
  it('persists the host-frozen plan and stops at ready_to_activate', async () => {
    const { controller, input } = fixture()
    const plan = controller.plan(input)
    expect(plan.targets[0]).toMatchObject({ packageName: 'loom-fixture-a', installed: { version: '1.0.0' } })
    const ready = await controller.execute(plan.id)
    expect(ready).toMatchObject({ state: 'ready_to_activate', transactionId: 'tx', result: { applied: false, restartRequired: true } })
    await expect(controller.execute(plan.id)).rejects.toThrow('not executable')
  })

  it('reconciles cold activation and creates a separate restore transaction', async () => {
    const { controller, transaction, input } = fixture()
    const ready = await controller.execute(controller.plan(input).id)
    transaction.state = 'completed'
    const completed = controller.reconcile(ready.id)
    expect(completed).toMatchObject({ state: 'completed', result: { applied: true, effective: true } })
    expect(controller.prepareRestore(ready.id)).toMatchObject({ id: 'restore', kind: 'restore', state: 'ready_to_activate' })
  })

  it('allows cancellation only before cold activation', async () => {
    const { controller, input } = fixture()
    const ready = await controller.execute(controller.plan(input).id)
    expect(controller.cancelReady(ready.id)).toMatchObject({ state: 'cancelled', result: { applied: false } })
    expect(() => controller.cancelReady(ready.id)).toThrow('not cancellable')
  })
})
