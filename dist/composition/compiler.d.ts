import type { ExpectedTrajectory } from '../types.js';
import type { ActorCompositionProposal } from './index.js';
export interface CompositionTargetPlan {
    id: string;
    dependsOn?: string[];
    targetId: string;
    targetKind: 'config' | 'tool' | 'skill';
    targetName?: string;
    entry?: string;
    before?: Record<string, unknown>;
    expectedTrajectory: ExpectedTrajectory;
}
export interface CompositionWorkspacePlan {
    id: string;
    rationale: string;
    expectedOutcome: string;
    targets: CompositionTargetPlan[];
}
/** Host compiler for a multi-component runtime workspace. The runtime can
 * alter after artifacts only; target identity, graph and before snapshots are
 * all supplied by the controller plan. */
export declare function compileCompositionWorkspace(workspace: string, plan: CompositionWorkspacePlan): ActorCompositionProposal;
