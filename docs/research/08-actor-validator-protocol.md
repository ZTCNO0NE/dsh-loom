# Actor/Validator 帧协议与启动硬约束

更新：2026-08-16。L4 的补充设计：回答"dsh 有哪些帧、validator 怎么被可靠唤起、actor/validator 只靠文件交互流通什么"。

## 1. dsh 的"帧"（可对齐的真实轨迹）

对齐最小单位按 L4 推荐 = **事件序列 + 配置树 + 外部状态哈希**，具体清单：

| 帧类型 | 来源 | 哈希/对齐方式 |
|---|---|---|
| Session 事件序列 | `packages/core/session` append-only 日志：`turn/start`、`step/start/end`、`user/message`、`assistant/chunk/message`（含 usage）、`tool/call`、`tool/result`（error/meta）、`request/header`、`todo/write`、compaction/* | 每条事件按 `(seq, type, payload)` 哈希；序列整体 = 逐条哈希链 |
| 工具结果规范值 | `tool/result.message` + `error {name, code}` + `meta` | 规范值 JSON 序列化后哈希 |
| 配置组合树 | `--dump-config` / `ctx.loader.entries()`（每行 id/name/config） | 整树规范化后哈希；未涉及行必须逐字节不变 |
| 外部世界状态 | 文件系统（workspace 文件字节/目录树）、命令真实输出、goal phase、feedback | 文件树哈希 / 重跑命令重读文件（dsh testing 原则） |
| 成本 | `assistant/message.usage`、token-meter | 数值记录，不参与对齐判定 |

## 2. validator 启动的三层路径（不能只靠 actor）

**结论：actor 陷入困境时，它的"主动唤起"能力本身会退化**（不发起、参数错、或试图操纵验证输入），所以自唤起只是第一层，不是唯一层。

| 层 | 触发者 | 机制 | 何时用 |
|---|---|---|---|
| L1 actor 主动 | actor（工具 `meta.request-validate`） | orchestrator 风格，actor 认为需要时提交候选 + 预期 | actor 正常、有明确候选时 |
| L2 宿主硬触发 | observer 宿主侧硬规则（**不经模型判断**） | 回合边界（turn/end）检查：连续 N 次 tool/result.error、用户纠正启发式、回归集失败、turn reason=error、token/回合预算耗尽、无进展卡死（连续同签名输出） | actor 陷入困境、忘记/无法自唤起时——这是正确性兜底 |
| L3 外部兜底 | 独立进程/人 | 独立 watcher（读 session JSONL 的 headless profile / systemd timer / 手动 `dsh` 命令）直接调度 validator CLI | 进程级兜底：即使宿主插件被拖死也能触发 |

硬约束原则：L2/L3 的判定条件全部是**确定性规则**（计数、签名比对、预算），不依赖 LLM 判断"该不该验证"；validator 启动入口不注册进 actor 工具表（或只读 status），actor 的 fs/shell 权限不覆盖验证器目录。

## 3. actor/validator 只通过文件交互（mailbox 协议）

参考 Tycho：actor 与 builder/verifier 不直接函数调用，全部经 workspace 文件（world_model.py / verify.py / plan.py / validated_plan.json / terminal.json）。我们定义对接口径 `$DSH_HOME/meta-validate/<session-id>/`：

```
meta-validate/<session-id>/
├── actor-in/        # actor 只写；validator 只读
│   ├── trajectory.jsonl     # 真实事件序列（session JSONL 的契约子集）
│   ├── config-tree.json     # dump-config 快照
│   ├── world-state.json     # 文件树哈希 + 关键文件字节哈希
│   ├── signals.json         # observer 聚合信号（含证据、回合 id）
│   └── candidate-patch.json # 可选：actor 自发起时提交（含预期轨迹）
├── validator-out/   # validator 只写；actor 只读
│   ├── report.json          # ValidationReport（verdict/指标/分歧）
│   ├── regression-results.json
│   └── before-after-hashes.json
└── protocol.json    # schema 版本 + 签名/哈希（双方校验）
```

规则：
- **方向单向**：actor 只能写 `actor-in/`、只读 `validator-out/`；validator 只读 `actor-in/`、只写 `validator-out/`（文件系统权限 + 只读挂载实现）；
- **原子写**：所有写入 tmp+rename（prime-agent 模式），杜绝读半截；
- **契约版本化**：`protocol.json` 带 schema version；session 事件类型 merge-extensible，解析器对未知类型跳过并告警；
- **防伪造**：`validator-out/` 由验证器签名；`actor-in/` 由 actor/宿主写后哈希登记，validator 校验来源（TCB 原则）。

## 4. 流通信息明细

**actor → validator（提供不可伪造的真实帧与上下文）**：
- 真实轨迹：事件序列（含 tool/call、tool/result、turn/start/end、assistant/message）；
- 当前配置组合树 + 修改目标行；
- 外部世界状态：workspace 文件树哈希、关键文件字节、命令真实输出；
- 失败上下文：连续失败计数、用户纠正文本、回归失败记录、关联回合 id/session id；
- 候选 patch（自发起时）+ 它声称的预期轨迹（供 validator 对照，不信任其结论）。

**validator → actor（产出判定与证据）**：
- `ValidationReport`：verdict（approved/rejected/needs_changes）、simulation_accuracy/strict/first_divergence/coverage；
- 第一个分歧点：精确到事件类型/字段/坐标（Tycho first_divergence）；
- 回归集逐场景结果（哪些绿哪些红）；
- before/after 哈希（应用前校验用）；
- needs_changes 的结构化建议（M2 起，给 proposer 的修复方向，类似 Tycho dispatcher 的 verify-state 回传）。

## 5. validator 帮 actor 做哪些

1. **安全判定**：候选 patch 的预期轨迹 vs 真实轨迹逐字段/哈希对齐，只有完全对齐才 approved；
2. **分歧定位**：first_divergence 告诉修改者具体哪个动作/字段错了；
3. **回归守护**：改配置/工具/技能后，keyless 回归集仍绿（防修 A 坏 B）；
4. **终局判定**：任务是否真的完成（外部断言 / goal phase，不采信 actor 自报）；
5. **配置不变性**：未涉及行逐字节不变（Tycho no-op 假变化判错）；
6. **成本记账**：每轮验证的 token/耗时回流系统级指标；
7. **（M2+）修复建议**：把分歧证据组织成给 proposer 的结构化反馈。

## 6. actor 帮 validator 验证哪些

1. **提供真实帧**：session 事件序列与外部世界状态——validator 的对齐基准，不能由 validator 自造；
2. **提供可复现执行**：临时 profile 配置、env、seed，让 validator 能在隔离环境重放候选行为；
3. **接受宿主调度**：回合边界停机、应用 patch、冒烟、恢复——冷替换协议是 actor 运行时必须配合的契约；
4. **结果回填**：验证通过后的真实表现继续回流 observer（收敛性：expectedOutcome 是否真的达成，形成下一轮信号）；
5. **不背书 validator**：validator 的正确性由独立模型 + 回归集 + 签名保证，不由 actor 评价。

## 7. 对现有设计文档的增量

- 07 §4 决策项 1/2 的具体化：帧 = §1 三类组合；预期轨迹 = JSON 事件序列 + 关键字段哈希；
- 07 §3 R6 关闭：文件协议即"预期轨迹格式"的载体；
- 触发规则（§2 L2）应在 M1 observer 里硬编码为 Config 阈值（`repeatedFailureCount` 等已有），**不是** proposer/validator 的模型决策。

## 8. 角色三分与信息边界（2026-08-16 用户方向确认）

用户口径：**"validator 帮助迭代，actor 只负责验证/感受当前迭代的效果"**。这与 Tycho 一致，但需要把角色拆清楚，否则 TCB 会泄漏：

| 角色 | 职责 | 需要看到什么 | 不需要看到什么 |
|---|---|---|---|
| **builder（迭代者）** | 读用户需求 + actor 轨迹 + 配置树，迭代出候选 patch + 预期轨迹；被核验拒绝时按分歧证据继续迭代 | 用户需求（user/message、goal、feedback、用户纠正）、真实轨迹、配置树、verifier 的 first_divergence | actor 的内心推理/提示词历史（防自我确认偏误） |
| **verifier（核验者）** | 确定性对齐：预期轨迹 vs 真实帧（Tycho verify）；回归集守护；终局断言 | 预期轨迹、真实帧、回归集、外部世界状态 | 用户需求的语义解释（回归集已经把需求编码成可测断言）；actor 内心 |
| **actor（体验者）** | 在当前配置下执行任务、感受效果、产出真实帧；可主动请求迭代 | 当前配置 + 任务 + 验证结果摘要（report.json） | 修改自己的实现细节；验证链路内部 |

关键规则：
- **builder 必须能看用户需求**（用户触发迭代时，需求从 session/goal/feedback 经 observer 进入 builder 输入）；verifier 不需要，它只对"预期 vs 真实"负责；
- **builder 对 verifier 只读**：builder 可以迭代任何东西，唯独不能改 verifier/回归集/签名链（否则自进化退化成自我欺骗）；
- **actor 不能改自己的 loop**：结构上 dsh 允许替换 loop 插件，但本项目禁止 actor 自改；改 loop 必须预约 → 回合边界 → gate 冷替换 → 核验 → 回滚，且 M4 才评估放开；
- **"效果由 actor 感受" = 真实帧来源**：actor 在新配置下的表现（成功/失败/卡死）就是 verifier 对齐的真实帧，也是下一轮 observer 的收敛信号；但正式判定（keep/rollback）由 verifier + 外部断言决定，不采信 actor 自报。

用户触发路径（本轮确认）：用户要求迭代 → observer 把需求/轨迹/信号写入 `actor-in/` → **builder 迭代**（可能多轮：候选 → verifier 拒绝 → 按 first_divergence 再改）→ verifier 通过 → gate 回合边界应用 → actor 以新配置继续执行 → 效果回流 → 收敛判定（expectedOutcome 达成才停）。

对代码结构的影响：`src/meta/propose.ts`（builder）与 `src/validate/index.ts`（verifier）职责保持不变，但**对外口径**统一为"validator 子系统 = builder + verifier"；M2 起 builder 的迭代循环可多轮，verifier 每轮独立跑。

## 9. verifier：固定式 vs 模型式（2026-08-16 决策）

事实：Tycho 的 builder 与 verifier 是**分离**的——builder 是 LLM（写/修 world_model.py），verifier 是**固定程序**（`verify.py`/`verify_outcome.py`，纯 numpy 确定性对齐，无 LLM 判定）；planner 是确定性搜索。

本项目决策：

- **核心核验固定式**：verdict 只由确定性对齐（simulation_accuracy/strict/first_divergence/coverage）+ 回归集通过 + 配置不变性 + 外部断言决定；
- **LLM 只出现在两处，都不进 verdict**：builder 迭代（产候选/按 first_divergence 修 patch）；needs_changes 结构化建议（基于固定分歧证据生成，属诊断非判定）；
- **第一版不引入 LLM 法官**：用户需求优先编码为回归集/断言；若未来开放任务必须语义判定，做成独立降权角色，明确不在 TCB 内；
- 依据：TCB 可审计性、防自我确认偏误、Tycho trigger（自动修复 83.07 < orchestrator 88.49）说明"模型对 ≠ 行动对"。

## 10. builder 自我评估 + verifier 硬门循环（v1 决策）

用户方向（2026-08-16）：**builder 与 verifier 完全分离；verifier 第一版固定式；硬要求完整验证版本**——builder 自己评估置信度/完整度，觉得够了才提交；verifier 不通过就**强制**回炉看完整性，不允许绕过。

### 状态机（v1）

```
draft（builder 起草）
  → self-check（builder 自我评估：跑自己的确定性自检 + 置信度/完整度估计）
  → submitted（builder 自评达标才提交：self-check 通过且置信度 ≥ 阈值）
  → verifying（verifier 完整验证：全部指标 + 全量回归集，不做抽样）
       ├─ approved → gate 回合边界冷应用 → 冒烟 → 成功/回滚
       └─ rejected（附 first_divergence/coverage 报告）→ **强制回 draft**（必须重新看完整性）
```

### 硬规则

1. **提交门槛归 builder**：候选只有经过 builder 自我评估（置信度、完整度、自跑确定性自检）且达到配置阈值才允许进入 verifier；这是模型侧的自律，不是判定。
2. **核验归 verifier，完整且固定**：verifier 每次跑**全量**验证——仿真对齐（simulation_accuracy/strict/first_divergence/coverage）、回归集全部场景、配置不变性、外部断言；不做子集/抽样。
3. **不通过 = 强制回炉**：verifier 拒绝后，候选状态只能是"回 draft 补完整性"，不存在 force-apply、跳过指标、降级阈值放行；由 gate（TCB）执行该约束，不依赖 builder 自觉。
4. **多指标与正确性**：对齐率、覆盖率、first_divergence 三者都要达标（Tycho verify 风格）；`approved` 只发生在全指标通过。
5. **收敛预算**：同一候选回炉次数上限（`maxIterations`，可配置）；超限未达标 → 升级给用户人工决定，而不是无限循环或放行。
6. **builder 输出（含代码）默认不可信**（2026-08-16 决策）：不假设"builder 生成的代码没问题"。代码级错误（语法、依赖解析、模块初始化、注册冲突）由 verifier 在隔离环境做**加载即校验**（fresh process import，失败即 rejected），行为再由 probe/回归验证；builder 的自检（如 `node --check`、静态检查）只是提交前的省钱过滤器，**不构成任何验收**。M2.6 隔离执行器是 verifier 的能力，不是 builder 的验收权。

### builder 自我评估（参考 Tycho meta-reflection）

- Tycho builder 工作区里有 verify.py/plan.py，可先自跑确定性校验再交；我们的 builder 同样可在提交前对候选跑**同一套固定校验的只读副本**（自检通过 ≠ 官方核验通过，官方 verdict 只出自 verifier）；
- 置信度/完整度是 builder 输出的**声明字段**（`selfConfidence`、`completeness`），只作为提交门槛与诊断，不参与 verifier 判定；
- builder 的每次回炉输入 = verifier 的 first_divergence/coverage 报告 + 完整度缺口清单。

### 指标阈值（verifier 完整版，草案）

| 指标 | 通过要求 |
|---|---|
| simulation_accuracy / strict | 100%（评分转移全部精确复现） |
| first_divergence | 无（存在即 rejected） |
| prediction_coverage | ≥ 阈值（默认 0.75，Tycho 口径；配置可调） |
| 回归集 | 全部场景通过 |
| 配置不变性 | 未涉及行逐字节一致 |
| 外部断言 | 全部通过 |

## 11. 文件优先与持久化 meta workspace（2026-08-16 决策）

原则：**上下文不可完全信任**——compaction 会丢细节、注意力稀疏、模型记忆不可靠。因此 actor/builder/verifier/gate 之间，以及每个角色**内部**的关键状态，一律文件持久化；上下文只承载当前回合的临时工作集。

### 布局（`$DSH_HOME/meta-validate/`）

```
meta-validate/
├── protocol.json                 # schema 版本 + 签名公钥指纹
├── regressions/                  # 回归集（TCB：对 actor/builder 只读）
│   ├── <scenario>/task.md        # 任务描述
│   ├── <scenario>/assert.*       # 外部断言/期望哈希
│   └── suite.json                # 场景清单 + 版本
└── workspace/<session-id>/
    ├── trajectory/
    │   ├── events.jsonl          # 真实帧持久化（append-only；dsh session JSONL 契约子集投影）
    │   └── world-state.json      # 外部状态哈希（文件树/关键文件/命令输出）
    ├── builder/
    │   ├── world-model.json      # builder 的持久世界模型（version + before/after hash）
    │   ├── self-check.json       # 自评记录（selfConfidence/completeness/自检结果）
    │   └── model-notes.md        # 可选推理笔记（诊断，非判定）
    ├── signals.jsonl             # observer 持久信号（append-only）
    ├── patches/<patch-id>/       # 每轮候选（状态机全程留档）
    │   ├── candidate.json        # MetaPatch
    │   ├── expected-trajectory.json  # 预期轨迹（事件序列 + 关键字段哈希）
    │   ├── report.json           # verifier 报告（verdict/指标/first_divergence）
    │   └── status.json           # draft/self-check/submitted/verifying/approved/rejected
    └── history.jsonl             # gate 应用/回滚历史（before/after 快照、版本、rollback 记录）
```

### 规则

1. **证据 append-only**：`events.jsonl`、`signals.jsonl`、`history.jsonl` 只追加不覆盖（可重放、可审计）；
2. **状态文件原子写 + 版本化**：`world-model.json`、`status.json`、`report.json` 一律 tmp+rename；每次变更记录 before/after 哈希与版本号（prime-agent/Tycho 模式）；
3. **恢复只读文件**：任何角色（含 builder 自己）恢复现场时从文件重建，**不依赖 LLM 摘要/上下文**；compaction 后 meta 层重读文件即可继续；
4. **写权限边界（TCB）**：regressions/ 与 verifier 代码对 actor/builder 只读；builder 只能写 builder/ 与 patches/<id>/；verifier 只写 report/status；gate 写 history 并执行应用；
5. **builder 的世界模型是文件不是记忆**：builder 每次迭代读 `world-model.json` → 提出更新 → 写回新版本；verifier 也只读文件版世界模型做对齐；模型上下文里的"理解"是临时草稿，文件才是权威；
6. **dsh 原生持久化配合**：session JSONL 已是 durable truth，meta workspace 保存其契约子集投影；**验证器重放需要 `persistenceCompression: 'none'` 的原始 JSONL**（acp-snapshot 的既有要求）；
7. **内容即协议**：所有跨角色文件带 `schemaVersion`，未知字段跳过并告警（merge-extensible），避免上游事件扩展导致解析失败。

### 与 Tycho 对照

| Tycho | 本项目 |
|---|---|
| frames/transitions（磁盘证据） | `trajectory/events.jsonl` + `world-state.json` |
| world_model.py（builder 持久模型） | `builder/world-model.json`（版本化） |
| verify.py / plan.py | `regressions/` + verifier 固定校验脚本 |
| validated_plan.json（计划+预期帧哈希） | `patches/<id>/expected-trajectory.json` |
| version_store 因果文件版本化 | 状态文件 before/after 哈希 + history.jsonl |
| replay viewer | run-log + 快照（`docs/research/run-log.md` 规则） |

## 12. v1 信息目录与闭环核对（2026-08-16）

逐条核对后补齐的缺口：①用户需求无显式文件；②§3 的 before-after-hashes 未进布局；③应用后冒烟范围未定；④隔离运行产物位置未定；⑤expectedOutcome 达成判定无载体；⑥世界模型 v1 最小内容未定；⑦触发请求无持久化。

### v1 信息目录（生产者 → 消费者，方向单向）

| # | 信息 | 载体文件 | 生产者 → 消费者 | v1 内容 | 状态 |
|---|---|---|---|---|---|
| I1 | 用户需求 | `requirements.json` | observer → builder | 触发文本 + goal/feedback 引用 | **本次补齐** |
| I2 | 触发请求 | `triggers.jsonl` | observer/外部 → gate | kind（user/host_rule/external）+ 规则名 + 证据引用 | **本次补齐** |
| I3 | 真实轨迹投影 | `trajectory/events.jsonl` | observer → builder/verifier | turn/start/end、user/message、tool/call、tool/result(+error)、assistant/message(usage)；**不含 assistant/chunk 原文** | 已定 |
| I4 | 外部世界状态 | `trajectory/world-state.json` | observer/gate → verifier | workspace 文件树哈希 + 关键文件哈希 | 已定 |
| I5 | 信号 | `signals.jsonl` | observer → builder | repeated_failure / user_correction(启发式) / regression_failure；**reusable_tactic 延后** | 已定 |
| I6 | 世界模型 | `builder/world-model.json` | builder 自产自读 → verifier 只读 | 目标行行为契约：invariants、配置依赖、预期事件模式、version/hash | 内容 v1 最小 schema 待 L5 |
| I7 | builder 自评 | `builder/self-check.json` | builder → gate（提交门槛） | selfConfidence、completeness、自检结果 | 已定 |
| I8 | 候选 patch | `patches/<id>/candidate.json` | builder → gate/verifier | MetaPatch 字段 + targetKind 白名单（config/tool/skill） | 已定 |
| I9 | 预期轨迹 | `patches/<id>/expected-trajectory.json` | builder → verifier | JSON 事件序列 + 关键字段哈希 | 格式待 L5 最终确认 |
| I10 | 验证报告 | `patches/<id>/report.json` | verifier → builder/gate | verdict + 对齐指标 + first_divergence + coverage + 回归结果 + **before/after 哈希** | 已定（哈希并入 I10，消除 §3 重复文件） |
| I11 | 状态机 | `patches/<id>/status.json` | gate 维护 → 全角色 | 状态 + 时间戳 + 操作者 | 已定 |
| I12 | 应用/回滚历史 | `history.jsonl` | gate → 审计/恢复 | patch、before/after 快照、rollback 记录 | 已定 |
| I13 | 隔离运行产物 | `patches/<id>/run/events.jsonl` + `world-state.json` | 验证执行环境 → verifier | 候选在临时 profile 的真实帧 | **本次补齐** |
| I14 | 回归集 | `regressions/` | 作者/维护者 → verifier | ≥3 keyless 场景（acp-snapshot/headless/自建） | 已定 |
| I15 | 应用后冒烟 | `patches/<id>/smoke.json` | gate → keep/rollback 判定 | keyless 子集 + 配置不变性 + expectedOutcome 外部断言 | **本次补齐**（范围待 L5 确认） |

### 闭环核对（每个消费者的输入都有生产者）

- observer：读 dsh 事件（agent/error、tool/result、user/message、turn/end、regression 结果）→ 写 I1/I2/I3/I4/I5；
- builder：读 I1/I2/I3/I4/I5/I10（回炉证据）→ 写 I6/I7/I8/I9；
- verifier：读 I3/I4/I6/I8/I9/I13/I14 → 写 I10（+ I15 的判定输入）；
- gate：读 I7/I8/I10/I11 → 写 I11/I12/I15，经 `ctx.loader` 应用；
- actor：读 I10/I11/I15 摘要（report 可读），写真实帧（经 dsh session 日志 → observer）；
- 外部：手动/CLI 触发 → 写 I2。

### v1 明确不做（范围切割）

- 不投影 assistant/chunk 原文（体积大，v1 无必要）；
- 不复用 reusable_tactic 信号（延后）；
- 不引入 LLM 语义法官（§9）；
- 不开放 loop 层修改（M4）；
- 不做进程级验证器隔离（M2 对抗场景再评估）；
- 不依赖压缩摘要恢复（§11 文件优先）。

## 13. builder 与 actor runtime 的边界 / 探测路径（2026-08-16 决策）

问题：builder 要不要看完整 actor runtime？能不能调起 actor 来实测？

决策：

1. **builder 只看 actor 的可观察行为（帧），不看完整 runtime**：actor 的内存/提示词历史/内部状态对 builder 是黑盒；行为轨迹（I3 事件序列 + I4 外部状态 + 配置树）齐全即足够迭代。看完整 runtime 会泄露 actor 上下文，引入自我确认偏误。
2. **builder 绝不直接改 actor**：写权限只覆盖 `patches/<id>/` 与 `builder/`；生产配置的完全覆盖只发生在 verifier approved 后由 gate 回合边界冷替换。
3. **builder 要实测（probe）→ 走隔离探测路径，不调起生产 actor**：

```
builder → 写 probe-request（探测任务 + 预期轨迹）到 patches/<id>/
        → verifier 在临时 profile 隔离环境应用候选并执行探测
        → 真实帧写回 patches/<id>/run/
        → builder 读回帧，决定继续迭代或提交
```

4. **v1 简化**：probe 与正式验证共用同一条隔离执行路径；builder 自检保持离线（静态检查 + 重放已记录帧），执行入口只有一个，TCB 干净。
5. 与 Tycho 对照：Tycho builder 从不驱动 actor（只写 world_model.py + 自跑 verify/plan 确定性重放），活体验证由 actor 使用模型或 harness 触发；我们的 probe-request 等价于"builder 申请一次隔离实测"，执行权仍在 verifier/gate。

## 14. 两级验证环：隔离准入 + 真实运行（2026-08-16 决策）

问题：临时 profile 的隔离探测能"完全"验证候选吗？拼接多个组件、对 runtime 影响很大时够吗？

结论：**不够，也不指望它够**。设计是两级环：

```
内环（pre-apply，准入门槛）：
  draft → builder self-check → verifier（临时 profile 隔离执行）
       → approved / rejected（强制回炉）

外环（post-apply，最终裁判）：
  gate 冷应用 → actor 以真实任务继续运行
       → observer 持续观察（expectedOutcome 达成 / 回归失败 / 新失败 / 卡死）
       → 达标 → 收敛（锁一个 epoch）
       → 不达标 → gate 回滚（M3 自动 / M2 人工确认）
                  → 带真实帧证据回 builder，重新进入内环（多轮）
```

要点：

1. **隔离验证 = 准入门槛**：能抓 schema 错、组合树错（`--dump-config` 校验同 profile 同 patch 层）、行为面回归（keyless）、探测任务分歧；**不能完全预测真实运行**——真实任务、时序、多插件拼接的涌现行为、长程效应都只能在真实运行中暴露。
2. **真实测试 = 上线后由真实 actor 跑**：候选不在上线前交给生产 actor 试跑（危险且会污染生产）；上线后 actor 的每一轮真实任务就是最终测试，observer 拿 expectedOutcome/回归/新失败当判定。
3. **多轮是设计常态**：外环不达标 → 回滚 → 带真实帧证据回 builder 再迭代；这正是"builder 认为改好上线 → actor 重跑出问题 → 回滚 → 再审阅多轮"的完整表达。
4. **拼接复杂度**：影响越大，越依赖外环与回滚成熟度——隔离环境必须尽量还原真实组合树；涌现行为留给外环；分层放开（config → tool/skill → loop）的根据就是拼接越复杂，外环验证成本越高。
5. **probe 的定位**：Tier 1 探测任务是"隔离下的行为采样"，不是真实任务；要更接近真实的验证，M2+ 可选"影子 profile"（独立进程跑真实任务子集，不碰生产），v1 不引入。
   - **隔离执行器只验证候选自身的基础错误**（组合树可加载、行为面对齐、未涉及行不变），**不感知 actor**（不复制会话/上下文）；actor 已提供全量轨迹时，隔离运行只回答"候选应用后世界是否按预期转"（2026-08-16 确认，见 m2-plan M2.6）。
6. 指标对应：A3（隔离判定）→ M2；B1/B2（效果对照、无回归）→ M3 外环；回滚成功率 → 外环安全网指标。

## 15. 触发频率与评审门（review gate，2026-08-16 设计）

问题：自动挂接后，builder 的调用频率怎么定？prime-agent 的做法是回合间隔/compaction 确定性触发 → `reviewAutoRefine` 独立 LLM 判 `shouldRefine` → 才跑 plan。我们照搬但**前置更省**：

```
回合边界
 → 阶段0（免费，确定性前置）：连续失败≥N / 用户纠正 / 回归失败 / 卡死 / 预算耗尽
     未命中 → 不动作（候选频率由阈值控制）
     命中   → 进入评审门
 → 阶段1（一次独立 LLM 调用，廉价）：review gate
     输入：信号摘要 + 最近轨迹摘要 + 迭代历史（reports）
     输出：{shouldRefine, rationale, focus, priority}
     shouldRefine=false → 只留痕，不启动 builder（省 builder+verifier 成本）
     shouldRefine=true  → 进入阶段2
 → 阶段2（贵）：builder 迭代 + verifier 完整核验 + gate 应用
```

### 与 prime-agent 的对照

| | prime-agent | 本项目 |
|---|---|---|
| 确定性触发 | turn_interval / compaction（固定间隔） | **只在"看起来有问题"时触发**（阈值前置，更省） |
| 语义判断 | reviewAutoRefine（独立 LLM）判 shouldRefine | review gate（独立 LLM，非 actor、非 builder）判 shouldRefine + focus |
| 贵步骤 | planRefinement | builder + verifier |
| 验收 | 宿主确定性校验 | verifier 固定式完整核验（唯一验收） |

### 关键规则

1. **评审门是第三个独立角色**：独立 sessionId/purpose，不注入 actor 历史；只读信号/轨迹摘要/历史报告。
2. **评审门只能否决启动，不能批准 patch**：approved 只出自 verifier；shouldRefine=false 省成本，shouldRefine=true 才值得花钱。
3. **频率不拍死，用三个旋钮收敛**：
   - 确定性前置阈值（`repeatedFailureCount` 等）→ 候选触发率；
   - `reviewGate.enabled` + prompt → 值得率；
   - 冷却/epoch 锁（`minIntervalTurns`、`maxIterationsPerEpoch`、apply 后锁定一个 epoch）→ 最大频率上限。
   - 有效频率 = 候选触发率 × 值得率，且被冷却上限截断；初期保守默认，B1 实测后调。
4. **模式**：observe 默认关评审门（只采集）；propose/apply 开。
5. **留痕**：决策写 `gate-decision.json`（shouldRefine/rationale/focus/evidenceRefs/cost），triggers.jsonl 追加 `kind='review_gate'`。
6. **指标**（09 增补）：gate 精度（yes 且最终 approved/无回归）、gate 召回（builder 成功案例中 yes 占比）、成本节省（no 省掉的轮次）、触发频率分布（每 epoch 迭代次数/间隔，用于调阈值）。
