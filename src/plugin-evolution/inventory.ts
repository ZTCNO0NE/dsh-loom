import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { resolvePluginCommandInvocation } from './command.js'
import { isProtectedPluginName } from './source.js'
import type { PluginSourceRequest } from './types.js'

export interface ProfilePluginInventoryItem {
  packageName: string
  dependencySpec: string
  installed: boolean
  version?: string
  evolvable: boolean
  sourceMetadata: boolean
}

interface InstalledManifest { version?: string; repository?: string | { url?: string }; gitHead?: string }
interface RegistryManifest extends InstalledManifest { name?: string; 'dist.integrity'?: string; dist?: { integrity?: string } }

/** Deterministic top-level route boundary shared by Actor-facing tools. */
export function isPluginEvolutionIntent(text: string): boolean {
  return /(?:插件|跨插件|plugin(?:s|\s+package)?|npm\s+package)/i.test(text)
}

function installedManifest(profileDir: string, packageName: string): InstalledManifest | null {
  const manifestPath = join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json')
  if (!existsSync(manifestPath)) return null
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')) as InstalledManifest } catch { return null }
}

function httpsRepository(repository: InstalledManifest['repository']): string | undefined {
  let value = typeof repository === 'string' ? repository : repository?.url
  if (!value) return undefined
  value = value.replace(/^git\+/, '')
  if (value.startsWith('github:')) value = `https://github.com/${value.slice('github:'.length)}`
  if (value.startsWith('git://github.com/')) value = `https://github.com/${value.slice('git://github.com/'.length)}`
  return /^https:\/\//i.test(value) ? value : undefined
}

function resolveRegistryPluginSource(profileDir: string, packageName: string, version: string, pnpmCommand: string): PluginSourceRequest | null {
  const args = ['view', `${packageName}@${version}`, 'name', 'version', 'repository', 'gitHead', 'dist.integrity', '--json']
  const invocation = resolvePluginCommandInvocation(pnpmCommand, args)
  const result = spawnSync(invocation.executable, invocation.args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
  if (result.error || result.status !== 0) return null
  try {
    const parsed = JSON.parse(result.stdout) as RegistryManifest | RegistryManifest[]
    const metadata = Array.isArray(parsed) ? parsed.at(-1) : parsed
    const repository = httpsRepository(metadata?.repository)
    const integrity = metadata?.dist?.integrity ?? metadata?.['dist.integrity']
    if (metadata?.name !== packageName || metadata.version !== version || !repository || !/^[0-9a-f]{40}$/i.test(metadata.gitHead ?? '')) return null
    if (!integrity || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity)) return null
    const lockPath = join(profileDir, 'pnpm-lock.yaml')
    if (!existsSync(lockPath) || !readFileSync(lockPath, 'utf8').includes(integrity)) return null
    return {
      kind: 'git', location: repository, commit: metadata.gitHead, attestedBy: 'loom',
      registryVersion: version, registryIntegrity: integrity,
    }
  } catch { return null }
}

export function resolveProfilePluginSource(profileDir: string, packageName: string, pnpmCommand?: string): PluginSourceRequest | null {
  const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  const spec = profile.dependencies?.[packageName]
  const manifest = installedManifest(profileDir, packageName)
  if (!spec || !manifest) return null
  if (spec.startsWith('file:')) {
    const raw = spec.slice('file:'.length)
    const location = isAbsolute(raw) ? raw : resolve(profileDir, raw)
    if (existsSync(join(location, 'package.json'))) return { kind: 'local', location, attestedBy: 'user' }
  }
  const repository = httpsRepository(manifest.repository)
  if (repository && /^[0-9a-f]{40}$/i.test(manifest.gitHead ?? '')) {
    return { kind: 'git', location: repository, commit: manifest.gitHead, attestedBy: 'loom' }
  }
  if (pnpmCommand && manifest.version) return resolveRegistryPluginSource(profileDir, packageName, manifest.version, pnpmCommand)
  return null
}

export function listProfilePlugins(profileDir: string): ProfilePluginInventoryItem[] {
  const profilePath = join(profileDir, 'package.json')
  if (!existsSync(profilePath)) throw new Error('current DSH Profile manifest is unavailable')
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { dependencies?: Record<string, string> }
  return Object.entries(profile.dependencies ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([packageName, dependencySpec]) => {
    const manifest = installedManifest(profileDir, packageName)
    if (!manifest) return { packageName, dependencySpec, installed: false, evolvable: false, sourceMetadata: false }
    try {
      return {
        packageName, dependencySpec, installed: true,
        ...(manifest.version ? { version: manifest.version } : {}),
        evolvable: Boolean(manifest.version) && !isProtectedPluginName(packageName),
        sourceMetadata: resolveProfilePluginSource(profileDir, packageName) !== null,
      }
    } catch {
      return { packageName, dependencySpec, installed: false, evolvable: false, sourceMetadata: false }
    }
  })
}
