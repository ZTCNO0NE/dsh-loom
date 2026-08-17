import type { BuilderToolAction } from './kernel.js'

/** Tool names exposed by the minimal Builder base loop. */
export type BuilderToolName = BuilderToolAction['name']

/** The complete starting tool set; capabilities add meaning, not hidden limits. */
export const BUILDER_BASE_TOOLS = [
  'read_input',
  'read_journal',
  'read_file',
  'list_directory',
  'write_world_model',
  'write_plan',
  'write_workspace_file',
  'read_workspace_file',
  'run_workspace_command',
  'write_submission',
  'write_candidate_draft',
  'inspect_staging',
  'preflight_staging_entry',
] as const satisfies readonly BuilderToolName[]

/** Declarative capability metadata supplied to a Builder run. */
export interface BuilderCapabilityPlugin {
  id: string
  version: string
  description: string
  targetKinds?: readonly string[]
  tools?: readonly BuilderToolName[]
  instructions?: string
}

/** Small registry used to compose capability context without hard-coding a workflow. */
export class BuilderCapabilityRegistry {
  private readonly plugins = new Map<string, BuilderCapabilityPlugin>()

  register(plugin: BuilderCapabilityPlugin): this {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(plugin.id)) throw new Error(`invalid builder capability id: ${plugin.id}`)
    if (this.plugins.has(plugin.id)) throw new Error(`builder capability already registered: ${plugin.id}`)
    this.plugins.set(plugin.id, plugin)
    return this
  }

  registerAll(plugins: readonly BuilderCapabilityPlugin[]): this {
    for (const plugin of plugins) this.register(plugin)
    return this
  }

  list(): BuilderCapabilityPlugin[] {
    return [...this.plugins.values()].map(plugin => ({ ...plugin }))
  }

  describe(): string {
    if (this.plugins.size === 0) return '(no additional capability registered)'
    return this.list().map(plugin => JSON.stringify({
      id: plugin.id,
      version: plugin.version,
      description: plugin.description,
      targetKinds: plugin.targetKinds ?? [],
      tools: plugin.tools ?? [],
      instructions: plugin.instructions ?? '',
    })).join('\n')
  }
}

/** First loop-focused capability; it declares context, never prescribes a route. */
export const LOOP_EVOLUTION_CAPABILITY: BuilderCapabilityPlugin = {
  id: 'loop-evolution',
  version: '0.1.0',
  description: 'Explore, rebuild, replace, or improve an actor loop in the Builder workspace.',
  targetKinds: ['actor-loop'],
  tools: ['read_file', 'list_directory', 'write_workspace_file', 'read_workspace_file', 'run_workspace_command', 'write_submission'],
  instructions: 'Choose your own exploration path. A candidate may be a small edit, a rebuilt loop, or a complete replacement; report what you tried and why.',
}
