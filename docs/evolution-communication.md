# 进化通讯与沉淀（Evolution Communication & Sedimentation）

> 目标：builder 在后台静默优化时，用户**不被打扰、但能感知**——知道"我的 agent 正在变强、为什么变强、变强了多少"，并且这些成长**可回看、可沉淀、可分享**。

## 设计原则

1. **启动必达、结束必达、过程静默**：开始和结束各一条轻量通知；中间除非超过预算，否则不刷屏。
2. **通知走插件 notice 通道**：通过 `agent.inject` 以 `form: notice` 注入，来源标记为插件，不伪装成用户/模型消息，可追溯。
3. **摘要说人话、带个性化**：不说"update bash-sandbox config"，而说"你上次纠正的格式已被固化，同类任务将自动遵守"。
4. **沉淀必须可读、可导出、可审计**：成长记录是普通文件，用户随时能看，也能打包带走。

## 通道一：即时通知（会话内）

### 启动通知

> 正在后台优化：检测到「{场景一句话，如：同类错误连续发生 3 次 / 这个环节耗时超出预算且进度很小}」。
> 完成会通知你，不影响当前对话。

- 条件：job 真正开始执行时注入（不是排队时）；
- 可配置 `notifyStart`（默认 true），不想要可关。

### 进度通知（低频，可选）

> 优化仍在进行：已超过预估时间，正在补齐「{正在处理的方向}」。你可以继续。

- 仅在超过预估预算（如 2× 预估时长）时发一次，避免刷屏；
- 可配置 `notifyProgress`（默认 false）。

### 完成通知（必达）

> 优化完成：{一句人话摘要}。reload 后生效。

完成摘要模板（带个性化）：

- 能力类：`新增了「{工具/技能名}」：{它能做什么}。`
- 配置类：`调整了「{配置项}」：{问题 → 新值/新策略}。`
- 模型类：`换了更合适的模型：{旧} → {新}（原因：{慢/贵/不匹配}）。`
- 偏好类：`记住了你的偏好：{如"输出不带 markdown"}，同类任务将自动遵守。`
- 指标类：`该环节错误率从 {a}% 降到 {b}%（/ 时延 -{x}% / 成本 -{y}%）。`

### 失败通知（必达）

> 本次优化未通过：{原因，如"核验发现预期轨迹与真实执行不一致"}。已保留现场，可稍后重试。

## 通道二：成长台账（沉淀）

每次进化追加一条记录，位置 `growth/ledger.jsonl`：

```json
{
  "id": "ev-20260816-001",
  "triggeredBy": "S2-progress-deficit",
  "problem": "阶段 2 耗时超预算 3.2×，进度增量 <5%",
  "changes": [
    { "target": "bash-sandbox", "kind": "config", "before": {"timeoutMs": 500}, "after": {"timeoutMs": 10000} }
  ],
  "verdict": "approved",
  "applied": true,
  "metricsBefore": { "toolErrorRate": 0.6, "avgTurnMs": 45000 },
  "metricsAfter": { "toolErrorRate": 0.1, "avgTurnMs": 12000 },
  "rolledBack": false,
  "appliedAt": "2026-08-16T10:00:00Z"
}
```

配套沉淀文件：

- `growth/preferences.json`：用户纠正 / 偏好的结构化沉淀（格式、风格、领域习惯），由改进模型从 `user/message` 纠正中提取，跨会话生效；
- `growth/report.md`：周期总结（见通道三），自动生成；
- 现有 `cost-log.jsonl`、`history.jsonl`、`handoff/` 继续作为原始证据，台账只做聚合视图。

## 通道三：周期总结（沉淀的呈现）

可选"进化小结"（按 epoch / 天 / 周聚合），注入一条通知或写入 `growth/report.md`：

> 本周你的 agent 进化了 {N} 次：
> - 新增技能 {a} 个，修复问题 {b} 类；
> - 工具错误率 {x}% → {y}%，平均回合时延 -{z}%；
> - 记住了 {m} 条你的偏好；
> - 共省 {c}（如 token/成本，有 cost-log 时）。

让"越用越舒服"从感觉变成**可量化、可回看**的东西。

## 用户可见入口

- `meta_status` 增强：返回当前 job 状态（scheduled / running / finished / failed）、最近 N 条进化、指标趋势摘要；
- 新增 `meta_growth`：查看成长台账摘要（次数、场景分布、指标变化、偏好清单）。

## 实现状态

- **已落地（2026-08-16）**：
  - 启动通知（`notify.start`，默认开）："正在后台优化：{原因}。完成会通知你，不影响当前对话。"；
  - 完成通知（`notify.completion`，默认开）："优化完成：{target/kind/verdict/applied}。reload 后生效。"；失败通知必达；
  - `growth/ledger.jsonl`：每次应用进化追加一条（触发场景 S1/S3/S4/S9、问题、改动、verdict、applied、rolledBack）；
  - `growth/preferences.json`：builder 声明偏好时按 scope+value 合并沉淀；
  - `growth/report.md`：人话一行式进化记录；
  - `meta_status` 增强（latestJob + growthCount）、新增 `meta_growth` 工具（台账摘要 + 偏好清单）；
  - 通知开关全部进 Config（`notify.start/progress/completion`），测试 97/97。
- **待做**：超预算进度通知（`notify.progress` 默认关，尚未接实际进度事件）、周期聚合 `report.md`（当前是逐条追加）。
- 所有通知文本与开关进 Config（`notifyStart` / `notifyProgress` / `notifyCompletion`），禁止硬编码。
