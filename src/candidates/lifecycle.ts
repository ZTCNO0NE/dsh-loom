import {
  CandidateRegistry,
  coldInstallCandidate,
  type ContractEvidence,
  type LoopInstallOps,
  type LoopInstallReport,
} from './index.js'

export interface CandidateVerificationResult {
  passed: boolean
  evidence?: ContractEvidence
  reason?: string
}

/**
 * Verifier-owned state advancement. A builder receives no registry capability;
 * it can only leave a `staging` manifest for this controller to examine.
 */
export function recordCandidateVerification(
  registry: CandidateRegistry,
  candidateId: string,
  result: CandidateVerificationResult,
): 'approved' | 'rejected' {
  const current = registry.get(candidateId)
  if (!current) throw new Error(`unknown candidate: ${candidateId}`)
  if (current.state !== 'staging' && current.state !== 'pending') {
    throw new Error(`candidate is not ready for verification: ${current.state}`)
  }
  if (result.passed && (!result.evidence?.contractReport || !result.evidence.regressionReport)) {
    throw new Error('passing candidate verification requires complete contract evidence')
  }
  if (current.state === 'staging') registry.transition(candidateId, 'pending', 'submitted to independent verifier')
  if (!result.passed) {
    registry.transition(candidateId, 'rejected', result.reason ?? 'independent contract verification failed')
    return 'rejected'
  }
  registry.transition(candidateId, 'verified', undefined, result.evidence)
  registry.transition(candidateId, 'approved', 'independent verifier approved')
  return 'approved'
}

/** Gate-only final act. This wrapper intentionally has no builder argument. */
export async function installVerifiedCandidate(
  registry: CandidateRegistry,
  candidateId: string,
  ops: LoopInstallOps,
): Promise<LoopInstallReport> {
  const record = registry.get(candidateId)
  if (!record || record.state !== 'approved') throw new Error(`candidate is not gate-approved: ${candidateId}`)
  return coldInstallCandidate(registry, candidateId, ops)
}
