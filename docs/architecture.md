# 架构设计：第二个验证器驱动的 Harness 自进化

## 1. 设计前提

### 1.1 冷替换是唯一安全路径

agent 不能在自己运行的循环里替换自己运行的循环（自指困境）。执行替换的人必须站在 loop 外面。因此所有修改都走：**预约 -> 回合边界停机 -> 原子切换 -> 冒烟验证 -> 失败回滚**。这与 prime-agent 的 refine 管线（内核预约、宿主执行、before/after 快照、rollback）同构，只是作用对象从 harness 条目换成了运行时组件。

注意：prime-agent 只参考它的**冷替换/回滚机制**；`validate` 的判定方式不学它，学 Tycho（见 2.3）。

角色三分（2026-08-16 定稿）：**builder（迭代者）/ verifier（核验者）/ actor（体验者）**。validator 子系统 = builder + verifier；builder 看用户需求并迭代，verifier 固定式完整核验，actor 只执行/感受/产出真实帧，不自行迭代、不改自己 loop。信息全部走文件（见 2.5、docs/research/08）。

### 1.2 内容进化 ≠ 结构进化

prime-agent 的 refine 只能改四类条目（prompt/memory/skill/subagent）的内容，schema、字段、条目类型、工具清单、处理器全部白名单封死。DeepSeek Harness 把结构层开放成插件，但开放不等于安全进化。本插件补的是"开放之后的治理层"。

## 2. 四个组件

### 2.1 observer（观察）

- 订阅 actor 的事件流（工具调用、失败、用户纠正、compaction、回合统计）。
- 输出 `EvolutionSignal`：类型（repeated_failure / user_correction / regression_failure / reusable_tactic）、证据、关联回合 id、严重度。
- 触发阈值可配置（`repeatedFailureCount`、`regressionFailureCount`），避免修改者频繁出手。
- **三层触发**：L1 actor 主动（`meta.request-validate` 工具）；L2 宿主硬触发（回合边界确定性规则：连续失败、用户纠正、回归失败、预算耗尽、无进展卡死——不经模型判断）；L3 外部兜底（独立 watcher / 手动 CLI）。actor 陷入困境时不能依赖其自唤起。
- **持久化**：信号写 `signals.jsonl`，用户需求投影 `requirements.json`，触发写 `triggers.jsonl`，真实轨迹投影 `trajectory/events.jsonl`（不投影 assistant/chunk 原文）。

### 2.2 builder（迭代者，原 proposer）

- 独立角色 prompt，与 actor 不共享会话状态。
- 输入：用户需求（requirements.json）+ 信号（signals.jsonl）+ 真实轨迹 + 当前组合配置（dump-config / `ctx.loader.entries()`）+ verifier 回炉报告（first_divergence/coverage）。
- 输出 `MetaPatch`：目标行 id（cordis.yml 里的行）、目标类型（config/tool/skill/loop）、新 config、依赖清单、理由、预期结果、版本。
- 候选 patch 必须**自带预期轨迹**（预测的配置树、工具输出、事件序列），供 validator 逐帧对齐；只给结论不给预测的 patch 无法验证。
- **持久世界模型**：builder 维护 `builder/world-model.json`（目标行行为契约：invariants、配置依赖、预期事件模式、version/hash）；迭代 = 读文件 → 提更新 → 写回新版本；上下文里的理解只是草稿，文件才是权威。
- **自我评估提交门槛**：提交前跑确定性自检（同一套固定校验的只读副本）+ 声明 `selfConfidence` / `completeness`，达标才允许进 verifier；自检 ≠ 官方核验。
- 第一版只允许 `targetKind: config | tool | skill`，`loop` 留到验证链路稳定后放开。
- 纪律：一次只改一个变量；改完锁定观察一个 epoch；不叠 patch。

### 2.3 validator（第二个 validate，本插件的核心）

参考实现：**Tycho**（ARC-AGI-3 求解 agent，NIMI-research/Tycho，arXiv:2607.28287）。Tycho 的 validate 不是"独立 LLM 主观审查"，而是 **actor/validate 分离 + 世界模型仿真预测与真实帧的确定性完全对齐**：

- actor 只负责观察、行动、决策；世界模型由 builder 独立构建；verifier 用已记录的真实帧序列从头仿真 `init_state -> transition -> render`，逐转移、逐格比对仿真帧与真实帧。
- 产出 `simulation_accuracy`（精确复现率）、`strict_simulation_accuracy`（规范渲染完全一致率）、`first_divergence`（第一个预测错的转移，精确到格子坐标）、`prediction_coverage`（预测覆盖率，低于阈值视为不足）。模型在真实 no-op 上凭空预测变化也算错，防止发明规则蒙混过关。
- 执行期仍做帧级对齐：计划产物保存每个预期帧的哈希，每步对照真实帧，第一次偏差就暂停计划并重新规划——"完全对齐"是字面意义的，不是"看起来差不多"。

映射到本插件：

- **独立模型实例**：不与 actor 共享模型实例、会话状态、提示词历史。这是防止自我确认偏误的关键。
- **回归集**：`regressionDir` 下的一组任务（任务描述 + 期望结果 + 判定脚本），必须覆盖被修改组件的行为面。
- **对齐式验证**：候选 patch 在隔离环境（临时 profile：`dsh --profile <scratch> --dump-config` 校验组合树后跑冒烟任务）中真实执行，把修改者给出的预期轨迹与真实轨迹**逐字段/哈希完全对齐**；只有完全对齐才 `approved`，第一个分歧点直接作为 `needs_changes` 的证据。
- 输出 `ValidationReport`：verdict（approved / rejected / needs_changes）、对齐指标（对齐率、覆盖率、第一个分歧点）、分数、证据、失败摘要、建议。

v1 决策（2026-08-16 定稿）：

- **verifier 固定式**：verdict 只由确定性对齐 + 回归集 + 配置不变性 + 外部断言决定，**无 LLM 参与判定**；LLM 只出现在 builder（迭代）与 needs_changes 建议（诊断），不进 verdict；第一版不引入 LLM 语义法官。
- **完整验证版本**：每次跑全量指标 + 全量回归集，不抽样；simulation_accuracy/strict 100%、first_divergence 无、coverage ≥ 阈值（默认 0.75）、回归集全过、未涉及行逐字节不变。
- **不通过 = 强制回炉**：rejected 只能回 builder 补完整性，无 force-apply/降阈值放行（由 gate 执行，不依赖 builder 自觉）；带收敛预算 `maxIterations`，超限升级人工。

### 2.4 gate（信任根基 / TCB）

- 预约队列：候选 patch 挂起，不在 loop 内直接生效。
- 回合边界执行器：在一个 actor 回合自然结束时停机、应用、验证、再恢复。
- 原子替换：快照当前行 config（`ctx.loader.entries()` 读）-> baseline 冲突检测（plan→apply 期间被改即拒）-> 写入新 config（`ctx.loader.update` + patch 文件 tmp+rename 持久化）-> 应用后冒烟（keyless 回归子集 + 配置不变性 + expectedOutcome 外部断言）-> 失败自动回滚到快照。版本号递增，历史留痕（history.jsonl + status.json 状态机）。
- 完整性：patch 必须通过签名/哈希校验；验证器、回归集、签名公钥所在路径对 actor 只读。
- 信任边界：**被修改的 actor 永远够不到验证链路**。如果修改者能改验证者，自进化就退化成自我欺骗。

### 2.5 帧与文件优先

- **"帧" = 事件序列 + 配置树 + 外部状态哈希**（session 事件投影、dump-config/loader entries、文件树/关键文件哈希）。
- **上下文不可完全信任**（compaction 丢细节、注意力稀疏、记忆不可靠）：关键状态一律落盘 `$DSH_HOME/meta-validate/`（trajectory/builder world-model/signals/triggers/requirements/patches/history/regressions）；恢复只读文件不依赖 LLM 摘要。
- 所有跨角色文件带 `schemaVersion`、tmp+rename 原子写、before/after 哈希；验证器重放要求 `persistenceCompression: 'none'`。完整目录与信息目录见 docs/research/08 §11-§12。

## 3. 修改者改什么：分层放开

| 层 | 对象 | 风险 | 放开条件 |
|---|---|---|---|
| 配置层 | 插件行 id、参数、开关 | 低 | 第一版就允许 |
| 工具/技能层 | 工具注册、技能组合 | 中 | 配置层闭环稳定后 |
| loop 层 | Agent Loop 实现本身 | 高 | 契约测试 + 回归集成熟后 |

## 4. 收敛纪律

- 修改者只在证据充分时出手（连续 N 次失败、用户明确纠正、回归集固定失败）。
- 一次一个变量，锁定观察一个 epoch。
- 每次应用必须绑定一个可量化的预期结果，验证时对照，防止"越改越忙"。
- 回炉收敛预算：同一候选 `maxIterations` 上限，超限升级人工，不允许无限循环或放行。

## 5. 状态兼容

- 换 loop 不等于换壳丢记忆：旧会话事件流、快照与新 loop 之间要有 schema 契约（版本号 + 迁移函数）。
- 应用任何 patch 前，记录 before/after 快照，保证可回滚。

## 6. 路线图

1. **M0（骨架，已完成）**：类型、接口、目录、配置层，`mode: observe`。
2. **M1**：observer 事件采集 + 三层触发骨架 + 文件持久化（signals/requirements/triggers/trajectory）；builder 独立模型调用 + 世界模型 + 自我评估 + 候选 patch/预期轨迹；合成验证集 A1/A2；`npm run check` 全绿；验收演示（假信号 → 候选 patch trace）。
3. **M2**：verifier 固定式完整验证（A3）+ 回归集 ≥3 keyless 场景 + 隔离执行 + gate 人工确认应用/回滚（A4）；builder 回炉闭环（verifier 不通过强制回炉）。
4. **M3**：gate 自动应用（回合边界执行）+ 应用后冒烟 + 效果对照（B1/B2：Δsuccess、无回归、2 epoch 收敛）。
5. **M4**：放开 tool/skill 层；评估 loop 层契约测试；进阶基准 B4。

## 7. 风险清单

- 验证成本：跑一次回归 = 一轮完整任务 token。用最小回归集 + 冒烟任务控制。
- 验证退化：validator 必须输出可复核的对齐指标（对齐率、覆盖率、第一个分歧点），不能只给一个主观 verdict。
- 信任根基泄漏：任何让 actor 可写验证链路的设计都是泄漏，必须物理隔离（权限、只读、签名）。
- 收敛性：没有预算和早停，meta-loop 会发散。用阈值、epoch 锁定、一次一变量约束。
- 上下文不可信：compaction/注意力稀疏会导致记忆丢失；关键状态必须文件持久化（2.5），恢复不依赖 LLM 摘要。
- 上游破坏性变更：dsh v0.1 是 developer preview，接口会变，插件依赖注入点要收敛在 index.ts。
