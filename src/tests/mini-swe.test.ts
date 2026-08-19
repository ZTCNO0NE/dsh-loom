import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runMiniSwe } from '../builder/mini-swe.js'

describe('mini-SWE runtime adapter', () => {
  it('accepts only a durable Submitted trajectory as a completed Builder run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-mini-swe-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\nprintf \'{"messages":[{"role":"assistant","tool_calls":[{}]},{"role":"exit","extra":{"exit_status":"Submitted"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const result = await runMiniSwe({
      executable,
      configPath: 'ignored',
      baselineRoot: 'ignored',
      dependencySnapshot: 'ignored',
      model: 'test',
      stepLimit: 3,
      timeoutMs: 5_000,
      workspace: root,
      trajectoryPath: join(root, 'trajectory.json'),
      task: 'test',
    })
    expect(result).toMatchObject({ submitted: true, modelTurns: 1, toolSteps: 1 })
  })

  it('passes an explicit host-owned runtime environment without persisting it in the trajectory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-mini-swe-env-'))
    const executable = join(root, 'mini-fixture.sh')
    const observed = join(root, 'observed.txt')
    writeFileSync(executable, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\nprintf '%s' "$MINI_SWE_HOST_ONLY" > ${JSON.stringify(observed)}\nprintf '{"messages":[{"role":"exit","extra":{"exit_status":"Submitted"}}]}' > "$out"\n`, 'utf8')
    chmodSync(executable, 0o755)
    const result = await runMiniSwe({
      executable, configPath: 'ignored', baselineRoot: 'ignored', dependencySnapshot: 'ignored', model: 'test', stepLimit: 3, timeoutMs: 5_000,
      workspace: root, trajectoryPath: join(root, 'trajectory.json'), task: 'test', env: { MINI_SWE_HOST_ONLY: 'host-value' },
    })
    expect(result.submitted).toBe(true)
    expect(readFileSync(observed, 'utf8')).toBe('host-value')
    expect(readFileSync(join(root, 'trajectory.json'), 'utf8')).not.toContain('host-value')
  })

  it('does not treat an incomplete durable trajectory as a submission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-mini-swe-incomplete-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\nprintf \'{"messages":[{"role":"assistant","tool_calls":[{}]},{"role":"exit","extra":{"exit_status":"Failed"}}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const result = await runMiniSwe({
      executable, configPath: 'ignored', baselineRoot: 'ignored', dependencySnapshot: 'ignored', model: 'test', stepLimit: 3, timeoutMs: 5_000,
      workspace: root, trajectoryPath: join(root, 'trajectory.json'), task: 'test',
    })
    expect(result).toMatchObject({ submitted: false, modelTurns: 1, toolSteps: 1 })
  })

  it('does not treat a parseable partial trajectory without a terminal exit as a submission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-mini-swe-partial-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\nprintf \'{"messages":[{"role":"assistant","tool_calls":[{}]}]}\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const result = await runMiniSwe({
      executable, configPath: 'ignored', baselineRoot: 'ignored', dependencySnapshot: 'ignored', model: 'test', stepLimit: 3, timeoutMs: 5_000,
      workspace: root, trajectoryPath: join(root, 'trajectory.json'), task: 'test',
    })
    expect(result).toMatchObject({ submitted: false, modelTurns: 1, toolSteps: 1 })
  })

  it('fails closed when the runtime exceeds its wall timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-mini-swe-timeout-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nsleep 1\n', 'utf8')
    chmodSync(executable, 0o755)
    const result = await runMiniSwe({
      executable, configPath: 'ignored', baselineRoot: 'ignored', dependencySnapshot: 'ignored', model: 'test', stepLimit: 3, timeoutMs: 20,
      workspace: root, trajectoryPath: join(root, 'trajectory.json'), task: 'test',
    })
    expect(result.submitted).toBe(false)
    expect(result.error).toContain('Command failed')
  })

  it('fails closed when the runtime exits without a durable trajectory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-mini-swe-missing-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nexit 7\n', 'utf8')
    chmodSync(executable, 0o755)
    const result = await runMiniSwe({
      executable, configPath: 'ignored', baselineRoot: 'ignored', dependencySnapshot: 'ignored', model: 'test', stepLimit: 3, timeoutMs: 5_000,
      workspace: root, trajectoryPath: join(root, 'trajectory.json'), task: 'test',
    })
    expect(result.submitted).toBe(false)
    expect(result.error).toContain('Command failed')
  })

  it('fails closed instead of throwing when the runtime writes a malformed trajectory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-mini-swe-malformed-'))
    const executable = join(root, 'mini-fixture.sh')
    writeFileSync(executable, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\nprintf \'not-json\' > "$out"\n', 'utf8')
    chmodSync(executable, 0o755)
    const result = await runMiniSwe({
      executable, configPath: 'ignored', baselineRoot: 'ignored', dependencySnapshot: 'ignored', model: 'test', stepLimit: 3, timeoutMs: 5_000,
      workspace: root, trajectoryPath: join(root, 'trajectory.json'), task: 'test',
    })
    expect(result).toMatchObject({ submitted: false, modelTurns: 0, toolSteps: 0 })
    expect(result.error).toContain('trajectory is unreadable')
  })
})
