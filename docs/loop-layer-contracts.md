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
4. **回归**：跑回归集（fromzero + TB 切片），要求不降；
5. **回滚演练**：故意装坏候选，验证自动回滚 + 快照还原。

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
- 候选 overlay 样例（本地）：`eval/overlay-contract-candidate-{benign,broken,reimpl}.yml`。

### 2026-08-17 行为差异实证（bh3）

- 候选：`@deepseek-ai/dsh-agent-loop-candidate`（本地 fork，唯一差异 `DEFAULT_MAX_PARALLEL_TOOL_CALLS` 10→1）；
- 结果：原版与候选 **C1-C4/C7/C8 全绿**（原版 114 事件、候选 131 事件），核心事件序列完全一致；
- 局限：27b 在明确要求"一条回复里发两个 tool_calls"时仍拆成两步（maxParallelAdjacency 两轮均为 1），**模型层并行差异不可观测**；实证证据 = 代码 diff（10→1）+ 契约全绿，不强求模型层可观测对比；
- 含义：这正好说明"行为变了、契约没坏"的正确验收方式——契约管**语义不变式**，行为差异管**可观测效果**；两者是不同维度的证据，不能互相替代。

### 完整契约报告（agent-loop 放开准入件）

一个候选 loop 的"完整契约报告" = 三件套：

1. **契约报告**：contract-runner 对候选 overlay 跑探针任务，C1-C8 全绿的机器可校验结果（事件协议/回合生命周期/持久化/工具配对/监督员帧/模型路由）；
2. **回归报告**：C6 联动（fromzero:verify 等现有验收集）在候选 loop 上不降；
3. **实装记录**：候选真正走一遍 gate 冷替换，记录 before/after 快照 + 冒烟 + 回滚演练，证明"装得上、坏了能还原"。

意义：契约报告把「环境语义没变」变成机器证据，回归把「能力没降」变成可复现证据，实装记录把「真的能换上去」变成可审计证据。verifier 只认这份三件套 + 报告路径，不做 LLM 主观判断；任何一项缺失 = 候选不可准入。
