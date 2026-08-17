import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CandidateImporter,
  CandidateRegistry,
  applyBuilderGeneratedEdits,
  coldInstallCandidate,
  type CandidateManifest,
} from '../candidates/index.js'
import {
  createCandidateProfile,
  hashProfileArtifact,
  removeCandidateProfile,
  replaceBaseLoopEntry,
} from '../candidates/profile.js'
import { profileGateOps } from '../candidates/profile-gate.js'
import { installVerifiedCandidate, recordCandidateVerification } from '../candidates/lifecycle.js'

function manifest(): CandidateManifest {
  return {
    schemaVersion: 1,
    id: 'serial-loop',
    displayName: 'Serial tool calls',
    targetId: 'agent-loop',
    packageName: '@deepseek-ai/dsh-agent-loop-candidate',
    artifactPath: 'vendored/serial-loop',
    entry: 'lib/index.js',
    build: { method: 'prebuilt', command: 'seed artifact' },
    source: { kind: 'vendored', uri: 'vendored/serial-loop', ref: 'seed', contentHash: 'a'.repeat(64) },
    config: { agents: [] },
    expectedOutcome: 'serial tool calls without protocol regressions',
    capabilities: ['serial-tool-calls'],
    createdAt: new Date().toISOString(),
    createdBy: 'seed',
  }
}

function approved(root: string): CandidateRegistry {
  const registry = new CandidateRegistry(root)
  registry.stage(manifest())
  registry.transition('serial-loop', 'pending')
  registry.transition('serial-loop', 'verified', undefined, {
    contractReport: '/evidence/contract.json', regressionReport: '/evidence/regression.json', verifiedAt: new Date().toISOString(),
  })
  registry.transition('serial-loop', 'approved')
  return registry
}

describe('loop candidate registry', () => {
  it('keeps builder staging separate from verifier approval and gate installation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-candidate-'))
    const registry = new CandidateRegistry(root)
    registry.stage({ ...manifest(), id: 'separated-loop', createdBy: 'builder' })
    expect(() => recordCandidateVerification(registry, 'separated-loop', { passed: true })).toThrow(/complete contract evidence/)
    expect(recordCandidateVerification(registry, 'separated-loop', {
      passed: true,
      evidence: { contractReport: '/evidence/contract.json', regressionReport: '/evidence/regression.json', verifiedAt: new Date().toISOString() },
    })).toBe('approved')
    const result = await installVerifiedCandidate(registry, 'separated-loop', {
      snapshot: () => ({ loop: 'base' }),
      install: () => {},
      smoke: () => ({ passed: true, checks: [{ name: 'C0', passed: true }] }),
      rollback: () => {},
    })
    expect(result.state).toBe('installed')
  })

  it('requires verification evidence before an approved candidate can be installed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-candidate-'))
    const registry = approved(root)
    let live = 'base'
    const result = await coldInstallCandidate(registry, 'serial-loop', {
      snapshot: () => ({ loop: live }),
      install: () => { live = 'serial' },
      smoke: () => ({ passed: true, checks: [{ name: 'boot', passed: true }] }),
      rollback: () => { live = 'base' },
    })
    expect(result.state).toBe('installed')
    expect(registry.get('serial-loop')?.state).toBe('installed')
  })

  it('rolls a failed smoke back without promoting an installed state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-candidate-'))
    const registry = approved(root)
    let live = 'base'
    const result = await coldInstallCandidate(registry, 'serial-loop', {
      snapshot: () => ({ loop: live }),
      install: () => { live = 'serial' },
      smoke: () => ({ passed: false, checks: [{ name: 'boot', passed: false, detail: 'load error' }] }),
      rollback: () => { live = 'base' },
    })
    expect(result.state).toBe('rolled_back')
    expect(live).toBe('base')
    expect(registry.get('serial-loop')?.state).toBe('approved')
  })

  it('does not allow builder staging to bypass verifier/gate transitions', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-candidate-'))
    const registry = new CandidateRegistry(root)
    registry.stage({ ...manifest(), id: 'builder-loop', createdBy: 'builder' })
    expect(() => registry.transition('builder-loop', 'approved')).toThrow(/invalid candidate transition/)
  })

  it('rejects an unallowlisted remote before builder can write staging or registry', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-candidate-'))
    const importer = new CandidateImporter({ root, allowedGitHosts: ['github.com'] })
    expect(() => importer.acquire({
      id: 'remote-loop', displayName: 'Remote', source: { uri: 'https://example.invalid/loop.git', ref: 'main' },
      packageName: 'remote-loop', entry: 'lib/index.js', build: { method: 'prebuilt' }, config: {}, expectedOutcome: 'x', capabilities: [],
    })).toThrow(/not allowed/)
    expect(new CandidateRegistry(root).get('remote-loop')).toBeNull()
  })

  it('applies only exact, bounded builder-generated source edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-generated-'))
    const sourcePath = join(root, 'packages/core/agent-loop/src/constants.ts')
    mkdirSync(join(root, 'packages/core/agent-loop/src'), { recursive: true })
    const before = 'export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10\n'
    writeFileSync(sourcePath, before)
    const beforeHash = createHash('sha256').update(before).digest('hex')
    const after = 'export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 20\n'
    const edits = [{ path: 'packages/core/agent-loop/src/constants.ts', beforeHash, after }]
    expect(applyBuilderGeneratedEdits(root, {
      kind: 'builder-generated',
      baseline: { uri: 'https://github.com/deepseek-ai/deepseek-harness.git', ref: 'a'.repeat(40) },
      edits,
    })).toEqual([{ path: edits[0].path, beforeHash, afterHash: createHash('sha256').update(after).digest('hex') }])
    expect(readFileSync(sourcePath, 'utf8')).toBe(after)
    expect(() => applyBuilderGeneratedEdits(root, {
      kind: 'builder-generated', baseline: { uri: 'https://github.com/deepseek-ai/deepseek-harness.git', ref: 'a'.repeat(40) },
      edits: [{ ...edits[0], beforeHash }],
    })).toThrow(/beforeHash mismatch/)
  })

  it('rejects generated edits outside agent-loop source', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-generated-'))
    expect(() => applyBuilderGeneratedEdits(root, {
      kind: 'builder-generated', baseline: { uri: 'https://github.com/deepseek-ai/deepseek-harness.git', ref: 'a'.repeat(40) },
      edits: [{ path: 'packages/core/tools/src/index.ts', beforeHash: 'a'.repeat(64), after: 'x' }],
    })).toThrow(/outside the agent-loop source allowlist/)
  })
})

describe('Loader replacement profile adapter', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-profile-'))
    const base = join(root, 'base')
    const candidate = join(root, 'candidate')
    const dependencies = join(root, 'cli-node-modules')
    mkdirSync(join(base), { recursive: true })
    mkdirSync(join(candidate, 'lib'), { recursive: true })
    mkdirSync(join(dependencies, '@deepseek-ai', 'cordis'), { recursive: true })
    writeFileSync(join(base, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base' }))
    writeFileSync(join(base, 'cordis.patch.yml'), `- insert:\n    - id: agent-loop\n      name: '@deepseek-ai/dsh-agent-loop'\n      config:\n        agents: []\n`)
    writeFileSync(join(candidate, 'package.json'), JSON.stringify({
      name: '@loom/candidate-loop',
      peerDependencies: { '@deepseek-ai/cordis': '*' },
    }))
    writeFileSync(join(candidate, 'lib', 'index.js'), 'const x = ctx.tools[TOOL_RUNTIME_SCHEDULER]\nexport const name = "candidate"\n')
    writeFileSync(join(dependencies, '@deepseek-ai', 'cordis', 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis' }))
    return { root, base, candidate, dependencies }
  }

  it('replaces agent-loop before profile composition and leaves the DSH base source untouched', () => {
    const { root, base, candidate, dependencies } = fixture()
    const profile = createCandidateProfile({
      runtimeRoot: join(root, 'runtime'), candidateId: 'serial-loop', candidateArtifact: candidate,
      baseBundle: base, dependencyRoot: dependencies,
    })
    const copiedPatch = readFileSync(join(profile.profileDir, 'node_modules', '@loom', 'candidate-base', 'cordis.patch.yml'), 'utf8')
    expect(copiedPatch).toContain(`name: ${JSON.stringify(profile.runtimeEntry)}`)
    expect(readFileSync(join(base, 'cordis.patch.yml'), 'utf8')).toContain("name: '@deepseek-ai/dsh-agent-loop'")
    expect(readFileSync(profile.runtimeEntry, 'utf8')).toContain('loomSchedulerKey')
    expect(existsSync(join(profile.profileDir, 'node_modules', '@loom', 'candidate-loop', 'node_modules', '@deepseek-ai', 'cordis'))).toBe(true)
    expect(createCandidateProfile({
      runtimeRoot: join(root, 'runtime'), candidateId: 'serial-loop', candidateArtifact: candidate,
      baseBundle: base, dependencyRoot: dependencies,
    })).toEqual(profile)
    removeCandidateProfile(profile)
    expect(existsSync(profile.home)).toBe(false)
  })

  it('fails loud if the base patch has no actual agent-loop entry to replace', () => {
    expect(() => replaceBaseLoopEntry('- insert:\n    - id: agent\n', '/candidate/lib/index.js'))
      .toThrow(/does not contain an agent-loop/)
  })

  it('records a real Loader-profile before/after install and removes only its owned profile on failed smoke', async () => {
    const { root, base, candidate, dependencies } = fixture()
    const candidateManifest = {
      ...manifest(), artifactPath: candidate,
      source: { ...manifest().source, contentHash: hashProfileArtifact(candidate) },
    }
    const registry = new CandidateRegistry(root)
    registry.stage(candidateManifest)
    registry.transition('serial-loop', 'pending')
    registry.transition('serial-loop', 'verified', undefined, {
      contractReport: '/evidence/contract.json', regressionReport: '/evidence/regression.json', verifiedAt: new Date().toISOString(),
    })
    registry.transition('serial-loop', 'approved')
    const runtimeRoot = join(root, 'runtime')
    const result = await coldInstallCandidate(registry, 'serial-loop', profileGateOps({
      runtimeRoot, baseBundle: base, dependencyRoot: dependencies,
      dumpConfig: (profile) => ({ exitCode: 0, output: profile.runtimeEntry }),
    }, 'serial-loop'))
    expect(result.state).toBe('installed')
    expect(result.before).toMatchObject({ exists: false })
    expect(result.after).toMatchObject({ exists: true })
  })
})
