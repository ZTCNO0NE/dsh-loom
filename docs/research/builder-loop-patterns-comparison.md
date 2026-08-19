# Builder 循环问题：业界实现对照与 Loom 学习笔记

更新：2026-08-18

这份文档回答一个具体问题：为什么一个能力足够强的模型，在拥有文件读取、状态表、错误反馈和仿真工具后，仍可能连续读取同一文件，最终耗尽回合而不提交？以及其他 agent 系统是怎样避免“循环起来但没有推进”的。

## 先区分四件事

“工具调用没有报错”不等于 Builder 在推进。一次调用至少要分别判断：

1. **可见性**：模型是否看到了事实、上次反馈和持久状态；
2. **信息增量**：这次调用是否产生了新信息或改变了工作区；
3. **语义推进**：模型是否形成了新的假设、选择了方向、产生了可验证候选；
4. **交付推进**：候选是否提交、通过 verifier/gate、真实安装并完成 replay。

当前 Loom 的 `prompt-visible.jsonl` 已经证明第一项成立；`newInformation=false` 已经证明第二项可以被确定性观测；官方 V4 Flash 仍重复 read，说明问题主要发生在第三项，而不是证据包“没送到”。

## 五种常见实现形状

### 1. Tycho：外部验证器驱动的 bounded pass

本地源码：`/chenzute/dsh-src/tycho/agent/builder.py`、`dispatcher.py`、`wm_signal.py`、`workspace/agent_tools.py`。

Tycho 的 Builder 不是泛化地“把系统变好”，而是修正一个单一、可证伪的 world-model 误差。每个 pass 开始前，宿主先运行 verifier，计算 `first_divergence`、diff 和必要帧；Builder 只需要针对这个诊断进行编辑。语义编辑后立即运行同一探针并把结果回传。pass 有硬上限，结束时必须写新的 report；旧 report 不能冒充本轮结果。只有外部 verifier 仍发现 divergence，才创建下一 pass。

关键经验：

- 不把“找问题”全部交给模型；先给一个确定性诊断；
- 工具反馈必须说明“这次改动是否改变了目标性质”，不能只有 exit code；
- 循环边界由外部事实决定，而不是让 Builder 在同一上下文里无限自我重试；
- 持久记忆是源码、notes、report，不是完整 transcript。

### 2. Prime Agent：持久 IPython/RLM + durable harness

本地源码：

- `/chenzute/dsh-src/prime-agent/prime-agent-runtime/src/rlm/harness.py`
- `/chenzute/dsh-src/prime-agent/prime-agent-runtime/src/rlm/mcp_base.py`
- `/chenzute/dsh-src/prime-agent/packages/coding-agent/docs/rlm.md`
- `/chenzute/dsh-src/prime-agent/packages/coding-agent/skills/refine/SKILL.md`

Prime Agent 把模型面对的“工具”收缩为持久 IPython 内核。文件、shell、MCP、skill、子 agent 都通过 Python 程序组合；变量、导入、函数和任务句柄跨工具调用及 compaction 保留。`HarnessState` 把 prompt note、memory、skill、subagent spec 和 refinement event 存为可审计 JSON；本地状态与全局状态分开，文件 mtime 用于避免内核缓存覆盖宿主 `/refine` 的修改。`/refine` 不是当前回合内的强制节点，而是“本回合结束后”进行的一次小型、证据驱动的 harness 修改；修改有历史和 rollback。

Prime 的连续性还来自 daemon：会话、内核、子 agent、心跳和 session artifact 可在终端断开后继续运行和恢复。MCP 工具每次调用重新建立会话，避免快照/恢复后持有失效连接。

它解决的是“状态和能力如何持续存在”，不是“模型一定会选择正确下一步”。README 明确警告：IPython/worker 不是安全沙盒，模型代码拥有进程权限。

可迁移经验：

- 如果 Builder 需要真正探索，持久 workspace/kernel 比不断把全量 transcript 塞回 prompt 更自然；
- 长期状态要拆成事实、记忆、技能和事件，且 local/global 分层；
- refine 应是小步、可回滚、证据驱动的外部更新，不应让 Builder 直接重写自己的 TCB；
- 持久内核改善“能不能继续工作”，不自动改善“是否会收敛”。

### 3. OpenHands SDK：事件溯源 + 专门的 stuck detector

参考仓库：<https://github.com/OpenHands/software-agent-sdk>。

OpenHands 将对话保存为事件流，状态、动作、观察、错误、压缩摘要和用户消息均是可恢复的事件。其 `StuckDetector` 只扫描最近窗口（默认最多 20 个事件），检测多种模式：

- 相同 action + 相同 observation；
- 相同 action 连续报错；
- agent monologue（连续自说自话）；
- action/observation 交替循环；
- context-window error 循环。

达到阈值时先发一次 nudge，告诉模型同一调用不会奏效；如果模式继续，则判定 stuck。它不是按“同一路径是否读过”计数，而是对 action 与 observation 的组合做窗口化模式检测。

OpenHands 还提供 pause/resume、事件状态保存和 conversation fork。其优点是：低价值循环被视为运行时诊断问题，而不是让每个工具自己各自发明一套拒绝规则。

### 4. SWE-agent：动作—观察循环 + requery 与外部 retry

参考源码：<https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/agents.py>、<https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/reviewer.py>。

SWE-agent 的主循环很朴素：模型产生 action，环境执行，observation 回到下一步，并将 trajectory 持久化。它只在格式错误、blocklist、bash 语法错误时进行有限次数 requery；命令超时有连续次数和总时长上限；环境或 API 出错时尝试 autosubmission，而不是无限重试。

更重要的是它把“再试一次”放到外部 `RetryAgent`：一次 attempt 结束并提交 trajectory 后，由 reviewer/chooser 决定是否开启下一次 attempt；下一次 attempt 会 hard reset 环境，单独保存 `attempt_N`，受总成本和最大 attempt 数限制，最后从多个 submission 中选最好的。

可迁移经验：

- 同一 pass 内只处理局部错误；
- 真正的重新思考应是新 attempt，而不是同一上下文中无穷追加错误文本；
- 每次 attempt 都必须留下独立 trajectory 和结果，才能比较“换思路”是否有效；
- 总成本、超时和 attempt 数是外部硬边界。

### 5. LangGraph 与 AutoGen：持久状态机/事件运行时

LangGraph 官方文档：

- <https://docs.langchain.com/oss/python/langgraph/persistence>
- <https://docs.langchain.com/oss/python/langgraph/interrupts>
- <https://docs.langchain.com/oss/python/langgraph/use-time-travel>

LangGraph 用 checkpointer 保存 thread-scoped graph state，用 store 保存跨 thread 的长期事实。`interrupt()` 可以在任意条件下暂停，持久化精确状态，并用同一个 `thread_id` 和 `Command(resume=...)` 恢复；checkpoint 还支持 replay 和 fork。它的强项是生命周期、人工介入和可重放，不是替模型决定语义方向。副作用节点必须可重入/幂等，因为 resume 会从节点开头重新执行。

AutoGen 的 `BaseGroupChat` 采用 runtime 中的消息路由和 termination condition；team/agent 支持 pause、resume、save_state、load_state。终止条件（最大消息数、外部终止等）由运行时持有，handoff 是显式消息，不是模型“想当然地已经交接”。

这两类系统说明：

- “图/phase”最适合做持久化、人工打断、恢复和权限边界；
- 不适合把所有认知步骤写成固定白名单，否则开放探索会退化为填表；
- 状态机应管理生命周期和外部裁决，不应替代 Builder 的假设形成。

## 对照表

| 系统 | 记忆载体 | 反馈形状 | 重复/停滞处理 | 再次尝试由谁触发 | 主要边界 |
|---|---|---|---|---|---|
| Tycho | 源码、notes、fresh report | verifier 的 divergence/diff | bounded pass + fresh report | 外部 `wm_signal` | 单一 world-model 目标 |
| Prime Agent | 持久 IPython + harness JSON + daemon artifacts | Python/MCP 真实返回值 | 依靠持久状态，refine 小步更新 | 用户、daemon、heartbeat、goal | 内核不是安全沙盒 |
| OpenHands | event store + conversation state | action/observation/error event | 窗口化 stuck detector + nudge | conversation controller | 事件窗口和阈值需调参 |
| SWE-agent | trajectory + attempt_N | 环境 observation / error template | 有限 requery、timeout、autosubmit | reviewer/chooser 外部 retry | 每个 attempt 硬预算 |
| LangGraph | thread checkpoint + cross-thread store | node state + interrupt payload | interrupt、checkpoint、replay/fork | graph/controller 或人工 resume | 节点 resume 需幂等 |
| AutoGen | runtime agent/team state | routed event/message | termination condition、pause/resume | runtime/team manager | handoff 必须显式 |

## 为什么“尾插一句强提示”通常不够

尾插提示仍然只是下一次模型输入中的一段文本。它可能被模型看见，但不一定改变 action policy；当前 Loom 的 `prompt-visible` 实验正好证明了这一点。模型可能把“再读一次确认事实”当成更安全的选择，即使反馈已经写着 `newInformation=false`。

确定性拒绝比提示强，因为它改变了可执行结果；但单独拒绝也只会把模型推向下一个低价值工具。当前 checkpoint 实验已经出现“从重复 read 转向 world-model/simulation，但仍未形成候选”的现象。这说明拒绝只能解决**动作层停滞**，不能自动解决**语义层方向**。

## 对 Loom 的结论：不要继续堆 phase 补丁

建议采用一个组合，而不是照搬某一个框架：

```text
确定性 evidence-diagnosis
        ↓
一次有上限的 Builder pass（开放 capability/workspace）
        ↓
fresh builder-report / proposal / needs_input / abort
        ↓
独立 verifier → gate → replay
        ↓
仍有 divergence 或 rejection 才创建新的 immutable pass
```

具体落点：

1. **Pass 开始时给诊断，不让 Builder 先盲搜全局**：至少提供失败任务、first divergence、可复现命令、候选入口、当前 target-before hash 和允许观察的范围。
2. **Builder 仍保持开放**：可读全局、写自己的 workspace、调用 capability、改小改/重建/换基座；Kernel 只管理持久化、预算、取消、消息、提交冻结和权限边界。
3. **每个 pass 必须有新鲜出口**：新的 report、proposal、needs_input 或明确 abort；没有新鲜产物只能记为 incomplete，不能沿用旧 report。
4. **反馈必须与目标绑定**：`simulation` 不应只运行一个与候选无关的 fixture；反馈至少要携带 candidate hash、执行命令、输入、结果和是否覆盖当前 hypothesis。
5. **停滞检测放在 Driver/Controller 层**：按 action+arguments+observation hash 的窗口检测整体模式，先一次 nudge，再结束当前 pass 并交给外部重新触发；不要让每个工具都各自维护重复拒绝计数。
6. **方向不明确时使用持久 interrupt/choice**：Builder 提出带 evidenceRefs 的选择，Actor 翻译给用户；用户回复后恢复同一 lineage 的新 immutable attempt。这个机制应是条件性的，不应每一步都问用户。
7. **把真实“再思考”放在新 attempt**：verifier/gate rejection、真实 replay divergence、用户方向改变或 stuck detector 触发时，创建新 run；继承 workspace、world model、report 和拒绝报告的 hash，但不重放有副作用的工具调用。
8. **IPython 是后续能力，不是死循环修复器**：它能提供 Prime Agent 式持久变量、批量探索和自定义工具组合；但若没有 bounded pass、stuck detector 和外部裁决，IPython 只会让同一策略拥有更大的活动空间。

## 当前 Loom 实验应如何解读

- `progress-state`：证明了紧凑持久状态和可审计恢复，未证明模型会采纳它；
- `repeatReadReject`：证明了可以打破纯 read 循环，未证明候选语义收敛；
- `workspace-simulation`：证明了仿真执行器与对应隔离命令的一致性，未证明高保真真实 loop 结果；
- `choice → resume`：证明了 Actor/用户/Builder 的通信与 immutable lineage，尚未证明选择后一定会形成 hypothesis→simulation→submit；
- `Tycho 对照`：给出了最值得先做的结构实验：`diagnosis → bounded pass → fresh report → external re-trigger`。

因此，当前最合理的下一步不是再增加一个“必须调用某工具”的 phase，而是做一组 A/B：

- A：现有开放探索；
- B：只增加启动时 evidence-diagnosis、pass 结束 fresh-report guard 和 controller 层 stuck detector；
- 保持模型、任务、预算、capability 不变；比较首次 hypothesis、首次候选编辑、提交率、verifier 通过率、真实 replay 率、重复 action 比例和单位成功成本。

只有 B 在真实 proposal→verifier→gate→replay 上改善，才能说 Builder 循环性能提升。

## 参考入口

- Tycho：项目源码 `/chenzute/dsh-src/tycho`，Loom 对照见 `docs/research/tycho-builder-comparison.md`。
- Prime Agent：<https://github.com/PrimeIntellect-ai/prime-agent>，本地 checkout `/chenzute/dsh-src/prime-agent`。
- OpenHands SDK：<https://github.com/OpenHands/software-agent-sdk>，`openhands-sdk/openhands/sdk/conversation/stuck_detector.py`。
- SWE-agent：<https://github.com/SWE-agent/SWE-agent>，`sweagent/agent/agents.py` 与 `reviewer.py`。
- LangGraph：<https://docs.langchain.com/oss/python/langgraph/persistence>、`interrupts`、`use-time-travel`。
- AutoGen：<https://github.com/microsoft/autogen>，`autogen_agentchat/teams/_group_chat/_base_group_chat.py`。
