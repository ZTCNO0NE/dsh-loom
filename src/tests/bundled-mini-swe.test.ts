import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bundledMiniSwePaths } from '../builder/bundled-mini-swe.js'

describe('bundled mini-SWE runtime resolver', () => {
  it('uses a user-owned cache and a package-owned pinned config by default', () => {
    const paths = bundledMiniSwePaths({ metaRoot: '/state/loom', packageRoot: '/pkg', exists: path => path.endsWith('/mini') || path.endsWith('.yaml') || path.endsWith('.py') })
    expect(paths).toMatchObject({
      runtimeRoot: '/state/loom/runtime/mini-swe-agent-2.4.6',
      executable: '/state/loom/runtime/mini-swe-agent-2.4.6/bin/mini',
      configPath: '/pkg/runtime/mini-swe-agent-v2.4.6.yaml', runnerPath: '/pkg/runtime/loom-mini-swe-runner.py', ready: true,
    })
  })

  it('keeps explicit host overrides for tests and advanced deployments', () => {
    const paths = bundledMiniSwePaths({ metaRoot: '/state', packageRoot: '/pkg', runtimeRoot: '/runtime', executable: '/custom/mini', configPath: '/custom/config.yaml', exists: () => false })
    expect(paths).toMatchObject({ runtimeRoot: '/runtime', executable: '/custom/mini', configPath: '/custom/config.yaml', ready: false })
  })

  it('bundles a soft budget landing without auto-submitting a candidate', () => {
    const source = readFileSync(new URL('../../runtime/loom-mini-swe-runner.py', import.meta.url), 'utf8')
    expect(source).toContain('only 2 model calls remain')
    expect(source).toContain('LOOM RUNTIME FINAL CALL')
    expect(source).toContain('echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT')
    expect(source).not.toContain('exit_status": "Submitted"')
    expect(source.indexOf('remaining == 1')).toBeLessThan(source.indexOf('self.n_calls == convergence_call'))
  })

  it('keeps the bash action contract on Windows instead of falling through to cmd.exe', () => {
    const source = readFileSync(new URL('../../runtime/loom-mini-swe-runner.py', import.meta.url), 'utf8')
    expect(source).toContain('class LoomLocalEnvironment')
    expect(source).toContain('[bash, "--noprofile", "--norc", "-lc", command]')
    expect(source).toContain('python3() { \\"$LOOM_PYTHON\\"')
    expect(source).toContain('{"LOOM_PYTHON": python}')
    expect(source).toContain('LOOM_BASH')
    expect(source).toContain('LOOM_GIT_BASH')
    expect(source).toContain('LOOM_PYTHON')
    expect(source).toContain('return shutil.which("python3") or sys.executable')
  })

  it('tells the runtime that actions start in the workspace instead of inviting path discovery', () => {
    const config = readFileSync(new URL('../../runtime/mini-swe-agent-v2.4.6.yaml', import.meta.url), 'utf8')
    expect(config).toContain('Every action already starts at the workspace root')
    expect(config).toContain('Do not guess /workspace')
    expect(config).toContain('Runtime profile: {{ loom_runtime_summary }}')
    expect(config).toContain("runtime profile's selected Python interpreter")
  })
})
