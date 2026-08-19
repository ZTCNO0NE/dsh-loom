# mini-SWE Builder Runtime Evidence Audit

日期：2026-08-19。范围：`builder-1787123618188-d57a45a7` 这一条真实
`agent-loop` 候选链路。本文只陈述可以由下列 artifact 复核的结论，不将
fixture repair、人工修改或单次 actor replay 外推为产品结论。

## 主张台账

| 主张 | 状态 | 直接证据 | 尚缺的证据 |
| --- | --- | --- | --- |
| mini-SWE 可作为 loop implementation runtime | **已证明（一个真实任务）** | durable trajectory 显示 runtime 自主完成 baseline failure、源码编辑、定向回归、回归修复和 `Submitted`：`/chenzute/dsh-src/eval/real-agent-loop-builder/workspace/real-agent-loop/builder-runs/builder-1787123618188-d57a45a7/mini-swe-agent-trajectory.json`。同 workspace 于本审计重跑 `delayed-prepare-regression.spec.ts` + `tool-calls.spec.ts`，22/22 pass。 | 多个独立复杂任务的成功率；timeout、partial trajectory、rejection reopen 的 runtime E2E。 |
| Loom 的控制面未被 runtime 绕过 | **已证明（这一候选）** | registry 记录 builder-generated source、固定 baseline `47f943859bef60e4160492346772ded9b24f765a`、raw before/after hash；contract report 记录 C0/C1-C4/C6/C7/C8 pass；registry 状态为 `approved`，因 gate 冷 rollback 后未留 installed profile。 | adversarial test：runtime 修改允许范围外文件、伪造 Submitted、缺失证据、超时等均不得进入 approval。 |
| 冷安装、actor replay、rollback 真正闭环 | **已证明（一个候选、一个 smoke workload）** | `/chenzute/dsh-src/eval/meta-workspace-mini-swe-agent-e2e-20260819/runtime/candidates/registry.json` 以及对应 contract/install reports；CURRENT.md 记录 cold install、actor replay 和 profile disappearance after rollback。 | 多 profile / real-user profile 启用前的 snapshot supplier 与 cold-start test。 |
| actor 一切可改 | **未证明，且当前不成立** | 当前 compiler 仅允许 pinned baseline 的 `packages/core/agent-loop/src/**/*.ts`，最多 4 个文件；verifier/gate/meta-validate 是不可改 TCB。config/tool/skill 仍走旧 patch-evolution path，未与 mini runtime 统一。 | 要实现更广泛演化，需定义并验证 config、tool、skill、composition 等独立 capability/runtime adapter；不应移除 TCB 锁。 |
| Loom-native 可处理复杂 loop 重构 | **未证明** | 多次真实 Terra/V4 Flash pass 能正确定位 `fillPool()` 串行 `await prepare()`，但 20/40 turns 未 edit、未 proposal。 | 若要继续保留 native implementation path，必须以相同 task 的独立成功率证明；不能以 prompt 文案替代。 |
| 当前候选有真实性能提升 | **未证明为一般性能结论** | 同任务 actor replay 单样本约 30.0 s vs 29.3 s，不足以归因。候选 diff 并非 `maxParallelToolCalls 10→20`，而是让 bounded pool 内的 `prepare()` 重叠。 | 与候选语义一致的重复 benchmark：prepare latency、pool size、顺序提交、failure/abort 与 end-to-end actor workload；raw spans、overlap、p50/p95、错误率。 |

## 当前候选到底改变了什么

`tool-calls.ts` 的变更将 `fillPool()` 中的 `await startCall()` 改为将
`prepare → dispatch` 的异步工作放进已经计入上限的 `inFlight` slot。因此：

- 同一 `maxParallelToolCalls` 范围内，多个 `parallel` tool 的异步
  `prepare()` 可以同时进入；
- 它**不**修改 `maxParallelToolCalls`，也不允许超过既有 pool cap；
- 它仍要求按模型顺序提交，且 failure/abort/exclusive 语义受已有 suite 约束。

所以旧版“12 个 1s probe，baseline cap=10、candidate cap=20”的 P1 不是此
候选的因果测量。用它来宣称该 candidate 提升会把 cap 改动与 prepare overlap
混为一谈。它可保留为未来一个明确改变 cap 的候选的预注册协议，不能复用。

## 正确的下一份性能协议

对本候选应新建、独立于旧 P1 的 **prepare-overlap benchmark**：

1. 同一 pinned baseline / candidate，各 5 次冷进程试验；
2. 2、4、8、16 个 `parallel` calls；每个 `prepare()` 有固定延迟，body 延迟为
   0 和非 0 两档；pool cap 固定；
3. 记录 prepare first-to-last span、dispatch/body span、turn wall time、
   maxInFlight、顺序、错误、abort 与 failure-draining 事实；
4. 只有所有正确性条件绿，且 prepare span 的中位数/尾部在至少三个负载点明显
   下降，才能声明“该调度路径的 prepare overlap 改善”；
5. 仍不得把它泛化为全部 actor 工作负载提升。另需 actor-level 受控 workload
才能主张用户可见端到端延迟改善。

### 已完成的最小因果测量

在不安装 profile 的两个 immutable workspace 中，使用固定 100ms `prepare()`
延迟、零 body 延迟、pool cap 等于 calls 数，baseline 与 candidate 各运行 5 次。
完整 raw record：`/chenzute/dsh-src/eval/run-records/2026-08-19-mini-swe-prepare-overlap-benchmark.json`。

| parallel calls | baseline median prepare span | candidate median prepare span | 结论 |
| --- | ---: | ---: | --- |
| 2 | 102.1ms | 0.55ms | candidate 同时进入 prepare |
| 4 | 304.5ms | 0.76ms | candidate 同时进入 prepare |
| 8 | 707.2ms | 1.41ms | candidate 同时进入 prepare |

同一 fixture 的观测窗口 wall time 中位数也由 235/429/833ms 降至
134/128/126ms。该 fixture 两边都达到所有 prepare；candidate 另行重跑
`delayed-prepare-regression` 与原 `tool-calls` suite 共 22/22 pass。

这足以说“Builder 自主候选修复了真实 scheduler 中 prepare 串行瓶颈，并在该
受控调度路径上有可重复时延改善”。它仍不是用户任务端到端 benchmark：没有
16 calls、body latency、exclusive/abort/failure 压力和 actor raw frames，故不能
说“actor 整体性能提升”。

## 运行时决策

当前合理部署形态是：Loom 继续拥有 evidence、immutable proposal、独立
verifier/gate、cold install/rollback；mini-SWE 作为复杂 implementation pass 的
可选 execution runtime。Loom-native 可继续承担诊断、与 Actor/用户的持久沟通
和小型探索，但在拿到同类任务的成功率前，不能作为复杂源码重构的默认实现器。

## 本轮新增负向保障

确定性回归现在验证三类 runtime 失败均不会伪装为 proposal：

- trajectory 的 exit status 不是 durable `Submitted`；
- runtime 退出却没有留下 trajectory；
- runtime 留下了无法解析的 trajectory；
- workspace 只有范围外文件变化，且没有 Kernel 捕获的
  `packages/core/agent-loop/src/**/*.ts` 改动。

最后一类会使 `compile_loop_submission` 明确失败，proposal 保持为空；后续
Importer、Verifier、Gate 没有可消费的候选。该证明仍不替代完整的恶意 runtime
矩阵：一个同时改动允许文件和其它文件时，范围外变化会被 archive-based Importer
自然丢弃，但还应补一条 E2E 证明它无法影响最终 artifact。

其中损坏 trajectory 已不只是在 adapter 单测中覆盖：Gateway E2E 使用临时 pinned
git baseline 真实 materialize workspace、执行伪 mini runtime，再确认 run 为
`aborted`、Actor status projection 的 proposal 为 unavailable。它证明异常不会漏成
“后台仍在运行”或“可提交”的模糊状态。
