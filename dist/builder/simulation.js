import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { sha256 } from '../protocol/index.js';
import { WORKSPACE_SIMULATION_CAPABILITY } from './capabilities.js';
/**
 * Shared execution substrate for simulation capabilities. It deliberately
 * runs only in the Builder-owned workspace; it never mutates a live target.
 */
export class SimulationRunner {
    workspacePath;
    constructor(workspacePath) {
        this.workspacePath = workspacePath;
    }
    run(request) {
        const id = safeId(request.id);
        mkdirSync(this.workspacePath, { recursive: true });
        const fixtureHash = sha256(request.files ?? {});
        for (const [path, content] of Object.entries(request.files ?? {}))
            this.writeFixture(path, content);
        const args = [...(request.args ?? [])];
        const inputHash = sha256({ ...request, args, files: request.files ?? {} });
        const started = Date.now();
        let output;
        try {
            output = spawnSync(request.command, args, {
                cwd: this.workspacePath,
                encoding: 'utf8',
                timeout: Math.max(1_000, Math.min(300_000, Math.floor(request.timeoutMs ?? 120_000))),
                maxBuffer: 512 * 1024,
                env: simulationEnv(),
            });
        }
        catch (error) {
            output = { status: null, signal: 'spawn-error', stdout: '', stderr: String(error) };
        }
        const stdout = String(output.stdout ?? '').slice(-128_000);
        const stderr = String(output.stderr ?? '').slice(-128_000);
        const exitCode = typeof output.status === 'number' ? output.status : null;
        const durationMs = Date.now() - started;
        const expected = {
            ...(request.expectedExitCode === undefined ? {} : { exitCode: request.expectedExitCode }),
            ...(request.expectedStdoutIncludes?.length ? { stdoutIncludes: [...request.expectedStdoutIncludes] } : {}),
        };
        const divergence = request.inconclusive
            ? 'fixture or runtime was explicitly marked inconclusive'
            : exitCode !== (request.expectedExitCode ?? 0)
                ? `exitCode expected ${request.expectedExitCode ?? 0}, observed ${String(exitCode)}`
                : (request.expectedStdoutIncludes ?? []).find((needle) => !stdout.includes(needle))
                    ? `stdout did not contain ${JSON.stringify((request.expectedStdoutIncludes ?? []).find((needle) => !stdout.includes(needle)))} `
                    : undefined;
        const status = request.inconclusive ? 'inconclusive' : divergence ? 'failed' : 'passed';
        const reportPath = join(this.workspacePath, '.loom', 'simulations', `${id}.json`);
        const base = {
            schemaVersion: 1,
            id,
            status,
            command: request.command,
            args,
            cwd: this.workspacePath,
            inputHash,
            fixtureHash,
            outputHash: sha256({ exitCode, stdout, stderr }),
            exitCode,
            ...(output.signal ? { signal: output.signal } : {}),
            stdout,
            stderr,
            durationMs,
            ...(Object.keys(expected).length ? { expected } : {}),
            ...(divergence ? { divergence } : {}),
            reportPath,
        };
        const reportHash = sha256(base);
        const report = { ...base, reportHash };
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        return report;
    }
    writeFixture(path, content) {
        const target = resolve(this.workspacePath, path);
        const rel = relative(resolve(this.workspacePath), target);
        if (isAbsolute(path) || rel.startsWith('..') || rel === '..')
            throw new Error(`simulation fixture escapes workspace: ${path}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf8');
    }
}
/** Compare the same observable fields from simulation and a real isolated run. */
export function compareSimulationToReal(simulation, real) {
    const divergences = [];
    if (simulation.exitCode !== real.exitCode)
        divergences.push(`exitCode: ${String(simulation.exitCode)} != ${String(real.exitCode)}`);
    if (simulation.stdout !== real.stdout)
        divergences.push('stdout differs');
    if (simulation.stderr !== real.stderr)
        divergences.push('stderr differs');
    return {
        schemaVersion: 1,
        simulationReportHash: simulation.reportHash,
        realObservationHash: sha256(real),
        consistent: divergences.length === 0,
        compared: ['exitCode', 'stdout', 'stderr'],
        divergences,
    };
}
/** Runtime adapter registered by the workspace-simulation capability. */
export function createWorkspaceSimulationRuntime() {
    return {
        plugin: WORKSPACE_SIMULATION_CAPABILITY,
        invoke(tool, input, context) {
            if (tool !== 'run_simulation')
                throw new Error(`unknown workspace-simulation tool: ${tool}`);
            if (typeof input.id !== 'string' || typeof input.command !== 'string')
                throw new Error('run_simulation requires id and command');
            const files = input.files === undefined ? undefined : asStringMap(input.files);
            const report = new SimulationRunner(context.workspacePath).run({
                id: input.id,
                command: input.command,
                args: asStringArray(input.args),
                ...(files ? { files } : {}),
                ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
                ...(typeof input.expectedExitCode === 'number' ? { expectedExitCode: input.expectedExitCode } : {}),
                ...(Array.isArray(input.expectedStdoutIncludes) ? { expectedStdoutIncludes: asStringArray(input.expectedStdoutIncludes) } : {}),
                ...(input.inconclusive === true ? { inconclusive: true } : {}),
            });
            return report;
        },
    };
}
function asStringArray(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
        throw new Error('expected a string array');
    return value;
}
function asStringMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('expected fixture files object');
    const entries = Object.entries(value);
    if (!entries.every(([, content]) => typeof content === 'string'))
        throw new Error('fixture file content must be string');
    return Object.fromEntries(entries);
}
function safeId(value) {
    const id = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id)
        throw new Error('simulation id must not be empty');
    return id.slice(0, 120);
}
function simulationEnv() {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.DSH_META_VALIDATE_ROOT;
    return env;
}
