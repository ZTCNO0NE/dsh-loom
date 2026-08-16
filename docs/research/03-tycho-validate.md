# Tycho validate（契约级笔记）

更新：2026-08-16。来源：NIMI-research/Tycho `f68912a` + 论文 arXiv:2607.28287。路径相对仓库根。

## 1. 组件边界（docs/ARCHITECTURE.md）

- `tycho/agent`：actor、builder、编排模式、上下文保留、视觉配置；
- `tycho/workspace`：持久证据、工具、可执行世界模型接口、**verifier**、planner、文件版本化；
- `tycho/harness`：ARC 引擎交互、reset/terminal/animation 证据、计分、精确恢复、监督；
- `tycho/serving`：provider 中立工具协议 + Anthropic/OpenAI transports；
- `tycho/viewer`：回放查看，不影响动作与计分。
- 扩展点：只导入 `tycho.serving.llm_client`；`TYCHO_LLM_PLUGIN` 换 transport，`TYCHO_RUNNER_PLUGIN` 换 worker 部署，都不改 prompt/动作策略/计分。

## 2. 可执行世界模型（Executable Model）

- `world_model.py` 定义 `State`、`init_state`、`transition`、`render`、`outcome`，可选 `actions/subgoals/heuristic`（ARCHITECTURE.md）。
- `render` 只允许 `-1` 表示真正未知的格子（UNKNOWN 语义）。
- 工作区预置：`world_model.py`（agent 可编辑）、`wmlib.py`（不可编辑的辅助库）、`verify.py`、`plan.py`（tycho/workspace/wm_templates.py）。
- 模型是 advisory：actor 可以继续探索或直接推理，不强制使用（ARCHITECTURE.md）。

## 3. verifier 判定（tycho/workspace/wmlib_template.py `verify()`，行 567）

输入：`world_model` 模块 + 已记录帧/转移（`frames(root)` / `transitions(root)`）。

流程：对每关 `init_state(grid0, level)` 先独立校验初始渲染；然后从 s0 逐步 `transition + render` 仿真，逐转移与真实帧比对，**不重读真实帧**。

输出指标：

| 指标 | 定义 |
|---|---|
| `simulation_accuracy` | 精确复现的评分转移占比（n_changing 分母） |
| `strict_simulation_accuracy` | 规范 render() 完全一致占比 |
| `cell_accuracy` / `known_cell_accuracy` | 逐格一致率（未知格不计入 known） |
| `prediction_coverage` | 声称的格子占比；低于阈值视为不足（wm_signal.py 默认 `TYCHO_WM_MIN_COVERAGE=0.75`） |
| `first_divergence` | 第一个预测错的转移：{level, turn, action, diff}，diff 精确到格子坐标 |
| `initial_render_ok` / 严格率 | 每关起点是否被复现 |
| `n_false_change_on_noop` | **模型在真实 no-op 上凭空预测变化**——判错（防发明规则） |
| 其余 | `n_observed_changed/n_joint_noop/n_unpredicted_noop/errors` 等诊断 |

关键规则：
- 评分转移 = 真实帧变化 **或** 模型预测变化（no-op 上的假变化也要打分）；
- `UNKNOWN(-1)` 格子不参与 accepted 匹配，但计入覆盖率诊断；
- `transition()/render()` 抛异常 = 该转移失败并记为 first_divergence；
- `render` 形状必须等于真实帧形状（全网格）。

## 4. outcome 验证（`verify_outcome()`，行 1071）

- 对终局单独验证：terminal.json（win 前状态 + 动作 + 终局帧）；重放到 pre-win 状态、施加动作、检查 `outcome()` 是否在真实终局帧上触发 level_complete/game_over（workspace.py 行 241-266）。
- dispatcher 把"在非终局帧上误报 level_complete"等失败以 [verify state] 块回给 actor（tycho/agent/dispatcher.py 行 57-120）。

## 5. 执行期帧级对齐（workspace.py `validated_plan_hint`）

- `plan.py` 产出 `notes/validated_plan.json`：`start`、`actions`、`expected_grid_sha256[]`、`world_model_sha256`、`plan_length`、`status: validated`。
- actor 每步执行前对照真实帧网格 SHA-256 与预期；`world_model.py` 变更后计划暂停（re-plan）；**第一次真实帧偏差即暂停**并提示重新规划（workspace.py 行 599-640）。
- "完全对齐"是字面意义的：网格字节哈希相等，不是近似。

## 6. 四种编排策略（tycho/agent/modes.py）

| policy | wm 变体 | builder 触发 | actor 写 wm | 结果（Opus 4.8 同预算，README） |
|---|---|---|---|---|
| no_world_model | none | 无 | 否 | RHAE 79.07 |
| single | actor 写 | 无 | 是 | 85.36 |
| orchestrator | 独立 builder，actor 拉取 | actor 调 `invoke_builder` | 否 | **88.49（最高）** |
| trigger | 独立 builder，harness 触发 | 验证失败自动修复 | 否 | 83.07 |

- 论文结论：自动修复让模型复现更准（transition match 更高）但 RHAE 反而低——"模型对 ≠ 行动对"；强玩法还要求决定何时构建/修复/使用/绕过模型（active abstraction）。
- 高分组合：GPT-5.6 Sol / Opus 5 + orchestrator → 100.00 RHAE，183 关全通，midrank 98.5/100.0。

## 7. 隔离与完整性（ARCHITECTURE.md "Integrity and Isolation"）

- agent 写的 Python 与可执行模型重放跑在全新 Docker/Finch 容器：**无网络、只读根文件系统、CPU/内存/进程受限、输出受限**，只挂载当前游戏 workspace（可写）。
- `PUBLIC_RELEASE_MANIFEST.json` 记录每个跟踪文件的 SHA-256；验证套件检查摘要、凭据泄漏、配置解析、测试与 wheel。

## 8. 映射到 dsh-meta-validate（结论）

- "真实帧" = dsh 的事件/工具结果/配置树轨迹；"世界模型" = 候选 patch 携带的**预期轨迹**；
- validator 输出应对齐 Tycho：`simulation_accuracy`（逐字段对齐率）、`first_divergence`（第一个分歧点，精确定位）、`coverage`（预期覆盖多少行为面）、no-op 假变化对应"未涉及配置不得变化"（配置不变性检查）；
- 执行期对齐 = 应用后继续用哈希对照真实轨迹，第一次偏差即回滚/暂停；
- 隔离按 §7 原则：回归容器无网络、只读根、workspace 只挂任务目录；
- orchestrator > trigger 的教训：**修改者（proposer）主动提出候选并附带预期，比"验证失败自动改"更好**——支持我们"proposer 先出预期轨迹，validator 独立对齐"的设计。
