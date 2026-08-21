import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../..', import.meta.url).pathname

describe('setup active-evolution patch', () => {
  it('makes source-checkout skill verification self-contained', () => {
    const source = mkdtempSync(join(tmpdir(), 'dsh-loom-source-'))
    const metaRoot = join(source, 'state')
    const runtimeRoot = join(metaRoot, 'runtime', 'mini-swe-agent-2.4.6')
    mkdirSync(join(source, 'apps', 'cli'), { recursive: true })
    mkdirSync(join(source, 'packages', 'core', 'tools'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'bin'), { recursive: true })
    writeFileSync(join(source, 'apps', 'cli', 'package.json'), '{}\n')
    writeFileSync(join(source, 'packages', 'core', 'tools', 'package.json'), '{}\n')
    writeFileSync(join(runtimeRoot, 'bin', 'mini'), '')
    writeFileSync(join(runtimeRoot, 'bin', 'python'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(runtimeRoot, 'bin', 'python'), 0o755)

    const result = spawnSync(process.execPath, [join(packageRoot, 'bin', 'dsh-loom.mjs'), 'setup', '--runtime-root', runtimeRoot], {
      cwd: source,
      env: { ...process.env, DSH_META_VALIDATE_ROOT: metaRoot, DSH_PNPM_COMMAND: process.execPath },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('dsh web --patch')
    expect(result.stdout).not.toContain('--profile loom')
    const patch = readFileSync(join(runtimeRoot, 'loom-active-evolution.patch.yml'), 'utf8')
    expect(existsSync(join(runtimeRoot, 'loom-active-evolution.patch.yml'))).toBe(true)
    expect(patch).toContain('skillStagingRoot:')
    expect(patch).toContain('skillRoot:')
    expect(patch).toContain('- id: loom-skill-filesystem')
    expect(patch).toContain("name: '@deepseek-ai/dsh-skill-filesystem'")
    expect(patch).toContain('providerName: loom')
    expect(patch).toContain('includeDefaultRoots: false')
    expect(patch).toContain('customSkillDirs:')
    expect(existsSync(join(metaRoot, 'skills'))).toBe(true)
    expect(patch).toContain('isolation:')
    expect(patch).toContain('enabled: true')
    expect(patch).toContain('dshCommand:')
    expect(patch).toContain('apps/cli/src/bin.ts')
    expect(patch).toContain(`cwd: ${JSON.stringify(source)}`)
    expect(patch).toContain('pluginEvolution:')
    expect(patch).toContain('enabled: true')
    expect(patch).toContain(`pnpmCommand: ${JSON.stringify(process.execPath)}`)
    expect(patch).toContain('profile: "web"')
    expect(patch).toContain('profileDir:')
  })

  it('does not advertise plugin transactions without a real distributable cold Loader probe', () => {
    const standalone = mkdtempSync(join(tmpdir(), 'dsh-loom-standalone-'))
    const metaRoot = join(standalone, 'state')
    const runtimeRoot = join(metaRoot, 'runtime', 'mini-swe-agent-2.4.6')
    mkdirSync(join(runtimeRoot, 'bin'), { recursive: true })
    writeFileSync(join(runtimeRoot, 'bin', 'mini'), '')
    writeFileSync(join(runtimeRoot, 'bin', 'python'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(runtimeRoot, 'bin', 'python'), 0o755)

    const result = spawnSync(process.execPath, [join(packageRoot, 'bin', 'dsh-loom.mjs'), 'setup', '--runtime-root', runtimeRoot], {
      cwd: standalone,
      env: { ...process.env, DSH_META_VALIDATE_ROOT: metaRoot, DSH_PNPM_COMMAND: process.execPath },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('v1.3 插件事务保持关闭')
    const patch = readFileSync(join(runtimeRoot, 'loom-active-evolution.patch.yml'), 'utf8')
    expect(patch).toMatch(/pluginEvolution:\n\s+enabled: false/)
    expect(patch).toContain('coldBootCommand: []')
  })
})
