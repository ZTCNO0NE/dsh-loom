import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
/** Host compiler for a multi-component runtime workspace. The runtime can
 * alter after artifacts only; target identity, graph and before snapshots are
 * all supplied by the controller plan. */
export function compileCompositionWorkspace(workspace, plan) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.id) || !plan.rationale.trim() || !plan.expectedOutcome.trim()) {
        throw new Error('composition plan requires bounded id, rationale, and expected outcome');
    }
    const operations = plan.targets.map((target) => ({
        id: target.id,
        dependsOn: [...(target.dependsOn ?? [])],
        patch: compileTarget(workspace, target),
    }));
    return { capability: 'actor-composition', id: plan.id, operations, rationale: plan.rationale, expectedOutcome: plan.expectedOutcome };
}
function compileTarget(workspace, target) {
    const common = {
        id: `${target.id}-patch`, targetId: target.targetId, targetKind: target.targetKind,
        ...(target.targetName ? { targetName: target.targetName } : {}), dependencies: [], rationale: `composition ${target.id}`,
        expectedOutcome: `composition component ${target.id}`, expectedTrajectory: target.expectedTrajectory, version: 1, createdAt: new Date().toISOString(),
    };
    if (target.targetKind === 'config') {
        if (!target.before)
            throw new Error(`composition config target ${target.id} has no host before snapshot`);
        const file = join(workspace, 'composition', target.id, 'config.json');
        const after = readObject(file, `composition config target ${target.id}`);
        if (JSON.stringify(target.before) === JSON.stringify(after))
            throw new Error(`composition config target ${target.id} has no change`);
        return { ...common, action: 'update', config: after };
    }
    if (!target.entry)
        throw new Error(`composition module target ${target.id} has no entry`);
    const root = join(workspace, 'composition', target.id, 'module');
    const module = collectModule(root, target.entry);
    return { ...common, action: 'insert', config: {}, module };
}
function readObject(file, label) {
    if (!existsSync(file))
        throw new Error(`${label} artifact is missing`);
    try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('not object');
        return value;
    }
    catch {
        throw new Error(`${label} artifact must be a JSON object`);
    }
}
function collectModule(root, entry) {
    if (!existsSync(root) || !statSync(root).isDirectory())
        throw new Error('composition module root is missing');
    const files = [];
    const visit = (directory) => {
        for (const item of readdirSync(directory, { withFileTypes: true })) {
            const file = join(directory, item.name);
            if (item.isDirectory())
                visit(file);
            else if (item.isFile()) {
                const path = relative(root, file).split('\\').join('/');
                const content = readFileSync(file, 'utf8');
                if (!path || path.startsWith('../') || !content || Buffer.byteLength(content) > 256 * 1024)
                    throw new Error(`invalid composition module file ${path}`);
                files.push({ path, content });
            }
        }
    };
    visit(root);
    files.sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0 || files.length > 16 || !files.some((file) => file.path === entry))
        throw new Error('composition module bundle must be bounded and contain its entry');
    return { files, entry };
}
