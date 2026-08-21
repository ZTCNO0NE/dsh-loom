export type PluginSourceKind = 'local' | 'managed' | 'git'

export interface PluginSourceRequest {
  kind: PluginSourceKind
  /** Local checkout/managed snapshot path, or a Git repository URL. */
  location: string
  /** Required for Git and optional as an additional pin for local/managed sources. */
  commit?: string
  /** Required for managed sources; optional for user-attested local sources. */
  expectedTreeHash?: string
  /** User explicitly selected a checkout; Loom metadata is host-governed. */
  attestedBy: 'user' | 'loom'
  /** Host-resolved npm provenance; never accepted from ordinary Actor input. */
  registryVersion?: string
  registryIntegrity?: string
}

export interface PluginCommand {
  command: string
  args: string[]
  /** Relative to the target source root; defaults to its packageDir. */
  cwd?: string
  timeoutMs?: number
}

export interface InstalledPluginIdentity {
  packageName: string
  version: string
  dependencySpec: string
  packagePath: string
  artifactHash: string
  profileManifestHash: string
  profileLockHash: string | null
  gitHead?: string
}

export interface FrozenPluginSource {
  kind: PluginSourceKind
  location: string
  commit?: string
  attestedBy: 'user' | 'loom'
  snapshotPath: string
  treeHash: string
  packageDir: string
  registryVersion?: string
  registryIntegrity?: string
}

export interface PluginEvolutionTargetPlan {
  id: string
  dependsOn: string[]
  packageName: string
  installed: InstalledPluginIdentity
  source: FrozenPluginSource
  prepareCommands: PluginCommand[]
  buildCommands: PluginCommand[]
  testCommands: PluginCommand[]
}

export interface PluginEvolutionPlan {
  schemaVersion: 1
  capability: 'plugin-evolution'
  id: string
  createdAt: string
  profile: string
  profileDir: string
  requirements: string
  expectedOutcome: string
  targets: PluginEvolutionTargetPlan[]
  integrationCommand?: PluginCommand
  state: 'planned' | 'implementing' | 'verifying' | 'ready_to_activate' | 'completed' | 'rejected' | 'aborted' | 'cancelled'
  execution?: { runId: string; at: string }
  transactionId?: string
  result?: PluginEvolutionResult
}

export interface PluginDiffEntry {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  beforeHash?: string
  afterHash?: string
  size?: number
}

export interface PluginCommandEvidence {
  phase: 'prepare' | 'build' | 'test'
  command: string
  args: string[]
  exitCode: number
  outputTail: string
  durationMs: number
}

export interface PluginCandidateArtifact {
  targetId: string
  packageName: string
  version: string
  sourceBeforeHash: string
  sourceAfterHash: string
  workspacePath: string
  diff: PluginDiffEntry[]
  commandEvidence: PluginCommandEvidence[]
  tarPath: string
  tarHash: string
  tarContentHash: string
}

export interface PluginEvolutionProposal {
  schemaVersion: 1
  capability: 'plugin-evolution'
  id: string
  planId: string
  profile: string
  expectedOutcome: string
  targets: PluginCandidateArtifact[]
  graph: Array<{ id: string; dependsOn: string[] }>
  createdAt: string
}

export interface PluginVerifierCheck {
  id: string
  targetId?: string
  required: true
  verdict: 'passed' | 'rejected' | 'error' | 'not_run'
  detail?: string
}

export interface PluginVerificationReport {
  schemaVersion: 1
  proposalId: string
  proposalHash: string
  verdict: 'approved' | 'rejected'
  checks: PluginVerifierCheck[]
  failureSummary?: string
  verifiedAt: string
}

export interface PluginEvolutionResult {
  verdict: 'approved' | 'rejected' | 'aborted'
  applied: boolean
  effective: boolean
  restartRequired: boolean
  summary: string
  limitations: string[]
}

export type PluginLifecycleOperation = 'install' | 'update' | 'remove'

export interface FrozenPluginDependency {
  packageName: string
  version?: string
  /** Exact registry package@version or a hash-bound absolute local tar spec. */
  dependencySpec?: string
  integrity?: string
  tarPath?: string
  tarHash?: string
}

export interface PluginLifecyclePlan {
  schemaVersion: 1
  capability: 'plugin-lifecycle'
  id: string
  createdAt: string
  profile: string
  profileDir: string
  operation: PluginLifecycleOperation
  packageName: string
  requestedSpec?: string
  beforeProfileHash: string
  beforeDependencySpec?: string
  frozen?: FrozenPluginDependency
  state: 'planned' | 'ready_to_activate' | 'completed' | 'rejected' | 'cancelled'
  transactionId?: string
  result?: PluginEvolutionResult
}

export interface ProfileFileSnapshot {
  relativePath: string
  exists: boolean
  contentBase64?: string
  hash?: string
}

export interface PluginTransactionRecord {
  schemaVersion: 1
  id: string
  kind: 'install' | 'lifecycle' | 'restore'
  sourceTransactionId?: string
  planId: string
  proposalHash: string
  profile: string
  profileDir: string
  dshHome: string
  dshCommand: string[]
  dshCwd: string
  pnpmCommand: string
  coldBootCommand: string[]
  /** Exact host-owned cwd allowed for the independent integration probe. */
  integrationCwd?: string
  state: 'preparing' | 'ready_to_activate' | 'activating' | 'completed' | 'cancelled' | 'failed' | 'rolled_back'
  createdAt: string
  updatedAt: string
  beforeProfileHash: string
  beforeFiles: ProfileFileSnapshot[]
  /** Restore transactions apply these exact files before reinstalling dependencies. */
  desiredFiles?: ProfileFileSnapshot[]
  artifacts: Array<{ packageName: string; version: string; tarPath: string; tarHash: string }>
  lifecycle?: {
    operation: PluginLifecycleOperation
    packageName: string
    dependencySpec?: string
    version?: string
    integrity?: string
  }
  integrationCommand?: PluginCommand
  shadowHome?: string
  verification?: PluginVerificationReport
  activation?: {
    activatedAt: string
    profileHash: string
    loaderPassed: boolean
    integrationPassed: boolean
  }
  error?: string
  rollback?: { attempted: boolean; succeeded: boolean; error?: string }
}
