# Loop 性能对照协议 v1

更新时间：2026-08-18

这份协议先于下一次真实候选安装冻结。它把“loop 性能提升”限定为可重复、可审计的 workload 结论，不把一次代码 diff 或一次成功启动当成性能证据。

## 1. 比较对象和固定条件

- baseline：官方 `@deepseek-ai/dsh-agent-loop`，默认 `maxParallelToolCalls=10`。
- candidate：builder-generated 固定 baseline commit 上的单变量 edit，默认值改为 `20`；manifest 记录 baseline/ref、edit-plan hash、artifact hash 和入口。
- actor：同一台本地 `qwen/qwen3.6-27b`，`thinking: disabled`，同一 `maxTokens`、prompt、工具 schema、环境和 profile 资源。
- 工具：只使用隔离 probe plugin；parallel-safe 工具无共享可变状态，明确 `isConcurrencySafe() === true`，每个 probe 固定延迟 1000ms。
- 每侧先执行一次主实验；只有主实验通过且结果没有异常，再做一次复现。禁止在 C0 失败时支付模型调用。

## 2. 先决验收（性能结果无效条件）

以下任一项失败，candidate 只能标为 rejected，性能数字不得解释为 loop 提升：

1. source commit、edit beforeHash/afterHash、build recipe 或 artifact hash 不一致；
2. C0 入口解析失败；
3. C1–C8 或 C6 回归失败；
4. gate before/after 快照缺失、actor 安装后重跑失败、rollback/restore 失败；
5. 任一侧出现 error frame、异常退出或工具结果缺失。

完整物理链路的唯一有效顺序是：

```text
retry acquisition → sandbox build → C0/C1–C8/C6 → pending/verified/approved
→ gate before/after → cold install → actor rerun → rollback → restore
```

## 3. 指标定义

每个 workload 的机器记录必须同时保存 raw event/frame 和以下派生值：

- `taskSuccess`：预期工具结果和最终 actor 结果是否完整正确；
- `errorFrames`、`exitCode`、`contractPass`、`regressionPass`；
- `toolSpanMs`：同一 turn/step 中第一条工具启动至最后一条结果完成的跨度；
- `turnWallMs`：该 turn 从 `turn/start` 到 `turn/end` 的墙钟时间；
- `callStartGapMs`：相邻调用启动间隔；
- `overlapRatio`：工具执行总时长减去 union wall span 后的重叠比例；
- `maxInFlight`：由 call/result 时间线重建的最大并发数；
- `promptTokens`、`completionTokens`、工具调用数；
- `beforeHash`、`afterHash`、resolved entry 和 run record 路径。

核心性能指标是 `toolSpanMs` 和 `turnWallMs`；token、调用数和错误率是解释变量，不得用 token 下降替代任务性能提升。

## 4. Workload 矩阵

| 编号 | 目的 | 负载 | 必须观察 |
| --- | --- | --- | --- |
| P1 | 因果主实验 | 12 个独立 parallel-safe、各 1000ms | cap=10 应为两批，cap=20 应为一批；overlap、span、maxInFlight |
| P2 | 低 fan-out 中性检查 | 2 个 parallel-safe、各 1000ms | 不应比 baseline 恶化；验证 candidate 没有额外串行化 |
| P3 | 混合安全边界 | 8 个 safe + 2 个 exclusive | safe 组可重叠，exclusive 不得并发；错误率和结果正确性 |
| P4 | 长短任务尾延迟 | safe probes：4×200ms + 4×1200ms | `turnWallMs`、尾延迟、调度是否饥饿 |

P1 是唯一可以直接检验 `10→20` 的主因果 workload；P2–P4 用于限制泛化，不能把其中一个失败隐藏在 P1 的平均值里。

## 5. 预注册的判定规则

- **准入**：两侧 `taskSuccess=true`、`errorFrames=0`、C0/C1–C8/C6 全 pass，且 gate/rollback 全 pass。
- **P1 提升**：candidate `toolSpanMs` 和 `turnWallMs` 均不高于 baseline 的 0.75 倍；12 个调用的启动重叠存在，`maxInFlight` 至少达到 12 或接近工具调度上限。
- **中性/退化**：P2–P4 任一任务成功率下降、出现契约/回归错误或错误率上升，即不能作广泛性能提升声明；应报告具体 trade-off。
- **泛化声明**：只有 P1–P4 全部通过，才允许说“在这组四类受控任务上表现出稳定改善”；即便如此，也不能泛化到所有 actor 任务。

固定延迟 probe 的预期只是理论 sanity check：P1 baseline 约 2s、candidate 约 1s。实际结论以 raw event 时间线和上述阈值为准，不以预期值替代测量值。

## 6. 证据布局

每次主实验保存：

```text
eval/run-records/<date>-loop-performance-<workload>-<side>.json
eval/run-records/<date>-loop-performance-comparison.json
```

comparison record 必须引用两侧 raw reports、contract/C6/gate/actor/rollback 报告、manifest/artifact hashes，并明确写出 `claimLevel`：`causal-workload`、`task-class` 或 `not-established`。

