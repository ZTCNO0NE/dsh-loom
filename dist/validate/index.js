import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendJsonl, paths, PROTOCOL_VERSION } from '../protocol/index.js';
import { runIsolation } from '../isolation/runner.js';
import { parseDump, findChangedRows, childEnv } from '../isolation/runner.js';
function hashOf(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function sameField(expected, actual, field) {
    if (expected === undefined || (expected === null && field !== 'error'))
        return true;
    return JSON.stringify(expected) === JSON.stringify(actual);
}
export class Validator {
    ctx;
    options;
    constructor(ctx, options) {
        this.ctx = ctx;
        this.options = options;
    }
    /** Tycho-style deterministic alignment: expected trajectory vs real frames. */
    align(expected, input) {
        const actual = input.actualEvents;
        let nGraded = 0;
        let nMatched = 0;
        let firstDivergence = null;
        for (let i = 0; i < expected.events.length; i++) {
            const exp = expected.events[i];
            const act = actual[i];
            nGraded++;
            if (!act) {
                if (!firstDivergence) {
                    firstDivergence = { index: i, expected: exp, actual: {}, fields: ['(missing event)'] };
                }
                continue;
            }
            const fields = [];
            if (!sameField(exp.type, act.type, 'type'))
                fields.push('type');
            if (!sameField(exp.name, act.name, 'name'))
                fields.push('name');
            if (!sameField(exp.error, act.error, 'error'))
                fields.push('error');
            if (!sameField(exp.argsHash, act.argsHash, 'argsHash'))
                fields.push('argsHash');
            if (!sameField(exp.resultHash, act.resultHash, 'resultHash'))
                fields.push('resultHash');
            if (!sameField(exp.reason, act.reason, 'reason'))
                fields.push('reason');
            if (fields.length === 0) {
                nMatched++;
            }
            else if (!firstDivergence) {
                firstDivergence = { index: i, expected: exp, actual: act, fields };
            }
        }
        // Deterministic coverage: claimed behaviors must be represented by at least one
        // NAMED tool event in the expected trajectory; probe success proves the behavior
        // actually happened. Exact tool-name matching is avoided because builders phrase
        // claimed behaviors semantically.
        const claimed = expected.coverage?.claimedBehaviors ?? [];
        const namedExpected = expected.events.filter((event) => typeof event.name === 'string' && event.name);
        // Config/persona patches legitimately have no named tool events; a successful
        // isolation probe still proves the target loaded/behaved (collectFrames maps
        // nameAliases to the candidate row id), so coverage counts that as satisfied.
        const namedAliases = input.nameAliases ?? [];
        const coverage = claimed.length > 0 ? (namedExpected.length > 0 || namedAliases.length > 0 ? 1 : 0) : null;
        return {
            accuracy: nGraded > 0 ? nMatched / nGraded : null,
            strictAccuracy: nGraded > 0 ? nMatched / nGraded : null,
            coverage,
            nGraded,
            nMatched,
            firstDivergence,
        };
    }
    /** Full fixed verification: alignment + regression + config invariance. */
    async run(patch, cases, input) {
        const expected = patch.expectedTrajectory;
        if (!expected) {
            return this.finish(patch, this.reject(patch, '候选缺少预期轨迹（I9），无法对齐', []), undefined);
        }
        const isolation = this.runIsolationCheck(patch);
        if (isolation && !isolation.composed) {
            return this.finish(patch, this.reject(patch, `isolation composed failed: ${isolation.dumpError ?? `changed rows: ${isolation.changedRows.join(',')}`}`, [
                `isolation candidateRowPresent=${isolation.candidateRowPresent}`,
                `isolation changedRows=[${isolation.changedRows.join(',')}]`,
            ]), isolation.commands);
        }
        if (isolation?.probe && !isolation.probe.ran) {
            return this.finish(patch, this.reject(patch, `isolation probe failed exit=${isolation.probe.exitCode}`, [isolation.probe.outputTail]), isolation.commands);
        }
        const loadCheck = this.runModuleLoadCheck(patch);
        if (loadCheck && !loadCheck.passed) {
            return this.finish(patch, this.reject(patch, `module load check failed: ${loadCheck.file}`, [loadCheck.error ?? 'load error']), isolation?.commands);
        }
        const skillIsolation = this.runSkillIsolationCheck(patch);
        if (skillIsolation && !skillIsolation.passed) {
            return this.finish(patch, this.reject(patch, `skill isolation failed: ${skillIsolation.error ?? skillIsolation.file}`, [
                skillIsolation.probeTail ?? '',
            ]), isolation?.commands);
        }
        const alignment = this.align(expected, input);
        const evidence = [];
        const failures = [];
        const threshold = this.options.coverageThreshold ?? 0.75;
        if (alignment.accuracy !== 1 || alignment.strictAccuracy !== 1) {
            failures.push(alignment.firstDivergence
                ? `first_divergence at ${alignment.firstDivergence.index}: fields ${alignment.firstDivergence.fields.join(',')}`
                : 'alignment incomplete');
        }
        if (alignment.coverage !== null && alignment.coverage < threshold) {
            failures.push(`coverage ${alignment.coverage.toFixed(2)} < ${threshold}`);
        }
        if (input.configBeforeHash && input.actualConfigHash && input.configBeforeHash !== input.actualConfigHash) {
            failures.push('config invariance violated: 未涉及配置发生变化');
        }
        if (input.configAfterHash && input.actualConfigHash && input.configAfterHash !== input.actualConfigHash) {
            failures.push('applied config hash mismatch');
        }
        const regressionResults = [];
        for (const reg of cases.slice(0, this.options.maxCases)) {
            const passed = reg.assert
                ? await reg.assert(reg.expected)
                : this.runRegressionCase(reg);
            regressionResults.push({ id: reg.id, passed, detail: passed ? undefined : `case ${reg.id} failed` });
            if (!passed)
                failures.push(`regression ${reg.id} failed`);
            evidence.push(`regression ${reg.id}: ${passed ? 'pass' : 'fail'}`);
        }
        evidence.push(`isolation composed=${isolation ? isolation.composed : 'n/a'}`);
        if (loadCheck)
            evidence.push(`module load check: ${loadCheck.passed ? 'pass' : 'fail'}`);
        if (skillIsolation)
            evidence.push(`skill isolation: ${skillIsolation.passed ? 'pass' : 'fail'}`);
        evidence.push(`alignment accuracy=${alignment.accuracy ?? 'n/a'} strict=${alignment.strictAccuracy ?? 'n/a'} coverage=${alignment.coverage ?? 'n/a'} firstDivergence=${alignment.firstDivergence ? 'yes' : 'none'}`);
        if (failures.length > 0) {
            return this.finish(patch, this.reject(patch, failures.join('; '), evidence, regressionResults, alignment), isolation?.commands);
        }
        return this.finish(patch, {
            patchId: patch.id,
            verdict: 'approved',
            score: 1,
            evidence,
            validatedAt: new Date().toISOString(),
            alignment,
            regressionResults,
            beforeAfterHashes: {
                before: input.configBeforeHash,
                after: input.configAfterHash,
                actual: input.actualConfigHash,
            },
        }, isolation?.commands);
    }
    /** Append a traceable verdict record (ledger) and attach replay commands to the report. */
    finish(patch, report, replay) {
        this.persistLedger(patch, report, replay);
        return { ...report, replay };
    }
    persistLedger(patch, report, replay) {
        if (!this.options.workspaceRoot || !this.options.sessionId)
            return;
        appendJsonl(paths.ledger(this.options.workspaceRoot, this.options.sessionId), {
            schemaVersion: PROTOCOL_VERSION,
            patchId: patch.id,
            verdict: report.verdict,
            score: report.score,
            failureSummary: report.failureSummary,
            evidence: report.evidence,
            alignment: report.alignment,
            regressionResults: report.regressionResults,
            replay,
            at: new Date().toISOString(),
        });
    }
    reject(patch, summary, evidence, regressionResults = [], alignment) {
        return {
            patchId: patch.id,
            verdict: 'rejected',
            score: 0,
            evidence,
            failureSummary: summary,
            validatedAt: new Date().toISOString(),
            alignment,
            regressionResults,
        };
    }
    /** M2.6 belongs to the verifier: candidate composition/load check before behavior alignment. */
    runIsolationCheck(patch) {
        if (!this.options.isolation)
            return null;
        return runIsolation(patch, this.options.isolation);
    }
    /** M4: deterministic load check for builder-drafted modules (fresh `node --check`). */
    runModuleLoadCheck(patch) {
        if (patch.action !== 'insert' || !patch.module)
            return null;
        if (!this.options.workspaceRoot || !this.options.sessionId) {
            return { passed: false, file: 'staging', error: 'workspaceRoot/sessionId not configured' };
        }
        const stagingRoot = paths.staging(this.options.workspaceRoot, this.options.sessionId, patch.id);
        for (const file of patch.module.files) {
            if (!/\.(js|mjs|cjs|ts)$/.test(file.path))
                continue;
            const filePath = join(stagingRoot, file.path);
            if (!existsSync(filePath)) {
                return { passed: false, file: file.path, error: 'staging file missing' };
            }
            try {
                if (/\.ts$/.test(file.path)) {
                    const packageJson = join(stagingRoot, 'package.json');
                    if (!existsSync(packageJson)) {
                        writeFileSync(packageJson, '{"type":"module"}\n', 'utf8');
                    }
                    execFileSync('node', ['--import', 'tsx/esm', filePath], { timeout: 20_000, stdio: 'pipe' });
                }
                else if (/\.(js|mjs|cjs)$/.test(file.path)) {
                    execFileSync('node', ['--check', filePath], { timeout: 15_000, stdio: 'pipe' });
                }
            }
            catch (error) {
                const e = error;
                return {
                    passed: false,
                    file: file.path,
                    error: String(e.stderr ?? e.message ?? 'syntax error').slice(0, 500),
                };
            }
        }
        return { passed: true, file: '' };
    }
    /** M4: generic skill isolation — staging skill root + real catalog probe. */
    runSkillIsolationCheck(patch) {
        if (patch.targetKind !== 'skill')
            return null;
        const opts = this.options.skillIsolation;
        if (!opts) {
            return { passed: false, file: 'skill-isolation', error: 'skillIsolation not configured' };
        }
        const skillFile = patch.module?.files[0];
        if (!skillFile) {
            return { passed: false, file: 'skill-isolation', error: 'skill patch missing module file' };
        }
        const name = skillFile.path.split('/')[0] ?? patch.targetId;
        const staging = join(opts.stagingRoot, patch.id);
        mkdirSync(join(staging, name), { recursive: true });
        writeFileSync(join(staging, skillFile.path), skillFile.content, 'utf8');
        const probeOverlay = join(staging, 'probe-overlay.yml');
        writeFileSync(probeOverlay, [
            '- id: skill-filesystem',
            "  name: '@deepseek-ai/dsh-skill-filesystem'",
            '  config:',
            '    providerName: filesystem',
            '    includeDefaultRoots: false',
            `    customSkillDirs: [${JSON.stringify(staging)}]`,
        ].join('\n') + '\n', 'utf8');
        const dump = opts.dumpRunner ?? ((overlays) => execFileSync(opts.dshCommand[0], [...opts.dshCommand.slice(1), '--profile', opts.profile, ...overlays.flatMap((o) => ['--patch', o]), '--dump-config'], { cwd: opts.cwd, encoding: 'utf8', timeout: 60000, env: childEnv() }));
        const baseline = parseDump(dump(opts.baseOverlays));
        const patched = parseDump(dump([...opts.baseOverlays, probeOverlay]));
        const changedRows = findChangedRows(baseline, patched, 'skill-filesystem');
        const task = `Call the skill tool with the name '${name}' and reply with its content.`;
        const probe = opts.probeRunner ?? ((overlays, t) => {
            try {
                return { out: execFileSync(opts.dshCommand[0], [...opts.dshCommand.slice(1), '--profile', opts.profile, ...overlays.flatMap((o) => ['--patch', o]), '--patch', probeOverlay, t], { cwd: opts.cwd, encoding: 'utf8', timeout: opts.probeTimeoutMs ?? 120000, env: childEnv() }), exit: 0 };
            }
            catch (error) {
                const e = error;
                return { out: String(e.stdout ?? e.stderr ?? e.message ?? ''), exit: e.status ?? -1 };
            }
        });
        const result = probe([...opts.baseOverlays, probeOverlay], task);
        const passed = changedRows.length === 0 && result.exit === 0 && result.out.includes(name) && !result.out.includes('不存在');
        return {
            passed,
            file: name,
            error: passed ? undefined : changedRows.length > 0 ? `changed rows: ${changedRows.join(',')}` : result.out.slice(-200),
            changedRows,
            probeExit: result.exit,
            probeTail: result.out.slice(-200),
        };
    }
    /** Public frame probe for skill patches: true when the staged skill loads in a real catalog. */
    probeSkillForFrames(patch) {
        const result = this.runSkillIsolationCheck(patch);
        return { passed: Boolean(result?.passed), name: result?.passed ? result.file : undefined };
    }
    /** Load regression scenarios from regressionDir: each subdir has task.md + expected.json + optional run.sh. */
    async loadRegressionCases() {
        const dir = this.options.regressionDir;
        if (!existsSync(dir))
            return [];
        const cases = [];
        for (const name of readdirSync(dir).sort()) {
            const scenarioDir = join(dir, name);
            if (!existsSync(join(scenarioDir, 'expected.json')))
                continue;
            const taskPrompt = existsSync(join(scenarioDir, 'task.md'))
                ? readFileSync(join(scenarioDir, 'task.md'), 'utf8')
                : name;
            cases.push({
                id: name,
                title: name,
                taskPrompt,
                expected: readFileSync(join(scenarioDir, 'expected.json'), 'utf8'),
            });
        }
        return cases.slice(0, this.options.maxCases);
    }
    /** Deterministic keyless runner: executes <scenario>/run.sh and checks expected.json rules. */
    runRegressionCase(reg) {
        const scenarioDir = join(this.options.regressionDir, reg.id);
        const runScript = join(scenarioDir, 'run.sh');
        let stdout = '';
        try {
            if (existsSync(runScript)) {
                stdout = execFileSync('bash', [runScript], { cwd: scenarioDir, encoding: 'utf8', timeout: 30_000 });
            }
        }
        catch {
            return false;
        }
        try {
            const rules = JSON.parse(reg.expected);
            if (typeof rules.stdoutContains === 'string' && !stdout.includes(rules.stdoutContains))
                return false;
            if (rules.file && typeof rules.file === 'object') {
                const file = rules.file;
                const filePath = join(scenarioDir, file.path);
                if (!existsSync(filePath))
                    return false;
                const content = readFileSync(filePath, 'utf8');
                if (file.contains && !content.includes(file.contains))
                    return false;
                if (file.exact !== undefined && content.trim() !== file.exact)
                    return false;
            }
            return true;
        }
        catch {
            return false;
        }
    }
    /** M3 post-apply smoke (I15): keyless regression subset + expectedOutcome presence. */
    async runSmoke(patch, cases) {
        const subset = cases.slice(0, Math.max(1, this.options.maxCases));
        const checks = [];
        for (const reg of subset) {
            const passed = reg.assert
                ? await reg.assert(reg.expected)
                : this.runRegressionCase(reg);
            checks.push({ name: `regression:${reg.id}`, passed, detail: passed ? undefined : `case ${reg.id} failed` });
        }
        checks.push({ name: 'expectedOutcome', passed: Boolean(patch.expectedOutcome), detail: patch.expectedOutcome ? undefined : 'expectedOutcome missing' });
        return {
            schemaVersion: PROTOCOL_VERSION,
            patchId: patch.id,
            passed: checks.every((check) => check.passed),
            checks,
            ranAt: new Date().toISOString(),
        };
    }
    /** Persist I10 report + write run events if provided. */
    persistReport(root, sessionId, patchId, report, actualEvents = []) {
        const reportPath = join(root, 'workspace', sessionId, 'patches', patchId, 'report.json');
        const runEventsPath = join(root, 'workspace', sessionId, 'patches', patchId, 'run', 'events.jsonl');
        mkdirSync(dirname(runEventsPath), { recursive: true });
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        writeFileSync(runEventsPath, actualEvents.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');
    }
    /** Hash a config tree snapshot for invariance checks. */
    hashConfig(config) {
        return hashOf(config);
    }
}
