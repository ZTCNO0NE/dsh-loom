const secretKey = /(api[_-]?key|token|secret|password|authorization)/i;
/** Actor triage: explicit bounded targets go direct; ambiguity and structural work get Builder diagnosis. */
export function routeEvolutionDirection(input) {
    if (input.mode === 'direct')
        return { route: 'direct', reason: 'Actor explicitly identified a bounded Config/Skill target.' };
    if (input.mode === 'diagnose')
        return { route: 'diagnose', reason: 'Actor or user explicitly requested evidence-backed direction diagnosis.' };
    if (input.priorFailed)
        return { route: 'diagnose', reason: 'A prior attempt failed; Builder should re-diagnose the layer before another implementation.' };
    if (input.targetKind && input.targetId?.trim())
        return { route: 'direct', reason: 'The request already identifies one bounded product target.' };
    return { route: 'diagnose', reason: 'The request describes a symptom or cross-layer goal without one bounded target.' };
}
/** Interpret one frozen Builder direction without allowing it to invent a host target identity. */
export function resolveEvolutionDirectionSelection(directions, selectedId) {
    const selected = directions.find((direction) => direction.id === selectedId);
    if (!selected?.id || !selected.goal || !selected.layer)
        return { kind: 'invalid', error: '所选方向不存在或缺少可路由层级；不会猜测执行目标。' };
    const direction = { id: selected.id, goal: selected.goal, layer: selected.layer };
    if (selected.layer === 'no_change')
        return { kind: 'no_change', direction };
    if (selected.layer === 'loop')
        return { kind: 'loop_confirmation', direction: { ...direction, unknowns: selected.unknowns, cost: selected.cost } };
    return { kind: 'product', targetKind: selected.layer, direction };
}
export function directionDiagnosisCard(status) {
    const directions = (status.diagnosisReport.directions ?? []).flatMap((direction) => {
        if (!direction.id || !direction.goal || !direction.layer)
            return [];
        return [{ key: direction.id, layer: direction.layer, goal: direction.goal, unknowns: direction.unknowns ?? [], cost: direction.cost ?? 'unknown' }];
    });
    const waiting = status.state === 'waiting_for_input' && status.diagnosisReport.available && directions.length > 0;
    const failed = status.state === 'aborted' || status.state === 'cancelled';
    const question = status.diagnosisReport.question;
    const directionKeys = new Set(directions.map((direction) => direction.key));
    const reportedOptions = (question?.options ?? []).flatMap((option) => option.id && option.label && directionKeys.has(option.id)
        ? [{ key: option.id, label: option.label, ...(option.description ? { description: option.description } : {}) }]
        : []);
    const options = reportedOptions.length > 0
        ? reportedOptions
        : directions.map((direction) => ({ key: direction.key, label: direction.goal }));
    return {
        phase: failed ? 'not_completed' : waiting ? 'waiting_for_choice' : 'diagnosing',
        headline: failed ? '方向诊断未完成' : waiting ? 'Builder 已提出改进方向' : 'Builder 正在只读诊断改进方向',
        progress: failed
            ? { current: '没有形成可供选择的方向报告。', next: 'Actor 可解释失败并重新发起一次诊断。' }
            : waiting
                ? { current: '方向报告已冻结；尚未创建实现计划。', next: 'Actor 向用户解释差异，用户选择后再创建新的 immutable execution plan。' }
                : { current: 'Builder 正在读取冻结证据并区分 Config、Skill、Loop 或不修改。', next: '形成 1–3 个有证据的方向；本阶段不能编辑、提交或安装。' },
        directions,
        ...(waiting && question?.question ? { question: {
                text: question.question,
                whyNow: question.whyNow ?? '现有事实无法替用户决定产品取舍。',
                options,
            } } : {}),
        controls: waiting ? ['view_status', 'choose_direction', 'cancel_diagnosis'] : ['view_status', 'cancel_diagnosis'],
    };
}
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
