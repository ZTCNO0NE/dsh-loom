export const DEFAULT_LOCKED_TARGETS = {
    ids: ['agent', 'agent-loop', 'meta-validate'],
    names: ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop'],
};
export function isLockedTarget(patch, policy = DEFAULT_LOCKED_TARGETS) {
    if (patch.targetKind === 'loop')
        return true;
    if (policy.ids.includes(patch.targetId))
        return true;
    const name = patch.targetName ?? '';
    if (policy.names.includes(name))
        return true;
    return false;
}
