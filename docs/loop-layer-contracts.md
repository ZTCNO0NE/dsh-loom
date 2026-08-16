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
