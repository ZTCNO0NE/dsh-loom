import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { atomicWriteJson, readJson } from '../protocol/index.js';
const TRANSITIONS = {
    staging: ['pending', 'rejected'],
    pending: ['verified', 'rejected'],
    verified: ['approved', 'rejected'],
    approved: ['installed', 'rejected'],
    installed: ['approved', 'rejected'],
    rejected: [],
};
export function candidatePaths(root) {
    const base = join(root, 'candidates');
    return {
        base,
        registry: join(base, 'registry.json'),
        install: (id) => join(base, 'installations', `${id}.json`),
    };
}
export function hashDirectory(directory) {
    const root = resolve(directory);
    if (!existsSync(root))
        throw new Error(`candidate artifact not found: ${root}`);
    const digest = createHash('sha256');
    const visit = (dir) => {
        for (const name of readdirSync(dir).sort()) {
            const path = join(dir, name);
            const rel = relative(root, path).split(sep).join('/');
            const stat = lstatSync(path);
            if (stat.isSymbolicLink())
                throw new Error(`candidate artifact contains symlink: ${rel}`);
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
function emptyRegistry() {
    return { schemaVersion: 1, candidates: {} };
}
/**
 * Persistent candidate registry. Builder may create staging/pending records;
 * only verifier/gate callers may advance the record beyond pending.
 */
export class CandidateRegistry {
    root;
    constructor(root) {
        this.root = root;
    }
    list() {
        return readJson(candidatePaths(this.root).registry) ?? emptyRegistry();
    }
    get(id) {
        return this.list().candidates[id] ?? null;
    }
    stage(manifest) {
        if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(manifest.id)) {
            throw new Error('candidate id must be 3-64 lowercase alphanumeric/hyphen characters');
        }
        if (manifest.targetId !== 'agent-loop')
            throw new Error('loop candidates may only target agent-loop');
        if (manifest.createdBy !== 'seed' && manifest.createdBy !== 'builder')
            throw new Error('invalid candidate creator');
        const registry = this.list();
        if (registry.candidates[manifest.id])
            throw new Error(`candidate already exists: ${manifest.id}`);
        const record = { manifest, state: 'staging', updatedAt: new Date().toISOString() };
        registry.candidates[manifest.id] = record;
        this.write(registry);
        return record;
    }
    transition(id, state, reason, evidence) {
        const registry = this.list();
        const record = registry.candidates[id];
        if (!record)
            throw new Error(`unknown candidate: ${id}`);
        if (!TRANSITIONS[record.state].includes(state)) {
            throw new Error(`invalid candidate transition: ${record.state} -> ${state}`);
        }
        if (state === 'verified' && (!evidence?.contractReport || !evidence.regressionReport)) {
            throw new Error('verified candidate requires contract and regression reports');
        }
        if (state === 'approved' && !record.evidence) {
            throw new Error('approved candidate requires prior verifier evidence');
        }
        record.state = state;
        record.updatedAt = new Date().toISOString();
        if (reason)
            record.reason = reason;
        if (evidence)
            record.evidence = evidence;
        this.write(registry);
        return record;
    }
    recordInstall(report) {
        const registry = this.list();
        const record = registry.candidates[report.candidateId];
        if (!record)
            throw new Error(`unknown candidate: ${report.candidateId}`);
        if (record.state !== 'approved')
            throw new Error(`candidate must be approved before install: ${record.state}`);
        atomicWriteJson(candidatePaths(this.root).install(report.candidateId), report);
        if (report.state === 'installed') {
            record.state = 'installed';
            record.updatedAt = report.createdAt;
            if (record.evidence)
                record.evidence.installReport = candidatePaths(this.root).install(report.candidateId);
            this.write(registry);
        }
    }
    write(registry) {
        atomicWriteJson(candidatePaths(this.root).registry, registry);
    }
}
const GENERATED_BASELINE_URI = 'https://github.com/deepseek-ai/deepseek-harness.git';
const GENERATED_PACKAGE_PATH = 'packages/core/agent-loop';
const GENERATED_PACKAGE_NAME = '@deepseek-ai/dsh-agent-loop';
const GENERATED_PATH_PREFIX = `${GENERATED_PACKAGE_PATH}/src/`;
const GENERATED_MAX_EDITS = 4;
const GENERATED_MAX_FILE_BYTES = 48_000;
const GENERATED_MAX_TOTAL_BYTES = 96_000;
function textHash(value) {
    return createHash('sha256').update(value).digest('hex');
}
function isBuilderGeneratedSource(source) {
    return 'kind' in source && source.kind === 'builder-generated';
}
/**
 * Apply the only self-authored loop change allowed by the importer. The
 * builder supplies an exact before hash and a complete replacement file; the
 * core validates path, size, count, and baseline bytes before writing. This is
 * intentionally exported for deterministic unit tests and verifier tooling.
 */
export function applyBuilderGeneratedEdits(repositoryRoot, source) {
    if (!Array.isArray(source.edits) || source.edits.length < 1 || source.edits.length > GENERATED_MAX_EDITS) {
        throw new Error(`builder-generated edit count must be 1-${GENERATED_MAX_EDITS}`);
    }
    const seen = new Set();
    let totalBytes = 0;
    const summary = [];
    for (const edit of source.edits) {
        if (!edit || typeof edit.path !== 'string' || typeof edit.beforeHash !== 'string' || typeof edit.after !== 'string') {
            throw new Error('builder-generated edit requires path, beforeHash, and after');
        }
        if (!edit.path.startsWith(GENERATED_PATH_PREFIX) || edit.path.includes('..') || !/^[A-Za-z0-9._/-]+\.tsx?$/.test(edit.path)) {
            throw new Error(`builder-generated edit path is outside the agent-loop source allowlist: ${edit.path}`);
        }
        if (seen.has(edit.path))
            throw new Error(`builder-generated edit path is duplicated: ${edit.path}`);
        seen.add(edit.path);
        if (!/^[0-9a-f]{64}$/i.test(edit.beforeHash))
            throw new Error(`invalid beforeHash for generated edit: ${edit.path}`);
        const file = resolve(repositoryRoot, edit.path);
        if (!file.startsWith(`${resolve(repositoryRoot)}${sep}`) || !existsSync(file) || !lstatSync(file).isFile()) {
            throw new Error(`builder-generated edit target is unavailable: ${edit.path}`);
        }
        const before = readFileSync(file, 'utf8');
        if (textHash(before) !== edit.beforeHash.toLowerCase())
            throw new Error(`builder-generated beforeHash mismatch: ${edit.path}`);
        const bytes = Buffer.byteLength(edit.after, 'utf8');
        if (bytes === 0 || bytes > GENERATED_MAX_FILE_BYTES)
            throw new Error(`builder-generated replacement is too large or empty: ${edit.path}`);
        totalBytes += bytes;
        if (totalBytes > GENERATED_MAX_TOTAL_BYTES)
            throw new Error('builder-generated replacement budget exceeded');
        writeFileSync(file, edit.after, { encoding: 'utf8', mode: 0o644 });
        summary.push({ path: edit.path, beforeHash: edit.beforeHash.toLowerCase(), afterHash: textHash(edit.after) });
    }
    return summary;
}
/**
 * The only self-authored candidate path (no network): a local pinned DSH
 * checkout is copied to content-addressed staging, builder edits are applied,
 * the audited sandbox recipe builds it, and a `staging` record is written.
 */
export class CandidateImporter {
    options;
    constructor(options) {
        this.options = options;
    }
    acquire(request) {
        if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(request.id))
            throw new Error('invalid candidate id');
        const generatedSource = isBuilderGeneratedSource(request.source) ? request.source : undefined;
        if (!generatedSource) {
            throw new Error('v1.1 only accepts builder-generated loop candidates; Git acquisition is removed');
        }
        const baseline = generatedSource.baseline;
        if (baseline.uri !== GENERATED_BASELINE_URI || !/^[0-9a-f]{40}$/i.test(baseline.ref)) {
            throw new Error('builder-generated source must use the pinned audited DSH baseline commit');
        }
        if (request.packagePath !== GENERATED_PACKAGE_PATH || request.packageName !== GENERATED_PACKAGE_NAME) {
            throw new Error('builder-generated candidate must target the audited DSH agent-loop package');
        }
        if (request.build?.method !== 'sandboxed-dsh-workspace') {
            throw new Error('builder-generated candidate must use the audited networkless build recipe');
        }
        const target = join(candidatePaths(this.options.root).base, 'staging', request.id);
        if (existsSync(target))
            throw new Error(`staging directory already exists: ${request.id}`);
        mkdirSync(join(candidatePaths(this.options.root).base, 'staging'), { recursive: true });
        try {
            const baselineRoot = resolve(this.options.baselineRoot);
            const baselineCommit = execFileSync('git', ['-C', baselineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim();
            if (baselineCommit.toLowerCase() !== baseline.ref.toLowerCase()) {
                throw new Error(`local DSH baseline commit mismatch: expected ${baseline.ref}, got ${baselineCommit}`);
            }
            const baselinePackage = resolve(baselineRoot, GENERATED_PACKAGE_PATH);
            if (!existsSync(join(baselinePackage, 'package.json'))) {
                throw new Error(`pinned DSH baseline package is unavailable: ${baselinePackage}`);
            }
            cpSync(baselinePackage, target, { recursive: true, dereference: false });
            const generatedEdits = applyBuilderGeneratedEdits(target, generatedSource);
            const artifactPath = resolve(target);
            if (!existsSync(join(artifactPath, 'package.json')))
                throw new Error('candidate packagePath has no package.json');
            const build = this.buildArtifact(target, artifactPath, request);
            if (!existsSync(join(artifactPath, request.entry)))
                throw new Error(`candidate build did not produce entry: ${request.entry}`);
            const manifest = {
                schemaVersion: 1,
                id: request.id,
                displayName: request.displayName,
                targetId: 'agent-loop',
                packageName: request.packageName,
                artifactPath,
                entry: request.entry,
                build,
                source: {
                    kind: 'builder-generated',
                    uri: baseline.uri,
                    ref: baseline.ref,
                    commit: baselineCommit,
                    contentHash: hashDirectory(artifactPath),
                    generated: {
                        baselineUri: baseline.uri,
                        baselineRef: baseline.ref,
                        editPlanHash: textHash(JSON.stringify(generatedSource.edits)),
                        edits: generatedEdits,
                    },
                },
                config: request.config,
                expectedOutcome: request.expectedOutcome,
                capabilities: request.capabilities,
                createdAt: new Date().toISOString(),
                createdBy: 'builder',
            };
            new CandidateRegistry(this.options.root).stage(manifest);
            return manifest;
        }
        catch (error) {
            rmSync(target, { recursive: true, force: true });
            throw error;
        }
    }
    /**
     * Build only a known DSH workspace recipe in a networkless bubblewrap
     * namespace. Builder text never becomes a command, and no host path other
     * than the read-only dependency store is visible to candidate build code.
     */
    buildArtifact(repositoryRoot, artifactPath, request) {
        const sourceUri = request.source.kind === 'builder-generated' ? request.source.baseline.uri : '';
        if (sourceUri !== GENERATED_BASELINE_URI
            || request.packagePath !== GENERATED_PACKAGE_PATH
            || request.packageName !== GENERATED_PACKAGE_NAME) {
            throw new Error('sandboxed-dsh-workspace build is restricted to the audited DSH agent-loop package');
        }
        const packageJson = JSON.parse(readFileSync(join(artifactPath, 'package.json'), 'utf8'));
        if (packageJson.name !== request.packageName || !existsSync(join(repositoryRoot, 'pnpm-workspace.yaml'))) {
            throw new Error('sandboxed DSH build workspace identity check failed');
        }
        const dependencyStore = this.options.buildDependencyRoot ? resolve(this.options.buildDependencyRoot) : '';
        if (!existsSync(dependencyStore))
            throw new Error('audited DSH dependency store is unavailable');
        const dependencyWorkspace = dirname(dependencyStore);
        const command = 'node_modules/.bin/tsc -b packages/core/agent-loop && cd packages/core/agent-loop && /workspace/node_modules/.bin/tsdown';
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
            ], { stdio: 'pipe', timeout: 300_000 });
        }
        catch (error) {
            const detail = error;
            const output = `${detail.stdout?.toString() ?? ''}\n${detail.stderr?.toString() ?? ''}`.trim().slice(-4000);
            throw new Error(`sandboxed DSH build failed${output ? `: ${output}` : `: ${detail.message ?? String(error)}`}`);
        }
        return { method: 'sandboxed-dsh-workspace', command: `bwrap --unshare-all --unshare-net: ${command}` };
    }
    /** Gate-only promotion after verifier approval; copies a hash-pinned staging artifact. */
    promoteApproved(candidateId) {
        const registry = new CandidateRegistry(this.options.root);
        const record = registry.get(candidateId);
        if (!record || record.state !== 'approved')
            throw new Error(`candidate is not approved: ${candidateId}`);
        const source = record.manifest.artifactPath;
        if (hashDirectory(source) !== record.manifest.source.contentHash)
            throw new Error('candidate staging artifact hash changed');
        const target = join(candidatePaths(this.options.root).base, 'vendored', candidateId);
        if (existsSync(target))
            throw new Error(`runtime vendored candidate already exists: ${candidateId}`);
        mkdirSync(join(candidatePaths(this.options.root).base, 'vendored'), { recursive: true });
        cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true });
        if (hashDirectory(target) !== record.manifest.source.contentHash) {
            rmSync(target, { recursive: true, force: true });
            throw new Error('candidate promotion hash mismatch');
        }
        return target;
    }
}
/** Gate-owned cold replacement. It deliberately accepts only an approved candidate record. */
export async function coldInstallCandidate(registry, candidateId, ops) {
    const record = registry.get(candidateId);
    if (!record)
        throw new Error(`unknown candidate: ${candidateId}`);
    if (record.state !== 'approved')
        throw new Error(`candidate is not approved: ${record.state}`);
    const before = ops.snapshot();
    try {
        await ops.install(record.manifest);
    }
    catch (error) {
        const report = {
            schemaVersion: 1, candidateId, state: 'rejected', before, after: before,
            smoke: { passed: false, checks: [{ name: 'install', passed: false, detail: String(error) }] },
            createdAt: new Date().toISOString(),
        };
        registry.recordInstall(report);
        return report;
    }
    const smoke = await ops.smoke(record.manifest);
    if (!smoke.passed) {
        let rollback = { attempted: true, succeeded: false };
        try {
            await ops.rollback(before, record.manifest);
            rollback = { attempted: true, succeeded: true };
        }
        catch (error) {
            rollback = { attempted: true, succeeded: false, error: String(error) };
        }
        const report = {
            schemaVersion: 1, candidateId, state: 'rolled_back', before, after: before, smoke, rollback,
            createdAt: new Date().toISOString(),
        };
        registry.recordInstall(report);
        return report;
    }
    const report = {
        schemaVersion: 1, candidateId, state: 'installed', before, after: ops.snapshot(), smoke,
        createdAt: new Date().toISOString(),
    };
    registry.recordInstall(report);
    return report;
}
