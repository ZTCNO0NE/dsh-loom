import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
/** Resolve the exact audited commit before a Builder workspace is materialized. */
export function miniSweBaselineCommit(baselineRoot) {
    return execFileSync('git', ['-C', baselineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim();
}
/** Materialize a complete immutable source workspace owned by this Builder run. */
export function materializeMiniSweWorkspace(options) {
    if (!/^[0-9a-f]{40}$/i.test(options.commit))
        throw new Error('mini-SWE baseline commit must be a 40-character SHA');
    if (!existsSync(options.dependencySnapshot))
        throw new Error('mini-SWE dependency snapshot is unavailable');
    mkdirSync(options.workspace, { recursive: true });
    const archive = execFileSync('git', ['-C', options.baselineRoot, 'archive', '--format=tar', options.commit], {
        maxBuffer: 512 * 1024 * 1024,
        timeout: 120_000,
    });
    execFileSync('tar', ['-xf', '-', '-C', options.workspace], { input: archive, timeout: 120_000 });
    // The snapshot is host-owned and prepared before model execution.  It is
    // copied into the run rather than linked, so a Builder cannot mutate future
    // runs or the verified build dependency root.
    cpSync(options.dependencySnapshot, join(options.workspace, 'node_modules'), { recursive: true, dereference: false });
}
/** Run mini-SWE in the Builder workspace and read only its durable trajectory. */
export async function runMiniSwe(options) {
    let error;
    try {
        const env = options.resolveEnv ? await options.resolveEnv() : options.env;
        const args = options.runnerPath
            ? [options.runnerPath, '--model', options.model, '--output', options.trajectoryPath, '--config', options.configPath, '--workspace', options.workspace, '--timeout-seconds', String(Math.ceil(options.timeoutMs / 1000)), '--step-limit', String(options.stepLimit), '--task', options.task]
            : [
                '-m', options.model, '-y', '--exit-immediately', '-l', '0', '-o', options.trajectoryPath,
                '-c', options.configPath,
                '-c', `environment.cwd=${options.workspace}`,
                '-c', `environment.timeout=${Math.ceil(options.timeoutMs / 1000)}`,
                '-c', `agent.step_limit=${options.stepLimit}`,
                '-t', options.task,
            ];
        const executable = options.runnerPath ? options.executable.replace(/mini(?:\.exe)?$/i, process.platform === 'win32' ? 'python.exe' : 'python') : options.executable;
        await execFileAsync(executable, args, {
            cwd: options.workspace,
            timeout: options.timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            ...(env ? { env } : {}),
        });
    }
    catch (caught) {
        error = String(caught.message ?? caught);
    }
    if (!existsSync(options.trajectoryPath))
        return { submitted: false, trajectoryPath: options.trajectoryPath, modelTurns: 0, toolSteps: 0, error: error ?? 'mini-SWE produced no trajectory' };
    let trajectory;
    try {
        trajectory = JSON.parse(readFileSync(options.trajectoryPath, 'utf8'));
    }
    catch (caught) {
        return {
            submitted: false,
            trajectoryPath: options.trajectoryPath,
            modelTurns: 0,
            toolSteps: 0,
            error: `mini-SWE trajectory is unreadable: ${String(caught.message ?? caught)}`,
        };
    }
    const messages = trajectory.messages ?? [];
    const terminal = [...messages].reverse().find((message) => message.role === 'exit');
    const exitStatus = terminal?.extra?.exit_status;
    const modelTurns = messages.filter((message) => message.role === 'assistant').length;
    const toolSteps = messages.filter((message) => Array.isArray(message.tool_calls) && message.tool_calls.length > 0).length;
    const submitted = exitStatus === 'Submitted';
    return {
        submitted,
        trajectoryPath: options.trajectoryPath,
        modelTurns,
        toolSteps,
        ...(!submitted && exitStatus
            ? { error: `mini-SWE exited ${exitStatus} after ${modelTurns} model turns and ${toolSteps} tool steps without submission` }
            : error ? { error } : {}),
    };
}
