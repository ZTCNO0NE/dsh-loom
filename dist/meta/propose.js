import { atomicWriteJson, ensureWorkspace, paths, PROTOCOL_VERSION, readJson, readJsonl, sha256, } from '../protocol/index.js';
import { DEFAULT_LOCKED_TARGETS, isLockedTarget } from '../policy.js';
import { mergePreferences } from '../growth/index.js';
import { BuilderKernel } from '../builder/kernel.js';
import { BuilderDriver } from '../builder/driver.js';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export class Proposer {
    ctx;
    options;
    constructor(ctx, options) {
        this.ctx = ctx;
        this.options = options;
    }
    async propose(signals, currentConfig, userRequirements, previousReport, probeResults) {
        ensureWorkspace(this.options.root, this.options.sessionId);
        const llm = this.options.llm
            ?? this.ctx.llm;
        if (!llm) {
            throw new Error('proposer: no llm service available');
        }
        const kernel = new BuilderKernel(this.options.root, this.options.sessionId);
        const resume = readJson(paths.builderResume(this.options.root, this.options.sessionId));
        const run = resume?.runId
            ? kernel.load(resume.runId)
            : kernel.create({
                kind: 'patch',
                actor: {
                    requirements: userRequirements ?? null,
                    signals,
                    telemetry: readJson(paths.actorProfile(this.options.root, this.options.sessionId)),
                    framesRef: paths.frames(this.options.root, this.options.sessionId),
                },
                targetBefore: currentConfig,
                ...(previousReport ? { previousAttempt: { ...previousReport } } : {}),
            });
        if (resume?.runId)
            unlinkSync(paths.builderResume(this.options.root, this.options.sessionId));
        let parsed;
        try {
            const outcome = await new BuilderDriver({
                llm,
                provider: this.options.provider,
                model: this.options.model,
                systemPrompt: this.options.systemPrompt,
                taskContext: this.buildTaskContext(signals, currentConfig, userRequirements, previousReport, probeResults),
                onUsage: this.options.onUsage,
                ...this.options.builder,
            }).run(kernel, run.id);
            if (outcome.state !== 'submitted' || !outcome.proposal) {
                throw new Error(`proposer: builder run ${run.id} ended ${outcome.state} without a submission`);
            }
            parsed = outcome.proposal;
        }
        catch (error) {
            if (kernel.load(run.id).state !== 'aborted' && kernel.load(run.id).state !== 'submitted') {
                kernel.append(run.id, 'error', 'propose', undefined, error);
                kernel.decide(run.id, { kind: 'abort', reason: String(error) });
            }
            throw error;
        }
        let patch;
        try {
            patch = this.normalizePatch(parsed, signals);
        }
        catch (error) {
            const feedback = {
                source: 'proposal_normalization',
                verdict: 'rejected',
                failureSummary: String(error),
                proposalHash: sha256(parsed),
                observedAt: new Date().toISOString(),
            };
            const next = kernel.reopenFromRejection(run.id, feedback);
            atomicWriteJson(paths.builderResume(this.options.root, this.options.sessionId), {
                schemaVersion: 1,
                runId: next.id,
                feedbackHash: sha256(feedback),
                createdAt: new Date().toISOString(),
            });
            throw error;
        }
        if (parsed.worldModel) {
            this.writeWorldModel(parsed.worldModel);
        }
        const preferences = this.normalizePreferences(parsed);
        if (preferences.length > 0) {
            mergePreferences(this.options.root, this.options.sessionId, preferences);
        }
        atomicWriteJson(paths.selfCheck(this.options.root, this.options.sessionId), patch.selfCheck);
        atomicWriteJson(paths.candidate(this.options.root, this.options.sessionId, patch.id), patch);
        atomicWriteJson(paths.expectedTrajectory(this.options.root, this.options.sessionId, patch.id), patch.expectedTrajectory);
        atomicWriteJson(paths.builderRun(this.options.root, this.options.sessionId, patch.id), {
            schemaVersion: 1,
            patchId: patch.id,
            runId: run.id,
            submittedAt: new Date().toISOString(),
        });
        const status = {
            schemaVersion: PROTOCOL_VERSION,
            patchId: patch.id,
            state: 'submitted',
            updatedAt: new Date().toISOString(),
            operator: 'builder',
            iteration: 1,
        };
        atomicWriteJson(paths.status(this.options.root, this.options.sessionId, patch.id), status);
        return [patch];
    }
    /** Only verifier/probe/gate callers invoke this: it never approves or installs. */
    reopenFromFeedback(patchId, feedback) {
        const ref = readJson(paths.builderRun(this.options.root, this.options.sessionId, patchId));
        if (!ref?.runId)
            return null;
        const kernel = new BuilderKernel(this.options.root, this.options.sessionId);
        const next = kernel.reopenFromRejection(ref.runId, feedback);
        atomicWriteJson(paths.builderResume(this.options.root, this.options.sessionId), {
            schemaVersion: 1,
            previousPatchId: patchId,
            runId: next.id,
            feedbackHash: sha256(feedback),
            createdAt: new Date().toISOString(),
        });
        return next.id;
    }
    buildTaskContext(signals, currentConfig, userRequirements, previousReport, probeResults) {
        const signalText = signals
            .map((signal) => `- [${signal.kind}] ${signal.evidence.join(' | ')}`)
            .join('\n');
        const configText = JSON.stringify(currentConfig, null, 2).slice(0, 16_000);
        const profile = readJson(paths.actorProfile(this.options.root, this.options.sessionId));
        const telemetryText = profile
            ? JSON.stringify(profile)
            : '(尚无观测数据)';
        const frames = readJsonl(paths.frames(this.options.root, this.options.sessionId)).slice(-40);
        const framesText = frames.length > 0
            ? frames.map((frame) => {
                const data = frame.data ?? {};
                const parts = [
                    frame.type ?? '?',
                    data.turn !== undefined ? `turn=${String(data.turn)}` : '',
                    data.step !== undefined ? `step=${String(data.step)}` : '',
                    data.name !== undefined ? `name=${String(data.name)}` : '',
                    data.error !== undefined ? `error=${String(data.error).slice(0, 200)}` : '',
                    data.args !== undefined ? `args=${String(data.args).slice(0, 200)}` : '',
                    data.result !== undefined ? `result=${String(data.result).slice(0, 200)}` : '',
                    data.reason !== undefined ? `reason=${String(data.reason)}` : '',
                ].filter(Boolean);
                return `[${frame.ts ?? ''}] ${parts.join(' ')}`;
            }).join('\n').slice(0, 12_000)
            : '(尚无完整轨迹帧；遥测为空)';
        const probeText = probeResults && probeResults.length > 0
            ? probeResults.map((result) => `- probe(${result.task}) exit=${result.exit} tail=${result.outputTail.slice(0, 500)}`).join('\n')
            : '';
        const requirementText = userRequirements ?? '(无显式需求；根据信号推断)';
        const previousText = previousReport
            ? `上一次核验未通过（verdict=${previousReport.verdict}）：${previousReport.failureSummary ?? ''}\n` +
                `分歧证据：${JSON.stringify(previousReport.alignment?.firstDivergence ?? previousReport.evidence)}。` +
                '必须补齐完整性与对齐，不允许绕过。'
            : '';
        return [
            this.options.systemPrompt,
            '',
            '你是独立迭代者（builder），不共享 actor 的会话状态。',
            '纪律：一次只改一个变量；targetKind 只允许 config/tool/skill；必须自带预期轨迹；',
            '禁止以任何 targetKind 修改 loop 层行（agent / agent-loop）；这些行永远锁定。',
            '提交前先自评：给出 selfCheck.confidence（0-1）与 selfCheck.completeness（0-1）。',
            '',
            '当 targetKind=tool 且 action=insert 时，module.files 必须实现 dsh 工具契约（entry 为 index.mjs）：',
            [
                "import { defineTool } from '@deepseek-ai/dsh-tools'",
                "export const name = '<tool-name>'",
                "export const inject = ['tools']",
                'export function apply(ctx) {',
                "  ctx.tools.register(defineTool({",
                "    name: '<tool-name>',",
                "    description: '<一句话描述>',",
                "    parameters: {",
                "      path: { type: 'string', required: true, description: '目标文件路径' },",
                "      content: { type: 'string', required: true, description: '写入内容' },",
                "    },",
                "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },",
                "    async execute(args) { /* 返回符合 output.schema 的规范值 */ },",
                '  }))',
                '}',
            ].join('\n'),
            '模块必须是完整可加载的 ESM（.mjs）；不要写占位注释；execute 要真实完成功能。',
            '**参数 schema 约束**：dsh 只接受 `required: true` 或省略 required；可选参数不要写 `required: false`。',
            '**参数类型约束**：parameters 只允许简单类型（string/number/boolean）；禁止嵌套 object/array 参数；output.schema 用 string 最简单；任何 object 节点必须显式写 `additionalProperties: false`。',
            '当需求是"运行命令"且工具名为 bash-run 时，直接采用以下已验证模板（只能改 description）：',
            [
                "import { exec } from 'node:child_process'",
                "import { promisify } from 'node:util'",
                "import { defineTool } from '@deepseek-ai/dsh-tools'",
                '',
                'const execAsync = promisify(exec)',
                '',
                "export const name = 'bash-run'",
                "export const inject = ['tools']",
                '',
                'export function apply(ctx) {',
                '  ctx.tools.register(defineTool({',
                "    name: 'bash-run',",
                "    description: '执行 shell 命令并返回输出',",
                '    parameters: {',
                "      command: { type: 'string', required: true, description: '要执行的 shell 命令' },",
                '    },',
                "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },",
                '    async execute(args) {',
                "      try { const { stdout, stderr } = await execAsync(args.command, { encoding: 'utf8' }); return `${stdout}${stderr}`.trim() }",
                "      catch (err) { const message = `${err.stdout || ''}${err.stderr || ''}`.trim(); return message || String(err.message) }",
                '    },',
                '  }))',
                '}',
            ].join('\n'),
            '',
            '当 targetKind=skill 且 action=insert 时，module.files 必须是目录束布局：',
            'files: [{ path: "<kebab-name>/SKILL.md", content: "..." }]，entry 为 "<kebab-name>/SKILL.md"，SKILL.md 格式：',
            [
                '---',
                'name: <kebab-case 技能名>',
                'description: <一句话：何时使用该技能>',
                '---',
                '',
                '<技能正文：明确、可执行的指令，约束行为>',
            ].join('\n'),
            'frontmatter 必须包含 name 与 description；正文用中文写可执行步骤。',
            '',
            '若你对候选行为不确定，可在 probes 里给出最多 3 条隔离探测任务（每条 ≤300 字）。系统会替你在隔离环境试运行并回传结果，全部通过后才进入 verifier 核验；不要提交你无法预期结果的 patch。',
            '',
            `用户需求：${requirementText}`,
            previousText,
            '',
            `信号：\n${signalText || '(无)'}`,
            '',
            `actor 运行观测（帧、回合时延、工具时延与错误率；只描述事实，不给出修改建议）：\n${telemetryText}`,
            '',
            `actor 完整轨迹帧（最近 ${frames.length} 条）：\n${framesText}`,
            '',
            probeText ? `上一轮隔离探测结果（exit≠0 必须先修正）：\n${probeText}` : '',
            '',
            `当前组合配置快照：\n${configText}`,
            '',
            '候选 proposal 的 JSON schema（driver 会要求你把它写入受限 draft 并预检后再提交）：',
            JSON.stringify({
                patch: {
                    action: '"update" | "insert"（新增行时用 insert）',
                    targetId: 'string（插件行 id）',
                    targetName: 'string（insert 时的行 name，模块入口绝对路径或包名）',
                    targetKind: '"config" | "tool" | "skill"',
                    config: { 新配置键值: '替换目标行的完整 config' },
                    module: {
                        files: [{ path: '相对路径', content: '文件内容' }],
                        entry: '入口相对路径（insert 必须）',
                    },
                    probes: [{ task: '隔离探测任务（可选，≤300 字，最多 3 条）', description: '说明（可选）' }],
                    dependencies: ['string[]'],
                    rationale: 'string',
                    expectedOutcome: 'string（可量化）',
                    version: 1,
                },
                expectedTrajectory: {
                    events: [{ type: 'turn/start|tool/call|tool/result|turn/end', name: 'tool 名', error: null }],
                    coverage: { claimedBehaviors: ['行为面'] },
                },
                selfCheck: { confidence: 0.9, completeness: 0.8, summary: 'string' },
                preferences: [{ scope: '偏好作用域（如 output-format）', value: '偏好内容（如 不带 markdown）' }],
                worldModel: {
                    invariants: ['未涉及配置行逐字节不变'],
                    expectedEventPatterns: [],
                    configDependencies: [],
                },
            }, null, 2),
        ].join('\n');
    }
    async streamText(llm, prompt) {
        let out = '';
        let inText = false;
        for await (const chunk of llm.stream({
            provider: this.options.provider,
            model: this.options.model,
            prompt,
            temperature: 0,
            maxTokens: 8000,
            sessionId: `${this.options.sessionId}:meta-propose`,
        })) {
            if (chunk.kind === 'block-start') {
                inText = chunk.type === 'text';
            }
            else if (chunk.kind === 'block-end') {
                inText = false;
            }
            else if (chunk.kind === 'text-delta' && inText && typeof chunk.text === 'string') {
                out += chunk.text;
            }
            else if (chunk.kind === 'usage' && typeof chunk.usage === 'object') {
                const usage = chunk.usage;
                this.options.onUsage?.({
                    prompt: usage.prompt ?? 0,
                    completion: usage.completion ?? 0,
                });
            }
        }
        return out;
    }
    parseJsonObject(text) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end <= start) {
            throw new Error(`proposer: model output contains no JSON object; head=${JSON.stringify(text.slice(0, 300))}`);
        }
        return JSON.parse(text.slice(start, end + 1));
    }
    normalizePatch(parsed, signals) {
        const patch = parsed.patch;
        if (!patch || typeof patch !== 'object') {
            throw new Error('proposer: missing patch object');
        }
        const targetKind = patch.targetKind;
        if (targetKind !== 'config' && targetKind !== 'tool' && targetKind !== 'skill') {
            throw new Error(`proposer: targetKind must be config|tool|skill, got ${String(targetKind)}`);
        }
        if (typeof patch.targetId !== 'string' || !patch.targetId) {
            throw new Error('proposer: targetId required');
        }
        if (isLockedTarget({ targetKind, targetId: patch.targetId, targetName: typeof patch.targetName === 'string' ? patch.targetName : undefined }, this.options.lockedTargets ?? DEFAULT_LOCKED_TARGETS)) {
            throw new Error(`proposer: target ${patch.targetId} is locked (loop layer)`);
        }
        const action = patch.action === 'insert' ? 'insert' : 'update';
        if (patch.config === undefined || patch.config === null) {
            if (action === 'insert') {
                patch.config = {};
            }
            else {
                throw new Error('proposer: config required for update patch');
            }
        }
        if (!patch.config || typeof patch.config !== 'object' || Array.isArray(patch.config)) {
            throw new Error('proposer: config must be an object');
        }
        const selfCheck = this.normalizeSelfCheck(parsed.selfCheck);
        const expectedTrajectory = this.normalizeTrajectory(parsed.expectedTrajectory);
        const id = `patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const targetName = typeof patch.targetName === 'string' ? patch.targetName : undefined;
        const module = this.normalizeModule(parsed.patch);
        const probes = this.normalizeProbes(parsed.patch);
        const result = {
            id,
            action,
            targetId: patch.targetId,
            targetName,
            targetKind,
            config: patch.config,
            module,
            probes,
            dependencies: Array.isArray(patch.dependencies) ? patch.dependencies.map(String) : [],
            rationale: typeof patch.rationale === 'string' ? patch.rationale : '',
            expectedOutcome: typeof patch.expectedOutcome === 'string' ? patch.expectedOutcome : '',
            expectedTrajectory,
            selfCheck,
            version: typeof patch.version === 'number' ? patch.version : 1,
            createdAt: new Date().toISOString(),
        };
        if (action === 'insert' && module) {
            this.writeStagingFiles(id, module);
        }
        return result;
    }
    normalizeProbes(patch) {
        const value = patch.probes;
        if (!Array.isArray(value))
            return undefined;
        const probes = value
            .filter((item) => Boolean(item) && typeof item === 'object')
            .map((item) => ({
            task: typeof item.task === 'string' ? item.task.trim() : '',
            description: typeof item.description === 'string' ? item.description.trim() : undefined,
        }))
            .filter((item) => item.task && item.task.length <= 300)
            .slice(0, 3);
        return probes.length > 0 ? probes : undefined;
    }
    normalizeSelfCheck(value) {
        const v = (value ?? {});
        const confidence = typeof v.confidence === 'number' ? v.confidence : 0;
        const completeness = typeof v.completeness === 'number' ? v.completeness : 0;
        if (confidence < 0 || confidence > 1 || completeness < 0 || completeness > 1) {
            throw new Error('proposer: selfCheck values must be in [0,1]');
        }
        return {
            confidence,
            completeness,
            summary: typeof v.summary === 'string' ? v.summary : undefined,
        };
    }
    normalizePreferences(parsed) {
        if (!Array.isArray(parsed.preferences))
            return [];
        return parsed.preferences
            .filter((item) => Boolean(item) && typeof item === 'object')
            .map((item) => ({
            scope: typeof item.scope === 'string' ? item.scope.trim() : '',
            value: typeof item.value === 'string' ? item.value.trim() : '',
            sourceRef: typeof item.sourceRef === 'string' ? item.sourceRef : undefined,
        }))
            .filter((item) => item.scope && item.value);
    }
    normalizeTrajectory(value) {
        if (!value || typeof value !== 'object')
            return undefined;
        const v = value;
        const events = Array.isArray(v.events) ? v.events.filter((event) => event && typeof event === 'object') : [];
        return {
            schemaVersion: PROTOCOL_VERSION,
            patchId: '',
            events: events,
            coverage: v.coverage,
        };
    }
    normalizeModule(patch) {
        const value = patch.module;
        if (!value || typeof value !== 'object')
            return undefined;
        const v = value;
        const files = Array.isArray(v.files)
            ? v.files
                .filter((file) => Boolean(file) && typeof file === 'object')
                .map((file) => ({
                path: typeof file.path === 'string' ? file.path : '',
                content: typeof file.content === 'string' ? file.content : '',
            }))
                .filter((file) => file.path && file.content)
            : [];
        const entry = typeof v.entry === 'string' ? v.entry : '';
        if (files.length === 0 || !files.some((file) => file.path === entry)) {
            throw new Error('proposer: insert patch requires module.files and module.entry matching one file');
        }
        return { files, entry };
    }
    writeStagingFiles(patchId, module) {
        const dir = paths.staging(this.options.root, this.options.sessionId, patchId);
        mkdirSync(dir, { recursive: true });
        for (const file of module.files) {
            const filePath = join(dir, file.path);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, file.content, 'utf8');
        }
    }
    writeWorldModel(value) {
        const v = (value ?? {});
        const previous = readJson(paths.worldModel(this.options.root, this.options.sessionId));
        const next = {
            schemaVersion: PROTOCOL_VERSION,
            target: {
                id: '',
                kind: 'config',
                targetId: '',
            },
            behavior: {
                invariants: Array.isArray(v.invariants) ? v.invariants.map(String) : [],
                expectedEventPatterns: Array.isArray(v.expectedEventPatterns) ? v.expectedEventPatterns : [],
                configDependencies: Array.isArray(v.configDependencies) ? v.configDependencies.map(String) : [],
            },
            version: previous ? previous.version + 1 : 1,
            updatedAt: new Date().toISOString(),
            hash: '',
        };
        next.hash = sha256(next);
        atomicWriteJson(paths.worldModel(this.options.root, this.options.sessionId), next);
    }
}
