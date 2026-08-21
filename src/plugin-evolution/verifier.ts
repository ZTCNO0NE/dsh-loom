import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { diffPluginTrees, hashTarContents, pluginProposalHash, runPluginCommands } from './compiler.js'
import { hashDirectory, hashFile, profileStateHash } from './source.js'
import type {
  PluginEvolutionPlan,
  PluginEvolutionProposal,
  PluginVerificationReport,
  PluginVerifierCheck,
} from './types.js'

const OMIT = new Set(['.git', 'node_modules'])
const FORBIDDEN_ARCHIVE_PATH = /(^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?)$/i

function stable(value: unknown): string { return JSON.stringify(value) }

function sameDiff(left: unknown, right: unknown): boolean { return stable(left) === stable(right) }

function acyclic(graph: Array<{ id: string; dependsOn: string[] }>): boolean {
  const byId = new Map(graph.map((node) => [node.id, node.dependsOn]))
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string): boolean => {
    if (done.has(id)) return true
    if (visiting.has(id)) return false
    visiting.add(id)
    for (const dependency of byId.get(id) ?? []) if (!byId.has(dependency) || !visit(dependency)) return false
    visiting.delete(id); done.add(id)
    return true
  }
  return graph.every((node) => visit(node.id))
}

function copyCleanSource(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => {
      const rel = relative(source, path).split(sep).join('/')
      return !rel.split('/').some((part) => OMIT.has(part))
    },
  })
}

function readCandidateManifest(sourceRoot: string, packageDir: string): { name?: string; version?: string; dsh?: { bundle?: { patch?: string } } } {
  const root = packageDir === '.' ? sourceRoot : join(sourceRoot, packageDir)
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string; dsh?: { bundle?: { patch?: string } } }
}

function archiveContract(tarPath: string, expectedName: string, expectedVersion: string): { passed: boolean; detail: string } {
  const temp = mkdtempSync(join(tmpdir(), 'loom-plugin-verify-tar-'))
  try {
    // hashTarContents performs extraction with the platform tar and rejects symlinks/sensitive paths.
    hashTarContents(tarPath)
    const executable = process.platform === 'win32' ? 'tar.exe' : 'tar'
    const extract = spawnSync(executable, ['-xf', tarPath, '-C', temp], { encoding: 'utf8', windowsHide: true })
    if (extract.error || extract.status !== 0) return { passed: false, detail: extract.error?.message ?? extract.stderr }
    const root = existsSync(join(temp, 'package')) ? join(temp, 'package') : temp
    const manifestPath = join(root, 'package.json')
    if (!existsSync(manifestPath)) return { passed: false, detail: 'tar lacks package.json' }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string; dsh?: { bundle?: { patch?: string } } }
    if (manifest.name !== expectedName || manifest.version !== expectedVersion) return { passed: false, detail: 'tar package identity mismatch' }
    const patch = manifest.dsh?.bundle?.patch
    if (!patch || patch.startsWith('/') || patch.includes('..') || !existsSync(join(root, patch))) return { passed: false, detail: 'tar does not contain its declared dsh.bundle.patch' }
    const visit = (directory: string): string | null => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name)
        const rel = relative(root, path).split(sep).join('/')
        if (FORBIDDEN_ARCHIVE_PATH.test(rel)) return rel
        if (item.isDirectory()) { const found = visit(path); if (found) return found }
      }
      return null
    }
    const forbidden = visit(root)
    return forbidden ? { passed: false, detail: `tar contains forbidden path: ${forbidden}` } : { passed: true, detail: `${expectedName}@${expectedVersion}; patch=${patch}` }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function check(checks: PluginVerifierCheck[], id: string, passed: boolean, detail?: string, targetId?: string): void {
  checks.push({ id, required: true, verdict: passed ? 'passed' : 'rejected', ...(targetId ? { targetId } : {}), ...(detail ? { detail } : {}) })
}

function safeCheck(checks: PluginVerifierCheck[], id: string, operation: () => { passed: boolean; detail?: string }, targetId?: string): void {
  try {
    const result = operation()
    check(checks, id, result.passed, result.detail, targetId)
  } catch (error) {
    check(checks, id, false, String(error), targetId)
  }
}

export interface VerifyPluginEvolutionOptions {
  env?: NodeJS.ProcessEnv
  maxChangedFiles?: number
  maxChangedBytes?: number
}

export function verifyPluginEvolution(
  plan: PluginEvolutionPlan,
  proposal: PluginEvolutionProposal,
  options: VerifyPluginEvolutionOptions = {},
): PluginVerificationReport {
  const checks: PluginVerifierCheck[] = []
  const proposalHash = pluginProposalHash(proposal)
  check(checks, 'proposal-plan-binding', proposal.capability === 'plugin-evolution' && proposal.planId === plan.id && proposal.profile === plan.profile, `plan=${proposal.planId}`)
  check(checks, 'bounded-targets', proposal.targets.length >= 1 && proposal.targets.length <= 3 && proposal.targets.length === plan.targets.length, `${proposal.targets.length}/3`)
  check(checks, 'composition-graph', sameDiff(proposal.graph, plan.targets.map((target) => ({ id: target.id, dependsOn: target.dependsOn }))) && acyclic(proposal.graph))
  safeCheck(checks, 'profile-before-unchanged', () => {
    const state = profileStateHash(plan.profileDir)
    return {
      passed: plan.targets.every((target) => target.installed.profileManifestHash === state.manifestHash && target.installed.profileLockHash === state.lockHash),
      detail: state.hash,
    }
  })

  for (const target of plan.targets) {
    const candidate = proposal.targets.find((item) => item.targetId === target.id)
    if (!candidate) {
      check(checks, 'target-present', false, 'proposal target missing', target.id)
      continue
    }
    safeCheck(checks, 'source-provenance', () => ({
      passed: candidate.packageName === target.packageName
        && candidate.version === target.installed.version
        && candidate.sourceBeforeHash === target.source.treeHash
        && hashDirectory(target.source.snapshotPath) === target.source.treeHash
        && (!target.source.registryIntegrity
          || (target.source.registryVersion === target.installed.version
            && existsSync(join(plan.profileDir, 'pnpm-lock.yaml'))
            && readFileSync(join(plan.profileDir, 'pnpm-lock.yaml'), 'utf8').includes(target.source.registryIntegrity))),
    }), target.id)
    let afterHash = 'missing'
    safeCheck(checks, 'candidate-hash', () => {
      afterHash = existsSync(candidate.workspacePath) ? hashDirectory(candidate.workspacePath) : 'missing'
      return { passed: afterHash === candidate.sourceAfterHash, detail: afterHash }
    }, target.id)
    let actualDiff = [] as ReturnType<typeof diffPluginTrees>
    try { actualDiff = diffPluginTrees(target.source.snapshotPath, candidate.workspacePath) } catch (error) {
      check(checks, 'diff-policy', false, String(error), target.id)
    }
    const changedBytes = actualDiff.reduce((total, item) => total + (item.size ?? 0), 0)
    check(checks, 'diff-policy', sameDiff(actualDiff, candidate.diff) && actualDiff.length > 0 && actualDiff.length <= (options.maxChangedFiles ?? 128) && changedBytes <= (options.maxChangedBytes ?? 4 * 1024 * 1024), `${actualDiff.length} files; ${changedBytes} bytes`, target.id)
    safeCheck(checks, 'artifact-integrity', () => ({
      passed: existsSync(candidate.tarPath) && hashFile(candidate.tarPath) === candidate.tarHash && hashTarContents(candidate.tarPath) === candidate.tarContentHash,
    }), target.id)
    safeCheck(checks, 'package-contract', () => archiveContract(candidate.tarPath, target.packageName, target.installed.version), target.id)

    const clean = mkdtempSync(join(tmpdir(), `loom-plugin-verify-${target.id}-`))
    try {
      const source = join(clean, 'source')
      copyCleanSource(candidate.workspacePath, source)
      const manifest = readCandidateManifest(source, target.source.packageDir)
      check(checks, 'clean-source-identity', manifest.name === target.packageName && manifest.version === target.installed.version, undefined, target.id)
      const commandEvidence = [
        ...runPluginCommands(source, target.source.packageDir, 'prepare', target.prepareCommands, options.env),
        ...runPluginCommands(source, target.source.packageDir, 'build', target.buildCommands, options.env),
        ...runPluginCommands(source, target.source.packageDir, 'test', target.testCommands, options.env),
      ]
      check(checks, 'independent-build-test', commandEvidence.every((item) => item.exitCode === 0) && commandEvidence.length > 0, `${commandEvidence.length} commands`, target.id)
    } catch (error) {
      check(checks, 'independent-build-test', false, String(error), target.id)
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
  }
  const failed = checks.filter((item) => item.verdict !== 'passed')
  return {
    schemaVersion: 1,
    proposalId: proposal.id,
    proposalHash,
    verdict: failed.length === 0 ? 'approved' : 'rejected',
    checks,
    ...(failed.length ? { failureSummary: failed.map((item) => `${item.targetId ? `${item.targetId}:` : ''}${item.id}`).join(', ') } : {}),
    verifiedAt: new Date().toISOString(),
  }
}
