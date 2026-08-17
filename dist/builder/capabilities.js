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
];
/** Small registry used to compose capability context without hard-coding a workflow. */
export class BuilderCapabilityRegistry {
    plugins = new Map();
    register(plugin) {
        if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(plugin.id))
            throw new Error(`invalid builder capability id: ${plugin.id}`);
        if (this.plugins.has(plugin.id))
            throw new Error(`builder capability already registered: ${plugin.id}`);
        this.plugins.set(plugin.id, plugin);
        return this;
    }
    registerAll(plugins) {
        for (const plugin of plugins)
            this.register(plugin);
        return this;
    }
    list() {
        return [...this.plugins.values()].map(plugin => ({ ...plugin }));
    }
    describe() {
        if (this.plugins.size === 0)
            return '(no additional capability registered)';
        return this.list().map(plugin => JSON.stringify({
            id: plugin.id,
            version: plugin.version,
            description: plugin.description,
            targetKinds: plugin.targetKinds ?? [],
            tools: plugin.tools ?? [],
            instructions: plugin.instructions ?? '',
        })).join('\n');
    }
}
/** First loop-focused capability; it declares context, never prescribes a route. */
export const LOOP_EVOLUTION_CAPABILITY = {
    id: 'loop-evolution',
    version: '0.1.0',
    description: 'Explore, rebuild, replace, or improve an actor loop in the Builder workspace.',
    targetKinds: ['actor-loop'],
    tools: ['read_file', 'list_directory', 'write_workspace_file', 'read_workspace_file', 'run_workspace_command', 'write_submission'],
    instructions: 'Choose your own exploration path. A candidate may be a small edit, a rebuilt loop, or a complete replacement; report what you tried and why.',
};
