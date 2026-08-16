# L4：映射与差距（设计输入）

更新：2026-08-16。前置：L3 笔记 02-06。本文档是 L5 路线修订的输入：三方映射表 + 指标映射 + 差距清单 + 决策清单。

## 1. 三方映射表

| 组件 | dsh 机制（契约） | Tycho / prime-agent 参考 | 落地要点 |
|---|---|---|---|
| observer | `agent/error`（turn/step/error 即时）；`tool/result.error {name, code}`；`user/message`（source.kind='user'）；`assistant/message.usage`；`request/header` 快照；compaction/* | prime-agent review gate："这段轨迹值不值得出手"；Tycho 只记录真实帧 | 失败=agent/error + tool/result.error；纠正=user/message 启发式（无原生 correction kind）；回归失败=回归任务结果；信号聚合按 `EvolutionSignal` |
| proposer | `ctx.llm.stream/prepareCall`（独立 provider/model/sessionId/purpose，不注入 actor 历史）；输入快照 = `--dump-config` 或 `ctx.loader.entries()` | Tycho orchestrator：actor 拉取独立 builder，builder 产出模型+预期；prime-agent planRefinement：独立 LLM 一次调用 | 输出 `MetaPatch` + **预期轨迹**（Tycho 对齐基准）；单变量、targetKind 白名单；expectedOutcome 绑定可量化预期 |
| validator | 隔离执行：临时 profile / plugin-group isolate；keyless 回归 = `dsh-acp-snapshot` + `dsh-llm-replay`；`--dump-config` 校验组合树；真实轨迹 = session JSONL/事件序列 | Tycho verify()：仿真预测 vs 真实帧逐格/哈希对齐；first_divergence/coverage；执行期帧哈希；隔离容器无网络只读根 | 候选自带预期轨迹 → 隔离跑真实执行 → 逐字段/哈希对齐 → 输出 alignment/first_divergence/coverage；只 approved 当完全对齐 |
| gate | `ctx.loader.entries()` 读目标行；`ctx.loader.update(id, {config})` 运行时热更新；patch 整行覆盖；写 profile patch 文件持久化；HMR 生效 | prime-agent：回合边界、baseline 冲突检测（plan→apply 期间被改即拒）、tmp+rename 原子写、before/after 快照、确定性逆序回滚 | 预约队列 → 回合边界 → 重读 before 与 baseline 比对 → 原子应用 → 冒烟 → 失败回滚；版本递增 + 历史留痕 |

## 2. 指标映射（01 指标 → 四组件）

| 指标（01 §3） | 归属组件 | 度量方式 | 阈值草案（01 §6） |
|---|---|---|---|
| 信号准确率/召回率 | observer | 合成故障注入 10 个事件，precision/recall | M1：1.0 / 1.0 |
| 阈值触发正确率 | observer | 低于阈值不触发、达到必触发 | M1：100% |
| 补丁合法性/单变量率 | proposer | schema 校验 + 变量数审计 | M1：100% 合成集 |
| 对齐指标（simulation_accuracy/strict/first_divergence/coverage） | validator | 预期轨迹 vs 真实轨迹逐字段/哈希 | M2：已知正确 patch 100%，错误 patch first_divergence 定位正确 |
| 回归通过率 | validator | keyless snapshot/冒烟集 | 始终 100%；M2 起 ≥3 场景 |
| 配置不变性 | validator/gate | patch 未涉及行 dump-config 逐字节一致 | 始终 100% |
| 回滚成功率 | gate | 合成故障注入 | M2 人工 100%；M3 自动 100% |
| 改进率/回归率/收敛性 | 系统级 | 同任务集 Δsuccess、红 patch 占比、连续 epoch 无同类补丁 | M3：Δsuccess>0、无回归、连续 2 epoch 收敛 |
| 成本收益 | 系统级 | token-meter（每轮 meta-loop 记账） | 每轮记录 |
| 任务完成率/效率 | 系统级 | 外部断言 + 效率比 | M3/M4 进阶验收（TB/DeepSWE 本地就绪） |

## 3. 差距清单（RED 处置更新）

| ID | 问题 | L4 结论 | 验证方法/降级方案 |
|---|---|---|---|
| R1 | 运行时读/写其他行 config | **已解决**：`ctx.loader.entries()` 读；`ctx.loader.update(id, {config})` 运行时热更新（vendor/loader/README.md 行 40-42）；持久化需另写 profile patch 文件 | gate 第一版：读=loader.entries()；应用=loader.update + 写 patch 文件（持久化）；两者都留日志 |
| R2 | user/message 有无"纠正"语义 | **已解决（启发式）**：MessageSource kind 只有 user/plugin/model/tool（packages/llm/llm/src/message.ts 行 100-105），无原生 correction | observer 用"失败后紧跟的 user/message"或文本特征归类；或插件注册自定义 source kind（merge-extensible） |
| R3 | 验证器模型实例隔离程度 | **分层决策**：会话级（独立 sessionId + 不注入历史）即可防上下文串扰；服务级 plugin-group isolate；进程级临时 profile 留 M2 对抗场景 | M2 先做会话级 + plugin-group；进程级作为验证器强化项 |
| R4 | 本地任务补丁影响可复现性 | 已知，已记录（eval README） | 官方口径需修容器 GitHub/Docker Hub 出口（用户决策） |
| R5 | overfull 超时是能力还是预算 | 未决 | 复测：agent 超时 ×2（1800s） |
| R6（新） | 预期轨迹格式未定 | 待 L5 决策 | 候选：JSON 事件序列 / 哈希清单 / 断言脚本 |
| R7（新） | 回归集第一版具体选哪些场景 | 待 L5 决策 | acp-snapshot text-turn + headless JSONL + 自建 5-10 冒烟 |
| R8（新） | gate 应用目标行的"原子性"与持久化路径 | loader.update 是运行时热更新；patch 文件写回需 tmp+rename（prime-agent 模式） | M2 验证 loader.update 的 HMR 行为与失败回滚 |

## 4. 决策清单（L5 需要用户拍板）

1. **"帧"的定义**：dsh 里对齐的最小单位——候选一：工具结果事件序列；候选二：配置树快照；候选三：两者结合（推荐）。
2. **预期轨迹格式**：JSON 事件序列 / 可执行断言脚本 / 哈希清单（推荐 JSON 事件序列 + 关键字段哈希）。
3. **对齐口径**：完全一致才 approved（Tycho strict）vs 允许 UNKNOWN/coverage 语义（推荐：第一版 strict，覆盖率仅诊断）。
4. **第一版回归集范围**：≥3 个 keyless 场景（acp-snapshot text-turn、headless JSONL、1 个自建冒烟）。
5. **量化验收阈值**：01 §6 草案是否作为各里程碑完成定义（推荐确认，允许按实测微调）。
6. **gate 写入方式**：第一版 `ctx.loader.update`（运行时）还是写 patch 文件（持久化）——推荐两者：loader 生效 + patch 文件留痕持久化。
7. **overfull 复测**：现在加长预算复测，还是 L5 后统一做（推荐 L5 后统一，先锁设计）。
8. **官方口径出口修复**：是否安排修复容器 GitHub/Docker Hub 出口（影响 TB/DeepSWE 官方分数），还是本阶段只用本地补丁口径。

## 5. 进入 L5 的前置

- 用户确认第 4 节决策清单；
- 用 01 §6 阈值绑定 M1-M4；
- 更新 architecture.md（2.3 的"帧"定义与对齐口径）与 CURRENT.md；
- 拆 M1 可验收任务（observer 订阅清单、阈值、proposer 独立调用、meta.* 工具、配置接线、npm run check）。
