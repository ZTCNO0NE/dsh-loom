import type { BuilderToolAction } from './kernel.js'

/** Tool names exposed by the minimal Builder base loop. */
export type BuilderToolName = BuilderToolAction['name']

/** Context exposed to a capability tool. The target remains outside this context. */
export interface BuilderCapabilityToolContext {
  root: string
  sessionId: string
  runId: string
  workspacePath: string
}

/** A synchronous capability tool keeps the kernel's durable action boundary simple. */
export interface BuilderCapabilityRuntime {
  plugin: BuilderCapabilityPlugin
  invoke(tool: string, input: Record<string, unknown>, context: BuilderCapabilityToolContext): Record<string, unknown>
}

/** The complete starting tool set; capabilities add meaning, not hidden limits. */
export const BUILDER_BASE_TOOLS = [
  'read_input',
  'read_journal',
  'read_file',
  'list_directory',
  'search_text',
  'inspect_file',
  'trace_artifact',
  'write_world_model',
  'write_plan',
  'write_diagnosis_report',
  'write_workspace_file',
  'apply_workspace_patch',
  'read_workspace_file',
  'run_workspace_command',
  'acknowledge_message',
  'publish_progress',
  'request_input',
  'write_submission',
  'compile_loop_submission',
  'compile_config_submission',
  'compile_module_submission',
] as const satisfies readonly BuilderToolName[]

/** Declarative capability metadata supplied to a Builder run. */
export interface BuilderCapabilityPlugin {
  id: string
  version: string
  description: string
  targetKinds?: readonly string[]
  /** Names may include capability-owned tools in addition to base tools. */
  tools?: readonly string[]
  instructions?: string
  /** Governance is selected after exploration; it is not a Builder route limit. */
  verifierIds?: readonly string[]
  gateId?: string
  proposalSchema?: string
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
      verifierIds: plugin.verifierIds ?? [],
      gateId: plugin.gateId ?? null,
      proposalSchema: plugin.proposalSchema ?? null,
    })).join('\n')
  }
}

/** Runtime registry: metadata registration alone never grants execution. */
export class BuilderCapabilityRuntimeRegistry {
  private readonly runtimes = new Map<string, BuilderCapabilityRuntime>()

  register(runtime: BuilderCapabilityRuntime): this {
    if (this.runtimes.has(runtime.plugin.id)) throw new Error(`builder capability runtime already registered: ${runtime.plugin.id}`)
    this.runtimes.set(runtime.plugin.id, runtime)
    return this
  }

  get(id: string): BuilderCapabilityRuntime | undefined {
    return this.runtimes.get(id)
  }

  list(): BuilderCapabilityRuntime[] {
    return [...this.runtimes.values()]
  }
}

/** First loop-focused capability; it declares context, never prescribes a route. */
export const LOOP_EVOLUTION_CAPABILITY: BuilderCapabilityPlugin = {
  id: 'loop-evolution',
  version: '0.1.0',
  description: 'Explore, rebuild, replace, or improve an actor loop in the Builder workspace.',
  targetKinds: ['actor-loop'],
  tools: ['read_file', 'list_directory', 'write_workspace_file', 'apply_workspace_patch', 'read_workspace_file', 'run_workspace_command', 'compile_loop_submission'],
  instructions: 'Choose your own exploration path. A candidate may be a small edit, a rebuilt loop, or a complete replacement; report what you tried and why.',
  verifierIds: ['loop-contract-v1', 'loop-regression-v1'],
  gateId: 'profile-cold-install-v1',
  proposalSchema: 'loop-evolution-v1',
}

/** General actor capabilities share the same host-materialize → compiler →
 * independent verifier → Gate shape.  They are metadata, not a second
 * Proposer permission path. */
export const CONFIG_EVOLUTION_CAPABILITY: BuilderCapabilityPlugin = {
  id: 'config-evolution', version: '0.1.0',
  description: 'Evolve one host-selected actor configuration row from an isolated JSON snapshot.',
  targetKinds: ['config'], tools: ['write_workspace_file', 'read_workspace_file', 'run_workspace_command', 'compile_config_submission'],
  instructions: 'Edit only actor-config.json. Host freezes target identity and before snapshot; the existing Validator and patch Gate decide release.',
  verifierIds: ['patch-validator-v1'], gateId: 'patch-cold-apply-v1', proposalSchema: 'patch-evolution-v1',
}

export const TOOL_EVOLUTION_CAPABILITY: BuilderCapabilityPlugin = {
  id: 'tool-evolution', version: '0.1.0',
  description: 'Create one host-selected actor tool bundle in an isolated module workspace.',
  targetKinds: ['tool'], tools: ['write_workspace_file', 'read_workspace_file', 'run_workspace_command', 'compile_module_submission'],
  instructions: 'Create only actor-module/. Host fixes tool identity and entry; module load/probe Validator and insert Gate own release.',
  verifierIds: ['module-load-validator-v1', 'patch-validator-v1'], gateId: 'patch-insert-v1', proposalSchema: 'patch-evolution-v1',
}

export const SKILL_EVOLUTION_CAPABILITY: BuilderCapabilityPlugin = {
  id: 'skill-evolution', version: '0.1.0',
  description: 'Create one host-selected skill bundle in an isolated module workspace.',
  targetKinds: ['skill'], tools: ['write_workspace_file', 'read_workspace_file', 'run_workspace_command', 'compile_module_submission'],
  instructions: 'Create only actor-module/. Host fixes the skill id/entry; catalog/load/probe Validator and skill Gate own release.',
  verifierIds: ['skill-catalog-probe-v1', 'patch-validator-v1'], gateId: 'skill-install-v1', proposalSchema: 'patch-evolution-v1',
}

/** Composition has deliberately no executable runtime until its dedicated
 * graph compiler, verifier set and transactional Gate are all registered. */
export const ACTOR_COMPOSITION_CAPABILITY: BuilderCapabilityPlugin = {
  id: 'actor-composition', version: '0.1.0',
  description: 'Describe a bounded multi-component actor change as an explicit dependency graph.',
  targetKinds: ['composition'], tools: [],
  instructions: 'Submission remains a needs_verifier draft until composition graph verification and transactional Gate are registered.',
  verifierIds: ['composition-graph-v1', 'composition-contract-v1'], gateId: 'composition-transaction-v1', proposalSchema: 'actor-composition-v1',
}

/** Simulation is optional: it adds an experiment surface, not a new Builder loop. */
export const WORKSPACE_SIMULATION_CAPABILITY: BuilderCapabilityPlugin = {
  id: 'workspace-simulation',
  version: '0.1.0',
  description: 'Run reproducible, workspace-local simulations against synthetic actor inputs.',
  targetKinds: ['actor-loop', 'builder'],
  tools: ['run_simulation'],
  instructions: 'Use simulation to distinguish hypotheses before requesting an expensive real probe. Simulation evidence is not verifier approval.',
}
