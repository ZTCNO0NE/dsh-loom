import type { BuilderToolAction } from './kernel.js';
/** Tool names exposed by the minimal Builder base loop. */
export type BuilderToolName = BuilderToolAction['name'];
/** The complete starting tool set; capabilities add meaning, not hidden limits. */
export declare const BUILDER_BASE_TOOLS: readonly ["read_input", "read_journal", "read_file", "list_directory", "write_world_model", "write_plan", "write_workspace_file", "read_workspace_file", "run_workspace_command", "write_submission"];
/** Declarative capability metadata supplied to a Builder run. */
export interface BuilderCapabilityPlugin {
    id: string;
    version: string;
    description: string;
    targetKinds?: readonly string[];
    tools?: readonly BuilderToolName[];
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
/** First loop-focused capability; it declares context, never prescribes a route. */
export declare const LOOP_EVOLUTION_CAPABILITY: BuilderCapabilityPlugin;
