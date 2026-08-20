import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Validator, type ActualEvent } from '../validate/index.js'
import { paths, readJsonl } from '../protocol/index.js'
import type { MetaPatch, ValidationReport } from '../types.js'

const REGRESSION_DIR = fileURLToPath(new URL('../../meta-regressions', import.meta.url))

const ISO_BASE = `# == base
- id: row-a
  name: 'x'
  config:
    timeoutMs: 5000
- id: row-b
  name: 'y'
  config:
    maxTokens: 8192
`
const ISO_PATCHED = ISO_BASE.replace('timeoutMs: 5000', 'timeoutMs: 30000')

function patch(overrides: Partial<MetaPatch> = {}): MetaPatch {
  return {
    id: 'p1',
    targetId: 'dsh-tool-bash-persistent',
    targetKind: 'config',
    config: { timeoutMs: 30000 },
    dependencies: [],
    rationale: 'test',
    expectedOutcome: 'bash ok',
    expectedTrajectory: {
      schemaVersion: 1,
      patchId: 'p1',
      events: [
        { type: 'turn/start', turn: 1 },
        { type: 'tool/call', turn: 1, step: 1, name: 'bash', argsHash: 'h1' },
        { type: 'tool/result', turn: 1, step: 1, name: 'bash', error: null, resultHash: 'h2' },
        { type: 'turn/end', turn: 1, reason: 'success' },
      ],
      coverage: { claimedBehaviors: ['bash'] },
    },
    version: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

const OK_EVENTS: ActualEvent[] = [
  { type: 'turn/start', turn: 1 },
  { type: 'tool/call', turn: 1, step: 1, name: 'bash', argsHash: 'h1' },
  { type: 'tool/result', turn: 1, step: 1, name: 'bash', error: null, resultHash: 'h2' },
  { type: 'turn/end', turn: 1, reason: 'success' },
]

function validator(): Validator {
  return new Validator(null, { regressionDir: REGRESSION_DIR, maxCases: 20, coverageThreshold: 0.75 })
}

async function reportFor(input: { actualEvents: ActualEvent[]; configBeforeHash?: string; actualConfigHash?: string }): Promise<ValidationReport> {
  const v = validator()
  return v.run(patch(), await v.loadRegressionCases(), input)
}

describe('validator A3', () => {
  it('approves a fully aligned candidate (accuracy=1, coverage ok, regression green)', async () => {
    const report = await reportFor({ actualEvents: OK_EVENTS })
    expect(report.verdict).toBe('approved')
    expect(report.alignment?.accuracy).toBe(1)
    expect(report.alignment?.coverage).toBe(1)
    expect(report.regressionResults?.every((item) => item.passed)).toBe(true)
  })

  it('writes a traceable ledger entry for every verification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-ledger-'))
    const sessionId = 's1'
    const v = new Validator(null, { regressionDir: REGRESSION_DIR, maxCases: 20, workspaceRoot: root, sessionId })
    const report = await v.run(patch(), await v.loadRegressionCases(), { actualEvents: OK_EVENTS })
    expect(report.verdict).toBe('approved')
    const ledger = readJsonl<{ patchId: string; verdict: string }>(paths.ledger(root, sessionId))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.patchId).toBe('p1')
    expect(ledger[0]!.verdict).toBe('approved')
  })

  it('rejects and locates the first divergence exactly', async () => {
    const events: ActualEvent[] = OK_EVENTS.map((event, index) =>
      index === 2 ? { ...event, error: 'TIMEOUT', resultHash: 'bad' } : event,
    )
    const report = await reportFor({ actualEvents: events })
    expect(report.verdict).toBe('rejected')
    expect(report.alignment?.firstDivergence?.index).toBe(2)
    expect(report.alignment?.firstDivergence?.fields).toContain('error')
  })

  it('rejects when coverage is below threshold', async () => {
    const p = patch()
    p.expectedTrajectory!.coverage = { claimedBehaviors: ['bash', 'fs-write'] }
    p.expectedTrajectory!.events = [
      { type: 'turn/start', turn: 1 },
      { type: 'turn/end', turn: 1, reason: 'success' },
    ]
    const v = validator()
    const report = await v.run(p, await v.loadRegressionCases(), { actualEvents: OK_EVENTS })
    expect(report.verdict).toBe('rejected')
    expect(report.failureSummary).toContain('coverage')
  })

  it('accepts named probe aliases as coverage for config/persona patches', async () => {
    const p = patch()
    p.expectedTrajectory!.coverage = { claimedBehaviors: ['输出格式偏好生效'] }
    p.expectedTrajectory!.events = [
      { type: 'turn/start', turn: 1 },
      { type: 'turn/end', turn: 1, reason: 'success' },
    ]
    const v = validator()
    const report = await v.run(p, await v.loadRegressionCases(), {
      actualEvents: [
        { type: 'turn/start', turn: 1 },
        { type: 'turn/end', turn: 1, reason: 'success' },
      ],
      nameAliases: ['system-prompt'],
    })
    expect(report.verdict).toBe('approved')
  })

  it('rejects on config invariance violation', async () => {
    const report = await reportFor({
      actualEvents: OK_EVENTS,
      configBeforeHash: 'before-a',
      actualConfigHash: 'before-b',
    })
    expect(report.verdict).toBe('rejected')
    expect(report.failureSummary).toContain('config invariance')
  })

  it('rejects when a regression scenario fails', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'dsh-mv-reg-'))
    const scenario = join(badDir, 'bad-case')
    mkdirSync(scenario)
    writeFileSync(join(scenario, 'task.md'), 'x')
    writeFileSync(join(scenario, 'expected.json'), JSON.stringify({ stdoutContains: 'never-appears' }))
    writeFileSync(join(scenario, 'run.sh'), '#!/bin/bash\necho wrong\n')
    const v = new Validator(null, { regressionDir: badDir, maxCases: 20 })
    const report = await v.run(patch(), await v.loadRegressionCases(), { actualEvents: OK_EVENTS })
    expect(report.verdict).toBe('rejected')
    expect(report.failureSummary).toContain('regression bad-case failed')
  })

  it('rejects a candidate without an expected trajectory', async () => {
    const p = patch()
    p.expectedTrajectory = undefined
    const v = validator()
    const report = await v.run(p, [], { actualEvents: [] })
    expect(report.verdict).toBe('rejected')
  })

  it('runs verifier-owned isolation first and rejects composition failure', async () => {
    const p = patch({ targetId: 'row-a' })
    const v = new Validator(null, {
      regressionDir: REGRESSION_DIR,
      maxCases: 20,
      isolation: {
        dshCommand: ['dsh'],
        cwd: '/tmp',
        profile: 'headless',
        baseOverlays: [],
        dumpRunner: (overlays) => (overlays.length === 0 ? ISO_BASE : ISO_PATCHED.replace('maxTokens: 8192', 'maxTokens: 4096')),
      },
    })
    const report = await v.run(p, [], { actualEvents: [] })
    expect(report.verdict).toBe('rejected')
    expect(report.failureSummary).toContain('isolation composed failed')
  })

  it('passes isolation then proceeds to alignment', async () => {
    const p = patch({ targetId: 'row-a' })
    const v = new Validator(null, {
      regressionDir: REGRESSION_DIR,
      maxCases: 20,
      isolation: {
        dshCommand: ['dsh'],
        cwd: '/tmp',
        profile: 'headless',
        baseOverlays: [],
        dumpRunner: (overlays) => (overlays.length === 0 ? ISO_BASE : ISO_PATCHED),
      },
    })
    const report = await v.run(p, [], { actualEvents: OK_EVENTS })
    expect(report.verdict).toBe('approved')
    expect(report.evidence.some((line) => line.startsWith('isolation composed=true'))).toBe(true)
  })

  it('runSmoke passes keyless regression subset + expectedOutcome', async () => {
    const v = validator()
    const smoke = await v.runSmoke(patch(), await v.loadRegressionCases())
    expect(smoke.passed).toBe(true)
    expect(smoke.checks.some((check) => check.name === 'expectedOutcome')).toBe(true)
  })

  it('runSmoke fails when a regression scenario fails', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'dsh-mv-smoke-'))
    const scenario = join(badDir, 'bad')
    mkdirSync(scenario)
    writeFileSync(join(scenario, 'task.md'), 'x')
    writeFileSync(join(scenario, 'expected.json'), JSON.stringify({ stdoutContains: 'nope' }))
    writeFileSync(join(scenario, 'run.sh'), '#!/bin/bash\necho wrong\n')
    const v = new Validator(null, { regressionDir: badDir, maxCases: 20 })
    const smoke = await v.runSmoke(patch(), await v.loadRegressionCases())
    expect(smoke.passed).toBe(false)
  })

  it('rejects builder modules with syntax errors via load check (M4)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-load-'))
    const sessionId = 's1'
    const p = patch({ action: 'insert', targetName: 'bad-tool', targetKind: 'tool' })
    p.module = {
      files: [{ path: 'bad.mjs', content: 'export const name = \n' }],
      entry: 'bad.mjs',
    }
    const staging = paths.staging(root, sessionId, p.id)
    mkdirSync(join(staging), { recursive: true })
    writeFileSync(join(staging, 'bad.mjs'), p.module.files[0]!.content, 'utf8')
    const v = new Validator(null, { regressionDir: REGRESSION_DIR, maxCases: 20, workspaceRoot: root, sessionId })
    const report = await v.run(p, [], { actualEvents: [] })
    expect(report.verdict).toBe('rejected')
    expect(report.failureSummary).toContain('module load check failed')
  })

  it('passes load check for valid builder modules (M4)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-load-'))
    const sessionId = 's1'
    const p = patch({ action: 'insert', targetName: 'ok-tool', targetKind: 'tool' })
    p.expectedTrajectory = {
      schemaVersion: 1,
      patchId: p.id,
      events: [
        { type: 'turn/start', turn: 1 },
        { type: 'tool/result', turn: 1, step: 1, name: 'ok-tool', error: null },
        { type: 'turn/end', turn: 1, reason: 'success' },
      ],
      coverage: { claimedBehaviors: ['ok-tool'] },
    }
    p.module = {
      files: [{ path: 'ok.mjs', content: 'export const name = "ok-tool"\n' }],
      entry: 'ok.mjs',
    }
    const staging = paths.staging(root, sessionId, p.id)
    mkdirSync(join(staging), { recursive: true })
    writeFileSync(join(staging, 'ok.mjs'), p.module.files[0]!.content, 'utf8')
    const v = new Validator(null, { regressionDir: REGRESSION_DIR, maxCases: 20, workspaceRoot: root, sessionId })
    const report = await v.run(p, [], { actualEvents: [
      { type: 'turn/start', turn: 1 },
      { type: 'tool/result', turn: 1, step: 1, name: 'ok-tool', error: null },
      { type: 'turn/end', turn: 1, reason: 'success' },
    ] })
    expect(report.verdict).toBe('approved')
  })

  function skillPatch() {
    const p = patch({ action: 'insert', targetId: 'edit-verify', targetName: 'edit-verify', targetKind: 'skill' })
    p.module = { files: [{ path: 'edit-verify/SKILL.md', content: '---\nname: edit-verify\n---\nwc -l body\n' }], entry: 'edit-verify/SKILL.md' }
    p.expectedTrajectory = {
      schemaVersion: 1,
      patchId: p.id,
      events: [
        { type: 'turn/start', turn: 1 },
        { type: 'tool/result', turn: 1, step: 1, name: 'edit-verify', error: null },
        { type: 'turn/end', turn: 1, reason: 'success' },
      ],
      coverage: { claimedBehaviors: ['edit-verify'] },
    }
    return p
  }

  it('passes skill isolation with a real catalog probe (M4)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-skill-'))
    const sessionId = 's1'
    const p = skillPatch()
    let probeOverlays: string[] | undefined
    const v = new Validator(null, {
      regressionDir: REGRESSION_DIR,
      maxCases: 20,
      workspaceRoot: root,
      sessionId,
      skillIsolation: {
        dshCommand: ['dsh'],
        cwd: '/tmp',
        profile: 'headless',
        baseOverlays: [],
        stagingRoot: join(root, 'skills-staging'),
        dumpRunner: () => '# base\n- id: skill-filesystem\n  name: x\n',
        probeRunner: (overlays) => {
          probeOverlays = overlays
          return { out: '技能 edit-verify 内容：wc -l body', exit: 0 }
        },
      },
    })
    const report = await v.run(p, [], { actualEvents: [
      { type: 'turn/start', turn: 1 },
      { type: 'tool/result', turn: 1, step: 1, name: 'edit-verify', error: null },
      { type: 'turn/end', turn: 1, reason: 'success' },
    ] })
    expect(report.verdict).toBe('approved')
    expect(report.evidence.some((line) => line.startsWith('skill isolation: pass'))).toBe(true)
    expect(probeOverlays).toEqual([])
  })

  it('never treats a SKILL.md bundle as a generic Cordis loader entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-skill-routing-'))
    const sessionId = 's1'
    const p = skillPatch()
    let genericDumpCalls = 0
    const v = new Validator(null, {
      regressionDir: REGRESSION_DIR,
      maxCases: 20,
      workspaceRoot: root,
      sessionId,
      isolation: {
        dshCommand: ['dsh'],
        cwd: '/tmp',
        profile: 'headless',
        baseOverlays: [],
        stagingRoot: paths.staging(root, sessionId, p.id),
        dumpRunner: () => {
          genericDumpCalls++
          throw new Error('SKILL.md must not be routed through plugin isolation')
        },
      },
      skillIsolation: {
        dshCommand: ['dsh'],
        cwd: '/tmp',
        profile: 'headless',
        baseOverlays: [],
        stagingRoot: join(root, 'skills-staging'),
        dumpRunner: () => '# base\n- id: skill-filesystem\n  name: x\n',
        probeRunner: () => ({ out: 'loaded edit-verify: wc -l body', exit: 0 }),
      },
    })
    const report = await v.run(p, [], { actualEvents: [
      { type: 'turn/start', turn: 1 },
      { type: 'tool/result', turn: 1, step: 1, name: 'edit-verify', error: null },
      { type: 'turn/end', turn: 1, reason: 'success' },
    ] })
    expect(report.verdict).toBe('approved')
    expect(genericDumpCalls).toBe(0)
  })

  it('cold-loads a Gate-installed skill from the installed root', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-installed-skill-'))
    const installedRoot = join(root, 'installed-skills')
    const p = skillPatch()
    mkdirSync(join(installedRoot, p.targetId), { recursive: true })
    writeFileSync(join(installedRoot, p.module!.entry), p.module!.files[0]!.content, 'utf8')
    let mountedRoot = ''
    const v = new Validator(null, {
      regressionDir: REGRESSION_DIR,
      maxCases: 20,
      skillIsolation: {
        dshCommand: ['dsh'], cwd: '/tmp', profile: 'headless', baseOverlays: [], stagingRoot: join(root, 'probe'),
        dumpRunner: (overlays) => {
          if (overlays.length > 0) mountedRoot = readFileSync(overlays.at(-1)!, 'utf8')
          return '# base\n- id: skill-filesystem\n  name: x\n'
        },
        probeRunner: () => ({ out: `loaded ${p.targetId}`, exit: 0 }),
      },
    })
    expect(v.runInstalledSkillCheck(p, installedRoot)).toMatchObject({ passed: true, file: p.targetId })
    expect(mountedRoot).toContain(JSON.stringify(installedRoot))
  })

  it('rejects skill when the catalog probe reports the skill missing (M4)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-skill-'))
    const sessionId = 's1'
    const p = skillPatch()
    const v = new Validator(null, {
      regressionDir: REGRESSION_DIR,
      maxCases: 20,
      workspaceRoot: root,
      sessionId,
      skillIsolation: {
        dshCommand: ['dsh'],
        cwd: '/tmp',
        profile: 'headless',
        baseOverlays: [],
        stagingRoot: join(root, 'skills-staging'),
        dumpRunner: () => '# base\n',
        probeRunner: () => ({ out: '技能 edit-verify 不存在或当前不可用', exit: 0 }),
      },
    })
    const report = await v.run(p, [], { actualEvents: [] })
    expect(report.verdict).toBe('rejected')
    expect(report.failureSummary).toContain('skill isolation failed')
  })

  it('rejects skill when skillIsolation is not configured (M4)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-skill-'))
    const sessionId = 's1'
    const v = new Validator(null, { regressionDir: REGRESSION_DIR, maxCases: 20, workspaceRoot: root, sessionId })
    const report = await v.run(skillPatch(), [], { actualEvents: [] })
    expect(report.verdict).toBe('rejected')
    expect(report.failureSummary).toContain('skillIsolation not configured')
  })

  it('passes load check for valid TypeScript modules (M4 .ts)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-ts-'))
    const sessionId = 's1'
    const p = patch({ action: 'insert', targetName: 'ts-tool', targetKind: 'tool' })
    p.expectedTrajectory = {
      schemaVersion: 1,
      patchId: p.id,
      events: [
        { type: 'turn/start', turn: 1 },
        { type: 'tool/result', turn: 1, step: 1, name: 'ts-tool', error: null },
        { type: 'turn/end', turn: 1, reason: 'success' },
      ],
      coverage: { claimedBehaviors: ['ts-tool'] },
    }
    p.module = {
      files: [{ path: 'index.ts', content: 'export const name = "ts-tool"\n' }],
      entry: 'index.ts',
    }
    const staging = paths.staging(root, sessionId, p.id)
    mkdirSync(join(staging), { recursive: true })
    writeFileSync(join(staging, 'index.ts'), p.module.files[0]!.content, 'utf8')
    const v = new Validator(null, { regressionDir: REGRESSION_DIR, maxCases: 20, workspaceRoot: root, sessionId })
    const report = await v.run(p, [], { actualEvents: [
      { type: 'turn/start', turn: 1 },
      { type: 'tool/result', turn: 1, step: 1, name: 'ts-tool', error: null },
      { type: 'turn/end', turn: 1, reason: 'success' },
    ] })
    expect(report.verdict).toBe('approved')
  })

  it('rejects TypeScript modules with syntax errors via load check (M4 .ts)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mv-ts-'))
    const sessionId = 's1'
    const p = patch({ action: 'insert', targetName: 'bad-ts', targetKind: 'tool' })
    p.module = {
      files: [{ path: 'index.ts', content: 'export const name =\n' }],
      entry: 'index.ts',
    }
    const staging = paths.staging(root, sessionId, p.id)
    mkdirSync(join(staging), { recursive: true })
    writeFileSync(join(staging, 'index.ts'), p.module.files[0]!.content, 'utf8')
    const v = new Validator(null, { regressionDir: REGRESSION_DIR, maxCases: 20, workspaceRoot: root, sessionId })
    const report = await v.run(p, [], { actualEvents: [] })
    expect(report.verdict).toBe('rejected')
    expect(report.failureSummary).toContain('module load check failed')
  })
})
