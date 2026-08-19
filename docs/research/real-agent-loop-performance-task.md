# 正式 agent-loop 性能 Builder 任务

性能 Builder 的下一轮必须以真实 `packages/core/agent-loop/src/tool-calls.ts` 为目标，不再以单文件 fixture 作为最终候选。

固定事实：

- 入口文件：`packages/core/agent-loop/src/tool-calls.ts`
- 入口函数：`executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext)`
- 工具分类：`ctx.tools.executionMode(exec).kind`，`parallel` 组才允许重叠；其它模式是 barrier。
- 并发上限：`ctx.agentLoop.config.maxParallelToolCalls`
- 结果语义：必须按模型顺序 `commitReady()`，不能按完成顺序提交。
- 失败语义：scheduler failure、abort、exclusive barrier 均须保持现有 contract。

Builder 必须先读取真实源码和现有 `tool-calls.spec.ts`，提出可证伪的性能假设，再在自身 workspace 复制完整 agent-loop package，修改真实源码并运行 package tests/contract runner。只有 package entry 通过 C0–C8/C6 后，才能提交给 gate。

性能门槛：2、4、8、16 个显式 parallel-safe 延迟工具至少三个负载点总时延下降 20%；错误帧为 0；结果顺序、exclusive barrier、abort 和 scheduler failure 回归全绿。否则记录为 no-improvement。
