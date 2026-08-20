import { describe, expect, it } from 'vitest'
import { pluginRootFromModuleUrl } from '../index.js'

describe('installed package root resolution', () => {
  it('keeps vendored runtime lookup inside dsh-loom rather than its parent node_modules', () => {
    const root = pluginRootFromModuleUrl('file:///fixture/node_modules/dsh-loom/dist/index.js')
    expect(root).toBe('/fixture/node_modules/dsh-loom/')
  })
})
