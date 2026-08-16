import { appendJsonl, atomicWriteJson, paths, readJson } from '../protocol/index.js';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
export function scenarioOf(signals) {
    if (signals.some((signal) => signal.kind === 'repeated_failure'))
        return 'S1-repeated-failure';
    if (signals.some((signal) => signal.kind === 'regression_failure'))
        return 'S4-regression-failure';
    if (signals.some((signal) => signal.kind === 'user_correction'))
        return 'S3-user-correction';
    return 'S9-explicit-request';
}
export function appendLedger(root, sessionId, entry) {
    appendJsonl(paths.growthLedger(root, sessionId), entry);
}
export function readLedger(root, sessionId) {
    const file = paths.growthLedger(root, sessionId);
    if (!existsSync(file))
        return [];
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
export function mergePreferences(root, sessionId, prefs) {
    if (prefs.length === 0)
        return;
    const file = paths.growthPreferences(root, sessionId);
    const existing = readJson(file) ?? [];
    const byKey = new Map(existing.map((item) => [`${item.scope}|${item.value}`, item]));
    const now = new Date().toISOString();
    for (const pref of prefs) {
        const key = `${pref.scope}|${pref.value}`;
        byKey.set(key, { ...pref, at: pref.at ?? now });
    }
    atomicWriteJson(file, [...byKey.values()]);
}
export function readPreferences(root, sessionId) {
    return readJson(paths.growthPreferences(root, sessionId)) ?? [];
}
export function appendReport(root, sessionId, line) {
    const file = paths.growthReport(root, sessionId);
    const dir = file.slice(0, file.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `- ${new Date().toISOString()} ${line}\n`, 'utf8');
}
