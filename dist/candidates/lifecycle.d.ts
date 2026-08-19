import { CandidateRegistry, type ContractEvidence, type LoopInstallOps, type LoopInstallReport } from './index.js';
export interface CandidateVerificationResult {
    passed: boolean;
    evidence?: ContractEvidence;
    reason?: string;
}
/**
 * Verifier-owned state advancement. A builder receives no registry capability;
 * it can only leave a `staging` manifest for this controller to examine.
 */
export declare function recordCandidateVerification(registry: CandidateRegistry, candidateId: string, result: CandidateVerificationResult): 'approved' | 'rejected';
/** Gate-only final act. This wrapper intentionally has no builder argument. */
export declare function installVerifiedCandidate(registry: CandidateRegistry, candidateId: string, ops: LoopInstallOps): Promise<LoopInstallReport>;
export interface InstalledCandidateRollbackOps {
    snapshot(): Record<string, unknown>;
    rollback(manifest: Parameters<LoopInstallOps['install']>[0]): void | Promise<void>;
}
/** Gate-owned removal of a previously installed cold profile. */
export declare function rollbackInstalledCandidate(registry: CandidateRegistry, candidateId: string, ops: InstalledCandidateRollbackOps): Promise<LoopInstallReport>;
