import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
function githubRepository(uri) {
    const parsed = new URL(uri);
    if (parsed.hostname !== 'github.com')
        return null;
    const segments = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
    if (segments.length !== 2 || !segments.every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment)))
        return null;
    return { owner: segments[0], repository: segments[1] };
}
function githubArchive(target, source) {
    const repository = githubRepository(source.uri);
    if (!repository)
        throw new Error(`not a supported GitHub source: ${source.uri}`);
    const revision = JSON.parse(execFileSync('curl', [
        '--fail', '--silent', '--show-error', '--location', '--max-time', '20',
        `https://api.github.com/repos/${repository.owner}/${repository.repository}/commits/${encodeURIComponent(source.ref)}`,
    ], { encoding: 'utf8', timeout: 25_000 }));
    if (typeof revision.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(revision.sha)) {
        throw new Error('GitHub did not return a resolved commit');
    }
    const archive = `${target}.tar.gz`;
    mkdirSync(target, { recursive: true });
    try {
        execFileSync('curl', [
            '--fail', '--silent', '--show-error', '--location', '--max-time', '120', '--output', archive,
            `https://codeload.github.com/${repository.owner}/${repository.repository}/tar.gz/${revision.sha}`,
        ], { stdio: 'pipe', timeout: 125_000 });
        execFileSync('tar', ['-xzf', archive, '--strip-components=1', '--no-same-owner', '--no-same-permissions', '-C', target], {
            stdio: 'pipe', timeout: 120_000,
        });
    }
    finally {
        rmSync(archive, { force: true });
    }
    return revision.sha;
}
/**
 * The only networked candidate path. It deliberately writes a content-addressed
 * staging directory and a `staging` record, never `approved` or project `vendored/`.
 */
export class CandidateImporter {
    options;
    constructor(options) {
        this.options = options;
    }
    acquire(request) {
        if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(request.id))
            throw new Error('invalid candidate id');
        const parsed = new URL(request.source.uri);
        if (parsed.protocol !== 'https:' || !this.options.allowedGitHosts.includes(parsed.hostname)) {
            throw new Error(`candidate source is not allowed: ${request.source.uri}`);
        }
        if (!/^[A-Za-z0-9._/@-]{1,160}$/.test(request.source.ref))
            throw new Error('invalid candidate ref');
        if (request.build?.method !== 'prebuilt' && request.build?.method !== 'sandboxed-dsh-workspace') {
            throw new Error('candidate build method is not allowed');
        }
        if (request.packagePath !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(request.packagePath)
            || request.packagePath.split('/').includes('..'))) {
            throw new Error('invalid candidate packagePath');
        }
        const target = join(candidatePaths(this.options.root).base, 'staging', request.id);
        if (existsSync(target))
            throw new Error(`staging directory already exists: ${request.id}`);
        mkdirSync(join(candidatePaths(this.options.root).base, 'staging'), { recursive: true });
        try {
            const github = githubRepository(request.source.uri);
            let commit;
            if (github) {
                commit = githubArchive(target, request.source);
            }
            else {
                execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', request.source.ref, request.source.uri, target], {
                    stdio: 'pipe', timeout: 120_000,
                });
                if (request.packagePath) {
                    execFileSync('git', ['-C', target, 'sparse-checkout', 'set', '--no-cone', request.packagePath], {
                        stdio: 'pipe', timeout: 10_000,
                    });
                }
                execFileSync('git', ['-C', target, 'checkout', '--detach'], { stdio: 'pipe', timeout: 120_000 });
                commit = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim();
            }
            const artifactPath = resolve(target, request.packagePath ?? '.');
            if (!artifactPath.startsWith(`${resolve(target)}${sep}`) && artifactPath !== resolve(target)) {
                throw new Error('candidate packagePath escapes cloned repository');
            }
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
                    kind: 'git', uri: request.source.uri, ref: request.source.ref, commit, contentHash: hashDirectory(artifactPath),
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
        if (request.build.method === 'prebuilt')
            return { method: 'prebuilt', command: 'entry pre-exists; no build executed' };
        if (request.source.uri !== 'https://github.com/deepseek-ai/deepseek-harness.git'
            || request.packagePath !== 'packages/core/agent-loop'
            || request.packageName !== '@deepseek-ai/dsh-agent-loop') {
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
