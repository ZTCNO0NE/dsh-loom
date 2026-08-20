import { type MiniSweRuntimeOptions } from '../builder/mini-swe.js';
import type { ExpectedTrajectory } from '../types.js';
import { type CompositionWorkspacePlan } from '../composition/compiler.js';
/** A host-selected plan. The external runtime never selects its compiler. */
export interface ConfigEvolutionPlan {
    capability: 'config-evolution';
    targetId: string;
    before: Record<string, unknown>;
    expectedTrajectory?: ExpectedTrajectory;
}
export interface ModuleEvolutionPlan {
    capability: 'tool-evolution' | 'skill-evolution';
    targetId: string;
    targetName?: string;
    targetKind: 'tool' | 'skill';
    entry: string;
    /** Host-owned verifier binding, never supplied by the execution runtime. */
    expectedTrajectory?: ExpectedTrajectory;
}
export interface CompositionEvolutionPlan extends CompositionWorkspacePlan {
    capability: 'actor-composition';
}
export interface ActorEvolutionGatewayOptions {
    root: string;
    sessionId: string;
    model: string;
    miniSwe: Omit<MiniSweRuntimeOptions, 'model' | 'baselineRoot' | 'dependencySnapshot'>;
}
export interface ActorEvolutionResult {
    runId: string;
    state: 'submitted' | 'aborted';
    proposal?: Record<string, unknown>;
    reason?: string;
}
/**
 * Generic actor execution ingress. v1 implements config-evolution only; its
 * output is deliberately the existing patch-evolution envelope, so Validator
 * and Gate remain the sole acceptance path rather than a second subsystem.
 */
export declare class ActorEvolutionGateway {
    private readonly options;
    constructor(options: ActorEvolutionGatewayOptions);
    startConfig(requirements: string, plan: ConfigEvolutionPlan): {
        runId: string;
    };
    runConfig(runId: string): Promise<ActorEvolutionResult>;
    startModule(requirements: string, plan: ModuleEvolutionPlan): {
        runId: string;
    };
    runModule(runId: string): Promise<ActorEvolutionResult>;
    startComposition(requirements: string, plan: CompositionEvolutionPlan): {
        runId: string;
    };
    runComposition(runId: string): Promise<ActorEvolutionResult>;
    /**
     * A verifier/gate rejection never resumes a mutable workspace.  It creates
     * a new immutable run with the full report and rematerializes only the
     * host-owned baseline shape required by the selected capability.
     */
    reopen(runId: string, report: Record<string, unknown>): {
        runId: string;
    };
    private abort;
    private acknowledgeRuntimeInbox;
    private builderSessionId;
    private kernel;
    private paths;
}
