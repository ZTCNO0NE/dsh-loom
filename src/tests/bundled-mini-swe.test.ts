import { describe, expect, it } from 'vitest'
import { bundledMiniSwePaths } from '../builder/bundled-mini-swe.js'

describe('bundled mini-SWE runtime resolver', () => {
  it('uses a user-owned cache and a package-owned pinned config by default', () => {
    const paths = bundledMiniSwePaths({ metaRoot: '/state/loom', packageRoot: '/pkg', exists: path => path.endsWith('/mini') || path.endsWith('.yaml') })
    expect(paths).toMatchObject({
      runtimeRoot: '/state/loom/runtime/mini-swe-agent-2.4.6',
      executable: '/state/loom/runtime/mini-swe-agent-2.4.6/bin/mini',
      configPath: '/pkg/runtime/mini-swe-agent-v2.4.6.yaml', ready: true,
    })
  })

  it('keeps explicit host overrides for tests and advanced deployments', () => {
    const paths = bundledMiniSwePaths({ metaRoot: '/state', packageRoot: '/pkg', runtimeRoot: '/runtime', executable: '/custom/mini', configPath: '/custom/config.yaml', exists: () => false })
    expect(paths).toMatchObject({ runtimeRoot: '/runtime', executable: '/custom/mini', configPath: '/custom/config.yaml', ready: false })
  })
})
