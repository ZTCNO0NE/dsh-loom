const secretKey = /(api[_-]?key|token|secret|password|authorization)/i;
/** Host-owned config rows that are safe to name and freeze into a plan. */
export function eligibleConfigTargetIds(currentConfig) {
    return Object.entries(currentConfig)
        .filter(([, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return false;
        const config = value.config;
        return Boolean(config && typeof config === 'object' && !Array.isArray(config)
            && !Object.keys(config).some((key) => secretKey.test(key)));
    })
        .map(([id]) => id)
        .sort();
}
/**
 * Deterministic preflight before an immutable evidence pack is created. It
 * asks for missing routing intent instead of making the Actor guess tool
 * parameters or persisting an orphan plan.
 */
export function evolutionPlanningClarification(currentConfig, kind, targetId) {
    if (!kind) {
        return {
            question: '你希望把这次改进沉淀成新技能，还是调整宿主已有配置？',
            choices: [
                { key: 'new_skill', title: '生成新技能', summary: '把行为方法沉淀为可独立加载、验证和回滚的 Skill bundle。' },
                { key: 'existing_config', title: '调整已有配置', summary: '只修改宿主已有且不含凭据的 Config 行。' },
            ],
        };
    }
    if (kind === 'skill') {
        if (targetId && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(targetId))
            return null;
        return {
            question: '请为新技能确认一个简短名称；Actor 会把它转换为 kebab-case，用户无需填写内部路径。',
            choices: [{ key: 'name_skill', title: '确认技能名称', summary: '例如“失败证据复盘”可使用 refine-failure-evidence。' }],
        };
    }
    const eligible = eligibleConfigTargetIds(currentConfig);
    if (targetId && eligible.includes(targetId))
        return null;
    return {
        question: targetId ? '刚才选择的配置项不可编辑；请选择一个宿主实际存在的安全配置目标。' : '请选择要调整的宿主配置项。',
        choices: eligible.slice(0, 12).map((id) => ({ key: id, title: id, summary: '宿主已有、可冻结 before snapshot 且不含凭据字段。' })),
    };
}
