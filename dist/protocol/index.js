import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
/**
 * Durable meta workspace (08 §11-§12). File-first: no role trusts context;
 * every artifact is written atomically and carries a schemaVersion.
 */
export const PROTOCOL_VERSION = 1;
export function metaRoot() {
    return process.env.DSH_META_VALIDATE_ROOT
        ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'meta-validate') : join(process.cwd(), '.meta-validate'));
}
export function workspaceDir(root, sessionId) {
    return join(root, 'workspace', sessionId);
}
export function patchDir(root, sessionId, patchId) {
    return join(workspaceDir(root, sessionId), 'patches', patchId);
}
export function sha256(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function atomicWriteJson(path, value) {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
        renameSync(tmp, path);
    }
    finally {
        if (existsSync(tmp)) {
            unlinkSync(tmp);
        }
    }
}
export function appendJsonl(path, record) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}
export function readJson(path) {
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
export function readJsonl(path) {
    if (!existsSync(path))
        return [];
    const out = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim())
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // Unknown/malformed lines are skipped and warned by the caller.
        }
    }
    return out;
}
export function ensureWorkspace(root, sessionId) {
    const dir = workspaceDir(root, sessionId);
    mkdirSync(join(dir, 'trajectory'), { recursive: true });
    mkdirSync(join(dir, 'builder'), { recursive: true });
    mkdirSync(join(dir, 'patches'), { recursive: true });
    mkdirSync(join(root, 'regressions'), { recursive: true });
    const protocol = { schemaVersion: PROTOCOL_VERSION, name: 'dsh-meta-validate' };
    atomicWriteJson(join(dir, 'protocol.json'), protocol);
}
export const paths = {
    requirements: (root, sessionId) => join(workspaceDir(root, sessionId), 'requirements.json'),
    triggers: (root, sessionId) => join(workspaceDir(root, sessionId), 'triggers.jsonl'),
    signals: (root, sessionId) => join(workspaceDir(root, sessionId), 'signals.jsonl'),
    events: (root, sessionId) => join(workspaceDir(root, sessionId), 'trajectory', 'events.jsonl'),
    frames: (root, sessionId) => join(workspaceDir(root, sessionId), 'trajectory', 'frames.jsonl'),
    handoff: (root, sessionId) => join(workspaceDir(root, sessionId), 'handoff', 'stall.jsonl'),
    errors: (root, sessionId) => join(workspaceDir(root, sessionId), 'errors.jsonl'),
    notices: (root, sessionId) => join(workspaceDir(root, sessionId), 'notices.jsonl'),
    worldState: (root, sessionId) => join(workspaceDir(root, sessionId), 'trajectory', 'world-state.json'),
    actorProfile: (root, sessionId) => join(workspaceDir(root, sessionId), 'trajectory', 'actor-profile.json'),
    worldModel: (root, sessionId) => join(workspaceDir(root, sessionId), 'builder', 'world-model.json'),
    selfCheck: (root, sessionId) => join(workspaceDir(root, sessionId), 'builder', 'self-check.json'),
    candidate: (root, sessionId, patchId) => join(patchDir(root, sessionId, patchId), 'candidate.json'),
    expectedTrajectory: (root, sessionId, patchId) => join(patchDir(root, sessionId, patchId), 'expected-trajectory.json'),
    report: (root, sessionId, patchId) => join(patchDir(root, sessionId, patchId), 'report.json'),
    status: (root, sessionId, patchId) => join(patchDir(root, sessionId, patchId), 'status.json'),
    smoke: (root, sessionId, patchId) => join(patchDir(root, sessionId, patchId), 'smoke.json'),
    runEvents: (root, sessionId, patchId) => join(patchDir(root, sessionId, patchId), 'run', 'events.jsonl'),
    probes: (root, sessionId, patchId) => join(patchDir(root, sessionId, patchId), 'probes.jsonl'),
    history: (root, sessionId) => join(workspaceDir(root, sessionId), 'history.jsonl'),
    gateDecisions: (root, sessionId) => join(workspaceDir(root, sessionId), 'gate-decisions.jsonl'),
    autopilotState: (root, sessionId) => join(workspaceDir(root, sessionId), 'autopilot-state.json'),
    costLog: (root, sessionId) => join(workspaceDir(root, sessionId), 'cost-log.jsonl'),
    ledger: (root, sessionId) => join(workspaceDir(root, sessionId), 'ledger.jsonl'),
    growthLedger: (root, sessionId) => join(root, 'growth', sessionId, 'ledger.jsonl'),
    growthPreferences: (root, sessionId) => join(root, 'growth', sessionId, 'preferences.json'),
    growthReport: (root, sessionId) => join(root, 'growth', sessionId, 'report.md'),
    harnessState: (root, sessionId) => join(workspaceDir(root, sessionId), 'harness-state.json'),
    overlays: (root, sessionId) => join(root, 'overlays', sessionId),
    overlayFile: (root, sessionId, patchId) => join(root, 'overlays', sessionId, `${patchId}.yml`),
    staging: (root, sessionId, patchId) => join(workspaceDir(root, sessionId), 'builder', 'staging', patchId),
};
