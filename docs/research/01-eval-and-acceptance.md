# 评测与验收标准（测试先行）

更新：2026-08-16

状态：草案。阈值待 L5 决策门与用户确认后成为各里程碑完成定义。

## 1. 结论速览

- dsh 官方仓库**没有**现成的 harness 自评测 bench / leaderboard / 数据集；`BENCHMARK.md` 只要求"独立 workspace/session 跑任务"。官方对外基准（Terminal-Bench 2.1 等）是模型+harness 分数，标注用 `minimal` 预设生成，仓库内无数据集与评测脚本。
- dsh **有**可直接复用的评测基础设施：keyless 快照回归（`dsh-acp-snapshot` + `dsh-llm-replay`）、每个 example 的 keyless/with-key 冒烟、`docs/testing.md` 的"验证世界，不验证自报"原则、token-meter 成本计量。
- 自迭代质量的现成衡量方式：**没有公开统一基准**（缺口）。参考口径只有 prime-agent 的 refine 历史/expectedOutcome 记录和 Tycho/ARC 的 RHAE 任务效率评分。因此本项目的量化验收 = 任务级指标 + 回归级指标 + 自迭代质量指标，全部自建。

> 实测注记（2026-08-16）：Terminal-Bench 2.1 本地切片首跑（27b + qwen-coder）已完成：fix-git PASS、overfull-hbox 超时 FAIL（1/2，50%）。细节与本地补丁见 `/chenzute/dsh-src/eval/README.md`。该分数含本地验证脚本偏离（pip 替代 uv），仅作管线验证，不作官方口径。

## 2. 事实与出处

### 2.1 dsh 官方评测现状

| 事实 | 出处 |
|---|---|
| 仓库根只有 3 行 `BENCHMARK.md`：装 Python SDK、跑 jsonrpc-agent 最小变体、独立 workspace/session 跑任务 | `/chenzute/dsh-src/deepseek-harness/BENCHMARK.md` |
| 官方对外基准：Terminal-Bench 2.1（V4 Flash 82.7 / V4 Pro 87.9）、DeepSWE 62.7、CyberGym 83.3，均标注"DeepSeek Harness minimal mode"生成 | 外部报道（orcarouter.ai，2026-08-12）；官方 API 文档标注 |
| 四种预设目录：`standard / minimal / code / cordis`；minimal = 固定 prompt + persistent bash + str_replace_editor，无 compaction | `/chenzute/dsh-src/deepseek-harness/apps/cli/config/agent-presets/` |
| 测试分四层：unit、coverage（逐文件 100%）、real-API e2e（有 key 自跳）、snapshot（无 key 必绿） | `docs/testing.md` |
| "验证世界，不验证自报"：e2e 断言重跑命令/重读文件；未触碰文件要 byte-identical；不允许用 agent 自报关键字过测 | `docs/testing.md`（"Verify the world, not the self-report"） |
| 每个 example 都有 keyless + with-key 冒烟；keyless 用 Loader 起真实 composition 断言输出与干净退出 | `examples/AGENTS.md` |
| `dsh-acp-snapshot`：确定性场景表（input.json + expected stdout + session JSONL + normalizer），record/replay/refresh 三态，keyless | `packages/test-support/acp-snapshot/README.md` |
| `dsh-llm-replay`：从 session.jsonl 重建模型流，无 key；父/子会话按首次调用顺序绑定脚本 | `packages/test-support/llm-replay/README.md` |
| token-meter：每次请求的 token 压力快照（total/surface/基线锚点） | `docs/subsystems/token-meter.md` |
| goal 域：objective + phase（active/paused/blocked/complete），可作为"任务完成"的持久判定 | `docs/subsystems/goal.md` |

### 2.2 ARC-AGI-3 / Tycho（任务效率与验证口径）

| 事实 | 出处 |
|---|---|
| RHAE：`level_score = (human_baseline_actions / ai_actions)^2`，单关上限 1.15；game score = 按关卡序号加权平均（难度越高权重越大）；total = 各 game 均值；完成率限制上限（没打通最后一关最高 66.7% 之类） | docs.arcprize.org/methodology |
| Tycho 结果（Opus 4.8 同预算）：no_world_model 79.07 → single 85.36 → orchestrator 88.49 → trigger 83.07；GPT-5.6 Sol / Opus 5 达 100.00，183 关全通，midrank 98.5/100.0 | NIMI-research/Tycho README；arXiv:2607.28287 摘要 |
| Tycho verifier 指标：simulation_accuracy / strict_simulation_accuracy / first_divergence / prediction_coverage（默认阈值 0.75），no-op 上凭空预测变化判错 | Tycho `tycho/workspace/wmlib_template.py` verify() |

### 2.3 prime-agent（自迭代衡量参考）

| 事实 | 出处 |
|---|---|
| 公开源：PrimeIntellect-ai/prime-agent（"self-improving RLM agent"）；Continual Harness 存 prompt/memory/skill/subagent，`/refine` 读取轨迹做小步、有证据的更新 | `/chenzute/dsh-src/prime-agent/README.md` 行 12、34、40、83 |
| refine 记录 `RefinementResult`：summary、appliedEdits（before/after）、expectedOutcome、rollbackOf、scope；全局 `refinements.jsonl` 追加式，跨会话回滚依据 | `references/background-prime-agent-learn.py`（本工作区笔记，行 52-70、155-158） |
| expectedOutcome 达成/失败是后续 refine 决策输入（"If prior refinements caused issues, rollback or replace…"） | 同上，行 57-59 |
| 无统一数值基准；衡量靠历史留痕 + 用户纠正 + 回归失败信号 | 同上 |

## 3. 候选指标（草案）

### 3.1 任务级（外部断言，借鉴 ARC 效率思想但不照搬）

| 指标 | 定义 | 口径 |
|---|---|---|
| 完成率 | 任务集里外部断言通过的占比 | 断言 = 重跑命令/重读文件/检查持久状态，禁止自报；可借 dsh goal phase=complete 辅助 |
| 任务效率 | 每任务消耗 actions 或 token | token-meter 记录；对照同一任务集的原生 dsh 基线 |
| 效率比 | `baseline_effort / candidate_effort`，参考 RHAE 形状 | 只对"都完成"的任务算，避免鼓励早停 |

### 3.2 回归级（keyless 优先）

| 指标 | 定义 | 口径 |
|---|---|---|
| 快照回归通过率 | acp-snapshot / headless JSONL 场景 replay 后 normalized 对比一致的比例 | 必须 100%；byte-identical 精神 |
| 冒烟通过率 | examples 的 keyless 冒烟 + 最小 with-key 冒烟 | keyless 每次必跑；with-key 每 patch 限量 |
| 配置不变性 | patch 不涉及的配置行 dump-config 逐字节一致 | 防止整行替换误伤 |

### 3.3 自迭代质量（本项目新增）

| 指标 | 定义 | 预期方向 |
|---|---|---|
| 改进率 | meta-loop 处理后，同任务集完成率提升量（Δ success） | >0 且不低于噪声线 |
| 回归率 | 应用后导致任务失败/快照红了的 patch 占比 | 尽量低；M3 前 0 容忍 |
| 对齐指标（validator） | simulation_accuracy / strict / first_divergence / coverage | 完全对齐才 approved；first_divergence 必报 |
| 收敛性 | 同一目标在连续 N 个 epoch 内不再出现同类补丁 | N=2 起步 |
| 回滚成功率 | 冒烟失败后 gate 恢复 before 快照的成功率 | 合成故障注入下 100% |
| 成本收益 | meta-loop 花费 token（propose+validate） vs 节省/改进收益 | 每轮记录 token-meter |

### 3.4 信号级（observer）

| 指标 | 定义 |
|---|---|
| 信号准确率 | 合成故障注入下，归类正确 / 总数（precision） |
| 信号召回率 | 注入的故障被采集到的比例（recall） |
| 阈值触发正确率 | 低于阈值不触发、达到阈值必触发 |

## 4. 候选数据集 / 任务集（第一版最小集）

| 任务集 | 来源 | 本地状态 | 成本 | 用途 |
|---|---|---|---|---|
| acp-agent keyless 快照场景 | dsh `examples/acp-agent/tests/snapshots/` | 在 dsh 源码内 | 0 token | 回归集第一批（text-turn 等确定性场景） |
| headless-agent JSONL 快照 | dsh `examples/headless-agent/` | 在 dsh 源码内 | 0 token | 事件流/会话面回归 |
| 自建 dsh 冒烟集（5-10 个） | 本项目 `meta-regressions/`：文件读写、bash、工具调用、配置替换场景 | 待建 | 0 token（replay）/ 少量（with-key） | 覆盖 config/tool/skill 修改面 |
| Terminal-Bench 2.1 | harbor-framework/terminal-bench-2-1 | **已拉取** `/chenzute/dsh-src/eval/terminal-bench-2-1`（91 任务） | 需 key、容器贵 | M3/M4 进阶验收；效率/成本指标 |
| DeepSWE | datacurve-ai/deep-swe | **已拉取** `/chenzute/dsh-src/eval/deep-swe`（~116 任务） | 需 key、容器贵 | M3/M4 进阶验收；长程编码任务 |
| CyberGym | sunblaze-ucb/cybergym | 框架已拉取；**数据 ~240GB 按需** | 需 key、极贵 | 背景参考，默认不跑 |
| 自迭代 bench（参考形态） | PrimeIntellect-ai/verifiers | **已拉取** `/chenzute/dsh-src/eval/verifiers` | 视环境 | 借鉴"环境 = 数据集 + rollout + reward rubric"设计我们的自迭代评测 |

## 5. 基线

- 主基线：**原生 dsh + 同一 preset + 同一模型 + 同一预算**，跑同一任务集（插件开/关对比）。Terminal-Bench 2.1 / DeepSWE 已本地就绪，可直接对表官方数字（Terminal-Bench 2.1：V4 Flash 82.7 / V4 Pro 87.9，minimal 模式）。
- 参考基线：官方对外分数（Terminal-Bench 2.1 82.7 minimal）仅作背景；不作为本项目验收门槛（数据集不在仓库、需外部 key）。
- 参考口径：Tycho 的 orchestrator 88.49 / 100.00（ARC）与 prime-agent 的 refine 历史，用于设计思路，不直接换算成 dsh 指标。

## 6. 按里程碑的量化验收阈值（草案，待确认）

| 里程碑 | 阈值草案 |
|---|---|
| M1 | `npm run check` 全绿；合成事件 10 个注入下 observer precision=1、recall=1；proposer 在 mock LLM 下产出 schema 合法、单变量、targetKind 受限的 patch；端到端 trace（假信号→候选 patch）跑通；无回归（快照集仍绿） |
| M2 | validator：已知正确 patch 对齐率 100%（回归集 ≥3 场景），已知错误 patch 至少定位 first_divergence 正确；gate 人工应用+回滚在故障注入下 100% 成功；with-key 冒烟限量（每 patch ≤2 任务） |
| M3 | 自动应用：冒烟失败回滚率 100%；改进率 Δsuccess > 0（至少 1 个可修复场景）；无回归（完成率不降）；收敛性：连续 2 epoch 无重复同类补丁 |
| M4 | tool/skill 层回归集扩展覆盖修改面；loop 层只做契约测试不放开；全程 token-meter 留痕 |

## 7. 评测缺口与自建方案

- 缺口：dsh 官方无"自迭代质量"数据集/指标；ARC/Tycho 只覆盖任务效率，不覆盖"改自己改对了没有"。
- 自建最小方案：合成故障注入 + 已知正确/错误 patch 对 + 外部断言任务集 + 对齐指标（Tycho verify 语义），即第 3 节指标与第 4 节任务集。
- 原则：keyless 优先（replay/snapshot 0 成本），with-key 限量；每轮 meta-loop 记账；任何指标必须"外部可复核"，不允许用模型自报。
