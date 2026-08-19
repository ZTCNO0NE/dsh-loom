import { createHash } from 'node:crypto';
export function compositionHash(proposal) {
    return createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
}
/** Deterministic structural verifier. Capability-specific Validators run before
 * this report is eligible for the transaction Gate. */
export function verifyComposition(proposal, options) {
    const checks = [];
    const operations = Array.isArray(proposal.operations) ? proposal.operations : [];
    const limit = options.maxOperations ?? 8;
    checks.push({ name: 'bounded-operations', passed: operations.length > 0 && operations.length <= limit, detail: `${operations.length}/${limit}` });
    const ids = operations.map((operation) => operation.id);
    checks.push({ name: 'unique-operation-ids', passed: ids.every((id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) && new Set(ids).size === ids.length });
    const targets = operations.map((operation) => operation.patch.targetId);
    checks.push({ name: 'unique-targets', passed: new Set(targets).size === targets.length });
    checks.push({
        name: 'controller-allowed-targets',
        passed: operations.every((operation) => options.allowedTargets.has(operation.patch.targetId)),
    });
    checks.push({
        name: 'supported-components',
        passed: operations.every((operation) => ['config', 'tool', 'skill'].includes(operation.patch.targetKind)),
    });
    checks.push({
        name: 'subpatch-trajectories',
        passed: operations.every((operation) => Boolean(operation.patch.expectedTrajectory?.events?.length)),
    });
    const idSet = new Set(ids);
    checks.push({ name: 'dependency-refs', passed: operations.every((operation) => operation.dependsOn.every((id) => idSet.has(id) && id !== operation.id)) });
    checks.push({ name: 'acyclic-dependencies', passed: isAcyclic(operations) });
    const rejected = checks.filter((check) => !check.passed);
    return {
        proposalId: proposal.id,
        proposalHash: compositionHash(proposal),
        verdict: rejected.length === 0 ? 'approved' : 'rejected',
        checks,
        ...(rejected.length ? { failureSummary: rejected.map((check) => check.name).join(', ') } : {}),
    };
}
function isAcyclic(operations) {
    const graph = new Map(operations.map((operation) => [operation.id, operation.dependsOn]));
    const visiting = new Set();
    const complete = new Set();
    const visit = (id) => {
        if (complete.has(id))
            return true;
        if (visiting.has(id))
            return false;
        visiting.add(id);
        for (const dependency of graph.get(id) ?? [])
            if (!visit(dependency))
                return false;
        visiting.delete(id);
        complete.add(id);
        return true;
    };
    return operations.every((operation) => visit(operation.id));
}
/** Controller dispatch for the composition capability. It deliberately does
 * not invoke ordinary patch Gates: every child must independently verify, then
 * the whole graph is atomically applied by the transaction Gate. */
export async function adjudicateComposition(proposal, deps) {
    const graph = verifyComposition(proposal, { allowedTargets: deps.allowedTargets });
    if (graph.verdict !== 'approved')
        return { verdict: 'rejected', graph, operationReports: [], reason: graph.failureSummary };
    const operationReports = await Promise.all(proposal.operations.map(async (operation) => ({ id: operation.id, ...await deps.verifyOperation(operation) })));
    const failed = operationReports.find((report) => !report.passed);
    if (failed)
        return { verdict: 'rejected', graph, operationReports, reason: `component verifier rejected ${failed.id}: ${failed.reason ?? 'unknown'}` };
    const applied = await applyCompositionWithRollback(proposal, graph, deps.gate);
    return {
        verdict: applied.applied ? 'approved' : 'rejected', graph, operationReports, applied,
        ...(applied.applied ? {} : { reason: applied.error ?? 'composition Gate rejected' }),
    };
}
/** Dedicated all-or-nothing gate. It never applies a partial graph, and it
 * refuses a report whose hash does not bind the exact frozen proposal. */
export async function applyCompositionWithRollback(proposal, report, ops) {
    const expectedHash = compositionHash(proposal);
    if (report.verdict !== 'approved' || report.proposalId !== proposal.id || report.proposalHash !== expectedHash) {
        return { applied: false, before: {}, error: 'composition verifier report is missing, rejected, or stale', rolledBack: [] };
    }
    const ordered = topologicalOrder(proposal.operations);
    const before = {};
    const applied = [];
    try {
        for (const operation of ordered) {
            before[operation.id] = await ops.snapshot(operation);
            await ops.apply(operation);
            applied.push(operation);
        }
        const smoke = await ops.smoke(proposal);
        if (smoke.passed)
            return { applied: true, before, smoke, rolledBack: [] };
        throw new Error(`composition smoke failed: ${smoke.checks.filter((check) => !check.passed).map((check) => check.name).join(', ')}`);
    }
    catch (error) {
        const rolledBack = [];
        for (const operation of [...applied].reverse()) {
            try {
                await ops.rollback(operation, before[operation.id]);
                rolledBack.push(operation.id);
            }
            catch { /* preserve original failure; caller sees incomplete rollback */ }
        }
        return { applied: false, before, error: String(error), rolledBack };
    }
}
function topologicalOrder(operations) {
    const byId = new Map(operations.map((operation) => [operation.id, operation]));
    const output = [];
    const seen = new Set();
    const visit = (operation) => {
        if (seen.has(operation.id))
            return;
        seen.add(operation.id);
        for (const id of operation.dependsOn) {
            const dependency = byId.get(id);
            if (dependency)
                visit(dependency);
        }
        output.push(operation);
    };
    operations.forEach(visit);
    return output;
}
