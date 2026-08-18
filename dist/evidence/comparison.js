import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteJson, sha256 } from '../protocol/index.js';
/** Execute exactly one isolated actor task and persist stdout/stderr as evidence. */
export function runActorReplay(options) {
    const started = Date.now();
    let exitCode = 0;
    let output = '';
    let error;
    try {
        output = execFileSync(options.command[0], [...options.command.slice(1), options.task], {
            cwd: options.cwd,
            env: options.env,
            encoding: 'utf8',
            timeout: options.timeoutMs ?? 300_000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch (caught) {
        const detail = caught;
        exitCode = detail.status ?? 1;
        output = `${String(detail.stdout ?? '')}${String(detail.stderr ?? '')}`;
        error = String(detail.message ?? `exit ${exitCode}`);
    }
    mkdirSync(dirname(options.outputPath), { recursive: true });
    writeFileSync(options.outputPath, output, 'utf8');
    const durationMs = Date.now() - started;
    return {
        label: options.label,
        task: options.task,
        command: options.command,
        cwd: options.cwd,
        exitCode,
        durationMs,
        outputPath: options.outputPath,
        outputSha256: sha256(output),
        outputTail: output.slice(-2_000),
        taskSuccess: exitCode === 0,
        ...(error ? { error } : {}),
    };
}
/** Persist the same-task comparison without turning a single exit code into a performance claim. */
export function writeActorComparison(options) {
    const admissible = options.contractPass
        && options.regressionPass
        && options.gatePass
        && (!options.rollbackRequired || options.rollbackPass === true)
        && options.baseline.taskSuccess
        && options.installed.taskSuccess;
    const ratio = options.baseline.durationMs > 0 ? options.installed.durationMs / options.baseline.durationMs : null;
    const report = {
        schemaVersion: 2,
        id: options.id,
        task: options.task,
        baseline: options.baseline,
        installed: options.installed,
        delta: { durationMs: options.installed.durationMs - options.baseline.durationMs, durationRatio: ratio },
        admissible,
        claimLevel: admissible ? 'causal-workload' : 'not-established',
        contractPass: options.contractPass,
        regressionPass: options.regressionPass,
        gatePass: options.gatePass,
        rollbackRequired: options.rollbackRequired ?? false,
        ...(options.rollbackPass === undefined ? {} : { rollbackPass: options.rollbackPass }),
        ...(options.beforeSnapshot === undefined ? {} : { beforeSnapshot: options.beforeSnapshot }),
        ...(options.afterSnapshot === undefined ? {} : { afterSnapshot: options.afterSnapshot }),
        ...(options.extra ? { extra: options.extra } : {}),
        createdAt: new Date().toISOString(),
    };
    atomicWriteJson(join(options.root, 'workspace', options.sessionId, 'comparisons', `${options.id}.json`), report);
    return report;
}
