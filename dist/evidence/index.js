import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, paths, PROTOCOL_VERSION, readJson, readJsonl, sha256 } from '../protocol/index.js';
import { buildRuntimeDigest } from '../meta/digest.js';
function rawFile(path) {
    if (!existsSync(path) || !statSync(path).isFile())
        return { exists: false, bytes: 0, lineCount: 0 };
    const content = readFileSync(path);
    return {
        exists: true,
        bytes: content.byteLength,
        lineCount: content.toString('utf8').split('\n').filter(Boolean).length,
        sha256: createHash('sha256').update(content).digest('hex'),
    };
}
function defaultHandoff(options, digest) {
    const clean = (text) => {
        const systemMarker = text.indexOf('<system-reminder>');
        const visible = systemMarker >= 0 ? `${text.slice(0, systemMarker).trim()} [system context omitted; see raw event ref]` : text;
        return visible.slice(0, 2_000);
    };
    const signals = options.signals.length > 0
        ? options.signals.map((signal) => `- ${signal.kind}: ${signal.evidence.map(clean).join(' | ')}`).join('\n')
        : '- 当前没有被确定性规则标记的信号；请从原始帧和用户反馈中自行寻找问题。';
    return [
        '# Actor handoff',
        '',
        '## 用户目标',
        options.requirements.trim() || '(未提供明确目标)',
        '',
        '## Actor/用户观察',
        options.actorAssessment?.trim() || '(未提供额外自然语言观察；以下内容不是模型结论。)',
        '',
        '## 确定性观察',
        signals,
        '',
        '## 当前未知',
        '- 尚未证明根因属于 config、tool、skill、prompt 还是 loop。',
        '- 尚未证明任何候选会改善同一任务的真实轨迹。',
        '- 请读取 manifest 中的原始 frames/events，再决定是否实验或提交。',
        '',
        '## Digest watermark',
        `turns=${digest.turns} toolCalls=${digest.toolCalls} toolErrors=${digest.toolErrors} at=${digest.at}`,
    ].join('\n') + '\n';
}
/**
 * Freeze an index over the actor's current evidence. The original path remains
 * discoverable for broader Builder exploration, while `snapshotPath` is the
 * immutable evidence input used by verifiers and replay. This avoids claiming
 * a frozen pack while reading an append-only live transcript.
 */
export function createActorEvidencePack(options) {
    const digest = buildRuntimeDigest({
        observer: options.observer,
        root: options.root,
        sessionId: options.sessionId,
        currentConfig: options.currentConfig,
        signals: options.signals,
        state: options.state,
    });
    const id = `evidence-${Date.now()}-${sha256({ sessionId: options.sessionId, requirements: options.requirements, digest }).slice(0, 10)}`;
    const dir = join(options.root, 'workspace', options.sessionId, 'evidence', id);
    const configPath = join(dir, 'config-snapshot.json');
    const handoffPath = join(dir, 'actor-handoff.md');
    const redactedConfig = JSON.parse(JSON.stringify(options.currentConfig));
    atomicWriteJson(configPath, redactedConfig);
    const handoff = defaultHandoff(options, digest);
    writeFileSync(handoffPath, handoff, 'utf8');
    const sourcePaths = [
        ['frames', paths.frames(options.root, options.sessionId)],
        ['events', paths.events(options.root, options.sessionId)],
        ['requirements', paths.requirements(options.root, options.sessionId)],
        ['signals', paths.signals(options.root, options.sessionId)],
        ['triggers', paths.triggers(options.root, options.sessionId)],
        ['autopilot-state', paths.autopilotState(options.root, options.sessionId)],
        ['world-state', paths.worldState(options.root, options.sessionId)],
        ['actor-profile', paths.actorProfile(options.root, options.sessionId)],
    ];
    const rawDir = join(dir, 'raw');
    mkdirSync(rawDir, { recursive: true });
    const rawRefs = sourcePaths.map(([name, path]) => {
        const info = rawFile(path);
        const snapshotPath = info.exists ? join(rawDir, `${name}.snapshot`) : undefined;
        if (snapshotPath)
            copyFileSync(path, snapshotPath);
        return { name, path, ...(snapshotPath ? { snapshotPath } : {}), ...info };
    });
    const configInfo = rawFile(configPath);
    const handoffInfo = rawFile(handoffPath);
    const frameRows = readJsonl(paths.frames(options.root, options.sessionId));
    const eventRows = readJsonl(paths.events(options.root, options.sessionId));
    const pack = {
        schemaVersion: PROTOCOL_VERSION,
        id,
        sessionId: options.sessionId,
        createdAt: new Date().toISOString(),
        watermark: {
            frameCount: frameRows.length,
            eventCount: eventRows.length,
            lastFrameAt: frameRows.length > 0 ? frameRows[frameRows.length - 1]?.ts ?? null : null,
        },
        rawRefs,
        deterministicDigest: digest,
        actorHandoff: { path: handoffPath, sha256: handoffInfo.sha256 ?? '', supplied: Boolean(options.actorAssessment?.trim()) },
        configSnapshot: { path: configPath, sha256: configInfo.sha256 ?? '' },
        manifestPath: join(dir, 'manifest.json'),
    };
    atomicWriteJson(pack.manifestPath, pack);
    return pack;
}
/** Read a previously frozen manifest for status/reporting tools. */
export function readActorEvidencePack(path) {
    return readJson(path);
}
