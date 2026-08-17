# Loop 层契约（v0 设计稿）

> 目标：把 actor 的 Agent Loop 当作**可替换插件**。替换前必须证明新 loop 满足契约；契约测试成熟后，`agent-loop` 行才从 deny-list 放开为可进化对象（verifier/gate/meta 行仍然锁死）。

## 一、为什么需要契约

现在 verifier 验证工具/技能/配置，是在"当前 loop 语义"下验证的——回合生命周期、会话事件协议、持久化都是环境本身。如果候选同时改 loop，等于在"裁判不知道的新规则"下比赛。契约测试就是给"环境本身"立的规矩：

- 新 loop 必须和旧 loop 对**同一份会话事件流**给出相同语义；
- 换 loop 后旧会话仍可重放、旧回归不降；
- 换 loop 失败可回滚，状态不丢。

## 二、契约清单（v0 草案）

| 编号 | 契约 | 不变式 |
| --- | --- | --- |
| C1 | 会话事件协议 | `session/event` 顺序固定：`turn/start → step/start → tool/call → tool/result → step/end → turn/end`；`assistant/message` 只出现在 step 内 |
| C2 | 回合生命周期 | `turn/start`/`turn/end` 一一配对；turn 号单调递增；`reason` 属于合法集（completed / aborted / blocked / error） |
| C3 | 持久化语义 | 会话 JSONL 可逐事件重放；`persistenceCompression: none` 时帧完整（不丢 event、时间戳可恢复）；换 loop 后旧会话仍能加载 |
| C4 | 工具调度 | `tool/call`→`tool/result` 配对；callId 唯一；错误/超时/取消的 result 语义确定（含 `TOOL_ABORTED`） |
| C5 | 冷替换/回滚 | before/after 快照完整；安装失败自动回滚；会话与 world-state 不丢 |
| C6 | 回归保持 | 现有 fromzero L1-L5、host-demo、TB 切片在新 loop 上不降 |
| C7 | 监督员可观测 | 新 loop 仍产出 observer 所需帧（turn/step 时间戳、`user/message`、`assistant/message`） |
| C8 | 模型路由 | LLM 契约不变：usage 上报、`finish.replayState` 语义、provider/model 路由不受 loop 影响 |

## 三、验证方式（contract-runner v0）

1. **黄金快照**：在现有 loop 上跑一组探针任务，录制一份事件流作为基线（`golden/events.jsonl` + 哈希）；
2. **候选 boot**：隔离环境用候选 loop overlay 启动 dsh，跑同一组探针任务；
3. **差分**：校验候选事件流与黄金快照的契约一致性（顺序、配对、reason、callId、时间戳单调）；
4. **入口解析（C0，前置）**：启动前 `dsh --dump-config` 必须确认 `agent-loop` 的 resolved `name` 等于候选 entry；否则不得运行模型探针。注意 dsh include patch 中的 `name` 是目标行匹配条件，**不是可修改字段**；
5. **回归**：跑回归集（fromzero + TB 切片），要求不降；
6. **回滚演练**：故意装坏候选，验证自动回滚 + 快照还原。

`contract-runner` 是纯本地脚本（零模型成本）：输入 candidate overlay，输出 C1-C8 的 pass/fail 报告。

## 四、放开条件（agent-loop 行）

- C1-C8 全部有自动化测试且候选 loop 全绿；
- deny-list 收窄为：`verifier/gate/meta-validate` 所在行 + 签名/回归集路径；
- `agent-loop` 进入可进化对象，但**每个候选必须带契约测试报告**，verifier 只认契约报告 + 回归结果。

## 五、当前状态与下一步

- 现状：`agent-loop` 行在 deny-list（v1 锁定）；无契约测试实现；
- 下一步：
  1. `scripts/contract-runner.mjs` v0 已落地（record/check/rollback/--regression）；
  2. 黄金快照：`loop-contract/golden-current.json`（71 事件，C1-C4/C7/C8 自检通过后录制）；
  3. 候选差分已验证：良改（agent-loop 显式配置）过、整包替换路径（name 指向官方构建入口）过、坏改（禁用 agent-loop）干净拦截；
  4. C6 回归联动已点亮（check --regression 调 fromzero:verify）。
- 候选 overlay 样例（本地）：`eval/overlay-contract-candidate-{benign,broken,reimpl}.yml`。**2026-08-17 已证实**：这些 overlay 不能替换已有 `agent-loop` 行的 `name`，仅可用于配置/禁用等 patch；真正候选需由完整 profile entry tree 或宿主 Loader `entry.update({ name })` 安装。

### 2026-08-17 行为差异实证（bh3）

- 候选：`@deepseek-ai/dsh-agent-loop-candidate`（本地 fork，唯一差异 `DEFAULT_MAX_PARALLEL_TOOL_CALLS` 10→1）；
- 结果：原版与候选 **C1-C4/C7/C8 全绿**（原版 114 事件、候选 131 事件），核心事件序列完全一致；
- 后续归因修正见下节：`maxParallelAdjacency=1` 不是“模型只产生一条调用”的充分指标；逐帧复核可见两条 `bash` call 位于同一 turn/step。

### 2026-08-17 并行归因对照（低成本，结论已定）

- 原始模型层：直接调用本地 `qwen/qwen3.6-27b`，固定两工具、`thinking: disabled`、单次 162 completion tokens，真实返回 `probe_alpha` + `probe_beta` 两个 native `tool_calls`。此前两次默认思考模式各在 256 tokens 截断且未到 tool call，不能据此给模型定性。
- DSH actor 层：原版和已冷安装的 `serial-tool-calls` profile 都在**同一 turn/step**记录了两条 `bash` tool/call；C0/C1-C4/C7/C8 均通过。模型输出没有被 loop 合并或丢弃。
- 调度层：每条 `bash` 是 exclusive（未声明 `isConcurrencySafe() === true`）。两轮的第二条均在第一条 result 后约 4–5ms 才开始，端到端 tool span 分别为 2123ms / 2143ms；这正是安全 barrier，而不是 `maxParallelToolCalls` 10→1 的效果。
- 零模型 scheduler 实证：官方 loop 与候选 loop 的 `tool-calls.spec.ts` 共 42/42 通过，明确覆盖“parallel-safe siblings 全部先 start”及 `maxParallelToolCalls=1` 的全串行语义。
- 结论：27b 可以产出两调用，DSH 也保留两调用；`bash` 用例不触发候选的并行上限，因此它本身不能作为候选性能结论。随后已按下一节用两个延迟且 `isConcurrencySafe` 的工具完成真实比较。
- 机器记录：`/chenzute/dsh-src/eval/run-records/2026-08-17-loop-parallel-attribution-comparison.json`。

### 2026-08-17 parallel-safe 真实性能对照（已安装 candidate）

- 固定任务：27b（`thinking: disabled`，`maxTokens: 2048`）在同一 assistant 回复调用 `delay_probe_a(A,1000)` 与 `delay_probe_b(B,1000)`；两个工具独立、无共享可变状态，显式 `isConcurrencySafe: () => true`。
- 原版 loop（默认 cap=10）：两条 call 相隔 **4ms**，均在约 1.02s 后完成，tool span **1017ms**，存在真实重叠。
- 已冷安装 `serial-tool-calls`（cap=1）：第二条在第一条 result 后才启动，tool span **2024ms**，无重叠；相对原版多 **1007ms**、墙钟比 **1.99×**。
- 可靠性：两侧均为真实 actor run，C0/C1-C4/C7/C8 全 pass、exit=0、0 error frame；候选既有 C6(L1-L5) 完整报告未受影响。
- 裁决：`serial-tool-calls` 已被证明为**安全/顺序策略**而非吞吐提升；不得把它作为“actor 因新 loop 更快”的证据。对吞吐型候选，应以此 benchmark 的 `≤ baseline wall time`、真实 overlap 与无回归作为 verifier 准入条件。
- 机器记录：`/chenzute/dsh-src/eval/run-records/2026-08-17-loop-parallel-safe-real-behavior-comparison.json`。

### 完整契约报告（agent-loop 放开准入件）

一个候选 loop 的"完整契约报告" = 三件套：

1. **契约报告**：contract-runner 对候选 overlay 跑探针任务，C1-C8 全绿的机器可校验结果（事件协议/回合生命周期/持久化/工具配对/监督员帧/模型路由）；
2. **回归报告**：C6 联动（fromzero:verify 等现有验收集）在候选 loop 上不降；
3. **实装记录**：候选真正走一遍 gate 冷替换，记录 before/after 快照 + 冒烟 + 回滚演练，证明"装得上、坏了能还原"。

意义：契约报告把「环境语义没变」变成机器证据，回归把「能力没降」变成可复现证据，实装记录把「真的能换上去」变成可审计证据。verifier 只认这份三件套 + 报告路径，不做 LLM 主观判断；任何一项缺失 = 候选不可准入。

### 2026-08-17 正式 Loader 路径

`src/candidates/profile.ts` 是唯一允许替换 `agent-loop` entry 的 adapter：它把 DSH base patch 复制到 runtime-owned profile，再在组合前替换该行。`--patch` 仍只负责模型/loom 配置，绝不能承担 entry replacement。`src/candidates/profile-gate.ts` 以此执行 C0 smoke、before/after snapshot 和 rollback；它会在 materialize 前复核 manifest 的内容 hash。

### 2026-08-17 自主候选完整终局实证

- builder：官方 V4 Flash 在 `BuilderKernel` 中作出 `write_candidate_draft → preflight_staging_entry → submit`；draft 固定 DeepSeek Harness public Git source、resolved commit 与 `sandboxed-dsh-workspace` build recipe。
- acquisition/build：core importer 用 commit-pinned GitHub archive 拉取；source archive 缺 `lib/index.js` 时，只能在 `bwrap --unshare-all`（无网络）中执行固定 DSH workspace build，随后重算 artifact hash。任意 entry/build 失败只会回注 builder，不能进入 registry `staging`。
- verifier：隔离 Loader profile 上 C0、C1–C4、C7、C8 与 C6(L1–L5) 全通过，随后独立 verifier 才推进 `staging → pending → verified → approved`。
- gate/observation：gate 在 before.exists=false 的 owned profile 中 cold install；actor 重跑 C0/C1–C4/C7/C8 全通过。随后同一 candidate 注入 C0 mismatch，gate 自动删除 profile（rollback.succeeded=true），最后按同 hash 重新安装并再次 actor 重跑通过。
- 记录：`/chenzute/dsh-src/eval/run-records/2026-08-17-loop-autonomous-final-lifecycle-proof.json`。该候选是**基线控制候选**，证明自主供应链和最后一公里，而非宣称性能/行为改进；serial-tool-calls 是单独的行为**变更**候选，其提升仍须以 parallel-safe 基准证明。
