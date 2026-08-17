import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
const ADAPTER_SCHEMA_VERSION = 1;
const ADAPTER_MARKER = '.loom-candidate-profile.json';
const BASE_BUNDLE_NAME = '@loom/candidate-base';
const CANDIDATE_PACKAGE_NAME = '@loom/candidate-loop';
const SCHEDULER_SYMBOL_DESCRIPTION = 'Symbol(@deepseek-ai/dsh-tools.scheduler)';
function safeId(value, label) {
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(value)) {
        throw new Error(`${label} must be 3-64 lowercase alphanumeric/hyphen characters`);
    }
}
function pathInside(root, path) {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
/** Hash regular files only. Profile input must not smuggle an executable symlink. */
export function hashProfileArtifact(directory) {
    const root = resolve(directory);
    if (!existsSync(root))
        throw new Error(`profile artifact not found: ${root}`);
    const digest = createHash('sha256');
    const visit = (current) => {
        for (const name of requireDirectory(current).sort()) {
            const path = join(current, name);
            const rel = relative(root, path).split(sep).join('/');
            const stat = lstatSync(path);
            if (stat.isSymbolicLink())
                throw new Error(`profile artifact contains symlink: ${rel}`);
            if (stat.isDirectory()) {
                digest.update(`dir:${rel}\n`);
                visit(path);
            }
            else if (stat.isFile()) {
                digest.update(`file:${rel}\0`);
                digest.update(readFileSync(path));
            }
        }
    };
    visit(root);
    return digest.digest('hex');
}
function requireDirectory(path) {
    const stat = lstatSync(path);
    if (!stat.isDirectory())
        throw new Error(`expected directory: ${path}`);
    return readdirSync(path);
}
function yamlString(value) {
    return JSON.stringify(value);
}
function hashBaseBundle(directory) {
    const digest = createHash('sha256');
    for (const name of ['package.json', 'cordis.patch.yml']) {
        const path = join(directory, name);
        digest.update(`file:${name}\0`);
        digest.update(readFileSync(path));
    }
    return digest.digest('hex');
}
/** Replace the base insert row before Loader composes the entry tree. */
export function replaceBaseLoopEntry(patch, runtimeEntry) {
    const pattern = /(^\s*- id: agent-loop\s*\r?\n\s*name:\s*)(?:[^\r\n]+)(\r?\n)/m;
    if (!pattern.test(patch))
        throw new Error('base bundle does not contain an agent-loop entry row');
    return patch.replace(pattern, `$1${yamlString(runtimeEntry)}$2`);
}
function markerPath(home) {
    return join(home, ADAPTER_MARKER);
}
function readMarker(home) {
    const marker = markerPath(home);
    if (!existsSync(marker))
        return null;
    return JSON.parse(readFileSync(marker, 'utf8'));
}
function sameProfile(a, b) {
    return a.schemaVersion === b.schemaVersion
        && a.candidateId === b.candidateId
        && a.home === b.home
        && a.profile === b.profile
        && a.runtimeEntry === b.runtimeEntry
        && a.candidateHash === b.candidateHash
        && a.baseBundleHash === b.baseBundleHash
        && a.loaderBridge === b.loaderBridge;
}
function createPeerLinks(candidatePackage, dependencyRoots) {
    const manifestPath = join(candidatePackage, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const names = new Set([
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.dependencies ?? {}),
    ].filter((name) => name.startsWith('@deepseek-ai/')));
    for (const name of names) {
        const target = dependencyRoots.map((root) => join(root, name)).find((path) => existsSync(path));
        if (!target)
            throw new Error(`candidate dependency is unavailable from DSH dependency anchors: ${name}`);
        const link = join(candidatePackage, 'node_modules', name);
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(target, link, 'dir');
    }
}
/**
 * DSH's source launcher may load its tools service from TypeScript while a
 * vendored candidate imports the published JavaScript entry. The scheduler is
 * keyed by a module-local Symbol, so the equivalent symbols are not identical.
 * Bridge only that private key at the Loader boundary; the vendored candidate
 * bytes and its recorded source hash remain untouched.
 */
function writeSchedulerSymbolBridge(candidatePackage) {
    const entry = join(candidatePackage, 'lib', 'index.js');
    const source = readFileSync(entry, 'utf8');
    const needle = 'ctx.tools[TOOL_RUNTIME_SCHEDULER]';
    const uses = source.split(needle).length - 1;
    if (uses === 0)
        throw new Error('candidate does not expose the expected DSH tool scheduler seam');
    const bridge = `\nconst loomSchedulerKey = (tools) => Object.getOwnPropertySymbols(tools).find((key) => String(key) === ${JSON.stringify(SCHEDULER_SYMBOL_DESCRIPTION)}) ?? TOOL_RUNTIME_SCHEDULER;\n`;
    writeFileSync(entry, `${source.replaceAll(needle, 'ctx.tools[loomSchedulerKey(ctx.tools)]')}${bridge}`, 'utf8');
}
/**
 * Materialize a Loader-level replacement without modifying the DSH checkout.
 * The generated DSH home owns both the copied base patch and a copied candidate
 * package, so the entry resolves from a stable, auditable runtime path.
 */
export function createCandidateProfile(options) {
    safeId(options.candidateId, 'candidate id');
    const profile = options.profileName ?? `loom-${options.candidateId}`;
    safeId(profile, 'profile name');
    const runtimeRoot = resolve(options.runtimeRoot);
    const candidateArtifact = resolve(options.candidateArtifact);
    const baseBundle = resolve(options.baseBundle);
    const dependencyRoot = resolve(options.dependencyRoot);
    const suppliedDependencyRoots = [dependencyRoot, ...(options.additionalDependencyRoots ?? []).map((root) => resolve(root))];
    const dependencyRoots = suppliedDependencyRoots.flatMap((root) => {
        const hoistedWorkspaceDependencies = join(root, '.pnpm', 'node_modules');
        return existsSync(hoistedWorkspaceDependencies) ? [root, hoistedWorkspaceDependencies] : [root];
    });
    if (!existsSync(join(candidateArtifact, 'package.json')))
        throw new Error('candidate artifact requires package.json');
    if (!existsSync(join(candidateArtifact, 'lib', 'index.js')))
        throw new Error('candidate artifact requires lib/index.js');
    if (!existsSync(join(baseBundle, 'package.json')) || !existsSync(join(baseBundle, 'cordis.patch.yml'))) {
        throw new Error('base bundle requires package.json and cordis.patch.yml');
    }
    if (dependencyRoots.some((root) => !existsSync(root)))
        throw new Error('a DSH dependency anchor was not found');
    const home = join(runtimeRoot, 'loader-profiles', options.candidateId);
    if (!pathInside(runtimeRoot, home))
        throw new Error('candidate profile home escapes runtime root');
    const profileDir = join(home, 'profiles', profile);
    const candidatePackage = join(profileDir, 'node_modules', ...CANDIDATE_PACKAGE_NAME.split('/'));
    const runtimeEntry = join(candidatePackage, 'lib', 'index.js');
    const candidateHash = hashProfileArtifact(candidateArtifact);
    const baseBundleHash = hashBaseBundle(baseBundle);
    const result = {
        schemaVersion: ADAPTER_SCHEMA_VERSION,
        candidateId: options.candidateId,
        home,
        profile,
        profileDir,
        runtimeEntry,
        candidateHash,
        baseBundleHash,
        loaderBridge: 'scheduler-symbol-v1',
        createdAt: new Date().toISOString(),
    };
    if (existsSync(home)) {
        const existing = readMarker(home);
        if (existing && sameProfile(existing, result))
            return existing;
        throw new Error(`candidate profile already exists and is not the same owned artifact: ${home}`);
    }
    try {
        const basePackage = join(profileDir, 'node_modules', ...BASE_BUNDLE_NAME.split('/'));
        mkdirSync(profileDir, { recursive: true });
        mkdirSync(basePackage, { recursive: true });
        cpSync(join(baseBundle, 'package.json'), join(basePackage, 'package.json'));
        cpSync(join(baseBundle, 'cordis.patch.yml'), join(basePackage, 'cordis.patch.yml'));
        cpSync(candidateArtifact, candidatePackage, { recursive: true, dereference: false });
        createPeerLinks(candidatePackage, dependencyRoots);
        writeSchedulerSymbolBridge(candidatePackage);
        const basePatch = join(basePackage, 'cordis.patch.yml');
        writeFileSync(basePatch, replaceBaseLoopEntry(readFileSync(basePatch, 'utf8'), runtimeEntry), 'utf8');
        writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
            name: `loom-candidate-profile-${options.candidateId}`,
            private: true,
            dsh: { profile: { bundles: [BASE_BUNDLE_NAME, '@deepseek-ai/dsh-headless'] } },
        }, null, 2)}\n`, 'utf8');
        writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
        writeFileSync(markerPath(home), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
        return result;
    }
    catch (error) {
        rmSync(home, { recursive: true, force: true });
        throw error;
    }
}
/** Remove only a complete adapter-owned profile with a matching marker. */
export function removeCandidateProfile(profile) {
    const current = readMarker(profile.home);
    if (!current || !sameProfile(current, profile)) {
        throw new Error(`refusing to remove unowned or changed candidate profile: ${profile.home}`);
    }
    rmSync(profile.home, { recursive: true, force: true });
}
