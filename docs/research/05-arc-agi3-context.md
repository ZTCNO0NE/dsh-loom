# ARC-AGI-3 背景与验证语义（契约级笔记）

更新：2026-08-16。来源：arcprize/ARC-AGI-3-Agents `4743e7d`、docs.arcprize.org/methodology、Tycho `f68912a`。

## 1. 是什么

- ARC-AGI-3：agent 在从未见过的视频游戏环境中，通过观察帧、采取动作、逐步学会规则并高效通关的交互式基准（方法论页）。
- 本仓库（arcprize/ARC-AGI-3-Agents）是官方 agent 框架：`Agent` 抽象基类 + `EnvironmentWrapper` + 评分卡（README；agents/agent.py）。

## 2. Agent 接口（agents/agent.py）

- `Agent(ABC)`：`choose_action(frames, observation)` 每步选动作；`is_done(frames, last)` 判终；`MAX_ACTIONS=80` 防死循环；`FrameData`（levels_completed / win_levels / available_actions）从 `arcengine` 来。
- 运行：`uv run main.py --agent=random --game=ls20`；`ARC_API_KEY` 走在线 API；`arc_agi` 工具支持本地执行环境。
- 对我们：ARC 的"帧"= `FrameData`（每步环境状态 + 可用动作），这是 Tycho 对齐语义里"真实帧"的来源。

## 3. 评分：RHAE（docs.arcprize.org/methodology）

- 全称 Relative Human Action Efficiency（读作 ray）。
- 动作定义：**对环境的离散交互才算动作**（提交命令/移动/输入）；内部工具调用、推理、重试不计。
- 人类基线：每关多名首次游玩者，取**上中位数**（fewest-actions 排序），不用平均。
- 每关得分：`level_score = (human_baseline_actions / ai_actions) ^ 2`，单关上限 **1.15**（发现捷径可超过人类，但封顶）。
- 每游戏聚合：按 1-indexed 关卡序号加权平均（后关权重更高）；**完成率设上限**（如 5 关只通 4 关，最高 66.7%）。
- 总分：所有 game 分数平均，0-100%。
- 语义：100% = 全通且效率不输人类；1-99% = 完成率 × 效率混合；0% = 一关没通。

## 4. 验证词表（本项目借用的语言）

| 词 | 官方/社区含义 | 本项目映射 |
|---|---|---|
| frame | 每步环境状态（FrameData：grid/score/available_actions） | dsh 的"帧" = 事件/工具结果/配置树快照序列 |
| action | 改变环境的离散交互 | 一次 dsh 工具调用或回合动作（内部推理不计） |
| transition match | 仿真器是否复现观察到的动力学（Tycho 论文） | validator 的逐字段/哈希对齐 |
| exact replay | 精确重放已记录轨迹（Tycho 只允许 exact-replay 模型进 actor 循环） | 回归集 keyless replay（llm-replay/snapshot） |
| RHAE | 效率评分（平方惩罚：10 倍低效 = 1%） | 我们的任务效率比（baseline_effort/candidate_effort，仅对完成任务算） |
| reward | Harbor/验证器输出 0/1（或部分通过） | 任务级外部断言 |

## 5. 对 dsh-meta-validate 的结论

- 任务效率评测可借鉴 RHAE 形状，但不照搬：dsh 任务没有统一人类基线；我们的效率比用"原生 dsh 基线"代替人类基线。
- "内部操作不计动作"提醒我们：validator 对齐的是**行为面/结果**（外部可复核的帧），不是 agent 的内心推理——与 dsh testing.md "verify the world, not the self-report" 一致。
- ARC/Tycho 覆盖的是任务效率与模型对齐，不覆盖"自迭代改对了没有"——自迭代 bench 仍要自建（见 01-eval-and-acceptance.md）。
