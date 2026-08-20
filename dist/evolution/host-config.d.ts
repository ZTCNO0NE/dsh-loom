/** DSH config rows whose effective value is owned by a runtime service. */
export declare const AGENT_DEFAULT_MODEL_TARGET = "agent-default-model";
export interface AgentDefaultModelServiceLike {
    currentSelection(): {
        provider: string;
        model: string;
        reasoningEffort?: unknown;
    };
    saveSelection(next: {
        provider: string;
        model: string;
        reasoningEffort?: unknown;
    }): Promise<void>;
}
/** Resolve the optional DSH default-model service without coupling Loom to its package implementation. */
export declare function agentDefaultModelServiceOf(host: unknown): AgentDefaultModelServiceLike | undefined;
/** Return the host-effective config rather than a lower-priority loader default. */
export declare function effectiveHostConfig(targetId: string, fallback: Record<string, unknown>, service: AgentDefaultModelServiceLike | undefined): Record<string, unknown>;
/** Persist a settings-backed config through its owning DSH service. */
export declare function writeEffectiveHostConfig(targetId: string, config: Record<string, unknown>, service: AgentDefaultModelServiceLike | undefined): Promise<boolean>;
