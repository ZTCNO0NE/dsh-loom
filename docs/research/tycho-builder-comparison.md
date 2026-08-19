# Tycho Builder 对照结论

更新：2026-08-18。本文只记录对 `/chenzute/dsh-src/tycho` 源码的核查，不改变当前 Builder 权限边界。

## Tycho 实际采用的循环

Tycho 的 `WorldModelBuilder.build()` 是一个有上限的独立 pass，默认最多 40 次模型调用。每次 pass 开始时，宿主先运行确定性 `verify`，把 `simulation_accuracy`、`first_divergence`、精确 delta 和必要的前后帧注入 Builder；Builder 再按需读取 frames/transitions，编辑 `world_model.py` 和 `notes/world_model.md`。每次成功的语义编辑由工具执行器立即运行同一个验证探针，把结果作为当前工具反馈返回。

Builder 不负责采取环境动作，也不负责批准自己的模型。它的完成出口是写 `notes/world_model_report.md` 并回复 `done`。如果没有写新报告，pass 结束前会使用一个不带工具的收尾回合要求报告；报告仍未落盘时写入明确的低置信度 fallback，避免把上一次报告误当成当前结果。

循环的再次进入不是由 Builder 自己“再想一轮”决定，而是由外部 `wm_signal` 决定：只有新动作后的模型验证仍出现 dynamics/outcome divergence，或新 level/reset 需要重新检查，才再次启动一个新 pass。Tycho 明确拒绝按固定次数限流，因为固定 cooldown 会在模型即将突破时停止；真正的总闸是游戏级 LLM budget。

## 为什么它不容易陷入重复工具调用

1. Builder 的问题是窄的：修正一个可验证的 world model，而不是泛化地“提升 Actor”。
2. 第一条反馈就是 verifier 产出的新事实，不要求模型先自行寻找“哪里错了”。
3. `run_python` 每次是短生命周期进程，持久记忆写入 notes/和源码；旧工具 transcript 不作为每轮必读输入。
4. 工具结果带有语义验证反馈，因此重复读取不会产生新的可用证据；模型自然会转向修复或结束。
5. 每个 pass 有硬上限和新鲜 report guard；失败表现为低置信度报告或下一次外部触发，不是无限内部循环。

## 与 Loom Builder 的差异

Loom 的 loop-evolution 是开放任务：候选可以修改 config/tool/skill/loop，且价值要到 verifier/gate/真实 replay 才能判断。因此不能直接复制 Tycho 的“每次只修 first divergence”目标，也不能让 Builder 自己运行 verifier/gate。

但可以移植其循环形状：

- `Builder pass` 只处理一个 Actor handoff 中明确的问题假设；
- pass 启动时由 Loom 生成一份确定性 `evidence-diagnosis`（已知失败、first divergence、可复现命令、候选入口），而不是让 Builder 先盲读全局；
- capability 工具的成功写入后立即运行最小相关 simulation/verifier probe，并把结构化结果回传；
- pass 结束必须写一份新鲜的 `builder-report`（或显式 abort/needs_input），旧 report 不可复用；
- verifier/gate rejection、Actor 新指导或真实 replay 失败才创建新的 immutable pass。

## 当前决策

当前已实现的 compact progress state 和默认关闭的二级无进展断路器可以保留作保险丝，但不应继续扩展成多级 phase 白名单。下一步优先做 `evidence-diagnosis → bounded Builder pass → fresh report → external re-trigger` 的结构实验；先观察它是否比“开放全局探索 + 重复 read reject”更稳定，再决定是否删除实验断路器。
