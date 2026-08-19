import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ActorEvolutionGateway } from '../candidates/actor-gateway.js'
import { BuilderKernel, builderRunPaths } from '../builder/kernel.js'
import { classifyBuilderProposal, adjudicatePatch } from '../deliberation/index.js'
import { Gate, type ApplyOps } from '../gate/index.js'
import { Validator } from '../validate/index.js'

const REGRESSION_DIR = fileURLToPath(new URL('../../meta-regressions', import.meta.url))

describe('actor evolution gateway', () => {
  it('runs mini-SWE over an isolated config copy and compiles the existing patch-evolution envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-actor-gateway-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi\n  if [ "$1" = "-c" ] && case "$2" in environment.cwd=*) true;; *) false;; esac; then work="${2#environment.cwd=}"; shift 2; continue; fi\n  shift\ndone\nprintf \'{"model":"after","timeoutMs":30000}\\n\' > "$work/actor-config.json"\nprintf \'runtime scratch\' > "$work/outside.txt"\nprintf \'{"messages":[{"role":"assistant","tool_calls":[{}]},{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const gateway = new ActorEvolutionGateway({
      root, sessionId: 's', model: 'test',
      miniSwe: { executable, configPath: 'ignored', stepLimit: 3, timeoutMs: 5_000 },
    })
    const started = gateway.startConfig('切换到可用模型', { capability: 'config-evolution', targetId: 'agent-default-model', before: { model: 'before', timeoutMs: 60000 } })
    const result = await gateway.runConfig(started.runId)
    expect(result).toMatchObject({ state: 'submitted', proposal: {
      capability: 'patch-evolution', payload: { targetId: 'agent-default-model', targetKind: 'config', action: 'update', config: { model: 'after', timeoutMs: 30000 } },
    } })
    const paths = builderRunPaths(root, 's:actor-evolution', started.runId)
    expect(readFileSync(join(paths.workspaceBaseline, 'actor-config.json'), 'utf8')).toContain('before')
    expect(readFileSync(join(paths.workspace, 'outside.txt'), 'utf8')).toBe('runtime scratch')
    const kernel = new BuilderKernel(root, 's:actor-evolution')
    expect(kernel.proposal(started.runId)).toEqual(result.proposal)
  })

  it('feeds the config runtime proposal through the existing Validator and Gate, including before/after application', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-actor-gateway-adjudicate-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi\n  if [ "$1" = "-c" ] && case "$2" in environment.cwd=*) true;; *) false;; esac; then work="${2#environment.cwd=}"; shift 2; continue; fi\n  shift\ndone\nprintf \'{"model":"after"}\\n\' > "$work/actor-config.json"\nprintf \'{"messages":[{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const gateway = new ActorEvolutionGateway({ root, sessionId: 's', model: 'test', miniSwe: { executable, configPath: 'ignored', stepLimit: 3, timeoutMs: 5_000 } })
    const started = gateway.startConfig('切换模型', {
      capability: 'config-evolution', targetId: 'agent-default-model', before: { model: 'before' },
      expectedTrajectory: { schemaVersion: 1, patchId: 'controller-bound', events: [{ type: 'turn/start' }, { type: 'turn/end', reason: 'success' }], coverage: { claimedBehaviors: [] } },
    })
    const run = await gateway.runConfig(started.runId)
    if (!run.proposal) throw new Error('test requires a frozen proposal')
    const classified = classifyBuilderProposal(run.proposal)
    if (classified.kind !== 'known' || classified.proposal.capability !== 'patch-evolution') throw new Error('test requires patch-evolution proposal')
    const proposal = classified.proposal
    let live: Record<string, unknown> = { model: 'before' }
    const ops: ApplyOps = {
      readConfig: () => live,
      writeConfig: (_id, next) => { live = next },
      smoke: () => ({ schemaVersion: 1, patchId: proposal.patch.id, passed: true, checks: [{ name: 'cold-config-smoke', passed: true }], ranAt: new Date().toISOString() }),
      baseline: live,
    }
    const result = await adjudicatePatch(proposal, {
      root, sessionId: 's', validator: new Validator(null, { regressionDir: REGRESSION_DIR, maxCases: 20, coverageThreshold: 0.75 }), gate: new Gate(null, { root, sessionId: 's' }), applyOps: ops,
      evidenceEvents: [{ type: 'turn/start' }, { type: 'turn/end', reason: 'success' }],
    })
    expect(result).toMatchObject({ verdict: 'approved', applied: { applied: true } })
    expect(live).toEqual({ model: 'after' })
  })

  it('runs mini-SWE over a tool bundle and compiles the existing patch-evolution module envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-actor-gateway-module-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi\n  if [ "$1" = "-c" ] && case "$2" in environment.cwd=*) true;; *) false;; esac; then work="${2#environment.cwd=}"; shift 2; continue; fi\n  shift\ndone\nprintf \'export const name = "echo-tool"\\n\' > "$work/actor-module/index.mjs"\nprintf \'{"messages":[{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const gateway = new ActorEvolutionGateway({ root, sessionId: 's', model: 'test', miniSwe: { executable, configPath: 'ignored', stepLimit: 3, timeoutMs: 5_000 } })
    const expectedTrajectory = { schemaVersion: 1 as const, patchId: 'controller-bound', events: [{ type: 'turn/start' }, { type: 'turn/end', reason: 'success' }], coverage: { claimedBehaviors: [] } }
    const started = gateway.startModule('新增 echo 工具', { capability: 'tool-evolution', targetId: 'echo-tool', targetName: 'echo-tool', targetKind: 'tool', entry: 'index.mjs', expectedTrajectory })
    const run = await gateway.runModule(started.runId)
    expect(run).toMatchObject({ state: 'submitted', proposal: {
      capability: 'patch-evolution', payload: { action: 'insert', targetId: 'echo-tool', targetKind: 'tool', module: { entry: 'index.mjs', files: [expect.objectContaining({ path: 'index.mjs' })] } },
    } })
    if (!run.proposal) throw new Error('test requires compiled module proposal')
    const classified = classifyBuilderProposal(run.proposal)
    if (classified.kind !== 'known' || classified.proposal.capability !== 'patch-evolution') throw new Error('test requires patch proposal')
    let installed = false
    const result = await adjudicatePatch(classified.proposal, {
      root, sessionId: 's:actor-evolution',
      validator: new Validator(null, { regressionDir: REGRESSION_DIR, maxCases: 20, coverageThreshold: 0.75, workspaceRoot: root, sessionId: 's:actor-evolution' }),
      gate: new Gate(null, { root, sessionId: 's:actor-evolution' }),
      evidenceEvents: expectedTrajectory.events,
      applyOps: {
        readConfig: () => ({}), writeConfig: () => {}, rowExists: () => installed,
        insertRow: () => { installed = true }, removeRow: () => { installed = false },
        smoke: (patch) => ({ schemaVersion: 1, patchId: patch.id, passed: true, checks: [{ name: 'module-cold-smoke', passed: true }], ranAt: new Date().toISOString() }),
      },
    })
    expect(result).toMatchObject({ verdict: 'approved', applied: { applied: true } })
    expect(installed).toBe(true)
  })

  it('runs mini-SWE over a skill bundle through the same module compiler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-actor-gateway-skill-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi\n  if [ "$1" = "-c" ] && case "$2" in environment.cwd=*) true;; *) false;; esac; then work="${2#environment.cwd=}"; shift 2; continue; fi\n  shift\ndone\nmkdir -p "$work/actor-module/edit-verify"\nprintf \'%b\' \'---\\nname: edit-verify\\n---\\nAlways validate edited files.\\n\' > "$work/actor-module/edit-verify/SKILL.md"\nprintf \'{"messages":[{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const gateway = new ActorEvolutionGateway({ root, sessionId: 's', model: 'test', miniSwe: { executable, configPath: 'ignored', stepLimit: 3, timeoutMs: 5_000 } })
    const started = gateway.startModule('新增编辑验证技能', { capability: 'skill-evolution', targetId: 'edit-verify', targetKind: 'skill', entry: 'edit-verify/SKILL.md' })
    await expect(gateway.runModule(started.runId)).resolves.toMatchObject({ state: 'submitted', proposal: {
      capability: 'patch-evolution', payload: { action: 'insert', targetId: 'edit-verify', targetKind: 'skill', module: { entry: 'edit-verify/SKILL.md', files: [expect.objectContaining({ path: 'edit-verify/SKILL.md' })] } },
    } })
  })

  it('rejects a mini-SWE skill through catalog probe and rolls its Gate install back on cold smoke failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-actor-gateway-skill-gate-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi\n  if [ "$1" = "-c" ] && case "$2" in environment.cwd=*) true;; *) false;; esac; then work="${2#environment.cwd=}"; shift 2; continue; fi\n  shift\ndone\nmkdir -p "$work/actor-module/edit-verify"\nprintf \'%b\' \'---\\nname: edit-verify\\n---\\nAlways validate edited files.\\n\' > "$work/actor-module/edit-verify/SKILL.md"\nprintf \'{"messages":[{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const expectedTrajectory = { schemaVersion: 1 as const, patchId: 'controller-bound', events: [{ type: 'turn/start' }, { type: 'turn/end', reason: 'success' }], coverage: { claimedBehaviors: [] } }
    const gateway = new ActorEvolutionGateway({ root, sessionId: 's', model: 'test', miniSwe: { executable, configPath: 'ignored', stepLimit: 3, timeoutMs: 5_000 } })
    const started = gateway.startModule('新增编辑验证技能', { capability: 'skill-evolution', targetId: 'edit-verify', targetKind: 'skill', entry: 'edit-verify/SKILL.md', expectedTrajectory })
    const run = await gateway.runModule(started.runId)
    if (!run.proposal) throw new Error('test requires compiled skill proposal')
    const classified = classifyBuilderProposal(run.proposal)
    if (classified.kind !== 'known' || classified.proposal.capability !== 'patch-evolution') throw new Error('test requires patch proposal')
    let installed = false
    const result = await adjudicatePatch(classified.proposal, {
      root, sessionId: 's:actor-evolution',
      validator: new Validator(null, {
        regressionDir: REGRESSION_DIR, maxCases: 20, coverageThreshold: 0.75, workspaceRoot: root, sessionId: 's:actor-evolution',
        skillIsolation: {
          dshCommand: ['unused'], cwd: root, profile: 'fixture', baseOverlays: [], stagingRoot: join(root, 'skill-staging'),
          dumpRunner: () => '# catalog baseline\n',
          probeRunner: (_overlays, task) => ({ out: `loaded edit-verify: ${task}`, exit: 0 }),
        },
      }),
      gate: new Gate(null, { root, sessionId: 's:actor-evolution' }), evidenceEvents: expectedTrajectory.events,
      applyOps: {
        readConfig: () => ({}), writeConfig: () => {}, skillExists: () => installed,
        installSkill: () => { installed = true }, removeSkill: () => { installed = false },
        smoke: (patch) => ({ schemaVersion: 1, patchId: patch.id, passed: false, checks: [{ name: 'cold-skill-smoke', passed: false }], ranAt: new Date().toISOString() }),
      },
    })
    expect(result).toMatchObject({ verdict: 'rejected', applied: { applied: false } })
    expect(result.reason).toContain('cold-skill-smoke')
    expect(installed).toBe(false)
  })

  it('reopens a rejected config run with a fresh workspace baseline and prior report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-actor-gateway-reopen-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf8')
    chmodSync(executable, 0o755)
    const gateway = new ActorEvolutionGateway({ root, sessionId: 's', model: 'test', miniSwe: { executable, configPath: 'ignored', stepLimit: 3, timeoutMs: 5_000 } })
    const started = gateway.startConfig('切换模型', { capability: 'config-evolution', targetId: 'agent-default-model', before: { model: 'before' } })
    const kernel = new BuilderKernel(root, 's:actor-evolution')
    kernel.decide(started.runId, { kind: 'tool', action: { name: 'write_workspace_file', path: 'actor-config.json', content: '{"model":"rejected"}\n' } })
    const message = kernel.context(started.runId).messages[0]
    if (!message) throw new Error('test requires initial Actor message')
    kernel.decide(started.runId, { kind: 'tool', action: { name: 'acknowledge_message', messageId: message.id, status: 'accepted', understanding: 'fixture', nextAction: 'submit fixture' } })
    kernel.decide(started.runId, { kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'patch-evolution', payload: { targetId: 'agent-default-model', targetKind: 'config' }, rationale: 'fixture' } } })
    kernel.decide(started.runId, { kind: 'submit' })
    const reopened = gateway.reopen(started.runId, { verdict: 'rejected', failureSummary: 'cold smoke failed' })
    const next = builderRunPaths(root, 's:actor-evolution', reopened.runId)
    expect(reopened.runId).not.toBe(started.runId)
    expect(readFileSync(join(next.workspace, 'actor-config.json'), 'utf8')).toContain('before')
    expect(readFileSync(join(next.workspaceBaseline, 'actor-config.json'), 'utf8')).toContain('before')
    expect(readFileSync(join(next.previousAttempt), 'utf8')).toContain('cold smoke failed')
  })

  it('runs mini-SWE over a host-fixed composition workspace and submits only an actor-composition envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-actor-gateway-composition-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi\n  if [ "$1" = "-c" ] && case "$2" in environment.cwd=*) true;; *) false;; esac; then work="${2#environment.cwd=}"; shift 2; continue; fi\n  shift\ndone\nprintf \'{"model":"after"}\\n\' > "$work/composition/config/config.json"\nmkdir -p "$work/composition/tool/module"\nprintf \'export const name = "echo"\\n\' > "$work/composition/tool/module/index.mjs"\nprintf \'{"messages":[{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const trajectory = { schemaVersion: 1, patchId: 'controller', events: [{ type: 'turn/start' }], coverage: { claimedBehaviors: [] } }
    const gateway = new ActorEvolutionGateway({ root, sessionId: 's', model: 'test', miniSwe: { executable, configPath: 'ignored', stepLimit: 3, timeoutMs: 5_000 } })
    const started = gateway.startComposition('同时更新模型并加入工具', {
      capability: 'actor-composition', id: 'composition-fixture', rationale: 'coupled feature', expectedOutcome: 'both available',
      targets: [
        { id: 'config', targetId: 'agent-config', targetKind: 'config', before: { model: 'before' }, expectedTrajectory: trajectory },
        { id: 'tool', dependsOn: ['config'], targetId: 'echo-tool', targetKind: 'tool', entry: 'index.mjs', expectedTrajectory: trajectory },
      ],
    })
    await expect(gateway.runComposition(started.runId)).resolves.toMatchObject({ state: 'submitted', proposal: {
      capability: 'actor-composition', id: 'composition-fixture', operations: [
        { id: 'config', patch: { targetId: 'agent-config', config: { model: 'after' } } },
        { id: 'tool', dependsOn: ['config'], patch: { targetId: 'echo-tool', module: { entry: 'index.mjs' } } },
      ],
    } })
  })
})
