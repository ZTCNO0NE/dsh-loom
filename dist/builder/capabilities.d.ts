import type { BuilderToolAction } from './kernel.js';
/** Tool names exposed by the minimal Builder base loop. */
export type BuilderToolName = BuilderToolAction['name'];
/** Context exposed to a capability tool. The target remains outside this context. */
export interface BuilderCapabilityToolContext {
    root: string;
    sessionId: string;
    runId: string;
    workspacePath: string;
}
/** A synchronous capability tool keeps the kernel's durable action boundary simple. */
export interface BuilderCapabilityRuntime {
    plugin: BuilderCapabilityPlugin;
    invoke(tool: string, input: Record<string, unknown>, context: BuilderCapabilityToolContext): Record<string, unknown>;
}
/** The complete starting tool set; capabilities add meaning, not hidden limits. */
export declare const BUILDER_BASE_TOOLS: readonly ["read_input", "read_journal", "read_file", "list_directory", "search_text", "inspect_file", "trace_artifact", "write_world_model", "write_plan", "write_diagnosis_report", "write_workspace_file", "apply_workspace_patch", "read_workspace_file", "run_workspace_command", "acknowledge_message", "publish_progress", "request_input", "write_submission", "compile_loop_submission", "compile_config_submission", "compile_module_submission"];
/** Declarative capability metadata supplied to a Builder run. */
export interface BuilderCapabilityPlugin {
    id: string;
    version: string;
    description: string;
    targetKinds?: readonly string[];
    /** Names may include capability-owned tools in addition to base tools. */
    tools?: readonly string[];
    instructions?: string;
    /** Governance is selected after exploration; it is not a Builder route limit. */
    verifierIds?: readonly string[];
    gateId?: string;
    proposalSchema?: string;
}
/** Small registry used to compose capability context without hard-coding a workflow. */
export declare class BuilderCapabilityRegistry {
    private readonly plugins;
    register(plugin: BuilderCapabilityPlugin): this;
    registerAll(plugins: readonly BuilderCapabilityPlugin[]): this;
    list(): BuilderCapabilityPlugin[];
    describe(): string;
}
/** Runtime registry: metadata registration alone never grants execution. */
export declare class BuilderCapabilityRuntimeRegistry {
    private readonly runtimes;
    register(runtime: BuilderCapabilityRuntime): this;
    get(id: string): BuilderCapabilityRuntime | undefined;
    list(): BuilderCapabilityRuntime[];
}
/** First loop-focused capability; it declares context, never prescribes a route. */
export declare const LOOP_EVOLUTION_CAPABILITY: BuilderCapabilityPlugin;
/** General actor capabilities share the same host-materialize → compiler →
 * independent verifier → Gate shape.  They are metadata, not a second
 * Proposer permission path. */
export declare const CONFIG_EVOLUTION_CAPABILITY: BuilderCapabilityPlugin;
export declare const TOOL_EVOLUTION_CAPABILITY: BuilderCapabilityPlugin;
export declare const SKILL_EVOLUTION_CAPABILITY: BuilderCapabilityPlugin;
/** Composition has deliberately no executable runtime until its dedicated
 * graph compiler, verifier set and transactional Gate are all registered. */
export declare const ACTOR_COMPOSITION_CAPABILITY: BuilderCapabilityPlugin;
/** Simulation is optional: it adds an experiment surface, not a new Builder loop. */
export declare const WORKSPACE_SIMULATION_CAPABILITY: BuilderCapabilityPlugin;
