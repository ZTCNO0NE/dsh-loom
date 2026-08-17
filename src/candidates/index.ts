import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { atomicWriteJson, readJson } from '../protocol/index.js'

/** A loop candidate is never an ordinary MetaPatch: it has its own supply-chain state machine. */
export type CandidateState = 'staging' | 'pending' | 'verified' | 'approved' | 'installed' | 'rejected'

export interface CandidateSource {
  kind: 'vendored' | 'git' | 'builder-generated'
  /** Immutable source identity: a Git URL, or `vendored/<id>` for a seed. */
  uri: string
  ref: string
  commit?: string
  contentHash: string
  /** Present only for a generated candidate; records the deterministic edit plan without source text. */
  generated?: {
    baselineUri: string
    baselineRef: string
    editPlanHash: string
    edits: Array<{ path: string; beforeHash: string; afterHash: string }>
  }
}

export interface BuilderGeneratedEdit {
  /** Repository-relative path. Core accepts only agent-loop source files. */
  path: string
  /** Exact SHA-256 of the baseline file before this edit. */
  beforeHash: string
  /** Complete replacement file content; never interpreted as shell text. */
  after: string
}

export interface BuilderGeneratedSourceRequest {
  kind: 'builder-generated'
  baseline: { uri: string; ref: string }
  edits: BuilderGeneratedEdit[]
}

export type CandidateSourceRequest =
  | { uri: string; ref: string; kind?: 'git' }
  | BuilderGeneratedSourceRequest

/** Build recipe selected from a small core-controlled allowlist, never shell text from the builder. */
export interface CandidateBuildRecord {
  method: 'prebuilt' | 'sandboxed-dsh-workspace'
  command: string
}

export interface CandidateManifest {
  schemaVersion: 1
  id: string
  displayName: string
  targetId: 'agent-loop'
  packageName: string
  /** Project-relative source directory. Gate resolves it; builder never supplies a live absolute path. */
  artifactPath: string
  entry: string
  build: CandidateBuildRecord
  source: CandidateSource
  config: Record<string, unknown>
  expectedOutcome: string
  capabilities: string[]
  createdAt: string
  createdBy: 'seed' | 'builder'
}

export interface ContractEvidence {
  contractReport: string
  regressionReport: string
  installReport?: string
  verifiedAt: string
}

export interface CandidateRecord {
  manifest: CandidateManifest
  state: CandidateState
  updatedAt: string
  evidence?: ContractEvidence
  reason?: string
}

export interface CandidateRegistryFile {
  schemaVersion: 1
  candidates: Record<string, CandidateRecord>
}

export interface LoopInstallReport {
  schemaVersion: 1
  candidateId: string
  state: 'installed' | 'rolled_back' | 'rejected'
  before: Record<string, unknown>
  after: Record<string, unknown>
  smoke: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail?: string }> }
  rollback?: { attempted: boolean; succeeded: boolean; error?: string }
  createdAt: string
}

const TRANSITIONS: Record<CandidateState, CandidateState[]> = {
  staging: ['pending', 'rejected'],
  pending: ['verified', 'rejected'],
  verified: ['approved', 'rejected'],
  approved: ['installed', 'rejected'],
  installed: ['approved', 'rejected'],
  rejected: [],
}

export function candidatePaths(root: string) {
  const base = join(root, 'candidates')
  return {
    base,
    registry: join(base, 'registry.json'),
    install: (id: string) => join(base, 'installations', `${id}.json`),
  }
}

export function hashDirectory(directory: string): string {
  const root = resolve(directory)
  if (!existsSync(root)) throw new Error(`candidate artifact not found: ${root}`)
  const digest = createHash('sha256')
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const rel = relative(root, path).split(sep).join('/')
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`candidate artifact contains symlink: ${rel}`)
      if (stat.isDirectory()) {
        digest.update(`dir:${rel}\n`)
        visit(path)
      } else if (stat.isFile()) {
        digest.update(`file:${rel}\0`)
        digest.update(readFileSync(path))
      }
    }
  }
  visit(root)
  return digest.digest('hex')
}

function emptyRegistry(): CandidateRegistryFile {
  return { schemaVersion: 1, candidates: {} }
}

/**
 * Persistent candidate registry. Builder may create staging/pending records;
 * only verifier/gate callers may advance the record beyond pending.
 */
export class CandidateRegistry {
  constructor(private readonly root: string) {}

  list(): CandidateRegistryFile {
    return readJson<CandidateRegistryFile>(candidatePaths(this.root).registry) ?? emptyRegistry()
  }

  get(id: string): CandidateRecord | null {
    return this.list().candidates[id] ?? null
  }

  stage(manifest: CandidateManifest): CandidateRecord {
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(manifest.id)) {
      throw new Error('candidate id must be 3-64 lowercase alphanumeric/hyphen characters')
    }
    if (manifest.targetId !== 'agent-loop') throw new Error('loop candidates may only target agent-loop')
    if (manifest.createdBy !== 'seed' && manifest.createdBy !== 'builder') throw new Error('invalid candidate creator')
    const registry = this.list()
    if (registry.candidates[manifest.id]) throw new Error(`candidate already exists: ${manifest.id}`)
    const record: CandidateRecord = { manifest, state: 'staging', updatedAt: new Date().toISOString() }
    registry.candidates[manifest.id] = record
    this.write(registry)
    return record
  }

  transition(id: string, state: CandidateState, reason?: string, evidence?: ContractEvidence): CandidateRecord {
    const registry = this.list()
    const record = registry.candidates[id]
    if (!record) throw new Error(`unknown candidate: ${id}`)
    if (!TRANSITIONS[record.state].includes(state)) {
      throw new Error(`invalid candidate transition: ${record.state} -> ${state}`)
    }
    if (state === 'verified' && (!evidence?.contractReport || !evidence.regressionReport)) {
      throw new Error('verified candidate requires contract and regression reports')
    }
    if (state === 'approved' && !record.evidence) {
      throw new Error('approved candidate requires prior verifier evidence')
    }
    record.state = state
    record.updatedAt = new Date().toISOString()
    if (reason) record.reason = reason
    if (evidence) record.evidence = evidence
    this.write(registry)
    return record
  }

  recordInstall(report: LoopInstallReport): void {
    const registry = this.list()
    const record = registry.candidates[report.candidateId]
    if (!record) throw new Error(`unknown candidate: ${report.candidateId}`)
    if (record.state !== 'approved') throw new Error(`candidate must be approved before install: ${record.state}`)
    atomicWriteJson(candidatePaths(this.root).install(report.candidateId), report)
    if (report.state === 'installed') {
      record.state = 'installed'
      record.updatedAt = report.createdAt
      if (record.evidence) record.evidence.installReport = candidatePaths(this.root).install(report.candidateId)
      this.write(registry)
    }
  }

  private write(registry: CandidateRegistryFile): void {
    atomicWriteJson(candidatePaths(this.root).registry, registry)
  }
}

export interface CandidateAcquisitionRequest {
  id: string
  displayName: string
  /** A builder's requested Git revision. It is an input to the importer, never a trusted manifest. */
  source: CandidateSourceRequest
  packageName: string
  /** Package root within a Git repository; defaults to the repository root. */
  packagePath?: string
  entry: string
  build: { method: CandidateBuildRecord['method'] }
  config: Record<string, unknown>
  expectedOutcome: string
  capabilities: string[]
}

export interface CandidateImporterOptions {
  /** Runtime-owned meta workspace, never the repository's vendored source tree. */
  root: string
  allowedGitHosts: string[]
  /** Read-only dependency root for the audited sandbox build recipe. Empty disables source builds. */
  buildDependencyRoot?: string
}

function githubRepository(uri: string): { owner: string; repository: string } | null {
  const parsed = new URL(uri)
  if (parsed.hostname !== 'github.com') return null
  const segments = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
  if (segments.length !== 2 || !segments.every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment))) return null
  return { owner: segments[0], repository: segments[1] }
}

function githubArchive(target: string, source: { uri: string; ref: string }): string {
  const repository = githubRepository(source.uri)
  if (!repository) throw new Error(`not a supported GitHub source: ${source.uri}`)
  const revision = JSON.parse(execFileSync('curl', [
    '--fail', '--silent', '--show-error', '--location', '--max-time', '20',
    `https://api.github.com/repos/${repository.owner}/${repository.repository}/commits/${encodeURIComponent(source.ref)}`,
  ], { encoding: 'utf8', timeout: 25_000 })) as { sha?: unknown }
  if (typeof revision.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(revision.sha)) {
    throw new Error('GitHub did not return a resolved commit')
  }
  if (/^[0-9a-f]{40}$/i.test(source.ref) && revision.sha.toLowerCase() !== source.ref.toLowerCase()) {
    throw new Error('GitHub resolved a different commit than the requested pin')
  }
  const archive = `${target}.tar.gz`
  mkdirSync(target, { recursive: true })
  try {
    execFileSync('curl', [
      '--fail', '--silent', '--show-error', '--location', '--max-time', '120', '--output', archive,
      `https://codeload.github.com/${repository.owner}/${repository.repository}/tar.gz/${revision.sha}`,
    ], { stdio: 'pipe', timeout: 125_000 })
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '--no-same-owner', '--no-same-permissions', '-C', target], {
      stdio: 'pipe', timeout: 120_000,
    })
  } finally {
    rmSync(archive, { force: true })
  }
  return revision.sha
}

const GENERATED_BASELINE_URI = 'https://github.com/deepseek-ai/deepseek-harness.git'
const GENERATED_PACKAGE_PATH = 'packages/core/agent-loop'
const GENERATED_PACKAGE_NAME = '@deepseek-ai/dsh-agent-loop'
const GENERATED_PATH_PREFIX = `${GENERATED_PACKAGE_PATH}/src/`
const GENERATED_MAX_EDITS = 4
const GENERATED_MAX_FILE_BYTES = 48_000
const GENERATED_MAX_TOTAL_BYTES = 96_000

function textHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isBuilderGeneratedSource(source: CandidateSourceRequest): source is BuilderGeneratedSourceRequest {
  return 'kind' in source && source.kind === 'builder-generated'
}

/**
 * Apply the only self-authored loop change allowed by the importer. The
 * builder supplies an exact before hash and a complete replacement file; the
 * core validates path, size, count, and baseline bytes before writing. This is
 * intentionally exported for deterministic unit tests and verifier tooling.
 */
export function applyBuilderGeneratedEdits(repositoryRoot: string, source: BuilderGeneratedSourceRequest): Array<{ path: string; beforeHash: string; afterHash: string }> {
  if (!Array.isArray(source.edits) || source.edits.length < 1 || source.edits.length > GENERATED_MAX_EDITS) {
    throw new Error(`builder-generated edit count must be 1-${GENERATED_MAX_EDITS}`)
  }
  const seen = new Set<string>()
  let totalBytes = 0
  const summary: Array<{ path: string; beforeHash: string; afterHash: string }> = []
  for (const edit of source.edits) {
    if (!edit || typeof edit.path !== 'string' || typeof edit.beforeHash !== 'string' || typeof edit.after !== 'string') {
      throw new Error('builder-generated edit requires path, beforeHash, and after')
    }
    if (!edit.path.startsWith(GENERATED_PATH_PREFIX) || edit.path.includes('..') || !/^[A-Za-z0-9._/-]+\.tsx?$/.test(edit.path)) {
      throw new Error(`builder-generated edit path is outside the agent-loop source allowlist: ${edit.path}`)
    }
    if (seen.has(edit.path)) throw new Error(`builder-generated edit path is duplicated: ${edit.path}`)
    seen.add(edit.path)
    if (!/^[0-9a-f]{64}$/i.test(edit.beforeHash)) throw new Error(`invalid beforeHash for generated edit: ${edit.path}`)
    const file = resolve(repositoryRoot, edit.path)
    if (!file.startsWith(`${resolve(repositoryRoot)}${sep}`) || !existsSync(file) || !lstatSync(file).isFile()) {
      throw new Error(`builder-generated edit target is unavailable: ${edit.path}`)
    }
    const before = readFileSync(file, 'utf8')
    if (textHash(before) !== edit.beforeHash.toLowerCase()) throw new Error(`builder-generated beforeHash mismatch: ${edit.path}`)
    const bytes = Buffer.byteLength(edit.after, 'utf8')
    if (bytes === 0 || bytes > GENERATED_MAX_FILE_BYTES) throw new Error(`builder-generated replacement is too large or empty: ${edit.path}`)
    totalBytes += bytes
    if (totalBytes > GENERATED_MAX_TOTAL_BYTES) throw new Error('builder-generated replacement budget exceeded')
    writeFileSync(file, edit.after, { encoding: 'utf8', mode: 0o644 })
    summary.push({ path: edit.path, beforeHash: edit.beforeHash.toLowerCase(), afterHash: textHash(edit.after) })
  }
  return summary
}

/**
 * The only networked candidate path. It deliberately writes a content-addressed
 * staging directory and a `staging` record, never `approved` or project `vendored/`.
 */
export class CandidateImporter {
  constructor(private readonly options: CandidateImporterOptions) {}

  acquire(request: CandidateAcquisitionRequest): CandidateManifest {
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(request.id)) throw new Error('invalid candidate id')
    const generatedSource = isBuilderGeneratedSource(request.source) ? request.source : undefined
    const generated = generatedSource !== undefined
    const networkSource: { uri: string; ref: string } = generatedSource
      ? generatedSource.baseline
      : request.source as { uri: string; ref: string }
    const parsed = new URL(networkSource.uri)
    if (parsed.protocol !== 'https:' || !this.options.allowedGitHosts.includes(parsed.hostname)) {
      throw new Error(`candidate source is not allowed: ${networkSource.uri}`)
    }
    if (!/^[A-Za-z0-9._/@-]{1,160}$/.test(networkSource.ref)) throw new Error('invalid candidate ref')
    if (generated) {
      if (networkSource.uri !== GENERATED_BASELINE_URI || !/^[0-9a-f]{40}$/i.test(networkSource.ref)) {
        throw new Error('builder-generated source must use the pinned audited DSH baseline commit')
      }
      if (request.packagePath !== GENERATED_PACKAGE_PATH || request.packageName !== GENERATED_PACKAGE_NAME) {
        throw new Error('builder-generated candidate must target the audited DSH agent-loop package')
      }
      if (request.build?.method !== 'sandboxed-dsh-workspace') {
        throw new Error('builder-generated candidate must use the audited networkless build recipe')
      }
    }
    if (request.build?.method !== 'prebuilt' && request.build?.method !== 'sandboxed-dsh-workspace') {
      throw new Error('candidate build method is not allowed')
    }
    if (request.packagePath !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(request.packagePath)
      || request.packagePath.split('/').includes('..'))) {
      throw new Error('invalid candidate packagePath')
    }
    const target = join(candidatePaths(this.options.root).base, 'staging', request.id)
    if (existsSync(target)) throw new Error(`staging directory already exists: ${request.id}`)
    mkdirSync(join(candidatePaths(this.options.root).base, 'staging'), { recursive: true })
    try {
      const github = githubRepository(networkSource.uri)
      let commit: string
      if (github) {
        commit = githubArchive(target, networkSource)
      } else {
        execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', networkSource.ref, networkSource.uri, target], {
          stdio: 'pipe', timeout: 120_000,
        })
        if (request.packagePath) {
          execFileSync('git', ['-C', target, 'sparse-checkout', 'set', '--no-cone', request.packagePath], {
            stdio: 'pipe', timeout: 10_000,
          })
        }
        execFileSync('git', ['-C', target, 'checkout', '--detach'], { stdio: 'pipe', timeout: 120_000 })
        commit = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim()
      }
      const generatedEdits = generatedSource ? applyBuilderGeneratedEdits(target, generatedSource) : undefined
      const artifactPath = resolve(target, request.packagePath ?? '.')
      if (!artifactPath.startsWith(`${resolve(target)}${sep}`) && artifactPath !== resolve(target)) {
        throw new Error('candidate packagePath escapes cloned repository')
      }
      if (!existsSync(join(artifactPath, 'package.json'))) throw new Error('candidate packagePath has no package.json')
      const build = this.buildArtifact(target, artifactPath, request)
      if (!existsSync(join(artifactPath, request.entry))) throw new Error(`candidate build did not produce entry: ${request.entry}`)
      const manifest: CandidateManifest = {
        schemaVersion: 1,
        id: request.id,
        displayName: request.displayName,
        targetId: 'agent-loop',
        packageName: request.packageName,
        artifactPath,
        entry: request.entry,
        build,
        source: {
          kind: generated ? 'builder-generated' : 'git', uri: networkSource.uri, ref: networkSource.ref, commit, contentHash: hashDirectory(artifactPath),
          ...(generated && generatedEdits ? {
            generated: {
              baselineUri: networkSource.uri,
              baselineRef: networkSource.ref,
              editPlanHash: textHash(JSON.stringify(generatedSource.edits)),
              edits: generatedEdits,
            },
          } : {}),
        },
        config: request.config,
        expectedOutcome: request.expectedOutcome,
        capabilities: request.capabilities,
        createdAt: new Date().toISOString(),
        createdBy: 'builder',
      }
      new CandidateRegistry(this.options.root).stage(manifest)
      return manifest
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      throw error
    }
  }

  /**
   * Build only a known DSH workspace recipe in a networkless bubblewrap
   * namespace. Builder text never becomes a command, and no host path other
   * than the read-only dependency store is visible to candidate build code.
   */
  private buildArtifact(repositoryRoot: string, artifactPath: string, request: CandidateAcquisitionRequest): CandidateBuildRecord {
    if (request.build.method === 'prebuilt') return { method: 'prebuilt', command: 'entry pre-exists; no build executed' }
    const sourceUri = isBuilderGeneratedSource(request.source) ? request.source.baseline.uri : request.source.uri
    if (sourceUri !== GENERATED_BASELINE_URI
      || request.packagePath !== GENERATED_PACKAGE_PATH
      || request.packageName !== GENERATED_PACKAGE_NAME) {
      throw new Error('sandboxed-dsh-workspace build is restricted to the audited DSH agent-loop package')
    }
    const packageJson = JSON.parse(readFileSync(join(artifactPath, 'package.json'), 'utf8')) as { name?: unknown }
    if (packageJson.name !== request.packageName || !existsSync(join(repositoryRoot, 'pnpm-workspace.yaml'))) {
      throw new Error('sandboxed DSH build workspace identity check failed')
    }
    const dependencyStore = this.options.buildDependencyRoot ? resolve(this.options.buildDependencyRoot) : ''
    if (!existsSync(dependencyStore)) throw new Error('audited DSH dependency store is unavailable')
    const dependencyWorkspace = dirname(dependencyStore)
    const command = 'node_modules/.bin/tsc -b packages/core/agent-loop && cd packages/core/agent-loop && /workspace/node_modules/.bin/tsdown'
    try {
      execFileSync('bwrap', [
        '--die-with-parent', '--new-session', '--unshare-all',
        '--ro-bind', '/usr', '/usr', '--ro-bind', '/usr/local', '/usr/local', '--symlink', 'usr/bin', '/bin',
        '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--ro-bind', dependencyWorkspace, dependencyWorkspace,
      '--bind', repositoryRoot, '/workspace', '--ro-bind', dependencyStore, '/workspace/node_modules',
      '--ro-bind', join(dependencyWorkspace, 'vendor'), '/workspace/vendor',
        '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/workspace/node_modules/.bin:/usr/local/bin:/usr/bin',
        '--', '/usr/bin/sh', '-c', `cd /workspace && ${command}`,
      ], { stdio: 'pipe', timeout: 300_000 })
    } catch (error) {
      const detail = error as { stderr?: Buffer; stdout?: Buffer; message?: string }
      const output = `${detail.stdout?.toString() ?? ''}\n${detail.stderr?.toString() ?? ''}`.trim().slice(-4000)
      throw new Error(`sandboxed DSH build failed${output ? `: ${output}` : `: ${detail.message ?? String(error)}`}`)
    }
    return { method: 'sandboxed-dsh-workspace', command: `bwrap --unshare-all --unshare-net: ${command}` }
  }

  /** Gate-only promotion after verifier approval; copies a hash-pinned staging artifact. */
  promoteApproved(candidateId: string): string {
    const registry = new CandidateRegistry(this.options.root)
    const record = registry.get(candidateId)
    if (!record || record.state !== 'approved') throw new Error(`candidate is not approved: ${candidateId}`)
    const source = record.manifest.artifactPath
    if (hashDirectory(source) !== record.manifest.source.contentHash) throw new Error('candidate staging artifact hash changed')
    const target = join(candidatePaths(this.options.root).base, 'vendored', candidateId)
    if (existsSync(target)) throw new Error(`runtime vendored candidate already exists: ${candidateId}`)
    mkdirSync(join(candidatePaths(this.options.root).base, 'vendored'), { recursive: true })
    cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true })
    if (hashDirectory(target) !== record.manifest.source.contentHash) {
      rmSync(target, { recursive: true, force: true })
      throw new Error('candidate promotion hash mismatch')
    }
    return target
  }
}

export interface LoopInstallOps {
  snapshot(): Record<string, unknown>
  install(manifest: CandidateManifest): void | Promise<void>
  smoke(manifest: CandidateManifest): { passed: boolean; checks: Array<{ name: string; passed: boolean; detail?: string }> } | Promise<{ passed: boolean; checks: Array<{ name: string; passed: boolean; detail?: string }> }>
  rollback(before: Record<string, unknown>, manifest: CandidateManifest): void | Promise<void>
}

/** Gate-owned cold replacement. It deliberately accepts only an approved candidate record. */
export async function coldInstallCandidate(
  registry: CandidateRegistry,
  candidateId: string,
  ops: LoopInstallOps,
): Promise<LoopInstallReport> {
  const record = registry.get(candidateId)
  if (!record) throw new Error(`unknown candidate: ${candidateId}`)
  if (record.state !== 'approved') throw new Error(`candidate is not approved: ${record.state}`)
  const before = ops.snapshot()
  try {
    await ops.install(record.manifest)
  } catch (error) {
    const report: LoopInstallReport = {
      schemaVersion: 1, candidateId, state: 'rejected', before, after: before,
      smoke: { passed: false, checks: [{ name: 'install', passed: false, detail: String(error) }] },
      createdAt: new Date().toISOString(),
    }
    registry.recordInstall(report)
    return report
  }
  const smoke = await ops.smoke(record.manifest)
  if (!smoke.passed) {
    let rollback: LoopInstallReport['rollback'] = { attempted: true, succeeded: false }
    try {
      await ops.rollback(before, record.manifest)
      rollback = { attempted: true, succeeded: true }
    } catch (error) {
      rollback = { attempted: true, succeeded: false, error: String(error) }
    }
    const report: LoopInstallReport = {
      schemaVersion: 1, candidateId, state: 'rolled_back', before, after: before, smoke, rollback,
      createdAt: new Date().toISOString(),
    }
    registry.recordInstall(report)
    return report
  }
  const report: LoopInstallReport = {
    schemaVersion: 1, candidateId, state: 'installed', before, after: ops.snapshot(), smoke,
    createdAt: new Date().toISOString(),
  }
  registry.recordInstall(report)
  return report
}
