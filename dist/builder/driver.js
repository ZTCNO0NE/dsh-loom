import { BUILDER_BASE_TOOLS, BuilderCapabilityRegistry } from './capabilities.js';
import { sha256 } from '../protocol/index.js';
/**
 * Bounded, file-backed builder micro-loop. The LLM selects a decision, while
 * the kernel alone executes tools, records outcomes, and owns terminal state.
 */
export class BuilderDriver {
    options;
    constructor(options) {
        this.options = options;
    }
    async run(kernel, runId) {
        const startedAt = Date.now();
        const maxTurns = this.options.maxModelTurns ?? 8;
        const maxTools = this.options.maxToolSteps ?? 12;
        const maxWallTimeMs = this.options.maxWallTimeMs ?? 120_000;
        let modelTurns = 0;
        let toolSteps = 0;
        while (modelTurns < maxTurns && toolSteps <= maxTools && Date.now() - startedAt <= maxWallTimeMs) {
            const context = kernel.context(runId);
            if (context.run.state === 'submitted') {
                return {
                    state: 'submitted', runId, proposal: kernel.proposal(runId) ?? undefined,
                    modelTurns, toolSteps,
                };
            }
            if (context.run.state === 'aborted')
                return { state: 'aborted', runId, modelTurns, toolSteps, reason: abortReason(context.journal) };
            if (context.run.state === 'paused' || context.run.state === 'waiting_for_input' || context.run.state === 'cancelled') {
                return { state: context.run.state, runId, modelTurns, toolSteps, reason: context.run.state === 'cancelled' ? 'builder run cancelled by actor' : undefined };
            }
            let decision;
            let responseText = '';
            try {
                responseText = await this.stream(this.prompt(context), runId);
                decision = this.parseDecision(responseText);
            }
            catch (error) {
                modelTurns++;
                kernel.append(runId, 'error', 'model_response', {
                    preview: responseText.slice(0, 2_000),
                    responseHash: responseText ? sha256(responseText) : undefined,
                }, error);
                // A malformed decision is feedback to the same persistent loop. The
                // next model turn may correct its JSON; only the normal budget aborts.
                if (modelTurns >= maxTurns) {
                    const reason = `invalid model response at budget: ${String(error)}`;
                    if (kernel.load(runId).state !== 'aborted')
                        kernel.decide(runId, { kind: 'abort', reason });
                    return { state: 'aborted', runId, modelTurns, toolSteps, reason };
                }
                continue;
            }
            modelTurns++;
            try {
                const result = kernel.decide(runId, decision);
                if (decision.kind === 'tool')
                    toolSteps++;
                if (decision.kind === 'submit') {
                    return { state: 'submitted', runId, proposal: kernel.proposal(runId) ?? undefined, modelTurns, toolSteps };
                }
                if (decision.kind === 'abort')
                    return { state: 'aborted', runId, modelTurns, toolSteps, reason: decision.reason };
                if (kernel.load(runId).state === 'paused' || kernel.load(runId).state === 'waiting_for_input' || kernel.load(runId).state === 'cancelled') {
                    return { state: kernel.load(runId).state, runId, modelTurns, toolSteps };
                }
                // A tool failure is deliberately feedback, not a driver failure. The
                // error is journaled by the kernel and appears in the next prompt.
                void result;
            }
            catch {
                if (decision.kind === 'tool')
                    toolSteps++;
            }
        }
        const reason = Date.now() - startedAt > maxWallTimeMs
            ? 'builder wall-time budget exhausted'
            : modelTurns >= maxTurns
                ? 'builder model-turn budget exhausted'
                : 'builder tool-step budget exhausted';
        kernel.append(runId, 'error', 'budget', { modelTurns, toolSteps }, reason);
        if (kernel.load(runId).state !== 'aborted' && kernel.load(runId).state !== 'submitted') {
            kernel.decide(runId, { kind: 'abort', reason });
        }
        return { state: kernel.load(runId).state === 'submitted' ? 'submitted' : 'aborted', runId, modelTurns, toolSteps, reason };
    }
    prompt(context) {
        const journal = context.journal.slice(-10).map((entry) => ({
            seq: entry.seq,
            kind: entry.kind,
            action: entry.action,
            ...(entry.error ? { error: entry.error.slice(0, 500) } : {}),
            ...(entry.result ? { result: compactPromptValue(entry.result, 600) } : {}),
        }));
        const messages = context.messages.slice(-4).map((message) => ({
            id: message.id,
            at: message.at,
            rawUserText: compactText(message.rawUserText, 1_600),
            ...(message.actorMemo ? { actorMemo: compactText(message.actorMemo, 600) } : {}),
            ...(message.evidenceRefs ? { evidenceRefs: message.evidenceRefs.slice(0, 8).map((ref) => compactText(ref, 300)) } : {}),
        }));
        const acknowledged = new Set(context.events
            .filter((event) => event.kind === 'message_ack' && typeof event.payload.messageId === 'string')
            .map((event) => event.payload.messageId));
        const pendingMessages = messages.filter((message) => !acknowledged.has(message.id));
        const capabilities = new BuilderCapabilityRegistry().registerAll(this.options.capabilities ?? []);
        return [
            this.options.systemPrompt,
            '你是持久化 Builder 的一个极简 loop 回合。你可以按需读取输入、全局文件与目录，在自己的 workspace 写多文件，并运行工作区命令获得真实反馈。你自己决定下一步、是否继续探索或何时提交。',
            '你没有 verifier、gate、install 权限；提交只会冻结 proposal，绝不会直接改变 actor、builder 或 loop 的 live target。',
            `Builder 起始工具：${BUILDER_BASE_TOOLS.join(', ')}`,
            '只输出一个严格 JSON decision，禁止 Markdown、解释和额外字段。允许的形式：',
            '硬性回合规则：本轮若尚未收到上一工具的真实反馈，必须先选择 tool；continue 只能紧跟一次工具反馈，不能连续空转。完成最小必要探索后应 write_submission 再 submit；不要用 continue 代替行动。',
            `已注册 capability（仅提供上下文，不限制你的选择）：\n${capabilities.describe()}`,
            'actor input and target-before are already present in the immutable kernel context below; do not repeatedly reread them. Read previous_attempt and previous_run when a rejection exists: previous_run provides read-only paths and hashes for the prior workspace, journal, plan and artifacts. You decide whether to reuse or restart; never treat prior artifacts as automatically approved.',
            'Actor message protocol: `rawUserText` is the user’s original wording; `actorMemo` is a helpful but non-authoritative interpretation. Preserve the distinction. For each new relevant message, call acknowledge_message with your understanding, next action, or a clarification question. You may publish_progress at meaningful phase boundaries; never expose hidden chain-of-thought.',
            JSON.stringify({ kind: 'tool', action: { name: 'read_journal', limit: 20 } }),
            JSON.stringify({ kind: 'tool', action: { name: 'read_input', document: 'previous_attempt' } }),
            JSON.stringify({ kind: 'tool', action: { name: 'read_input', document: 'previous_run' } }),
            JSON.stringify({ kind: 'tool', action: { name: 'read_file', path: '/path/to/source.ts' } }),
            JSON.stringify({ kind: 'tool', action: { name: 'list_directory', path: '/path/to/source' } }),
            JSON.stringify({ kind: 'tool', action: { name: 'write_workspace_file', path: 'notes/idea.md', content: '...' } }),
            JSON.stringify({ kind: 'tool', action: { name: 'read_workspace_file', path: 'notes/idea.md' } }),
            JSON.stringify({ kind: 'tool', action: { name: 'run_workspace_command', command: 'git', args: ['status', '--short'] } }),
            JSON.stringify({ kind: 'tool', action: { name: 'acknowledge_message', messageId: 'message-id', status: 'accepted', understanding: '...', nextAction: '...' } }),
            JSON.stringify({ kind: 'tool', action: { name: 'publish_progress', phase: 'diagnosis', summary: '...' } }),
            JSON.stringify({ kind: 'tool', action: { name: 'request_input', question: '需要用户确认哪一项优先级？', context: '已完成的检查…' } }),
            JSON.stringify({ kind: 'tool', action: { name: 'write_world_model', value: {} } }),
            JSON.stringify({ kind: 'tool', action: { name: 'write_plan', value: {} } }),
            JSON.stringify({ kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'loop-evolution', payload: { id: 'candidate-id', displayName: '...', source: { kind: 'builder-generated', baseline: { uri: '...', ref: '...' }, edits: [] }, packageName: '...', entry: 'lib/index.js', config: {}, expectedOutcome: '...', capabilities: [] }, rationale: '...' } } }),
            JSON.stringify({ kind: 'tool', action: { name: 'write_submission', proposal: { capability: 'patch-evolution', payload: { id: 'patch-id', targetId: '...', targetKind: 'config', action: 'update', config: {}, dependencies: [], rationale: '...', expectedOutcome: '...', version: 1, createdAt: '...' }, rationale: '...' } } }),
            JSON.stringify({ kind: 'continue', summary: '根据刚才工具反馈继续' }),
            JSON.stringify({ kind: 'submit' }),
            JSON.stringify({ kind: 'abort', reason: '证据不足或不能安全提交' }),
            '工具报错和命令的 stdout/stderr 是下一轮可见反馈；由你判断可否纠正、继续或 abort。预检不是 verifier 通过。',
            this.options.draftKind === 'loop_candidate'
                ? '本 run 可将 loop candidate 作为 `loop-evolution` capability proposal。你可先探索来源、源码、构建和测试，再选择提交何种可审计变更。'
                : '本 run 的 draft 是 { patch: MetaPatch, expectedTrajectory, selfCheck, worldModel? }。',
            `任务上下文：\n${this.options.taskContext.slice(0, 28_000)}`,
            'actor 在本 run 开始后的新观察会写入 durable inbox；它们不是命令，你应结合证据自行决定是否调整路线。',
            `内核上下文（不可修改输入）：\n${JSON.stringify({
                run: context.run,
                input: {
                    actor: compactPromptValue(context.input.actor, 4_000),
                    targetBefore: compactPromptValue(context.input.targetBefore, 2_000),
                    previousAttempt: context.input.previousAttempt ? compactPromptValue(context.input.previousAttempt, 2_000) : null,
                    previousRun: context.input.previousRun ? compactPromptValue(context.input.previousRun, 2_000) : null,
                },
                messages,
                pendingMessageIds: pendingMessages.map((message) => message.id),
                journal,
            })}`.slice(0, 28_000),
        ].join('\n\n');
    }
    async stream(prompt, runId) {
        let out = '';
        let inText = false;
        for await (const chunk of this.options.llm.stream({
            provider: this.options.provider,
            model: this.options.model,
            prompt,
            temperature: 0,
            maxTokens: this.options.maxTokens ?? 6000,
            sessionId: `${runId}:builder`,
        })) {
            if (chunk.kind === 'block-start')
                inText = chunk.type === 'text';
            else if (chunk.kind === 'block-end')
                inText = false;
            else if (chunk.kind === 'text-delta' && inText && typeof chunk.text === 'string')
                out += chunk.text;
            else if (chunk.kind === 'usage' && chunk.usage)
                this.options.onUsage?.({ prompt: chunk.usage.prompt ?? 0, completion: chunk.usage.completion ?? 0 });
        }
        return out;
    }
    parseDecision(text) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end <= start)
            throw new Error(`no JSON decision: ${JSON.stringify(text.slice(0, 200))}`);
        const value = JSON.parse(text.slice(start, end + 1));
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('decision must be an object');
        const decision = value;
        const kind = decision.kind;
        // Required fields are strict; harmless model-added metadata is ignored so
        // the micro-loop can recover from ordinary JSON wrappers without narrowing
        // the Builder's exploratory choices.
        if (kind === 'continue' && typeof decision.summary === 'string')
            return { kind, summary: decision.summary };
        if (kind === 'abort' && typeof decision.reason === 'string')
            return { kind, reason: decision.reason };
        if (kind === 'submit')
            return { kind };
        if (kind === 'tool') {
            const rawAction = isObject(decision.action)
                ? decision.action
                : typeof decision.action === 'string'
                    ? { ...decision, name: decision.action }
                    : null;
            if (rawAction) {
                // V4 Flash sometimes emits the tool name as `action` inside the
                // action object. Normalize that harmless wrapper before allowlisting.
                const normalized = rawAction.name === undefined && typeof rawAction.action === 'string'
                    ? { ...rawAction, name: rawAction.action }
                    : rawAction;
                return { kind, action: this.parseTool(normalized) };
            }
        }
        throw new Error('decision does not match the allowlisted protocol');
    }
    parseTool(action) {
        if (action.name === 'read_input' && isOneOf(action.document, ['actor', 'target_before', 'previous_attempt', 'previous_run', 'world_model', 'plan']))
            return { name: action.name, document: action.document };
        if (action.name === 'read_journal' && typeof action.limit === 'number' && Number.isFinite(action.limit))
            return { name: action.name, limit: action.limit };
        if (action.name === 'write_world_model' && isObject(action.value))
            return { name: action.name, value: action.value };
        if (action.name === 'write_plan' && isObject(action.value))
            return { name: action.name, value: action.value };
        if (action.name === 'read_file' && typeof action.path === 'string')
            return { name: action.name, path: action.path };
        if (action.name === 'list_directory' && typeof action.path === 'string')
            return { name: action.name, path: action.path };
        if (action.name === 'write_workspace_file' && typeof action.path === 'string' && typeof action.content === 'string')
            return { name: action.name, path: action.path, content: action.content };
        if (action.name === 'read_workspace_file' && typeof action.path === 'string')
            return { name: action.name, path: action.path };
        if (action.name === 'run_workspace_command' && typeof action.command === 'string' && Array.isArray(action.args) && action.args.every(arg => typeof arg === 'string')
            && (action.timeoutMs === undefined || typeof action.timeoutMs === 'number')) {
            return { name: action.name, command: action.command, args: action.args, ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }) };
        }
        if (action.name === 'acknowledge_message' && typeof action.messageId === 'string' && typeof action.status === 'string' && typeof action.understanding === 'string'
            && (action.nextAction === undefined || typeof action.nextAction === 'string') && (action.question === undefined || typeof action.question === 'string')) {
            return {
                name: action.name,
                messageId: action.messageId,
                status: action.status,
                understanding: action.understanding,
                ...(action.nextAction === undefined ? {} : { nextAction: action.nextAction }),
                ...(action.question === undefined ? {} : { question: action.question }),
            };
        }
        if (action.name === 'publish_progress' && typeof action.summary === 'string'
            && (action.phase === undefined || typeof action.phase === 'string') && (action.question === undefined || typeof action.question === 'string')) {
            return {
                name: action.name,
                summary: action.summary,
                ...(action.phase === undefined ? {} : { phase: action.phase }),
                ...(action.question === undefined ? {} : { question: action.question }),
            };
        }
        if (action.name === 'request_input' && typeof action.question === 'string' && (action.context === undefined || typeof action.context === 'string')) {
            return { name: action.name, question: action.question, ...(action.context === undefined ? {} : { context: action.context }) };
        }
        if (action.name === 'write_submission' && isObject(action.proposal))
            return { name: action.name, proposal: action.proposal };
        if (action.name === 'write_candidate_draft' && isObject(action.proposal))
            return { name: action.name, proposal: action.proposal };
        if (action.name === 'inspect_staging' && typeof action.path === 'string')
            return { name: action.name, path: action.path };
        if (action.name === 'preflight_staging_entry' && typeof action.entry === 'string')
            return { name: action.name, entry: action.entry };
        throw new Error(`tool is not allowlisted: ${String(action.name)}`);
    }
}
function compactPromptValue(value, maxBytes) {
    const encoded = JSON.stringify(value);
    if (encoded.length <= maxBytes)
        return value;
    return { truncated: true, originalBytes: Buffer.byteLength(encoded, 'utf8'), preview: encoded.slice(0, maxBytes - 120) };
}
function compactText(value, maxChars) {
    if (value.length <= maxChars)
        return value;
    return { truncated: true, originalChars: value.length, preview: value.slice(0, maxChars) };
}
function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isOneOf(value, allowed) {
    return typeof value === 'string' && allowed.includes(value);
}
function abortReason(journal) {
    const abort = [...journal].reverse().find((entry) => entry.kind === 'model' && entry.action === 'decision' && entry.result?.kind === 'abort');
    return typeof abort?.result?.reason === 'string' ? abort.result.reason : undefined;
}
