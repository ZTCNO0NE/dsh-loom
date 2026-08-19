import { type BuilderCapabilityRuntime } from './capabilities.js';
export type SimulationStatus = 'passed' | 'failed' | 'inconclusive';
export interface SimulationRequest {
    id: string;
    command: string;
    args?: string[];
    files?: Record<string, string>;
    timeoutMs?: number;
    expectedExitCode?: number;
    expectedStdoutIncludes?: string[];
    /** A simulation may be deliberately marked inconclusive when its fixture is incomplete. */
    inconclusive?: boolean;
}
export interface SimulationReport {
    schemaVersion: 1;
    id: string;
    status: SimulationStatus;
    command: string;
    args: string[];
    cwd: string;
    inputHash: string;
    fixtureHash: string;
    outputHash: string;
    exitCode: number | null;
    signal?: string;
    stdout: string;
    stderr: string;
    durationMs: number;
    expected?: {
        exitCode?: number;
        stdoutIncludes?: string[];
    };
    divergence?: string;
    reportPath: string;
    reportHash: string;
}
export interface RuntimeObservation {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}
export interface SimulationConsistencyReport {
    schemaVersion: 1;
    simulationReportHash: string;
    realObservationHash: string;
    consistent: boolean;
    compared: Array<'exitCode' | 'stdout' | 'stderr'>;
    divergences: string[];
}
/**
 * Shared execution substrate for simulation capabilities. It deliberately
 * runs only in the Builder-owned workspace; it never mutates a live target.
 */
export declare class SimulationRunner {
    private readonly workspacePath;
    constructor(workspacePath: string);
    run(request: SimulationRequest): SimulationReport;
    private writeFixture;
}
/** Compare the same observable fields from simulation and a real isolated run. */
export declare function compareSimulationToReal(simulation: SimulationReport, real: RuntimeObservation): SimulationConsistencyReport;
/** Runtime adapter registered by the workspace-simulation capability. */
export declare function createWorkspaceSimulationRuntime(): BuilderCapabilityRuntime;
