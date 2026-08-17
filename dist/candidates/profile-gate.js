import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCandidateProfile, hashProfileArtifact, removeCandidateProfile } from './profile.js';
function homeFor(options, candidateId) {
    return resolve(options.runtimeRoot, 'loader-profiles', candidateId);
}
function snapshot(options, candidateId) {
    const profileHome = homeFor(options, candidateId);
    const markerPath = resolve(profileHome, '.loom-candidate-profile.json');
    return { profileHome, exists: existsSync(profileHome), marker: existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null };
}
/**
 * Adapter-backed gate operations. A successful install is only an isolated
 * Loader profile; it never edits the DSH checkout or any user profile.
 */
export function profileGateOps(options, candidateId) {
    let installed = null;
    return {
        snapshot: () => ({ ...snapshot(options, candidateId) }),
        install: (manifest) => {
            if (manifest.id !== candidateId)
                throw new Error(`gate candidate mismatch: expected ${candidateId}, got ${manifest.id}`);
            const artifact = resolve(manifest.artifactPath);
            if (hashProfileArtifact(artifact) !== manifest.source.contentHash) {
                throw new Error(`candidate artifact hash mismatch: ${manifest.id}`);
            }
            installed = createCandidateProfile({
                runtimeRoot: options.runtimeRoot,
                candidateId: manifest.id,
                candidateArtifact: artifact,
                baseBundle: options.baseBundle,
                dependencyRoot: options.dependencyRoot,
                additionalDependencyRoots: options.additionalDependencyRoots,
            });
        },
        smoke: () => {
            if (!installed)
                return { passed: false, checks: [{ name: 'C0-entry', passed: false, detail: 'profile was not installed' }] };
            const result = options.dumpConfig(installed);
            const passed = result.exitCode === 0 && result.output.includes(installed.runtimeEntry);
            return {
                passed,
                checks: [{
                        name: 'C0-entry', passed,
                        detail: passed ? installed.runtimeEntry : `dump-config did not resolve ${installed.runtimeEntry}`,
                    }],
            };
        },
        rollback: (before) => {
            if (!installed)
                return;
            const prior = before;
            if (prior.exists)
                throw new Error(`refusing to overwrite pre-existing profile home: ${installed.home}`);
            removeCandidateProfile(installed);
            installed = null;
        },
    };
}
