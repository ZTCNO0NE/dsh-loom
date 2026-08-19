# Builder Evolution Flow Spec

更新：2026-08-18。状态：流程基线；phase 记录与 choice/verification evidence guards 已接入 BuilderKernel。

## 1. 目标

Builder 是开放任务的自主协助者，但开放不等于无流程。它需要一条可回退、可暂停、可向 Actor/用户提问、可请求真实验证的证据生产骨架：

```text
事实 → 假设 → 低成本仿真 → 修正/再仿真 → 提交
                                      ↓
                           verifier → gate → actor replay
```

流程节点不是 Builder 的候选路线白名单，也不是允许边列表。Builder 可以自由读取、编辑、重建、替换、询问、仿真或 abort；Kernel 只禁止明确非法的状态跳跃和权限越界，其余动作默认放行并留痕。

## 1.1 Pass 开始的 evidence-diagnosis

`diagnosis` 不是把“慢、笨、不好用”等主观问题原样塞给 Builder，也不是一份要求 Builder 一次解决的长问题列表。它是由 Actor handoff、近期真实轨迹和确定性 probe 共同生成的**本次 pass 工作单**。

诊断可以列出多个观察到的问题，但必须选出一个 `primaryObjective`；其他问题只能作为 `secondaryObservations`，不得在同一 pass 中同时宣称解决。最小结构如下：

```json
{
  "schemaVersion": 1,
  "diagnosisId": "diag-2026-08-18-001",
  "userIntent": "希望 loop 更智能，能根据真实问题自行演进",
  "problemClass": "convergence",
  "scope": {
    "target": "actor-loop",
    "baselineRef": "profile-before.json",
    "baselineHash": "sha256:..."
  },
  "symptom": "最近 18 个 model turns 中 16 次读取同一内容且无新信息，未形成候选",
  "evidenceRefs": [
    "run-records/builder-progress-state-real-run.json",
    "state/prompt-visible.jsonl",
    "state/progress-state.json"
  ],
  "firstDivergence": "第 3 次 unchanged read 后仍未写 hypothesis 或运行候选相关仿真",
  "primaryObjective": "在代表性任务中更早形成可验证假设并提交候选，同时保持现有契约",
  "successCriteria": [
    "首次 hypothesis 不晚于 6 turns",
    "候选相关 simulation 或 workspace evidence 成功",
    "在预算内产生冻结 proposal",
    "C0-C8/C6 与 verifier/gate/replay 不回退"
  ],
  "nonGoals": ["本 pass 不证明整体延迟提升", "不改变 verifier/gate"],
  "unknowns": ["需要哪种候选改动才能改善收敛"],
  "passBudget": {"modelTurns": 12, "toolCalls": 24},
  "exit": ["fresh report/proposal", "needs_input", "abort with reason"]
}
```

诊断字段的职责：

- `symptom` 只写可观察事实；“慢”必须带时延基线，“不智能”必须落成重复动作、未形成假设、任务失败等轨迹事实；
- `firstDivergence` 指出从哪一个可复现节点开始偏离预期；
- `primaryObjective` 把用户愿望翻译成一个可证伪的 pass 目标；
- `successCriteria` 同时规定改进证据和不可回退的契约/安全条件；
- `unknowns` 只描述当前无法由证据推出的决策，必要时才触发 choice/clarification；
- `passBudget` 和 `exit` 防止“继续观察”变成无界 transcript；
- `nonGoals` 防止一次 pass 把收敛、延迟、可用性和正确性混成一个无法验收的总分。

### “loop 更智能”如何变成明确目标

用户原话可以保持开放，但 pass 不能直接使用“更智能”作为验收条件。Actor/diagnosis 应先依据真实会话选择主要问题类别：

| 主观描述 | 可观测诊断 | 一个合格的 pass 目标示例 |
|---|---|---|
| loop 不智能 | 重复 unchanged read、无 hypothesis、无提交 | 在同一任务和预算内，把首次 hypothesis/候选编辑提前，并产生可冻结 proposal；不降低 verifier/replay 通过率 |
| loop 很慢 | 首 token、工具调用间隔、总时长或成本基线 | 在固定任务集上降低 p50/p95 wall time 或单位成功成本；若只改变并发策略，必须同时报告错误率和语义回归 |
| 用着不顺手 | Actor 无法获知状态、Builder 无法表达阻塞问题、用户反复补充同一信息 | 让 Builder 在缺少产品取舍时发出一次有证据的 choice，并在 resume 后确认选择、改变 nextIntent；不把每一步都变成询问 |
| 经常改错 | verifier rejection、回滚、真实 replay divergence | 针对已知 first divergence 生成一份候选，拒绝报告能被下一 attempt 消化，且错误候选不会越过 gate |

如果从现有证据仍不能选择类别或优先级，Builder 不应自行发明“成功”；它应提交带 `known/unknowns/options/whyNow/evidenceRefs` 的 choice。用户选择后，新 immutable pass 的 `primaryObjective` 必须体现该选择。

因此，“改进 loop 循环更加智能化”通常会被拆成多个 pass：先做**收敛 pass**，再做**任务成功 pass**，最后才做**延迟/成本 pass**。每个 pass 只改变一个主要变量，最终效果由真实 proposal→verifier→gate→replay 证据合并判断。

## 1.2 谁定义和维护 Pass

Pass 采用“固定外壳、可维护内核”的分层，而不是完全由系统定死，也不是完全交给 Builder 自由改写。

### 固定外壳：由 Controller / Actor / Verifier 共同约束

以下字段在 pass 创建后不可被 Builder 静默修改：

- `passId`、`lineageId`、`parentRun`；
- `scope`、target-before hash、baseline/ref 版本；
- 用户原话和 Actor memo（只能追加修正消息，不能覆盖原文）；
- 回合/工具/成本上限；
- 可用 capability、写入边界和禁止触碰的 TCB；
- 必须生成的 artifact 类型、verifier set、gate、replay 要求；
- 用户明确给出的硬约束、安全条件和 non-negotiable acceptance criteria。

这些字段是治理合同，不是 Builder 的认知路线。它们防止 Builder 通过“重新定义问题”逃避验收。

### 可维护内核：由 Builder 在 pass 内持续更新

以下字段允许 Builder 通过公开 artifact 追加新版本：

- `hypothesis`、候选假设及其置信度；
- `known`、`unknowns`、`evidenceRefs`；
- `nextIntent`、实验计划和已观察结果；
- 对症状的解释、候选方案和 `skipReason`；
- 在固定 success envelope 内提出更好的测量方式。

每次更新都写入 `diagnosis-history.jsonl` 或等价 journal，保留旧版本 hash。Builder 可以修正自己的理解，但不能把“尚未证明”写成“已通过”。

### 重大变化：不能在原 pass 内偷偷换题

如果 Builder 发现需要改变以下任一项：

- target 从 Builder 自身改成 actor-loop，或反过来；
- 用户优先级发生变化；
- success criteria / 安全约束发生变化；
- 需要新的 verifier、gate 或更高成本真实验证；

它必须提交 `diagnosis_revision`，说明旧证据、变化原因和新目标。Controller 决定：

1. 保持当前 pass，仅更新 Builder working diagnosis；
2. 请求 Actor/用户 choice；或
3. 关闭当前 pass，创建新的 immutable pass。

因此 Builder 拥有“维护和补充问题理解”的自由，但没有“维护验收合同”的权力。简单的假设修正留在同一 pass；目标、范围或验收标准改变，就进入新 pass。

## 1.3 可选 Diagnosis pass：先对齐方向，再进入改动 Pass

当 Actor/Controller 明确需要先做方向盘点时，可以运行一个**诊断/对齐 pass**。它不是每个开放请求的强制表单：默认 Builder 进入开放 implementation pass，自主判断现有事实能否支持一个安全、可验收的方向；只有无法从事实推出产品优先级、验收目标或高成本验证是否必要时，才通过 `request_input` 向 Actor/用户发起 clarification/choice/verification。

`allowLoopCandidates.diagnosisFirst=true` 是 Controller 明确选择的 diagnosis-only 入口，用于希望先得到方向清单、暂不允许候选的场景；默认关闭。无论入口为何，Builder 的追问能力始终存在，且用户原话、选择和拒绝/错误反馈都会持久化到下一 immutable run。

诊断 pass 的职责只有四件事：

1. 读取 evidence pack、近期真实轨迹和现有报告；
2. 总结已观察到的可优化方向，最多列出 1–3 个优先候选；
3. 对每个方向给出证据、影响、未知项和预计验证成本；
4. 如果方向不能由事实推出，向 Actor 发起一次结构化 choice/clarification，请用户确定大方向；若证据已经足够，也可以不追问并直接在 implementation pass 中提出候选。

诊断 pass 的交付物是 `diagnosis-report`，不是候选 patch：

```json
{
  "kind": "diagnosis-report",
  "userIntent": "希望 actor loop 变得更智能",
  "observations": [
    {"fact": "最近任务出现重复工具读取", "evidenceRefs": ["run:17"]},
    {"fact": "真实任务成功率尚无对照", "evidenceRefs": ["comparison:missing"]}
  ],
  "directions": [
    {
      "id": "convergence",
      "goal": "减少无进展探索并更早形成候选",
      "evidenceRefs": ["run:17", "prompt-visible:17"],
      "unknowns": ["问题来自 Builder 策略还是 actor loop"],
      "cost": "low"
    },
    {
      "id": "task-success",
      "goal": "提高代表性任务的真实完成率",
      "evidenceRefs": ["actor-frames:latest"],
      "unknowns": ["需要固定任务集和 oracle"],
      "cost": "medium"
    }
  ],
  "question": {
    "blocking": true,
    "whyNow": "现有证据不能判断应优先改善 Builder 收敛还是 Actor 任务成功率",
    "options": ["convergence", "task-success"],
    "evidenceRefs": ["diagnosis-report"]
  }
}
```

用户选择后，Actor 将原话和 `selectedOption` 回传，Controller 创建一个新的 immutable implementation pass；该 pass 才拥有明确的 `primaryObjective`、success criteria、预算和 verifier set。诊断 pass 不安装、不修改 live target，也不把“提出方向”冒充成性能提升。

### 不懂就再问，但不能无限追问

Builder 可以在获得新证据后再次请求澄清，但每次必须说明：

- 当前已经知道什么；
- 哪个决策仍不可由事实推出；
- 如果不回答，将采用什么明确的临时假设；
- 该问题为何现在阻塞下一步。

建议对连续 clarification 设置很小的上限（例如 2–3 次）。达到上限仍没有方向时，Builder 应暂停并报告“等待用户选择”，而不是反复读文件或自行编造目标。若用户已经给出可验收目标，则跳过诊断提问，只保留一份简短 diagnosis-report 作为 pass 入口记录。

## 2. 角色边界

| 角色 | 决定什么 | 不拥有的权力 |
|---|---|---|
| Builder | 问题、假设、探索路径、仿真方式、是否提问、是否提交/放弃 | verifier/gate/install；不能把自己的判断标为 verified |
| Actor | 是否委托、把 Builder 问题翻译给用户、转交用户原话、解释进展 | 不能替用户改写选择；不能批准候选 |
| User | 目标优先级、取舍、是否继续高成本验证 | 不能跳过 verifier/gate |
| SimulationRunner | workspace-local 仿真与报告 | 不能批准、安装或修改 live target |
| Verifier | 对冻结 proposal 和证据给出独立 verdict | 不能写 live target |
| Gate | 冷替换、before/after、rollback | 不产生“候选好”的主观判断 |

## 3. Phase 图

```text
created
  → observing
  → hypothesizing
  → baseline_simulating
  → exploring
  → candidate_simulating
  → ready_to_submit
  → submitted
  → awaiting_verifier
  → approved
  → installed
  → replayed

hypothesizing ──需要用户取舍──→ waiting_for_actor
baseline_simulating/candidate_simulating ──仿真不足──→ waiting_for_verification
任何探索阶段 ──证据不足/无价值──→ aborted
rejected/rollback ──报告回注──→ new immutable run(reopened)
```

### 默认节点语义

- `observing`：读取 evidence pack、actor 状态、目标 before、已有报告；确认问题入口。
- `hypothesizing`：写出一个具体问题、可证伪假设、已知事实、未知项和下一步意图。
- `baseline_simulating`：先确认问题/基线行为是否能在 workspace 中重现。
- `exploring`：Builder 可自由修改、重建、换基座、构造 fixture 和运行工具。
- `candidate_simulating`：验证候选是否改变了假设所指向的行为；失败可回到 hypothesizing/exploring。
- `ready_to_submit`：proposal、simulation/evidence refs、rationale 和 target-before hash 冻结完整。
- `waiting_for_actor`：Builder 认为产品方向不能从证据推出，发起 choice/clarification；不伪造默认选择。
- `waiting_for_verification`：Builder 认为仿真无法判断真实 Loader、模型、资源、时序或部署行为，发起外部验证请求。

流程不是每次都必须走所有节点。允许跳过的条件必须写成公开的 `skipReason` 和 evidence refs；是否接受跳过由 capability verifier 决定，而不是 Builder 自己宣布通过。

## 4. Builder 的公开决策记录

“深度思考”不以隐藏思维链或模型轮数定义，而以以下不可变 artifact 定义：

```json
{
  "schemaVersion": 1,
  "problem": "当前 actor 在并发工具调用时存在顺序风险",
  "hypothesis": "保留 isConcurrencySafe 分组并修正 scheduler barrier 可消除风险",
  "known": ["C0-C8 baseline pass", "两个工具声明 concurrency-safe"],
  "unknowns": ["真实 profile 是否保留重叠执行"],
  "evidenceRefs": ["evidence/manifest.json", "artifact/sim-03.json"],
  "nextIntent": "candidate_simulation",
  "confidence": "tentative",
  "whyNotSubmitYet": "尚无真实 profile 时序证据"
}
```

Builder 可以随时修正该记录。Kernel 不评价内容真假，只绑定 hash、时间和 run；Verifier 决定哪些 claim 具备验收效力。

## 5. Actor / 用户请求

### 5.1 方向选择

只有当 Builder 已有 `known/unknown/options/evidenceRefs/whyNow` 后，才发出：

```json
{
  "kind": "choice",
  "questionId": "choice-17",
  "question": "优先保留并发吞吐，还是优先顺序安全？",
  "options": [
    {"id": "throughput", "label": "保留并发", "description": "需要真实性能与安全验证"},
    {"id": "safety", "label": "优先顺序安全", "description": "允许牺牲吞吐"}
  ],
  "whyNow": "源码和低成本仿真无法推出产品优先级",
  "evidenceRefs": ["state/hypothesis.json"],
  "blocking": true
}
```

Actor 把问题解释给用户，用户回复以 raw text + 可选 selectedOption 回传。恢复必须建立新 immutable run，继承旧 run hash 资产，不重放中断副作用。

### 5.2 真实验证请求

Builder 只有在完成 L0/L1 推理或仿真、并公开说明仿真为何不足后，才发出：

```json
{
  "kind": "verification",
  "claim": "候选在真实 profile 中保持安全并发",
  "simulationRefs": ["artifact/sim-03.json"],
  "whySimulationInsufficient": "需要真实 Loader 和模型工具时序",
  "requestedChecks": ["C0-C8", "C6", "cold_reload", "replay"]
}
```

Builder 不能调用 verifier；该请求只是交给 Actor/调度器，由独立 verifier/gate 决定是否执行。

## 6. Kernel 的最小确定性约束（禁止非法，不限制正常探索）

Kernel 不限制 Builder 的探索内容，也不要求它严格依次经过每个 phase；它只禁止以下不可证明或越权的动作：

1. `submit` 前必须存在已冻结 proposal、target-before、message acknowledgements 和 artifact/evidence hash；
2. `choice` 请求必须包含问题、至少两个选项或明确 clarification、whyNow 和证据引用；
3. `verification` 请求必须包含 claim、已尝试的 simulation/evidence 和仿真不足理由；
4. `gate` 只能接受完整、同 hash、未过期的 verifier reports；
5. rejection、rollback、host restart 都创建新 immutable run；
6. 重复反馈可以继续读取，但 Kernel 标记 `newInformation=false`；它可以提供 progress hint，但不强迫 Builder 采用某条路线，也不以固定轮数替代 Builder 判断。

实现状态：`BuilderRunRecord.phase` 将上述证据生产节点作为可观察里程碑持久化到
`run.json`，并以 `state_changed`/journal 事件记录；`write_world_model`、仿真 capability、
workspace 修改、submission draft 和 typed request 会更新对应 phase。phase 不构成允许边，
旧 run 没有该字段时按 state 兼容读取。

### 6.1 实验性无进展断路器

当部署显式开启 `repeatReadRejectAfter` 与 `enforceProgressCheckpoints` 时，连续无新信息的读取会产生一个公开的 `progressRequirement`。`declare_direction` 要求 Builder 写出 `world_model`/`plan`，或主动提问、提交、放弃；完成后立即恢复自由探索。要求会写入 `progress-state.json`、错误 journal 和下一回合 prompt。默认关闭时，既有自由探索语义不变。

这不是把正常探索改成固定有向图，而是只在证据停滞时收取“进度债务”。checkpoint 不能授予 verifier、gate 或 install 权限，提交和放弃仍由原有 Kernel/裁决边界处理。

`request_input(kind=choice)` 现在必须包含至少两个唯一选项；
`request_input(kind=verification)` 必须包含 `whyNow` 与至少一个 `evidenceRefs`。
不满足时 Kernel fail-closed，保留错误反馈供 Builder 下一回合修正。

除上述红线外，未知 capability、未预期的探索顺序、额外 workspace 文件、不同的 hypothesis 组织方式和新的 simulation backend 都不因“未列入流程图”而被拒绝；它们只进入 journal，并在提交/裁决时接受验证。

## 7. Prompt、Kernel、SimulationRunner 还是 LangGraph

三者职责不同：

- **Prompt**：告诉 Builder 使命、默认 phase 语义、何时应该形成 hypothesis、何时提问或请求验证；不能作为唯一约束，因为模型可以忽略。
- **Kernel**：持久化 phase、artifact、hash、权限和非法转移拒绝；这是必须有的确定性骨架，但不负责执行 Python/仿真。
- **SimulationRunner**：共享仿真执行基础设施；可挂接 command/script、IPython 等 backend。backend 失败只产生 simulation `failed/inconclusive`，不改变 verifier/gate 权限。
- **LangGraph 等编排框架**：可以表达条件边、human-in-the-loop 和持久 checkpoint，但不是必须依赖。当前 TypeScript 项目用自己的小型 phase state machine 更轻、更透明，也避免把 capability 逻辑绑定到第三方图模型。

推荐：`Prompt policy + Kernel phase/evidence guards + Capability runtime`。只有当未来需要跨进程长任务、复杂并行分支、定时恢复和多节点调度时，再考虑把 Kernel 的持久执行层迁移到 Temporal/LangGraph；迁移不应改变本规格的事件和 artifact contract。

## 8. 验收案例

最小真实案例必须证明：

1. Builder 读 Actor evidence 后写出 hypothesis；
2. baseline simulation 能复现已知问题；
3. candidate simulation 改变预期行为；
4. Builder 能在方向不明时发 choice，Actor/用户选择后 resume；
5. Builder 认为仿真不足时发 verification request；
6. proposal 经 verifier/gate 冷安装，Actor 真实重跑并保留/回滚；
7. 每个阶段都有可重放 journal 和 hash 证据。
