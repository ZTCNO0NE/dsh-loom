import type { MetaPatch, ValidationReport } from '../types.js'
import type { ActualEvent, Validator, VerifierInput } from '../validate/index.js'
import type { ApplyOps, ApplyResult, Gate } from '../gate/index.js'
import type {
  BuilderGeneratedSourceRequest,
  CandidateImporter,
  ContractEvidence,
  LoopInstallReport,
} from '../candidates/index.js'
import { CandidateRegistry } from '../candidates/index.js'
import { recordCandidateVerification, installVerifiedCandidate } from '../candidates/lifecycle.js'

/**
 * Frozen Builder proposal accepted by the adjudicator. The builder never
 * applies anything; this is the only place a proposal becomes a target change.
 */
export type BuilderProposal =
  | { capability: 'patch-evolution'; patch: MetaPatch; rationale?: string; artifacts?: string[] }
  | { capability: 'loop-evolution'; loop: LoopEvolutionProposal; rationale?: string; artifacts?: string[] }

/** Capability-neutral model-facing envelope; known payloads are normalized
 * before adjudication, while unknown-but-well-formed capabilities become
 * `needs_verifier` drafts (never installed, never blocked from submission). */
export interface BuilderProposalEnvelope {
  capability: string
  payload: Record<string, unknown>
  rationale?: string
  artifacts?: string[]
}

export interface LoopEvolutionProposal {
  id: string
  displayName: string
  source: BuilderGeneratedSourceRequest
  packageName: string
  packagePath?: string
  entry: string
  config: Record<string, unknown>
  expectedOutcome: string
  capabilities: string[]
}

export interface PatchAdjudicationDeps {
  validator: Validator
  gate: Gate
  root: string
  sessionId: string
  collectFrames?: (patch: MetaPatch, base: VerifierInput) => Promise<VerifierInput>
  applyOps?: ApplyOps
  evidenceEvents?: ActualEvent[]
  onApplied?: (info: { patch: MetaPatch; report: ValidationReport; applied: ApplyResult }) => void | Promise<void>
}

export interface LoopAdjudicationDeps {
  root: string
  importer: CandidateImporter
  /** Independent contract verification (C0/C1-C8/C6). Fail-closed when absent. */
  verifyContract: (manifest: Awaited<ReturnType<CandidateImporter['acquire']>>) => Promise<{ passed: boolean; evidence?: ContractEvidence; reason?: string }>
  /** Gate-owned cold install; omitted means "approved but not installed". */
  install?: (candidateId: string) => Promise<LoopInstallReport>
}

export interface PatchAdjudicationResult {
  kind: 'patch'
  verdict: 'approved' | 'rejected'
  patch: MetaPatch
  report: ValidationReport
  applied?: ApplyResult
  reason?: string
}

export interface LoopAdjudicationResult {
  kind: 'loop'
  verdict: 'approved' | 'rejected'
  candidateId: string
  evidence?: ContractEvidence
  install?: LoopInstallReport
  reason?: string
}

export type AdjudicationResult = PatchAdjudicationResult | LoopAdjudicationResult

export type ProposalClassifyResult =
  | { kind: 'known'; proposal: BuilderProposal }
  | { kind: 'needs_verifier'; capability: string; payload: Record<string, unknown>; rationale?: string; artifacts?: string[] }
  | { kind: 'malformed'; reason: string }

/**
 * Classify a frozen submission without narrowing Builder exploration:
 * known capabilities are normalized for adjudication, unknown capabilities
 * with a payload become `needs_verifier` drafts, malformed envelopes are the
 * only thing that may be reopened as a rejection.
 */
export function classifyBuilderProposal(value: Record<string, unknown>): ProposalClassifyResult {
  const capability = typeof value.capability === 'string' ? value.capability : ''
  const rationale = typeof value.rationale === 'string' ? value.rationale : undefined
  const artifacts = Array.isArray(value.artifacts) && value.artifacts.every((item) => typeof item === 'string')
    ? value.artifacts as string[]
    : undefined
  if (capability === 'patch-evolution') {
    const payload = value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) ? value.payload : value.patch
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { kind: 'malformed', reason: `${capability} proposal missing payload` }
    }
    if (typeof (payload as Record<string, unknown>).targetId !== 'string' || typeof (payload as Record<string, unknown>).targetKind !== 'string') {
      return { kind: 'malformed', reason: `${capability} payload missing targetId/targetKind` }
    }
    return {
      kind: 'known',
      proposal: {
        capability: 'patch-evolution',
        patch: payload as MetaPatch,
        ...(rationale ? { rationale } : {}),
        ...(artifacts ? { artifacts } : {}),
      },
    }
  }
  if (capability === 'loop-evolution') {
    const payload = value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) ? value.payload : value.loop
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { kind: 'malformed', reason: `${capability} proposal missing payload` }
    }
    if (typeof (payload as Record<string, unknown>).id !== 'string' || typeof (payload as Record<string, unknown>).entry !== 'string') {
      return { kind: 'malformed', reason: `${capability} payload missing id/entry` }
    }
    return {
      kind: 'known',
      proposal: {
        capability: 'loop-evolution',
        loop: payload as LoopEvolutionProposal,
        ...(rationale ? { rationale } : {}),
        ...(artifacts ? { artifacts } : {}),
      },
    }
  }
  if (!capability) return { kind: 'malformed', reason: 'proposal missing capability' }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    return { kind: 'malformed', reason: `capability ${capability} submitted without payload` }
  }
  return {
    kind: 'needs_verifier',
    capability,
    payload: value.payload as Record<string, unknown>,
    ...(rationale ? { rationale } : {}),
    ...(artifacts ? { artifacts } : {}),
  }
}

function isPatchProposal(proposal: BuilderProposal): proposal is Extract<BuilderProposal, { capability: 'patch-evolution' }> {
  return proposal.capability === 'patch-evolution'
}

/**
 * Adjudicate a frozen patch proposal: fixed verifier first, gate only after
 * approval. Rejection is returned to the caller, which reopens the Builder run.
 */
export async function adjudicatePatch(
  proposal: Extract<BuilderProposal, { capability: 'patch-evolution' }>,
  deps: PatchAdjudicationDeps,
): Promise<PatchAdjudicationResult> {
  const { validator, gate, root, sessionId, collectFrames, applyOps, evidenceEvents } = deps
  const patch = proposal.patch
  if (!patch || typeof patch !== 'object' || typeof patch.targetId !== 'string') {
    throw new Error('patch proposal must contain a MetaPatch object')
  }
  gate.markStatus(root, sessionId, patch.id, 'verifying', 'deliberation', 1)
  const cases = await validator.loadRegressionCases()
  const base: VerifierInput = { actualEvents: evidenceEvents ?? [] }
  const frames = collectFrames ? await collectFrames(patch, base) : base
  const report = await validator.run(patch, cases, frames)
  validator.persistReport(root, sessionId, patch.id, report, frames.actualEvents)

  if (report.verdict !== 'approved') {
    gate.markStatus(root, sessionId, patch.id, 'rejected', 'deliberation', 1, report.failureSummary)
    return { kind: 'patch', verdict: 'rejected', patch, report, reason: report.failureSummary }
  }
  gate.markStatus(root, sessionId, patch.id, 'approved', 'deliberation', 1)
  if (!applyOps) return { kind: 'patch', verdict: 'approved', patch, report }

  const applied = await gate.applyWithRollback(patch, applyOps)
  if (!applied.applied) {
    const rejected: ValidationReport = {
      ...report,
      verdict: 'rejected',
      failureSummary: applied.error ?? 'gate/install rejected and rolled back',
      validatedAt: new Date().toISOString(),
    }
    return { kind: 'patch', verdict: 'rejected', patch, report: rejected, reason: rejected.failureSummary }
  }
  await deps.onApplied?.({ patch, report, applied })
  return { kind: 'patch', verdict: 'approved', patch, report, applied }
}

/**
 * Adjudicate a frozen loop proposal: local baseline -> builder edits ->
 * sandboxed build -> independent contract evidence -> gate cold install.
 */
export async function adjudicateLoop(
  proposal: Extract<BuilderProposal, { capability: 'loop-evolution' }>,
  deps: LoopAdjudicationDeps,
): Promise<LoopAdjudicationResult> {
  const { root, importer, verifyContract, install } = deps
  const request = proposal.loop
  if (!request || typeof request !== 'object' || typeof request.id !== 'string') {
    throw new Error('loop proposal must contain a loop object')
  }
  let manifest: Awaited<ReturnType<CandidateImporter['acquire']>>
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
    })
  } catch (error) {
    return { kind: 'loop', verdict: 'rejected', candidateId: request.id, reason: `staging failed: ${String(error)}` }
  }

  let verification: { passed: boolean; evidence?: ContractEvidence; reason?: string }
  try {
    verification = await verifyContract(manifest)
  } catch (error) {
    verification = { passed: false, reason: `contract verifier failed: ${String(error)}` }
  }
  if (!verification.passed) {
    const registry = new CandidateRegistry(root)
    recordCandidateVerification(registry, manifest.id, {
      passed: false,
      reason: verification.reason ?? 'independent contract verification failed',
    })
    return {
      kind: 'loop',
      verdict: 'rejected',
      candidateId: manifest.id,
      evidence: verification.evidence,
      reason: verification.reason,
    }
  }

  const registry = new CandidateRegistry(root)
  const approved = recordCandidateVerification(registry, manifest.id, {
    passed: true,
    evidence: verification.evidence,
  })
  if (approved !== 'approved') {
    return { kind: 'loop', verdict: 'rejected', candidateId: manifest.id, evidence: verification.evidence, reason: 'verifier did not approve' }
  }
  if (!install) {
    return { kind: 'loop', verdict: 'approved', candidateId: manifest.id, evidence: verification.evidence }
  }
  const report = await install(manifest.id)
  return {
    kind: 'loop',
    verdict: report.state === 'installed' ? 'approved' : 'rejected',
    candidateId: manifest.id,
    evidence: verification.evidence,
    install: report,
    reason: report.state === 'installed' ? undefined : `gate install: ${report.state}`,
  }
}

/** Dispatch a frozen Builder proposal to its capability-specific adjudicator. */
export async function adjudicate(
  proposal: BuilderProposal,
  deps: PatchAdjudicationDeps & LoopAdjudicationDeps,
): Promise<AdjudicationResult> {
  if (isPatchProposal(proposal)) return adjudicatePatch(proposal, deps)
  return adjudicateLoop(proposal, deps)
}
