import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CandidateManifest, LoopInstallOps } from './index.js'
import { createCandidateProfile, hashProfileArtifact, removeCandidateProfile, type CandidateProfile, type CandidateProfileOptions } from './profile.js'

export interface ProfileGateOptions {
  runtimeRoot: string
  baseBundle: string
  dependencyRoot: string
  additionalDependencyRoots?: string[]
  /** The gate owns this invocation; callers never provide a mutable Loader patch. */
  dumpConfig(profile: CandidateProfile): { exitCode: number; output: string }
}

interface ProfileSnapshot {
  profileHome: string
  exists: boolean
  marker: string | null
}

function homeFor(options: ProfileGateOptions, candidateId: string): string {
  return resolve(options.runtimeRoot, 'loader-profiles', candidateId)
}

function snapshot(options: ProfileGateOptions, candidateId: string): ProfileSnapshot {
  const profileHome = homeFor(options, candidateId)
  const markerPath = resolve(profileHome, '.loom-candidate-profile.json')
  return { profileHome, exists: existsSync(profileHome), marker: existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null }
}

/**
 * Adapter-backed gate operations. A successful install is only an isolated
 * Loader profile; it never edits the DSH checkout or any user profile.
 */
export function profileGateOps(options: ProfileGateOptions, candidateId: string): LoopInstallOps {
  let installed: CandidateProfile | null = null
  return {
    snapshot: () => ({ ...snapshot(options, candidateId) }),
    install: (manifest: CandidateManifest) => {
      if (manifest.id !== candidateId) throw new Error(`gate candidate mismatch: expected ${candidateId}, got ${manifest.id}`)
      const artifact = resolve(manifest.artifactPath)
      if (hashProfileArtifact(artifact) !== manifest.source.contentHash) {
        throw new Error(`candidate artifact hash mismatch: ${manifest.id}`)
      }
      installed = createCandidateProfile({
        runtimeRoot: options.runtimeRoot,
        candidateId: manifest.id,
        candidateArtifact: artifact,
        baseBundle: options.baseBundle,
        dependencyRoot: options.dependencyRoot,
        additionalDependencyRoots: options.additionalDependencyRoots,
      } satisfies CandidateProfileOptions)
    },
    smoke: () => {
      if (!installed) return { passed: false, checks: [{ name: 'C0-entry', passed: false, detail: 'profile was not installed' }] }
      const result = options.dumpConfig(installed)
      const passed = result.exitCode === 0 && result.output.includes(installed.runtimeEntry)
      return {
        passed,
        checks: [{
          name: 'C0-entry', passed,
          detail: passed ? installed.runtimeEntry : `dump-config did not resolve ${installed.runtimeEntry}`,
        }],
      }
    },
    rollback: (before) => {
      if (!installed) return
      const prior = before as Partial<ProfileSnapshot>
      if (prior.exists) throw new Error(`refusing to overwrite pre-existing profile home: ${installed.home}`)
      removeCandidateProfile(installed)
      installed = null
    },
  }
}
