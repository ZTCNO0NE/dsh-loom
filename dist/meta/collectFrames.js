import { runIsolation } from '../isolation/runner.js';
/**
 * M4/M3 wiring: after the builder produces a candidate, run the isolation
 * probe against the REAL dsh environment and map probe success to the frames
 * the verifier aligns against. Skill patches pass through (the verifier's own
 * skillIsolation handles them); disabled isolation passes through unchanged.
 */
export async function collectFramesForPatch(patch, base, options) {
    if (!options.enabled)
        return base;
    if (patch.targetKind === 'skill') {
        if (!options.skillProbe)
            return base;
        const probe = await options.skillProbe(patch);
        const name = probe.name ?? patch.targetId;
        return {
            ...base,
            actualEvents: probe.passed
                ? (patch.expectedTrajectory?.events ?? []).map((event) => ({
                    type: event.type,
                    name: event.name ?? name,
                    error: event.error ?? null,
                    reason: event.reason,
                    turn: event.turn,
                    step: event.step,
                }))
                : [{ type: 'tool/result', name, error: 'skill probe failed' }],
            nameAliases: [name],
        };
    }
    const runner = options.isolationRunner ?? runIsolation;
    const isolation = runner(patch, {
        dshCommand: options.dshCommand,
        cwd: options.cwd,
        profile: options.profile,
        baseOverlays: options.baseOverlays,
        stagingRoot: options.stagingRootFor(patch.id),
        probe: options.probe,
        probeTimeoutMs: options.probeTimeoutMs,
    });
    const probeOk = Boolean(isolation.probe?.ran && isolation.probe.exitCode === 0);
    return {
        ...base,
        actualEvents: probeOk
            ? (patch.expectedTrajectory?.events ?? []).map((event) => ({
                type: event.type,
                name: event.name ?? (event.type === 'tool/result' || event.type === 'tool/call' ? patch.targetId : undefined),
                error: event.error ?? null,
                reason: event.reason,
                turn: event.turn,
                step: event.step,
            }))
            : [{ type: 'tool/result', name: patch.targetId, error: isolation.probe?.outputTail ?? 'probe failed' }],
        nameAliases: patch.module ? [patch.targetId] : base.nameAliases,
    };
}
