# Builder Foundation Spec — 极简持久化 Builder（草案）

更新：2026-08-18。状态：**已定架构基线，尚未替换现有受限 candidate gateway 实现。**

## 1. 定义

Builder 不是一次性 proposal generator，也不是 loop 候选 JSON 填表器。它是一个独立的、持久化的极简 DSH agent：有自己的 loop、工具、文件状态与跨回合 journal。它读取 actor 的状态和环境，主动探索并决定是否提出一个变更。

```text
actor 状态 / 用户目标 / 历史反馈
              ↓
       Builder minimal loop
              ↓
  capability skills + tools + own journal
              ↓
        proposal（不直接生效）
              ↓
      verifier → gate → cold apply / rollback
```

`loop-evolution` 不是 BuilderKernel 内置的特例或小网关；它是 Builder 的第一个 capability skill/tool。未来 actor 能力演化、builder 自我演化和其他目标演化都按相同的 capability 注册协议增加。

## 2. 极简内核

内核只负责下列稳定职责：

1. 持久化 Builder 自己的 world model、plan、journal、snapshots 和未完成任务；
2. 在每次工具调用后把真实结果（返回值、stdout/stderr、退出码、artifact ref/hash、错误）写入 journal，并在下一回合提供给 Builder；
3. 接收 Builder 的 `continue | invoke_tool | submit | abort` 决定；
4. 冻结提交物、建立 proposal 与 Builder run 的对应关系；
5. 接收 verifier、gate、probe、install 的拒绝/回滚报告，创建新的 immutable run，并把报告作为下一 run 的已知输入；
6. 在目标为 Builder 自身时，安排回合边界的冷切换；Builder 不在正在执行的 loop 中替换自己。

内核**不**规定 Builder 该读哪份文件、429 后该选哪条路线、该改几个文件、何时必须 preflight，或 loop 候选必须来自哪一条特定网关。这些是 capability 的行为与 verifier 的验收规则，不是 Builder 的认知边界。

## 3. 信息与工作空间

Builder 对部署所划定的全局可读信息有读取能力，至少包括 actor profile/state、源码、配置、历史运行记录、候选和 registry、构建/测试输出、自己的历史、以及 verifier/gate 报告。它可按需重新读取 actor，不依赖压缩后的 LLM 摘要。

Builder 自由写自己的持久状态和实验工作区，例如：

```text
builder/<id>/
  world-model.json
  plan.json
  journal.jsonl
  workspace/             # checkout、补丁、多文件实验、构建产物
  artifacts/             # 工具结果与可重放证据
  submission/            # 冻结 proposal / manifest / diff
```

JSON 是工具协议、状态和交付格式；它不是唯一表达方式，也不是源码修改只能放进一个 `candidate.json` 的理由。

## 4. 工具与 capability

### Actor evidence pack

用户主动委托时，核心在 Builder run 创建前冻结一份三层 evidence pack：

```text
evidence/<id>/
  manifest.json          # watermark、hash、原始文件引用
  config-snapshot.json   # 已脱敏的 actor 配置快照
  actor-handoff.md       # actor/用户的自然语言观察与未知项
```

`manifest.json` 引用 `trajectory/frames.jsonl`、`events.jsonl`、requirements、signals、triggers、actor profile 和其他存在的状态文件，并记录行数、字节数与 SHA-256。`deterministicDigest` 只抽取已知指标（错误、延迟、停滞、工具统计和确定性信号）；`actor-handoff.md` 可以自由描述怀疑、上下文和目标，但不是 verifier 结论。Builder 以 manifest 为入口，仍可读取 watermark 对应的原始文件，不把摘要当成信息边界。

首个真实 evidence pack 使用隔离 actor 会话生成：`/chenzute/dsh-src/eval/meta-workspace-actor-loop-async-20260818/workspace/actor-loop-async-20260818/evidence/`。它包含 826 个原始帧、8 个归一化事件、27b actor 的运行 digest，以及对“loop 基座过弱”请求的自然语言 handoff。该会话证明了主动委托和后台调度，但尚未证明候选改动的效果。

Builder 运行标准 DSH 工具调用微循环。基础工具面应允许：全局读取/搜索、文件工作区操作、源码/候选发现、Git/网络获取、构建、测试、契约 runner、性能 probe 与 artifact 查询。每个调用都必须返回可记录的实际反馈，而非只返回“已执行”。

Capability 以 skill/tool 形式注册，并声明：输入、工作区约定、可调用工具、产物 schema、verifier、目标类型及安装策略。首个 capability：

```text
loop-evolution
  输入：actor 任务/遥测、当前 loop、历史报告
  工作：发现候选或自行改动 → build → contract/probe → 提交 diff/manifest
  交付：可重放的 candidate proposal
  裁决：独立 loop verifier + gate cold install + rollback
```

429、构建失败、测试失败和性能不达标均是普通工具反馈。Builder 自己决定重试、换来源、手工修复、改用现有基线、继续探索或 abort；系统不得用提示词把选择收缩为固定三选一。

## 5. 变更与裁决边界

Builder 可以自由产生和验证候选，但不能让候选直接改变被治理目标：

```text
Builder workspace 写入          → Builder 自主
actor / builder / loop target   → proposal/diff，等待 verifier
verifier / regression / gate    → Builder 只读
正式安装、冷替换、回滚          → Gate 专有
```

这不是以减少信息或减少选择来防错；Builder 可以尝试任意合理方案。约束只落在“谁能让目标状态生效”：只有独立 verifier 通过、gate 执行的 proposal 才能修改 live target。

若部署在尚未物理隔离的开发阶段，必须如实标记为 **trusted exploration mode**：一旦向 Builder 暴露能直接写 live target 的原始宿主 shell，就无法声称“所有目标写入均经过 verifier”。该模式可用于能力验证，但不是可证明的治理边界。正式治理模式需把目标写入收敛到 proposal/gate 路径；这不限制 Builder 的全局读取、工作区写入或探索深度。

## 6. 迁移顺序

1. 固化本规格，冻结继续向 `allowLoopCandidates` 添加强制策略；
2. 把现有 Kernel 缩回“持久状态、journal、反馈回注、冻结 submit”的最小职责；
3. 建立 Builder 基础 profile/loop，并提供全局读取与持久 workspace；
4. 将当前 Git/generated candidate 逻辑迁为 `loop-evolution` capability，而非 core gateway；
5. capability 产出多文件 diff + manifest + artifacts；verifier/gate 接口保持最终裁决；
6. 以真实案例验证：Builder 读取 429 → 自主换路线或修改 → build/probe → 提交 → verifier/gate 冷切换 → actor 重跑。

## 7. 非目标

- 不要求 Builder 每次都修改；abort 是有效的自主结论。
- 不将 verifier/gate 合并进 Builder，也不允许 Builder 自我批准。
- 不把完整自主性等同于任意修改 live target。
- 不把当前 `candidate.json`、固定 attempt 数或固定 fallback 文案固化为长期接口。
