# 监督员触发场景（Supervisor Trigger Scenarios）

> 目的：定义"何时值得唤起一次迭代进化"的可观测、可量化、可收敛的判定模式。
> 原则：触发不是随机的。每个场景都有**证据来源**（帧 / 遥测 / 信号 / handoff）、**可配阈值**、**触发动作**与**收敛语义**；监督员只负责"该不该唤起"，核验器仍然是唯一裁判。

## 场景总览

| ID | 场景（专业话术） | 观测信号 | 实现状态 |
| --- | --- | --- | --- |
| S1 | 重复失败（repeated failure） | 同类工具/代理错误连续 ≥ N 次 | ✅ 已落地 |
| S2 | 进度不足（progress deficit / stagnation） | 阶段耗时/步数超预算且进度增量低于阈值 | 🛠 阈值待定（遥测已支撑） |
| S3 | 用户纠正（user correction / preference drift） | 用户消息含纠正意图，或与既有偏好冲突 | ✅ 已落地 |
| S4 | 回归失败（regression failure） | 既有回归用例失败 | ✅ 已落地 |
| S5 | 回合异常（turn pathology） | 回合超时 / 步骤超限 / 输出重复 / 帧心跳缺失 | ✅ 已落地（stall-abort） |
| S6 | 资源异常（resource anomaly） | 时延分位超标 / token 预算超限 / 成本超预算 | 🛠 记账已支撑，判定待定 |
| S7 | 能力不足（capability insufficiency） | 工具调用错误率高 / 输出合规率低 / 反复重试 | 🛠 遥测已支撑，判定待定 |
| S8 | 领域泛化缺口（generalization gap） | 旧方法论/技能无法覆盖新领域任务 | ✅ 已有实证（from-zero L5） |
| S9 | 用户显式请求（explicit request） | 用户要求改运行时 / 加能力 / 优化成本 | ✅ 已落地（预约式） |
| S10 | 战术迁移（tactic migration） | 曾在别处成功的战术在本场景失效 | 🛠 信号定义待定 |

## S2 进度不足（重点场景）

**场景描述**：一个复杂任务被拆成多个阶段；某个阶段的**实际难度显著超过预期**（如预期的 2 个工具调用却消耗了 12 个），并且持续了超过该阶段预算的时间，而**累计进度增量极小**。此时继续硬跑没有收益，监督员判定存在"能力缺口或复杂度误判"，主动唤起迭代进化。

**判定公式（建议）**：

```
阶段进度不足 ⇔
    stageElapsed / stageBudgetRatio > stageBudgetRatio        // 耗时超过预算 × 系数
    AND progressDelta(stage) < progressDeltaMin                // 阶段内进度增量低于阈值
    AND lastProgressAt + progressStallWindow < now             // 已有一段时间无实质进展
```

**证据来源**：`frames.jsonl`（阶段内工具调用序列与耗时）、`actor-profile.json`（回合时延/调用数）、`handoff/stall.jsonl`（停滞快照）。

**触发动作**：监督员标记 `progress-deficit` → 主动暂停当前回合（如仍在执行）→ 唤起 builder，交付"阶段预算、实际消耗、进度增量、最近帧"打包信息 → builder 判断是补能力、换方案还是改参数。

**收敛语义**：迭代后同一阶段在预算内达到预期进度；或 builder 明确给出"该任务不可行/需降级"的结论并回写。

## 各场景细节

### S1 重复失败（repeated failure）

- **触发条件**：同一签名（工具 + 错误码/消息摘要）连续失败 ≥ `repeatedFailureCount`（默认 3）。
- **证据**：`signals.jsonl`、`trajectory/events.jsonl`。
- **动作**：回合边界唤起 builder；错误证据作为输入。
- **收敛**：升级后同类错误不再出现（回归集新增该用例，形成免疫记忆）。

### S3 用户纠正（user correction / preference drift）

- **触发条件**：用户消息被判定为纠正（直接纠正、否定、或与历史偏好冲突）。
- **证据**：`user/message` 帧、`triggers.jsonl`。
- **动作**：监督员判断是否值得唤起（纠正类消息允许被监督员否决，避免每次聊天都触发）；唤起后 builder 把纠正沉淀为技能/偏好。
- **收敛**：同类任务后续自动遵守纠正后的行为；偏好写入持久化技能或偏好文件。

### S4 回归失败（regression failure）

- **触发条件**：既有回归用例失败 ≥ `regressionFailureCount`（默认 1）。
- **证据**：回归结果、`report.json`。
- **动作**：强制唤起 builder 修复，不允许绕过。
- **收敛**：回归集全绿且保持全绿。

### S5 回合异常（turn pathology）

- **触发条件**（任一）：回合时长 > `maxTurnSeconds`；回合步骤 ≥ `maxStepsPerTurn`；连续输出文本重复 ≥ 3 次；帧心跳缺失 > `noFrameSeconds`。
- **证据**：`frames.jsonl`、`handoff/stall.jsonl`、agent-error 信号。
- **动作**：轮询监督员主动回合级 abort（`keepInbox`）→ 空闲后唤起 builder，交付停滞打包信息。
- **收敛**：新回合在预算内推进；builder 修复了导致空转的能力/配置缺口。

### S6 资源异常（resource anomaly）

- **触发条件**（建议阈值，待定）：P95 回合时延 > `latencyP95Threshold`；单任务 token 消耗 > `tokenBudgetPerTask`；单 epoch 成本 > `costBudgetPerEpoch`。
- **证据**：`actor-profile.json`（时延）、`cost-log.jsonl`（token/成本）。
- **动作**：唤起 builder 做资源调度（换模型、限输出、减重试、调并发/缓存）。
- **收敛**：资源指标回落到预算内且任务质量不退化（verifier 把关）。

### S7 能力不足（capability insufficiency）

- **触发条件**（建议）：工具调用错误率 > `toolErrorRateThreshold`；同一任务重试次数 > `retryCountThreshold`；输出格式合规率低（可由回归/断言度量）。
- **证据**：遥测工具错误率、帧内重试序列、回归断言。
- **动作**：唤起 builder 补工具/技能或调整配置。
- **收敛**：错误率回落、重试减少、断言通过率提升。

### S8 领域泛化缺口（generalization gap）

- **触发条件**：任务来自新领域，actor 沿用了旧方法论但验证证据不足（如只做行数验证、未做 JSON 结构校验）。
- **证据**：任务输出 + 断言失败原因；既有技能覆盖检查。
- **动作**：唤起 builder 产出领域专用技能。
- **收敛**：新领域任务通过且旧领域回归不降（实证：from-zero L5，json-verify 技能）。

### S9 用户显式请求（explicit request）

- **触发条件**：用户要求修改运行时、增加能力、更换模型、优化成本等。
- **证据**：`user/message` 帧 + 请求原文。
- **动作**：预约式后台执行（`scheduled=true` 时立即返回 jobId），完成注入"reload 后生效"通知。
- **收敛**：请求目标达成并通过核验；未达成则回传失败原因。

### S10 战术迁移（tactic migration）

- **触发条件**：同一战术（技能/工具组合）在场景 A 成功、在场景 B 失败。
- **证据**：跨任务战术使用记录 + 失败差异。
- **动作**：唤起 builder 泛化或分化战术（提炼共性 / 增加条件分支）。
- **收敛**：场景 B 通过且场景 A 回归不降。

## 参数命名建议（与 Config 对齐）

```text
repeatedFailureCount        // S1
regressionFailureCount      // S4
maxTurnSeconds              // S5
maxStepsPerTurn             // S5
checkIntervalMs             // S5 轮询周期
stageBudgetRatio            // S2 阶段预算 × 系数
progressDeltaMin            // S2 阶段最小进度增量
progressStallWindow         // S2 无进展窗口
latencyP95Threshold         // S6
tokenBudgetPerTask          // S6
costBudgetPerEpoch          // S6
toolErrorRateThreshold      // S7
retryCountThreshold         // S7
```

## 与现有实现的对应

- **已落地**：S1 / S3 / S4（信号与硬触发）、S5（轮询 + 回合级 abort + handoff）、S9（预约式后台执行 + 完成通知）。
- **数据已支撑、判定待定**：S2（帧 + 遥测）、S6（cost-log + actor-profile）、S7（工具错误率遥测）。
- **信号定义待定**：S10。
- **阈值策略**：所有阈值都应可配、可调，禁止硬编码；收敛语义以"回归全绿 + 目标指标回落"为准。
