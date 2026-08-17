import { CandidateRegistry } from '../candidates/index.js';
import { recordCandidateVerification } from '../candidates/lifecycle.js';
function isPatchProposal(proposal) {
    return proposal.capability === 'patch-evolution';
}
/**
 * Adjudicate a frozen patch proposal: fixed verifier first, gate only after
 * approval. Rejection is returned to the caller, which reopens the Builder run.
 */
export async function adjudicatePatch(proposal, deps) {
    const { validator, gate, root, sessionId, collectFrames, applyOps, evidenceEvents } = deps;
    const patch = proposal.patch;
    if (!patch || typeof patch !== 'object' || typeof patch.targetId !== 'string') {
        throw new Error('patch proposal must contain a MetaPatch object');
    }
    gate.markStatus(root, sessionId, patch.id, 'verifying', 'deliberation', 1);
    const cases = await validator.loadRegressionCases();
    const base = { actualEvents: evidenceEvents ?? [] };
    const frames = collectFrames ? await collectFrames(patch, base) : base;
    const report = await validator.run(patch, cases, frames);
    validator.persistReport(root, sessionId, patch.id, report, frames.actualEvents);
    if (report.verdict !== 'approved') {
        gate.markStatus(root, sessionId, patch.id, 'rejected', 'deliberation', 1, report.failureSummary);
        return { kind: 'patch', verdict: 'rejected', patch, report, reason: report.failureSummary };
    }
    gate.markStatus(root, sessionId, patch.id, 'approved', 'deliberation', 1);
    if (!applyOps)
        return { kind: 'patch', verdict: 'approved', patch, report };
    const applied = await gate.applyWithRollback(patch, applyOps);
    if (!applied.applied) {
        const rejected = {
            ...report,
            verdict: 'rejected',
            failureSummary: applied.error ?? 'gate/install rejected and rolled back',
            validatedAt: new Date().toISOString(),
        };
        return { kind: 'patch', verdict: 'rejected', patch, report: rejected, reason: rejected.failureSummary };
    }
    await deps.onApplied?.({ patch, report, applied });
    return { kind: 'patch', verdict: 'approved', patch, report, applied };
}
/**
 * Adjudicate a frozen loop proposal: local baseline -> builder edits ->
 * sandboxed build -> independent contract evidence -> gate cold install.
 */
export async function adjudicateLoop(proposal, deps) {
    const { root, importer, verifyContract, install } = deps;
    const request = proposal.loop;
    if (!request || typeof request !== 'object' || typeof request.id !== 'string') {
        throw new Error('loop proposal must contain a loop object');
    }
    let manifest;
    try {
        manifest = importer.acquire({
            id: request.id,
            displayName: request.displayName,
            source: request.source,
            packageName: request.packageName,
            ...(request.packagePath ? { packagePath: request.packagePath } : {}),
            entry: request.entry,
            build: { method: 'sandboxed-dsh-workspace' },
            config: request.config,
            expectedOutcome: request.expectedOutcome,
            capabilities: request.capabilities,
        });
    }
    catch (error) {
        return { kind: 'loop', verdict: 'rejected', candidateId: request.id, reason: `staging failed: ${String(error)}` };
    }
    let verification;
    try {
        verification = await verifyContract(manifest);
    }
    catch (error) {
        verification = { passed: false, reason: `contract verifier failed: ${String(error)}` };
    }
    if (!verification.passed) {
        const registry = new CandidateRegistry(root);
        registry.stage(manifest);
        recordCandidateVerification(registry, manifest.id, {
            passed: false,
            reason: verification.reason ?? 'independent contract verification failed',
        });
        return {
            kind: 'loop',
            verdict: 'rejected',
            candidateId: manifest.id,
            evidence: verification.evidence,
            reason: verification.reason,
        };
    }
    const registry = new CandidateRegistry(root);
    registry.stage(manifest);
    const approved = recordCandidateVerification(registry, manifest.id, {
        passed: true,
        evidence: verification.evidence,
    });
    if (approved !== 'approved') {
        return { kind: 'loop', verdict: 'rejected', candidateId: manifest.id, evidence: verification.evidence, reason: 'verifier did not approve' };
    }
    if (!install) {
        return { kind: 'loop', verdict: 'approved', candidateId: manifest.id, evidence: verification.evidence };
    }
    const report = await install(manifest.id);
    return {
        kind: 'loop',
        verdict: report.state === 'installed' ? 'approved' : 'rejected',
        candidateId: manifest.id,
        evidence: verification.evidence,
        install: report,
        reason: report.state === 'installed' ? undefined : `gate install: ${report.state}`,
    };
}
/** Dispatch a frozen Builder proposal to its capability-specific adjudicator. */
export async function adjudicate(proposal, deps) {
    if (isPatchProposal(proposal))
        return adjudicatePatch(proposal, deps);
    return adjudicateLoop(proposal, deps);
}
