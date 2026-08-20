/** DSH config rows whose effective value is owned by a runtime service. */
export const AGENT_DEFAULT_MODEL_TARGET = 'agent-default-model';
/** Resolve the optional DSH default-model service without coupling Loom to its package implementation. */
export function agentDefaultModelServiceOf(host) {
    try {
        const contextual = host;
        const service = (typeof contextual.get === 'function'
            ? contextual.get('agentDefaultModel')
            : contextual.agentDefaultModel);
        return service && typeof service.currentSelection === 'function' && typeof service.saveSelection === 'function'
            ? service
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** Return the host-effective config rather than a lower-priority loader default. */
export function effectiveHostConfig(targetId, fallback, service) {
    if (targetId !== AGENT_DEFAULT_MODEL_TARGET || !service)
        return { ...fallback };
    return { ...service.currentSelection() };
}
/** Persist a settings-backed config through its owning DSH service. */
export async function writeEffectiveHostConfig(targetId, config, service) {
    if (targetId !== AGENT_DEFAULT_MODEL_TARGET || !service)
        return false;
    if (typeof config.provider !== 'string' || typeof config.model !== 'string') {
        throw new Error('agent-default-model requires string provider and model');
    }
    await service.saveSelection({
        provider: config.provider,
        model: config.model,
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    });
    return true;
}
