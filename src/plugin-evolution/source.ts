import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  FrozenPluginSource,
  InstalledPluginIdentity,
  PluginEvolutionTargetPlan,
  PluginSourceRequest,
} from './types.js'

const PROTECTED_PACKAGES = new Set([
  'dsh-loom',
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-agent-loop-candidate',
  '@deepseek-ai/dsh-agent-loop-testkit',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-credentials-local',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
])
const OMIT_DIRECTORIES = new Set(['.git', 'node_modules'])
const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?)$/i

export interface PluginTargetRequest {
  id: string
  packageName: string
  dependsOn?: string[]
  source: PluginSourceRequest
  packageDir?: string
  prepareCommands?: PluginEvolutionTargetPlan['prepareCommands']
  buildCommands?: PluginEvolutionTargetPlan['buildCommands']
  testCommands?: PluginEvolutionTargetPlan['testCommands']
}

export interface FreezePluginTargetsOptions {
  planRoot: string
  profileDir: string
  requests: PluginTargetRequest[]
  gitCommand?: string
  curlCommand?: string
  tarCommand?: string
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function safeRelativePath(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`${label} must be a bounded relative path`)
  }
  return normalized
}

export function assertEvolvablePluginName(packageName: string): void {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) throw new Error(`invalid plugin package name: ${packageName}`)
  if (PROTECTED_PACKAGES.has(packageName)) throw new Error(`protected package cannot be evolved: ${packageName}`)
}

export function isProtectedPluginName(packageName: string): boolean { return PROTECTED_PACKAGES.has(packageName) }

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function hashDirectory(directory: string): string {
  const root = resolve(directory)
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`directory not found: ${root}`)
  const digest = createHash('sha256')
  const visit = (current: string): void => {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isDirectory() && OMIT_DIRECTORIES.has(item.name)) continue
      const path = join(current, item.name)
      const rel = relative(root, path).split(sep).join('/')
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`plugin source contains symlink: ${rel}`)
      if (SENSITIVE_PATH.test(rel)) throw new Error(`plugin source contains sensitive path: ${rel}`)
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

export function copySourceSnapshot(source: string, destination: string): void {
  const root = resolve(source)
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`source checkout not found: ${root}`)
  if (existsSync(destination)) throw new Error(`source snapshot already exists: ${destination}`)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(root, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => {
      const rel = relative(root, path).split(sep).join('/')
      if (!rel) return true
      if (rel.split('/').some((part) => OMIT_DIRECTORIES.has(part))) return false
      if (SENSITIVE_PATH.test(rel)) throw new Error(`plugin source contains sensitive path: ${rel}`)
      if (lstatSync(path).isSymbolicLink()) throw new Error(`plugin source contains symlink: ${rel}`)
      return true
    },
  })
}

export function profileStateHash(profileDir: string): { manifestHash: string; lockHash: string | null; hash: string } {
  const manifest = join(profileDir, 'package.json')
  if (!existsSync(manifest)) throw new Error(`profile manifest not found: ${manifest}`)
  const manifestHash = hashFile(manifest)
  const lock = join(profileDir, 'pnpm-lock.yaml')
  const lockHash = existsSync(lock) ? hashFile(lock) : null
  return { manifestHash, lockHash, hash: createHash('sha256').update(`${manifestHash}:${lockHash ?? 'none'}`).digest('hex') }
}

export function inspectInstalledPlugin(profileDir: string, packageName: string): InstalledPluginIdentity {
  assertEvolvablePluginName(packageName)
  const profileManifestPath = join(profileDir, 'package.json')
  const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  const dependencySpec = profileManifest.dependencies?.[packageName]
  if (!dependencySpec) throw new Error(`plugin is not a current profile dependency: ${packageName}`)
  const packagePath = join(profileDir, 'node_modules', ...packageName.split('/'))
  const manifestPath = join(packagePath, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`installed plugin is not resolvable from current profile: ${packageName}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string; gitHead?: string }
  if (manifest.name !== packageName || !manifest.version) throw new Error(`installed plugin identity mismatch: ${packageName}`)
  const state = profileStateHash(profileDir)
  return {
    packageName,
    version: manifest.version,
    dependencySpec,
    packagePath,
    artifactHash: hashDirectory(realpathSync(packagePath)),
    profileManifestHash: state.manifestHash,
    profileLockHash: state.lockHash,
    ...(manifest.gitHead ? { gitHead: manifest.gitHead } : {}),
  }
}

export function githubCommitArchiveUrl(location: string, commit: string): string | null {
  if (!/^[0-9a-f]{40}$/i.test(commit)) return null
  try {
    const url = new URL(location)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) return null
    const parts = url.pathname.replace(/\.git\/?$/i, '').split('/').filter(Boolean)
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) return null
    return `https://codeload.github.com/${parts[0]}/${parts[1]}/tar.gz/${commit.toLowerCase()}`
  } catch { return null }
}

function acquireGithubArchive(request: PluginSourceRequest, destination: string, curlCommand: string, tarCommand: string): boolean {
  const archiveUrl = githubCommitArchiveUrl(request.location, request.commit ?? '')
  if (!archiveUrl) return false
  const archive = `${destination}.source.tar.gz`
  mkdirSync(destination, { recursive: true })
  const download = spawnSync(curlCommand, [
    '-fL', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '10', '--max-time', '120',
    '--output', archive, archiveUrl,
  ], { encoding: 'utf8', timeout: 130_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  if (download.error || download.status !== 0) {
    rmSync(destination, { recursive: true, force: true })
    rmSync(archive, { force: true })
    throw new Error(`GitHub source archive download failed: ${download.error?.message ?? download.stderr.trim()}`)
  }
  const extract = spawnSync(tarCommand, ['-xzf', archive, '--strip-components=1', '-C', destination], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  })
  rmSync(archive, { force: true })
  if (extract.error || extract.status !== 0) {
    rmSync(destination, { recursive: true, force: true })
    throw new Error(`GitHub source archive extraction failed: ${extract.error?.message ?? extract.stderr.trim()}`)
  }
  return true
}

function acquireSource(
  request: PluginSourceRequest,
  destination: string,
  gitCommand: string,
  curlCommand: string,
  tarCommand: string,
): { location: string; commit?: string } {
  if (request.kind !== 'git') {
    const source = resolve(request.location)
    copySourceSnapshot(source, destination)
    return { location: source, ...(request.commit ? { commit: request.commit } : {}) }
  }
  if (!/^[0-9a-f]{40}$/i.test(request.commit ?? '')) throw new Error('git plugin source requires an exact 40-character commit')
  if (!/^https:\/\//i.test(request.location) || /[\0\r\n]/.test(request.location)) throw new Error('git plugin source requires a non-interactive HTTPS repository URL')
  if (githubCommitArchiveUrl(request.location, request.commit!) && acquireGithubArchive(request, destination, curlCommand, tarCommand)) {
    return { location: request.location, commit: request.commit }
  }
  mkdirSync(dirname(destination), { recursive: true })
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
  const clone = spawnSync(gitCommand, ['clone', '--no-checkout', '--filter=blob:none', request.location, destination], { encoding: 'utf8', env: gitEnv, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  if (clone.error || clone.status !== 0) {
    rmSync(destination, { recursive: true, force: true })
    throw new Error(`git source clone failed: ${clone.error?.message ?? clone.stderr.trim()}`)
  }
  const checkout = spawnSync(gitCommand, ['checkout', '--detach', request.commit!], { cwd: destination, encoding: 'utf8', env: gitEnv, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  if (checkout.error || checkout.status !== 0) {
    rmSync(destination, { recursive: true, force: true })
    throw new Error(`git source checkout failed: ${checkout.error?.message ?? checkout.stderr.trim()}`)
  }
  rmSync(join(destination, '.git'), { recursive: true, force: true })
  return { location: request.location, commit: request.commit }
}

export function freezePluginTargets(options: FreezePluginTargetsOptions): PluginEvolutionTargetPlan[] {
  if (options.requests.length < 1 || options.requests.length > 3) throw new Error('plugin evolution requires 1-3 targets')
  const ids = new Set<string>()
  const packages = new Set<string>()
  for (const request of options.requests) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.id) || ids.has(request.id)) throw new Error(`duplicate or invalid plugin target id: ${request.id}`)
    assertEvolvablePluginName(request.packageName)
    if (packages.has(request.packageName)) throw new Error(`duplicate plugin target package: ${request.packageName}`)
    ids.add(request.id); packages.add(request.packageName)
  }
  for (const request of options.requests) {
    for (const dependency of request.dependsOn ?? []) if (!ids.has(dependency) || dependency === request.id) throw new Error(`invalid plugin dependency ${request.id} -> ${dependency}`)
  }
  if (!isAcyclic(options.requests)) throw new Error('plugin target graph must be acyclic')

  return options.requests.map((request) => {
    const installed = inspectInstalledPlugin(options.profileDir, request.packageName)
    const snapshotPath = join(options.planRoot, 'sources', request.id)
    const acquired = acquireSource(
      request.source,
      snapshotPath,
      options.gitCommand ?? 'git',
      options.curlCommand ?? (process.platform === 'win32' ? 'curl.exe' : 'curl'),
      options.tarCommand ?? (process.platform === 'win32' ? 'tar.exe' : 'tar'),
    )
    const packageDir = request.packageDir ? safeRelativePath(request.packageDir, 'packageDir') : '.'
    const packageRoot = packageDir === '.' ? snapshotPath : join(snapshotPath, packageDir)
    if (!pathInside(snapshotPath, packageRoot) || !existsSync(join(packageRoot, 'package.json'))) throw new Error(`source packageDir is invalid for ${request.packageName}`)
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: string; version?: string; gitHead?: string; scripts?: Record<string, string> }
    if (manifest.name !== installed.packageName || manifest.version !== installed.version) {
      throw new Error(`source identity does not match installed ${installed.packageName}@${installed.version}`)
    }
    if (request.source.kind === 'git' && installed.gitHead && installed.gitHead.toLowerCase() !== request.source.commit!.toLowerCase()) {
      throw new Error(`git source commit does not match installed gitHead for ${installed.packageName}`)
    }
    if (request.source.registryVersion || request.source.registryIntegrity) {
      const integrity = request.source.registryIntegrity
      if (
        request.source.attestedBy !== 'loom'
        || request.source.kind !== 'git'
        || request.source.registryVersion !== installed.version
        || !integrity
        || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity)
        || !existsSync(join(options.profileDir, 'pnpm-lock.yaml'))
        || !readFileSync(join(options.profileDir, 'pnpm-lock.yaml'), 'utf8').includes(integrity)
      ) throw new Error(`registry source provenance does not match installed lock for ${installed.packageName}`)
    }
    if (request.source.kind === 'managed' && !request.source.expectedTreeHash) throw new Error(`managed source requires expectedTreeHash: ${request.packageName}`)
    const treeHash = hashDirectory(snapshotPath)
    if (request.source.expectedTreeHash && request.source.expectedTreeHash !== treeHash) throw new Error(`source tree hash mismatch: ${request.packageName}`)
    const source: FrozenPluginSource = {
      kind: request.source.kind,
      location: acquired.location,
      ...(acquired.commit ? { commit: acquired.commit } : {}),
      attestedBy: request.source.attestedBy,
      snapshotPath,
      treeHash,
      packageDir,
      ...(request.source.registryVersion ? { registryVersion: request.source.registryVersion } : {}),
      ...(request.source.registryIntegrity ? { registryIntegrity: request.source.registryIntegrity } : {}),
    }
    const inferred = inferPackageCommands(manifest.scripts ?? {})
    const prepareCommands = structuredClone(request.prepareCommands ?? inferred.prepare)
    const buildCommands = structuredClone(request.buildCommands ?? inferred.build)
    const testCommands = structuredClone(request.testCommands ?? inferred.test)
    if (buildCommands.length + testCommands.length === 0) throw new Error(`plugin source lacks a host-verifiable build/test script: ${request.packageName}`)
    return {
      id: request.id,
      dependsOn: [...(request.dependsOn ?? [])],
      packageName: request.packageName,
      installed,
      source,
      prepareCommands,
      buildCommands,
      testCommands,
    }
  })
}

function inferPackageCommands(scripts: Record<string, string>): {
  prepare: PluginEvolutionTargetPlan['prepareCommands']
  build: PluginEvolutionTargetPlan['buildCommands']
  test: PluginEvolutionTargetPlan['testCommands']
} {
  // Lifecycle commands are host-derived from the frozen package manifest, not
  // accepted as arbitrary Actor/user argv. Dependency installation remains an
  // explicit managed-source concern; Loom does not silently access a registry.
  return {
    prepare: [],
    build: typeof scripts.build === 'string' && scripts.build.trim() ? [{ command: 'npm', args: ['run', 'build'] }] : [],
    test: typeof scripts.test === 'string' && scripts.test.trim() && !/no test specified/i.test(scripts.test)
      ? [{ command: 'npm', args: ['test'] }]
      : [],
  }
}

function isAcyclic(requests: PluginTargetRequest[]): boolean {
  const graph = new Map(requests.map((request) => [request.id, request.dependsOn ?? []]))
  const visiting = new Set<string>()
  const complete = new Set<string>()
  const visit = (id: string): boolean => {
    if (complete.has(id)) return true
    if (visiting.has(id)) return false
    visiting.add(id)
    for (const dependency of graph.get(id) ?? []) if (!visit(dependency)) return false
    visiting.delete(id); complete.add(id)
    return true
  }
  return requests.every((request) => visit(request.id))
}
