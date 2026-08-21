import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compilePluginEvolutionProposal, pluginTarDependencySpec, resolvePluginCommandInvocation } from '../plugin-evolution/compiler.js'
import { freezePluginTargets, githubCommitArchiveUrl, hashDirectory } from '../plugin-evolution/source.js'
import { verifyPluginEvolution } from '../plugin-evolution/verifier.js'
import { isPluginEvolutionIntent, resolveProfilePluginSource } from '../plugin-evolution/inventory.js'
import type { PluginEvolutionPlan } from '../plugin-evolution/types.js'

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function plugin(root: string, name: string, version = '1.0.0'): void {
  mkdirSync(root, { recursive: true })
  writeJson(join(root, 'package.json'), {
    name, version, type: 'module', files: ['index.js', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(join(root, 'index.js'), 'export const value = "before"\n', 'utf8')
  writeFileSync(join(root, 'cordis.patch.yml'), '- name: fixture\n', 'utf8')
}

function fixture(targets = ['loom-fixture-a', 'loom-fixture-b']): { root: string; profileDir: string; sources: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'loom-plugin-core-'))
  const profileDir = join(root, 'dsh-home', 'profiles', 'loom')
  mkdirSync(profileDir, { recursive: true })
  writeJson(join(profileDir, 'package.json'), { private: true, dependencies: Object.fromEntries(targets.map((name) => [name, '1.0.0'])) })
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8')
  const sources = targets.map((name, index) => {
    plugin(join(profileDir, 'node_modules', name), name)
    const source = join(root, `source-${index}`)
    plugin(source, name)
    return source
  })
  return { root, profileDir, sources }
}

describe('plugin evolution source, compiler, and verifier', () => {
  it('executes Windows npm-family shims through Node without enabling a command shell', () => {
    const npmCli = join(tmpdir(), 'node-runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const node = join(tmpdir(), 'node-runtime', 'node.exe')
    expect(resolvePluginCommandInvocation('npm', ['test', '--', '--runInBand'], {
      platform: 'win32', nodeExecutable: node, env: { npm_execpath: npmCli }, fileExists: (path) => path === npmCli,
    })).toEqual({ executable: node, args: [npmCli, 'test', '--', '--runInBand'] })

    const pnpmCli = join(tmpdir(), 'pnpm-runtime', 'pnpm.cjs')
    expect(resolvePluginCommandInvocation('pnpm', ['run', 'build'], {
      platform: 'win32', nodeExecutable: node, env: { npm_execpath: pnpmCli }, fileExists: (path) => path === pnpmCli,
    })).toEqual({ executable: node, args: [pnpmCli, 'run', 'build'] })

    const absolutePnpm = join(tmpdir(), 'global-pnpm', 'pnpm.cmd')
    const absolutePnpmCli = join(tmpdir(), 'global-pnpm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    expect(resolvePluginCommandInvocation(absolutePnpm, ['view', 'fixture@latest'], {
      platform: 'win32', nodeExecutable: node, env: {}, fileExists: (path) => path === absolutePnpmCli,
    })).toEqual({ executable: node, args: [absolutePnpmCli, 'view', 'fixture@latest'] })

    expect(() => resolvePluginCommandInvocation('npx', ['vitest'], {
      platform: 'win32', nodeExecutable: node, env: {}, fileExists: () => false,
    })).toThrow('without a command shell')
    expect(resolvePluginCommandInvocation('npm', ['test'], { platform: 'linux' })).toEqual({ executable: 'npm', args: ['test'] })
    expect(pluginTarDependencySpec('C:\\Users\\Builder\\candidate.tgz')).toBe('file:C:/Users/Builder/candidate.tgz')
    expect(pluginTarDependencySpec('/tmp/candidate.tgz')).toBe('file:/tmp/candidate.tgz')
  })

  it('routes explicit plugin/package requests away from Config and Skill evolution', () => {
    expect(isPluginEvolutionIntent('让两个插件联动显示成本')).toBe(true)
    expect(isPluginEvolutionIntent('evolve the installed npm package')).toBe(true)
    expect(isPluginEvolutionIntent('adjust agent-default-model config')).toBe(false)
  })
  it('maps only exact GitHub HTTPS repositories and commits to immutable codeload archives', () => {
    const commit = 'e7a27eb01606e6deccdaacccb8e0cfd992c0bcdc'
    expect(githubCommitArchiveUrl('https://github.com/awesome-dsh-plugin/dsh-find-plugin.git', commit)).toBe(
      `https://codeload.github.com/awesome-dsh-plugin/dsh-find-plugin/tar.gz/${commit}`,
    )
    expect(githubCommitArchiveUrl('https://github.com.evil.example/owner/repo', commit)).toBeNull()
    expect(githubCommitArchiveUrl('https://github.com/owner/repo', 'main')).toBeNull()
  })
  it('derives a pinned registry source only when version and live lock integrity agree', () => {
    const { root, profileDir } = fixture(['loom-fixture-a'])
    const integrity = 'sha512-YWJjZGVmZw=='
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), `resolution: {integrity: ${integrity}}\n`, 'utf8')
    const registry = join(root, 'fake-pnpm')
    writeFileSync(registry, `#!/usr/bin/env node
console.log(JSON.stringify({ name: 'loom-fixture-a', version: '1.0.0', repository: { url: 'git+https://github.com/example/loom-fixture-a.git' }, gitHead: '0123456789abcdef0123456789abcdef01234567', 'dist.integrity': '${integrity}' }))
`, 'utf8')
    chmodSync(registry, 0o755)
    expect(resolveProfilePluginSource(profileDir, 'loom-fixture-a', registry)).toEqual({
      kind: 'git', location: 'https://github.com/example/loom-fixture-a.git', commit: '0123456789abcdef0123456789abcdef01234567', attestedBy: 'loom',
      registryVersion: '1.0.0', registryIntegrity: integrity,
    })
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'integrity: different\n', 'utf8')
    expect(resolveProfilePluginSource(profileDir, 'loom-fixture-a', registry)).toBeNull()
  })
  it('freezes a bounded acyclic multi-plugin source graph and rejects unsafe plans', () => {
    const { root, profileDir, sources } = fixture()
    const frozen = freezePluginTargets({
      planRoot: join(root, 'plan'), profileDir,
      requests: [
        { id: 'cost', packageName: 'loom-fixture-a', source: { kind: 'local', location: sources[0]!, attestedBy: 'user' }, testCommands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }] },
        { id: 'notify', packageName: 'loom-fixture-b', dependsOn: ['cost'], source: { kind: 'managed', location: sources[1]!, attestedBy: 'loom', expectedTreeHash: hashDirectory(sources[1]!) }, testCommands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }] },
      ],
    })
    expect(frozen.map((target) => ({ id: target.id, dependsOn: target.dependsOn }))).toEqual([
      { id: 'cost', dependsOn: [] }, { id: 'notify', dependsOn: ['cost'] },
    ])
    expect(() => freezePluginTargets({
      planRoot: join(root, 'too-many'), profileDir,
      requests: [0, 1, 2, 3].map((index) => ({ id: `p-${index}`, packageName: `plugin-${index}`, source: { kind: 'local' as const, location: sources[0]!, attestedBy: 'user' as const } })),
    })).toThrow('1-3 targets')
    expect(() => freezePluginTargets({
      planRoot: join(root, 'protected'), profileDir,
      requests: [{ id: 'loom', packageName: 'dsh-loom', source: { kind: 'local', location: sources[0]!, attestedBy: 'user' } }],
    })).toThrow('protected package')
    expect(() => freezePluginTargets({
      planRoot: join(root, 'cycle'), profileDir,
      requests: [
        { id: 'a', packageName: 'loom-fixture-a', dependsOn: ['b'], source: { kind: 'local', location: sources[0]!, attestedBy: 'user' } },
        { id: 'b', packageName: 'loom-fixture-b', dependsOn: ['a'], source: { kind: 'local', location: sources[1]!, attestedBy: 'user' } },
      ],
    })).toThrow('acyclic')
  })

  it('compiles an immutable package and independently rejects a corrupt archive without throwing', () => {
    const { root, profileDir, sources } = fixture(['loom-fixture-a'])
    const targets = freezePluginTargets({
      planRoot: join(root, 'plan'), profileDir,
      requests: [{
        id: 'cost', packageName: 'loom-fixture-a', source: { kind: 'local', location: sources[0]!, attestedBy: 'user' },
        buildCommands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
        testCommands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      }],
    })
    const plan: PluginEvolutionPlan = {
      schemaVersion: 1, capability: 'plugin-evolution', id: 'plan-1', createdAt: new Date().toISOString(),
      profile: 'loom', profileDir, requirements: 'add a model dimension', expectedOutcome: 'cost event includes model', targets, state: 'planned',
    }
    const workspace = join(root, 'workspace')
    cpSync(targets[0]!.source.snapshotPath, join(workspace, 'plugins', 'cost'), { recursive: true })
    writeFileSync(join(workspace, 'plugins', 'cost', 'index.js'), 'export const value = "after"\n', 'utf8')
    const proposal = compilePluginEvolutionProposal({ plan, workspace, artifactsRoot: join(root, 'artifacts') })
    expect(verifyPluginEvolution(plan, proposal)).toMatchObject({ verdict: 'approved' })
    writeFileSync(proposal.targets[0]!.tarPath, 'not a tar archive', 'utf8')
    const rejected = verifyPluginEvolution(plan, proposal)
    expect(rejected.verdict).toBe('rejected')
    expect(rejected.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'artifact-integrity', verdict: 'rejected' }),
      expect.objectContaining({ id: 'package-contract', verdict: 'rejected' }),
    ]))
    expect(existsSync(proposal.targets[0]!.workspacePath)).toBe(true)
  })
})
