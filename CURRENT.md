# CURRENT.md — 当前状态与交接

更新：2026-08-19 01:00（Asia/Shanghai）

## 一句话状态

**`v1.1.0` 已完成双重正式发布**（GitHub release + npm latest）。本轮补齐了 capability runtime registry、共享 `SimulationRunner`、`workspace-simulation` capability 和结构化 clarification/choice/verification 请求；当前工作树 `npm run check`、`npm test`（**173/173**）、`npm run build`、`git diff --check` 已通过。生产与用户 profile 均未触及。

### 2026-08-19 通用溯因导航底座 + 成品 Agent 上游选型

- 不再把 oracle/verifier error 仅作为 prompt 文本回灌。每个 Builder run 新增 `state/provenance.json`：确定性记录 actor/target-before、rejection、prior run/assets、candidate、submission 与 manifest 的 artifact ID/hash/path/producer-consumer-test-report 关系；读取/检查源码时追加 source artifact。详见 `docs/artifact-provenance-navigation-spec.md`。
- 新增开放只读工具：`trace_artifact {artifact}`、`inspect_file {path}`、`search_text {query,roots?,maxResults?}`、`read_input(provenance)`。它们只给关系、接口和检索事实，不生成修复建议；Builder 仍自由决定读/改/仿真/提问/提交/abort，verifier/gate/install 权限没有变化。
- compact prompt 只带 provenance 入口、artifact 数量及当前 failure/candidate ID，完整图按需读；短上下文回归仍低于原 5KB 测试阈值。
- 成品 agent 参考已核：Prime Agent `97b994c3d7c45ca1ae635190e91e9e58ddf2577c`（MIT）是比 Tycho 更合适的开放 Builder runtime 参照；其持久 IPython、host-owned state 和工具语义将以可选 adapter 接入，而不直接嵌入完整 CLI/30+ 依赖或改变 Loom 的独立 verifier/gate。尝试浅拉 OpenHands 官方仓库时 HTTPS 传输持续卡住，已终止临时 clone，未写入仓库。
- 新增 Kernel/Driver 确定性覆盖：rejection→candidate factual trace、接口 inspect、全局文本 search、compact schema；全量 **172/172**、check/build/diff-check 通过。尚未跑官方 V4 Flash 的 graph-only repair 对照，故不声称模型修复收敛已改善。

### 2026-08-19 V4 Flash provenance-assisted oracle repair 复测

- 直接复测（未先跑新的对照）：3 个独立 fresh immutable repair pass；每次均先写入真实失败 candidate、运行 oracle 取得 `TypeError: run is not a function`，再经 `reopenFromRejection` 生成含 failure→candidate、oracle→tests→candidate 的 provenance 图。唯一新增变量为 `trace_artifact`/`inspect_file`/`search_text`/`read_input(provenance)`；其余维持 compact、20 model turns/40 tools/2400 tokens、thinking disabled、repeat-read guard/checkpoint。
- 记录：`/chenzute/dsh-src/eval/run-records/2026-08-19-builder-oracle-rejection-provenance-convergence-rate-official.json`。严格成功条件保持：新 candidate、oracle `strict-order-pass`、`write_submission → submit`。
- 结果 **0/3（0%）**。三次都实际读取了 `provenance`（2/3 首轮读取），prompt-visible 也确认 graph/failure ID 已送达；但没有一次调用 `trace_artifact`、`inspect_file`、`search_text`、workspace edit、oracle command 或 submit。动作退化为 `read_input(provenance|actor|context_index) → write_world_model`，20 turns 后 abort。
- 严格结论：图谱的可见性/持久化/工具可用性已证实，但“模型会主动把图谱转为查询操作”没有证实，且本 case 未改善 repair 收敛。下一步不应把结果包装成提升；需要审计为什么 `read_input(provenance)` 的完整图未能触发 edge traversal，再决定 runtime/tool surface 是否要转向成熟 agent adapter，而不是继续堆文本提示。

### 2026-08-19 builder 0/3 根因：模型从未看见失败原文（已修复，待 A/B）

- 审计结论：compact prompt 只有图谱指针与 hash，`candidate.run is not a function` 原文只藏在 previous-attempt.json；三次 run 均未读 previous_attempt、未 trace，模型从未看到问题文本，动作退化为 read_input→同一 hash 的 write_world_model。
- 修复：compact prompt 注入 rejection facts（failureSummary/previousCandidatePath/oraclePath + "fix the artifact → run oracle → submit"），新增单测；**173/173**。
- 待办：同一 fixture 单跑 V4 Flash fresh repair pass 对照，确认"问题可见"是否改善收敛。

### 2026-08-18 23:15 短上下文 + 无进展跳转 + 用户中途指导闭环实验

- 本轮确定性收缩：compact prompt 保留 durable progress/index、pending 原话和**最近一条压缩真实工具反馈**（上限 1.2KB），不恢复全量 journal/snapshot；无进展断路器在声明一次 `world_model/plan` 后立即恢复自由探索，不再强制下一种工具。
- 另修复三项窄协议问题：兼容 `action.input`/`action.params` 等价包装；解析首个完整 JSON 决策以容忍供应商多余尾 `}`；`run_workspace_command` 的 `args` 可省略（默认为空数组）。`npm test` **169/169**、`npm run check`、`npm run build`、`git diff --check` 全绿。
- 官方 V4 Flash 实验记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-short-context-progress-checkpoint-closed-loop-official.json`；同一明确目标、`compactPrompt=true`、`repeatReadRejectAfter=2`、`enforceProgressCheckpoints=true`、thinking disabled。
- 初始 bounded run 6 回合：断路器触发后 Builder 写出 plan，但仍未候选；预算结束后按真实 immutable 协议创建新 run。用户原话指导“停止重复读取，直接写候选并运行 oracle”被原样写入新 run。
- 第二 run 真实写出 workspace candidate，但 oracle 报 `run is not a function`；这证明用户指导能把动作从重复读取推进到候选编辑，但尚未提交。
- oracle 失败作为 rejection feedback 回注尝试重开第三 run；该 run 再次在目录探索中耗尽预算，未修复、未 proposal、未进入 verifier/gate/install。
- 结论等级：**short-context-observation-and-user-retrigger-proof / candidate-edit-observed / oracle-repair-and-submission-failed**。不能宣称 Builder 已完成闭环或 loop 性能提升；compact context 与断路器只改善可观测停滞处理，不保证语义收敛。
- 当前不再增加 prompt/phase 补丁。下一步若继续，应把 candidate entry/export contract 作为 evidence pack 的明确事实，并单独评估“oracle rejection → fresh pass 修复”收敛率；verifier/gate 仍保持独立裁决。

### 2026-08-18 23:25 oracle rejection → fresh pass 修复收敛率

- 独立实验记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-oracle-rejection-fresh-pass-convergence-rate-official.json`。
- 设计：3 个独立 fresh immutable repair runs；每个都预置同一真实失败 `TypeError: run is not a function`，回注 `previous_attempt`/`previous_run`，`compactPrompt=true`，断路器开启，预算 20 model turns / 40 tool steps / 2400 maxTokens。
- 成功定义：fresh run 写出新候选、oracle exit 0 且输出 `strict-order-pass`，并完成 `write_submission → submit`。verifier/gate/install 不计入本指标。
- 结果：**0/3，收敛率 0%**。三次均未写候选、未运行 oracle、未 proposal；分别触发 5、4、4 次 unchanged-read rejection 后，仍在 `previous_attempt`/`actor`/错误路径间循环至 20 回合预算耗尽。
- 诊断：问题不是回合数不足，而是 Builder 没有把 `run is not a function` 转成“读取旧候选 → 修复导出 → oracle”动作链；断路器只迫使它重复写 world-model/plan，不能让它采用 rejection 的语义修复。
- 结论等级：**oracle-rejection-fresh-pass-convergence-rate = 0/3 (0%)**。当前不能宣称 rejection 回注已具备修复收敛性；不要继续通过增加回合数掩盖动作策略问题。

### 2026-08-18 23:46 V4 Flash thinking-enabled 单次复验

- 为区分“模型无推理预算”与“agent 工具策略”问题，`officialDeepSeekLlm` 新增显式 `thinking: 'enabled' | 'disabled'` 选项；默认仍为 disabled，只有本次隔离评测开启。reasoning chunk 不写入 journal 或用户可见状态，Driver 仍只消费最终 JSON content。
- 同一 fresh oracle-rejection repair 任务、20 turns/40 tools，输出预算提高至 4800；记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-oracle-rejection-fresh-pass-thinking-enabled-official.json`。
- 结果：**0/1**。thinking-enabled Builder 读取 context-index 并尝试 workspace command，但把 `find . -maxdepth 3 -type f | sort` 当作单一 executable（`spawnSync ... EACCES`），随后回到 index/world-model 循环；未写 candidate、未重跑 oracle、未提交。
- 结论：thinking 不是这条链路的充分修复。V4 Flash 对简单代码 bug 未被证明能力不足；这次证明当前 tool representation、previous-candidate 定位和 repair-action policy 仍让它无法把 rejection 转成编辑动作。当前全量 **170/170**、check/build/diff-check 均通过。

### 2026-08-18 diagnosis-first 已实装并完成官方对照审计

- Builder run 新增 `diagnosis | implementation`；开放 loop 请求在 `allowLoopCandidates.diagnosisFirst=true`（默认）时先进入 diagnosis。diagnosis 只允许落 `diagnosis-report.json`（1–3 个 evidence-backed directions + blocking question），随后 `waiting_for_input`；它不能 proposal/submit。Actor 可通过 `meta_builder_status` 查看报告，转交用户原话后 resume 生成同 lineage、带 previousRun 资产的新 immutable implementation run。
- 新增确定性端到端测试覆盖报告结构、诊断禁止提交、模式专属完成合同、status 投影、用户选择→新 implementation run→proposal freeze；当前全量 **162/162**，`npm run check`、`npm run build`、`git diff --check` 均通过。
- 官方 V4 Flash 低预算 A/B（同一错误 loop、同 6 turn/8 tool/1200 token 上限、thinking disabled）：修正前 prompt 内同时有 diagnosis report 与 write_submission→submit 两个冲突完成定义，结果 6 turns、5 read（3 unchanged）、无报告、abort；修正为模式专属合同后，4 turns：ack→读 requirements→读 source→写 diagnosis report，0 unchanged read，`waiting_for_input`。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-diagnosis-first-prompt-contract-ab.json`。
- 严格结论：已证明 **方向诊断/用户对齐改善**，尚未证明选择后的 implementation 收敛、proposal、verifier/gate、安装或 loop 性能提升。下一步：用上述 report 的用户选择（建议 `task-success`）运行一次独立 implementation pass，再按 proposal→裁决→gate/replay 的既有链路评估。

### 2026-08-18 compact prompt / context index 快速试验（默认未开启）

- `BuilderKernel` 新增 `state/context-index.json`，提供所有 durable input/state/workspace 的地址与概述；`read_input(context_index)` 可按需展开。`BuilderDriver.compactPrompt` 仅给流转/通讯/权限、最小 JSON protocol、index 入口、pending 原话、progress 和 feedback hash，不再默认灌入完整索引/长示例/任务正文。
- 官方 V4 Flash 同一模糊取舍任务实测 prompt **3.4–3.8KB**（此前约 12–13KB），但 7 turns 仍未主动 `request_input`，而是重复读 actor snapshot 后 budget abort。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-minimal-user-guided-ambiguity-to-implementation-official.json`。
- 所以只确认“上下文足迹显著降低、compact JSON wrapper 已兼容”，**不**确认 Builder 自主通讯/任务收敛改善；该选项保持实验性、默认关闭。当前确定性测试 **166/166**，`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-18 多系统 Builder 循环审阅（只读）

- 已对照 Tycho、Prime Agent、OpenHands SDK、SWE-agent、LangGraph 与 AutoGen，学习文档见 `docs/research/builder-loop-patterns-comparison.md`；本次未改运行时代码、未跑模型、未触碰生产/profile。
- 统一结论：Prime 的持久 kernel 解决连续性但不保证收敛；OpenHands 的窗口化 stuck detection 适合作为 Driver/Controller 诊断；SWE-agent/Tycho 都把“再试”放到有硬预算的独立 attempt/pass 和外部 reviewer/verifier；LangGraph/AutoGen 的图状态主要适合 checkpoint、interrupt、恢复及权限边界，而不应替 Builder 决定认知路线。
- 下一结构实验应是 `evidence-diagnosis → bounded pass → fresh report → external re-trigger`，而不是继续扩张 Kernel phase 或把某个工具设为必经节点；实验前保持当前断路器默认关闭。

### 2026-08-18 pass diagnosis 规格补充

- 在 `docs/builder-evolution-flow-spec.md` 新增 `evidence-diagnosis` 定义：问题列表可以有多个观察项，但每个 pass 只冻结一个 `primaryObjective`，并绑定 symptom、firstDivergence、evidenceRefs、successCriteria、nonGoals、unknowns、预算和出口。
- “loop 更智能”不再作为直接验收词；应先按真实证据拆成收敛、任务成功、延迟/成本或可用性 pass。若无法从证据推出优先级，Builder 发起带选项和证据的 choice，由 Actor/用户选择后创建新 immutable pass。
- Pass 采用“固定外壳、可维护内核”：Controller/Actor/Verifier 固定 lineage、scope、baseline、预算、权限、required artifacts、verifier/gate/replay 和硬约束；Builder 可版本化维护 hypothesis、known/unknowns、evidence、nextIntent 和实验计划。若改变 target、优先级或验收标准，必须提交 `diagnosis_revision`，由 Controller 保持、询问或创建新 immutable pass，不能静默换题。
- 新增 diagnosis-first 方向：开放目标先运行短诊断/对齐 pass，产出 1–3 个有证据的优化方向和未知项；无法从事实推出优先级时向用户发起 choice/clarification。用户选择后创建新的 immutable implementation pass；连续澄清设小上限，避免无限追问。已有明确可验收目标时仅记录 diagnosis-report，不重复询问。

### 2026-08-18 21:10 无进展断路器与官方复跑

- 新增默认关闭的 `enforceProgressCheckpoints`：连续 unchanged read 被拒后，Builder 必须先公开 `world_model.hypothesis + nextIntent`/plan，再产生 simulation、workspace 命令/编辑、提问或提交；要求、错误与下一意图均落盘到 `progress-state.json`、journal、prompt-visible。默认 `repeatReadRejectAfter=0`、`enforceProgressCheckpoints=false`，不缩小正常自由探索。
- 配置入口已接入 `allowLoopCandidates.repeatReadRejectAfter` 与 `allowLoopCandidates.enforceProgressCheckpoints`；`npm test` **159/159**、`npm run check`、`npm run build`、`git diff --check` 通过。
- 官方 V4 Flash 低预算 A（12 回合）从重复 read 推进到 `write_world_model → baseline simulation → candidate simulation`，但仿真因无候选文件失败而预算中止；B（18 回合）重复进入 3 次 world model + 3 次 simulation，仍未 workspace edit/submission，预算中止。记录见 `docs/research/run-log.md` 与两个 `run-records/2026-08-18-builder-progress-checkpoint-real-run*.json`。
- 结论：节点式确定性约束能消除纯 read 死循环并推进“状态→仿真”，但不能保证模型做出有价值候选。当前瓶颈从工具调用死循环转为低价值仿真/候选关联与提交收敛，不能宣称真实演进或性能提升。

### 2026-08-18 Tycho Builder 源码对照

- 已核查 Tycho `WorldModelBuilder`、`wm_signal`、`dispatcher`、工具执行器与 Builder prompt。Tycho 不靠重复读取拒绝或多级 phase；它依靠单一可证伪目标、启动前自动 verifier diagnosis、语义编辑后即时反馈、bounded pass/fresh report，以及外部 divergence 才重启下一 pass。
- 迁移方向：Loom 下一步应验证 `evidence-diagnosis → bounded pass → fresh builder report → external re-trigger`，而不是继续堆 Kernel 节点。当前二级断路器保留为默认关闭保险丝，三级扩展已撤回；对照记录见 `docs/research/tycho-builder-comparison.md`。

### 2026-08-18 20:15 Compact progress state 落地与官方复跑

- 每个 Builder run 新增公开、可审计的 `state/progress-state.json`：`state`、`phase`、`objective`、`hypothesis`、`known`、`unknowns`、`nextIntent`、`lastAction`、`lastObservationHash`、`unchangedReadStreak`、`pendingMessageIds`。Kernel 在状态迁移、工具反馈、Actor 消息、world-model/plan、提交/回滚边界自动维护；Builder 只能通过公开状态工具声明假设和下一意图，不记录隐藏思维链。
- `read_input` 新增 `progress_state`；Driver 每轮注入 compact state、少量 journal tail 和 hash/入口，不再默认灌入完整 actor/target/journal；`prompt-visible.jsonl` 额外绑定 `progressStateVersion/hash`。`meta_builder_status` 投影 progress state，Actor 可见当前方向与停滞信号。
- 确定性验证：`npm run check`、`npm test`（**158/158**）、`npm run build` 通过；新增 Kernel/Driver 状态恢复测试。
- 官方 V4 Flash 同任务低成本复跑记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-progress-state-real-run.json`。18/18 model turns 仍选择 `read_file`，其中 16 次反馈 `newInformation=false`；无 world-model/plan、simulation、submission，最终预算中止。prompt 平均约 11.6KB（此前审计约 12.9KB），说明上下文确实收缩且状态表被审计，但仅注入 compact state 尚未改变模型 action policy。
- 结论：状态表解决了“每轮恢复记忆依赖全量回放”的结构问题，但不宣称已解决收敛；下一实验应将 `unchangedReadStreak` 与一次性 progress artifact/负向无进展反馈做受控 A/B，再观察是否能进入 simulation→submit，不能直接把本轮算作性能提升。

### 2026-08-18 18:35 Builder flow guards 实装与真机观察

- `BuilderRunRecord` 新增可观察 `phase`（observing/hypothesizing/simulation/exploring/waiting/ready/submitted 等）；phase 只记录证据生产里程碑，不构成探索白名单，旧 run 可兼容读取。
- Kernel 已接入最小负向约束：`choice` 请求至少两个唯一选项、`whyNow` 与 evidenceRefs；`verification` 请求必须提供 `whyNow` 与 evidenceRefs；非法请求 fail-closed 并把错误反馈留在 journal，正常探索路径不受限制。
- 新增 Kernel 测试覆盖非法请求与 phase，当前 `npm test` **154/154**（本轮单测）/ 全量基线其余均绿，`npm run check`、`npm run build`、`git diff --check` 通过。
- 官方 V4 Flash 仿真 Builder 复跑记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-phase-guard-real-run.json`。18 model turns/18 tool steps 仍重复读取 requirements/actor source，未写 world-model、未调用 simulation、未提交；最终预算中止。结论：phase/evidence guards 已确定性生效，但不能替模型形成方向；当前智能化瓶颈仍是开放任务的策略收敛，需要下一轮 Actor choice/clarification 或更明确的可验证目标实验，不能宣称 Builder 已完成演进。

### 2026-08-18 18:45 Builder 方向缺失自识别实验

- 无提示式缺证据案例：Builder 在 1 model turn 内自行 abort，理由为“无源码、无 oracle、无用户偏好，无法安全提交改进候选”。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-direction-awareness-no-explicit-ask.json`。这证明它能识别信息/方向不足，但当时选择放弃，没有主动请求 Actor。
- 有源码、可仿真但产品取舍冲突案例：在没有直接命令“请提问”的前提下，Builder 读取源码和 requirements 后第 3 回合主动发出 `request_input(kind=choice)`，提出“优先吞吐还是优先严格顺序”，带 `whyNow`、`evidenceRefs`、`blocking=true`，进入 `waiting_for_actor`。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-direction-choice-no-explicit-ask.json`。
- 结论：Builder 已具备“知道方向不足”的能力；是否把缺口转成 Actor 通讯取决于任务是否仍有可探索证据。当前最小闭环已经成立：识别缺口 → 结构化 choice → Actor 转交用户 → resume。尚未做用户选择后的第二 run、仿真和提交。

### 2026-08-18 19:00 choice→resume 后续验证

- 真实两阶段记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-direction-choice-resume-e2e.json`。
- 第一 run：3 turns/3 tools，自主发出 choice，进入 `waiting_for_actor`。
- Actor 原样转交用户原话“优先吞吐，但不得牺牲安全契约”，并携带 `selectedOption=throughput`；第二 run 为新 immutable run，`previousRun` 带旧 workspace/journal/assets hash。Builder 首轮 `message_ack` 正确理解为“throughput-first while preserving safety contract”。通讯、选择保真、跨 run 继承均通过。
- 第二 run：8 turns/8 tools；重复读取已知 source/requirements，执行一次无关 `probe`，没有 `write_world_model`/`write_plan`/`invoke_capability(workspace-simulation)`/`write_submission`，最终预算中止。故本次不能证明 hypothesis/nextIntent 改变、仿真或提交成功；结论为 **choice-delivery-and-resume-proof / post-choice-convergence-failed**。

### 2026-08-18 19:20 prompt-visible 审计

- 新增 `state/prompt-visible.jsonl`：每回合保存脱敏后的实际 prompt、原始 hash/bytes、run state/phase、上一工具反馈 hash、pending message ids；不保存隐藏思维链。`previousRun` 资产清单也继承该证据文件。
- 真实复跑记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-prompt-visible-audit.json`；prompt 从 9,641 bytes 增长到约 13,307 bytes。Builder 第一轮已经看到错误 actor source 和 requirements，后续 prompt 明确包含 `observation.newInformation=false`、`unchangedSinceSeq`、完成定义“形成 hypothesis→simulation→submit”以及工具错误反馈。
- 但 18 回合中 requirements 被读取 14 次、actor source 4 次；重复 read 的 prompt 仍包含上一反馈和“不要重复读取”提示。说明不是输入不可见，而是模型在看到完整事实和无新增反馈后仍选择 read_file；当前最可能是模型 action policy/上下文注意力偏置，而非 evidence pack 缺失。

### 2026-08-18 19:35 progress banner vs Kernel reject A/B

- 新增实验开关：`BuilderDriver.progressBanner`（仅文本提示）与 `BuilderKernelOptions.repeatReadRejectAfter`（确定性拒绝 unchanged read；默认关闭，保持自由探索兼容）。新增测试后全量 **156/156**。
- 同一任务、同模型、同回合预算真实 A/B 记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-progress-ab-comparison.json`。
- A banner-only：10 turns/10 tools，4 次 source/requirements 读取（2 次 unchanged），0 simulation；产生 2 次 proposal draft，但未最终 submit，预算 abort。
- B Kernel reject（阈值 2）：10 turns/10 tools，4 次读取（2 次 unchanged）；重复 `read_workspace_file` 被 Kernel 明确拒绝后，Builder 转向 `write_workspace_file`/读取候选 workspace，未 simulation/submission，仍预算 abort。
- 结论：文本 banner 有一定帮助但不能强制切换；Kernel reject 能改变动作分布（从重复读取转向 workspace 写入），但单独仍不足以保证 simulation→submit。需要下一轮把 reject 后的错误反馈与最小 progress artifact/phase 绑定，再比较是否真正提高提交率。

### 2026-08-18 13:40 本轮收口（针对 1/5/6/7）

- 裁决、import、install/gate 异常统一转为带 proposal/error 的 `rejected`，进入 immutable reopen，不再静默落为 job `failed`。
- 宿主重载会把遗留 `scheduled/running` job 安全标记为 `interrupted`，保留 run/journal/evidence，避免持久状态谎称仍在执行；actor 可重新委托。
- comparison 增加 `rollbackRequired`，要求 rollback 证据时缺失即 `admissible=false`；普通同任务 replay 明确标记 rollback 不在本次比较范围。
- Builder 重复工具调用只在连续反馈完全不变达到阈值时终止；工作区内容变化时允许继续探索。
- 当前仍有未跟踪临时文件 `.tmp-e2e-overlay.yml`，提交前需清理或转成正式实验资产。

### 2026-08-18 15:30 Actor ↔ Builder 持久会话（协议已收口）

- `meta_auto` 现在返回 `builderSessionId`（当前等同 jobId）；`meta_builder_message` 可分别保存 `rawUserText`、`actorMemo`、`evidenceRefs`，旧 `message` 字段兼容保留。
- 新增 `meta_builder_events(afterSeq, limit)`：Actor 读取生命周期、工具完成/失败、Builder `message_ack`、`builder_update`、proposal draft 等可审计摘要，再向用户解释；不输出隐藏思维链。
- Builder 新增 `acknowledge_message` 与 `publish_progress` 工具。用户/Actor 的语义保持开放；固定的只有传输、审计、取消与 verifier/gate/install 权限边界。
- rejection 与 host-restart resume 的新 immutable run 带 `previousRun`：旧 workspace/journal/world model/plan/events/submission 的路径与 hash 清单，供 Builder 自主只读复用。`meta_auto(exploreLoop=true, resumeJobId=...)` 会建立这种安全续接，而不重放中断时的副作用。
- 消息使用 Actor 稳定 `idempotencyKey` 去重；同 key 不同内容 fail-closed。`meta_builder_events` 返回 `${lineageId}:${runId}:${seq}` composite cursor，run 切换自动 `reset=true`，不会因 seq 重用漏事件。
- `submission/manifest.json` 绑定 proposal、input、target-before、evidence/artifact hash；提交前若任一冻结内容变化即拒绝。
- Kernel/Driver/Gateway 已覆盖 pause/cancel/resume 与 `request_input → needs_input`；resume 会保留旧 run 只读资产并重新走同一后台 executor。下一步只需做一次隔离 Actor 真机多轮演示，不再扩张协议边界。
- 已完成一次真实官方 Builder 多轮中途指导实验：证据见 `docs/research/run-log.md` 与 `/chenzute/dsh-src/eval/run-records/2026-08-18T074405558Z-real-actor-builder-mid-guidance.json`。通信、pause→immutable resume、原文/memo 保真均通过；Builder 因相对源码目录探索失败和回合预算耗尽未提交 proposal，故没有 verifier/gate/安装或性能提升结论。后续应先补“源码根目录/候选入口”上下文，再重跑同一案例。
- 已补跑带明确源码根目录/候选入口的复验：`/chenzute/dsh-src/eval/run-records/2026-08-18T074750285Z-real-actor-builder-mid-guidance-rooted.json`。路径问题消失，但 Builder 仍在 18 回合内重复读取/回执而未提交，确认当前剩余瓶颈是模型收敛与提交纪律；不得据此宣称真实演进或性能提升。

### 2026-08-18 16:50 仿真能力与 Builder 复测

- `src/builder/capabilities.ts` 新增 runtime registry；`BuilderKernel` 只负责 capability tool dispatch、journal 和权限边界，`loop-evolution` 与 `workspace-simulation` 均以 capability 注入。
- `src/builder/simulation.ts` 新增共享 `SimulationRunner`：固定 workspace、fixture hash、命令反馈、reset-safe 文件边界、simulation report 和 `compareSimulationToReal`。仿真结果只有 `passed/failed/inconclusive`，不能直接变成 verifier approval。
- 结构化 `request_input` 现在支持 `clarification | choice | verification`、options、whyNow、evidenceRefs、blocking；Actor 可把 Builder 的方向问题交给用户，再以原话恢复新 immutable run。
- 仿真/隔离真实对照记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-workspace-simulation-real-consistency.json`。同一 actor contract 的 3 个案例 exit/stdout/stderr 完全一致，claimLevel 仅为 **mechanism-consistent**，不代表 DSH live loop 高保真。
- 重新运行官方 V4 Flash Builder（18 turns/36 tool budget，已注册 workspace-simulation）仍在 18 turns 内重复读取 requirements/source，未调用 simulation、未写 submission、未进入 verifier/gate；记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-simulation-capability-real-run.json`。结论：工具环境已能提供仿真入口，但开放任务仍缺方向收敛；下一步是用真实 `choice/clarification` 进行 Actor→用户→Builder 多轮指导实验。
- 官方 Builder 的最小不可判定选择实验已在 1 turn 进入 `waiting_for_input` 并发出 `needs_input(kind=choice)`，记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-official-clarification-request.json`。它证明真实模型可触发协议；该次 options 沿用 prompt 示例，尚不证明模型能根据证据生成高质量问题。下一实验必须让 Actor 回传用户选择、resume 新 immutable run，并检验该选择是否实际改变 Builder 路线。
- 对 `builder-simulation-capability-real-run` 完整 journal 的复核：18/18 tool steps 全是外部 `requirements.json`（15 次）或错误 actor source（3 次）`read_file`；没有 `read_input(world_model|plan|journal|previous_attempt)`、`write_plan`、`write_world_model`、`write_workspace_file`、`run_workspace_command`、`invoke_capability` 或 `request_input`。Builder 收到 immutable context 但没有形成可观察的世界模型/计划；当前行为更像“重复寻找下一段文本”而非 Tycho 式持续建模。`BuilderDriver` 已新增 prompt/context fingerprint journal（不记录思维链），下一次可区分模型看到了什么与它实际选择了什么。
- 上层使命 prompt、`newInformation=false/unchangedSinceSeq` 重复读取反馈接入后复跑，结果仍为 18 turns/18 reads/无 simulation/无 submission。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-mission-unchanged-feedback-rerun.json`。Builder 实际看到了“没有新增信息”但仍未改变策略，说明仅靠自然语言使命和提示性反馈不能保证收敛；下一步需要 Actor 澄清或确定性 progress transition，而不是继续堆 prompt 文案。
- 已冻结流程设计基线：`docs/builder-evolution-flow-spec.md`。采用 Prompt policy + Kernel phase/evidence guards + Capability runtime：默认事实→假设→基线仿真→候选仿真→提交→verifier→gate→replay；方向选择和真实验证请求是条件节点，不是每次固化必走。深度思考以公开 hypothesis/known/unknown/evidence/nextIntent artifact 定义，不记录隐藏思维链。

### 2026-08-18 v1.1 减法定稿（docs/v1-1-route.md）

- 唯一入口：`meta_auto(exploreLoop=true, requirements, actorAssessment)`；后台 job 先冻结三层 evidence pack（manifest+digest+handoff），Builder 读原始文件自由探索；
- 裁决：patch → Validator + Gate + 同任务隔离重跑 + 台账；loop → `CandidateImporter`（本地固定 baseline，无网络）→ contract-runner C0/C1-C8/C6 → profile gate 冷安装；
- loop leg 启用需配置 `allowLoopCandidates.{baselineRoot,baseBundle,dependencyRoot,contractCommand,contractTask,goldenPath}`，未配置 fail-closed；
- 测试 133/133（新增 deliberation 6 条 + verifier 拒绝回注 reopen 1 条，删除 discover 3 条）。

### 2026-08-18 真机实证（e2e16 + 确定性 gate 复现）

- **proposal→裁决→gate→同任务重跑全链路真实闭环**：27b 主动委托 → V4 Flash Builder 提交 loop-evolution proposal（5 回合/4 工具）→ 本地 baseline 构建 → C0/C1-C8/C6 全绿 → approved → profile gate 冷安装（C0 冒烟 pass、before/after 落盘）→ 同任务重跑 admissible=true（causal-workload）。
- 修复 6 个真实 bug（二次 stage、git archive 整树、依赖锚点、maxTokens 脱敏、workspaceRoot 串味、C6 cwd）；快照 `run-records/2026-08-18-loop-e2e-proposal-adjudication-gate.json`。
- 剩余：Builder 自由探索收敛性不稳（e2e17 卡重复 read_file 未提交），后续引导"最小必要探索后尽早 submit"。

## 当前进行中（loop 层放开，按序）

### Builder 基础重定（2026-08-18，优先于继续扩展候选网关）

用户确认：Builder 应是一个具有自身持久化极简 loop 的独立 agent，而非受限 JSON candidate generator；`loop-evolution` 应降为第一个 Builder capability skill/tool。Builder 对部署范围内状态具备全局读取、可在自身 workspace 自由探索/写入/构建/测试，并以真实工具反馈驱动多步修正；actor、builder 或 loop 的 live 变更一律以 proposal 交给独立 verifier/gate。JSON 保留为工具协议、journal 与交付格式，不作为认知或单文件写入边界。规格：`docs/builder-foundation-spec.md`。

`loopBaseline`、固定 fallback 文案与扩大的 acquisition attempts 临时修补已从当前工作树撤出。基础 Kernel 已补齐：全局文件/目录读取、持久 workspace 多文件读写、命令 stdout/stderr/exit-code 反馈及通用 proposal freeze；`npm run check`、`npm test`（124/124）、`npm run build` 全绿。下一实现步骤：建立 Builder 基础 profile 与 capability 注册协议，再把现有 Git/generated gateway 收编为 `loop-evolution` capability。

插件拼装基线（2026-08-18）：Capability 可自由新增并声明它要求的 verifier set；Verifier 以可插拔、固定版本/hash 的治理插件形式存在；Gate 对 immutable proposal + 完整同 hash 的 required reports 执行 fail-closed 授权，缺报告、超时、错误、not_run、stale evidence 或 before-snapshot 冲突一律不放行。`loop-evolution` 的首个 verifier set 及实现顺序见 `docs/plugin-composition-spec.md`。

Builder 洁净重绘（2026-08-18）：`src/builder/capabilities.ts` 提供最小起始工具集与 capability registry，`loop-evolution` 作为首个声明式插件注册；capability 只提供上下文，不替 Builder 规定路线。隔离实测 `eval/run-records/2026-08-18-builder-free-loop-observation.json`：故意错误 actor loop 基线 0/3，官方 V4 Flash 单次 Builder run（8 turns/7 tools）读取源码与需求、根据第一次 oracle 路径错误反馈修正、重写 loop，最终外部 oracle 3/3；未安装、未调用 verifier/gate。

Actor ↔ Builder 通信基础（2026-08-18）：actor 的主动委托不再同步等待 Builder。`meta_auto(exploreLoop=true)` 先持久化 immutable Builder run，再进入 single-flight 后台 job queue 并立刻返回 `jobId/runId`；`meta_builder_status`、`meta_builder_message`、`meta_builder_events` 和新增 `meta_builder_control` 分别提供状态、原话 inbox、composite cursor 事件流和 pause/cancel/resume。job 的 request/runId 在 scheduled/running/paused/waiting_for_input/cancelled/finished 中保留。真机隔离运行记录 `eval/run-records/2026-08-18-actor-builder-async-communication.json` 仍只证明非阻塞委托；本轮新增的是零成本确定性协议闭环，尚无新的真机性能声明。

Actor evidence pack（2026-08-18）：新增 `src/evidence/index.ts`，主动委托前冻结三层证据：原始 frames/events 等文件引用及 hash、确定性 runtime digest、可自由书写的 `actor-handoff.md`（含未知项）。Builder 收到 manifest 入口后可继续读取原始文件，摘要不是信息边界。真实隔离 actor 会话 pack 仍在 `/chenzute/dsh-src/eval/meta-workspace-actor-loop-async-20260818/workspace/actor-loop-async-20260818/evidence/`；它证明素材可恢复和主动委托非阻塞，不虚构 loop 演进效果。代码接线已补：Builder submit 后自动进入 deliberation（verifier/gate），应用后同任务重跑。

1. **A 收编（已完成）**：可运行构建产物已进入 `vendored/serial-tool-calls/`；`loop-candidates/serial-tool-calls.manifest.json` 固定上游 commit、候选 delta（并行 10→1）、目录 SHA-256 与入口。
2. **候选状态/边界（已完成代码，122/122）**：`src/candidates/` 实现 `staging → pending → verified → approved → installed`（及 rejected）、契约证据要求、before/after 安装记录、失败 rollback；builder Git acquisition 只能写 staging，需 HTTPS allowlist、固定 ref/commit/hash，不能直接写正式 vendored。builder-generated 另受固定 baseline、精确 hash 替换、路径/大小/无 symlink 限制。
3. **完整报告（已完成）**：正式 profile 下 C0/C1-C4/C7/C8 与 C6(L1-L5) 都通过，报告见 `eval/meta-workspace-loop-adapter-20260817/reports/profile-candidate-full-contract.json`。
4. **真实替换/gate（已完成，隔离 runtime）**：`src/candidates/profile.ts` + `profile-gate.ts` 在组合前替换 entry，严格校验 artifact hash，记录 before/after；`meta-workspace-loop-gate-final-20260817` 中 installed candidate 的 actor 重跑全绿，fault-injected C0 mismatch 自动 rollback。
5. **候选网关/自主获取/E2E（Git 通道完成；generated 通道待补真实链路）**：`allowLoopCandidates` 默认关闭；开启后仅 `meta_auto(discoverLoopCandidate=true)` 可调用独立 BuilderKernel。loop draft/工具反馈/journal 与 config/tool/skill builder 复用同一 bounded driver；提交后 core importer 才能 HTTPS 拉取。source 缺 entry 时，只允许固定的 `sandboxed-dsh-workspace` 无网络 build，build recipe/hash 写 manifest。builder-generated 只接受固定 DSH baseline commit、`agent-loop/src/**/*.ts`、exact beforeHash/after 替换、文件数/字节数/无 symlink 限制，并仍只进入 staging。控制候选完整证据见 `eval/run-records/2026-08-17-loop-autonomous-final-lifecycle-proof.json`；generated 首次真实拉取因 codeload 429 清理 staging，registry 无残留，未获验收。
6. **BuilderKernel（完成）**：`docs/builder-kernel-spec.md` 将 Tycho 的 bounded tool loop、workspace、verify feedback 与 Loom 权限/状态一一映射。`BuilderDriver` 以严格 JSON `tool | continue | submit | abort` 运行有上限的真实 LLM 微循环；Kernel 自动写 decision/tool/error journal 与 snapshots，allowlist 为 `read_input/read_journal/write_world_model/write_plan/write_candidate_draft/inspect_staging/preflight_staging_entry`，无 shell/任意文件/裁决能力。`submit` 无 payload，只冻结已预检 draft；verifier、probe 失败、gate/install rollback 全会 `reopenFromFeedback()` 建立新的 immutable run 并在 `previous-attempt.json` 回注。官方 V4 Flash 成功实证见 `eval/run-records/2026-08-17-builder-kernel-real-feedback-proof.json`：项目真实 `Validator` 产生 rejection，第三个官方 builder run 读取该 report 后以 4-turn/3-tool 提交（无 install）。
7. **并行归因与真实对照（完成，低成本）**：直接 27b（thinking disabled）真实生成两个 native tool calls；DSH 也在同一 turn/step 保留两调用。随后用两个 1000ms、显式 `isConcurrencySafe` 的隔离工具验证 cap：原版 loop overlap、tool span **1017ms**；已安装 serial candidate 串行、**2024ms**（**1.99×**），两侧 C0/C1-C4/C7/C8 全绿、0 error frame。因此该候选是安全/顺序策略，**不构成吞吐提升**；完整 record 为 `eval/run-records/2026-08-17-loop-parallel-safe-real-behavior-comparison.json`。官方/候选 scheduler 的 parallel-safe 与 cap=1 语义另有零模型 42/42 测试复核。

## 环境（2026-08-17 05:40 实测）

- Node v22.20.0 / npm 10.9.3 / pnpm 11.21.0（`/chenzute/dsh-src/tools/bin/pnpm`）；`dsh` 不在 PATH。
- dsh checkout `/chenzute/dsh-src/deepseek-harness` 存在；插件类型链 devDependencies `file:` 正常。
- `dist/index.js` 已构建；`npm run check` ✓；`npm test` 148/148 ✓；`npm run build` ✓；`git diff --check` ✓。
- 候选 fork 已构建 `lib/index.js`，`DEFAULT_MAX_PARALLEL_TOOL_CALLS = 1` ✓。
- env 文件在位（600）：`.env-27b`（本地 actor）、`.env-deepseek`（官方 V4 Flash builder/评审门）；禁止打印/提交。
- 契约跑法模板：

```bash
set -a; . /chenzute/dsh-src/eval/.env-27b; set +a
export DSH_CMD='/chenzute/dsh-src/tools/bin/pnpm dsh' DSH_CWD=/chenzute/dsh-src/deepseek-harness
export DSH_META_VALIDATE_ROOT=/chenzute/dsh-src/eval/meta-workspace-<name>
node scripts/contract-runner.mjs check /chenzute/dsh-src/eval/overlay-contract-candidate-fork.yml '<task>' loop-contract/golden-current.json
```

- golden 快照：`loop-contract/golden-current.json`（71 事件）；候选 overlays 在 `/chenzute/dsh-src/eval/overlay-contract-*.yml`。**任何候选运行必须带** `--expected-entry <candidate entry>`，C0 不通过即不允许花模型费用。
- run 快照：`/chenzute/dsh-src/eval/run-records/`（含 2026-08-17-loop-contract-bh3-*.json）。

## 已完成的里程碑（v1 实证；详见 docs/project-status.md + run-log）

- 发布：dsh-loom@1.0.4（npm latest），tags v1.0.2/v1.0.3/v1.0.4；便携 CLI `dsh-loom try` 已发布（真机留档待做）。
- 从零成长：off 0/3 → L1-L5 全过；严格同任务集 off 0/3 → on 3/3。
- 宿主闭环：host-demo pass=true；meta_auto/meta_iterate 真实链路（评审门 → builder → 隔离探测 → verifier → gate）。
- 演示留档：model-swap、supervisor-swap、scheduled-notify、preferences、refine-skill、actor-progress-qa。
- loop 契约 runner：record/check/rollback/--regression/--report/--profile + C0 entry-resolution 已实现；正式 profile adapter、完整三件套、cold gate 安装与回滚均已有隔离实证。旧单纯 overlay 差分证据仍仅是“官方 loop 上的环境/runner 验证”。

## 决策记录（保持简短；细节见 docs/research/08 等）

- 角色：builder（迭代者）+ verifier（固定式核验）完全分离；verifier 不通过强制回炉，无 force-apply。
- 文件优先：上下文不可信，状态落盘 `$DSH_HOME/meta-validate/`。
- 模型分工：actor = 本地 27b；builder/评审门 = 官方 V4 Flash。
- loop 放开门槛：完整契约报告三件套（C1-C8 + C6 回归 + 实装 before/after）；builder 必须自主选候选。
- dsh 约束（2026-08-17 新发现）：`PatchOptions.name` 不是更新字段；`--patch` 无法把 `agent-loop` 从官方包换成候选路径。gate 必须在完整 entry tree/宿主 Loader 级别做替换，并以 C0 验证实际解析入口。
- v1 锁定：`agent`/`agent-loop`/`meta-validate` 行禁止修改。

## 待用户决策/待办

- 下一步顺序：先在 codeload 限流解除后重跑 generated baseline→edit→sandbox build；成功后用独立 verifier 跑 C0/C1–C8/C6，再做 gate before/after、actor 重跑和 rollback；全部通过后，才跑 12 个 parallel-safe 延迟工具的 cap=10 对 cap=20 性能对照。任一供应链/契约/回滚失败都只记 rejected，不宣称性能提升。
- awesome-dsh-plugin PR：fork 分支 `ZTCNO0NE:add-dsh-loom` 已推；仓库满 1 天后（北京时间 08-17 20:35 后）`gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --base main --head ZTCNO0NE:add-dsh-loom --title "Add ZTCNO0NE/dsh-loom to the plugin list"`。
- README 竞品定位段（prime-agent 合并 + 偏好沉淀证据）已入库（commit `386269a`），如需调整再改。
- 曝光待办：GitHub Discussions 自荐 → 其他 awesome 列表 PR → Discord/公众号/掘金/知乎。
- 官方 DeepSeek key 曾短暂泄漏进 git 历史（已 force push），建议用户撤销换新（未确认）。

## 风险与注意

- 烧钱敏感：优先本地 27b / 零成本验证；官方调用（builder/评审门/基准）跑前确认。
- dsh v0.1 developer preview，接口会变；注入点收敛 `src/index.ts`。
- 候选 fork 在 dsh checkout 内，上游更新会冲突 → 尽快定收编。
- 每次运行必须留档（run-log + run-records）；未留档不算完成。

## 里程碑

| 里程碑 | 状态 |
| --- | --- |
| M0-M4（config/tool/skill 进化 + gate + 回滚） | 完成 |
| v1.0.0-v1.0.4（监督员/后台/通知/偏好/便携 CLI） | 完成 |
| loop 契约 runner + golden + C0 entry-resolution | 完成（正式 Loader adapter + 自主候选实装均有 C0） |
| 完整契约报告三件套 + 候选 loop 网关 | 完成（正式 profile、C0–C8/C6、冷 gate、staging 网关均有隔离实证） |
| v1.1 减法定稿 + 单一路线接线（deliberation/evidence/拒绝回注/同任务重跑） | 完成（代码 148/148；loop 真机端到端待配置 runtime） |
| builder 自主选择候选 loop + 端到端案例 | 收敛为 v1.1 单一路线：builder-generated + 本地 baseline；外部 Git acquisition 已砍 |
| Tycho 型 BuilderKernel 微循环 + 拒绝回注 | 完成（官方 V4 Flash patch/loop-candidate run + verifier feedback 证据） |
| 自主 loop 最后一公里 | 完成（staging → C0–C8/C6 → installed → actor 重跑 → rollback/restore） |
| loom-bench / Web 成长面板 / `dsh-loom try` 真机留档 | 后续 |
