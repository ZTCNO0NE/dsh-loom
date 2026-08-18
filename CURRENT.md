# CURRENT.md — 当前状态与交接

更新：2026-08-18 15:30（Asia/Shanghai）

## 一句话状态

**`v1.1.0` 已完成双重正式发布**（GitHub release + npm latest）。`35abb31` 已完成 Builder 开放探索、unknown capability `needs_verifier` 草案、rejection reopen、evidence snapshot 与真实 proposal→verifier→gate→replay 闭环；本轮 Actor ↔ Builder 持久会话又补齐幂等消息、跨 run composite cursor、冻结 submission manifest、Kernel pause/cancel、typed `needs_input` 与安全 resume。`npm run check`、`npm test`（**148/148**）、`npm run build`、`git diff --check` 已通过；生产与用户 profile 均未触及。

### 2026-08-18 13:40 本轮收口（针对 1/5/6/7）

- 裁决、import、install/gate 异常统一转为带 proposal/error 的 `rejected`，进入 immutable reopen，不再静默落为 job `failed`。
- 宿主重载会把遗留 `scheduled/running` job 安全标记为 `interrupted`，保留 run/journal/evidence，避免持久状态谎称仍在执行；actor 可重新委托。
- comparison 增加 `rollbackRequired`，要求 rollback 证据时缺失即 `admissible=false`；普通同任务 replay 明确标记 rollback 不在本次比较范围。
- Builder 重复工具调用只在连续反馈完全不变达到阈值时终止；工作区内容变化时允许继续探索。
- 当前仍有未跟踪临时文件 `.tmp-e2e-overlay.yml`，提交前需清理或转成正式实验资产。

### 2026-08-18 15:30 Actor ↔ Builder 持久会话（协议已收口）

- `meta_auto` 现在返回 `builderSessionId`（当前等同 jobId）；`meta_builder_message` 可分别保存 `rawUserText`、`actorMemo`、`evidenceRefs`，旧 `message` 字段兼容保留。
- 新增 `meta_builder_events(afterSeq, limit)`：Actor 读取生命周期、工具完成/失败、Builder `message_ack`、`builder_update`、proposal draft 等可审计摘要，再向用户解释；不输出隐藏思维链。
- Builder 新增 `acknowledge_message` 与 `publish_progress` 工具。用户/Actor 的语义保持开放；固定的只有传输、审计、取消与 verifier/gate/install 权限边界。
- rejection 与 host-restart resume 的新 immutable run 带 `previousRun`：旧 workspace/journal/world model/plan/events/submission 的路径与 hash 清单，供 Builder 自主只读复用。`meta_auto(exploreLoop=true, resumeJobId=...)` 会建立这种安全续接，而不重放中断时的副作用。
- 消息使用 Actor 稳定 `idempotencyKey` 去重；同 key 不同内容 fail-closed。`meta_builder_events` 返回 `${lineageId}:${runId}:${seq}` composite cursor，run 切换自动 `reset=true`，不会因 seq 重用漏事件。
- `submission/manifest.json` 绑定 proposal、input、target-before、evidence/artifact hash；提交前若任一冻结内容变化即拒绝。
- Kernel/Driver/Gateway 已覆盖 pause/cancel/resume 与 `request_input → needs_input`；resume 会保留旧 run 只读资产并重新走同一后台 executor。下一步只需做一次隔离 Actor 真机多轮演示，不再扩张协议边界。
- 已完成一次真实官方 Builder 多轮中途指导实验：证据见 `docs/research/run-log.md` 与 `/chenzute/dsh-src/eval/run-records/2026-08-18T074405558Z-real-actor-builder-mid-guidance.json`。通信、pause→immutable resume、原文/memo 保真均通过；Builder 因相对源码目录探索失败和回合预算耗尽未提交 proposal，故没有 verifier/gate/安装或性能提升结论。后续应先补“源码根目录/候选入口”上下文，再重跑同一案例。
- 已补跑带明确源码根目录/候选入口的复验：`/chenzute/dsh-src/eval/run-records/2026-08-18T074750285Z-real-actor-builder-mid-guidance-rooted.json`。路径问题消失，但 Builder 仍在 18 回合内重复读取/回执而未提交，确认当前剩余瓶颈是模型收敛与提交纪律；不得据此宣称真实演进或性能提升。

### 2026-08-18 v1.1 减法定稿（docs/v1-1-route.md）

- 唯一入口：`meta_auto(exploreLoop=true, requirements, actorAssessment)`；后台 job 先冻结三层 evidence pack（manifest+digest+handoff），Builder 读原始文件自由探索；
- 裁决：patch → Validator + Gate + 同任务隔离重跑 + 台账；loop → `CandidateImporter`（本地固定 baseline，无网络）→ contract-runner C0/C1-C8/C6 → profile gate 冷安装；
- loop leg 启用需配置 `allowLoopCandidates.{baselineRoot,baseBundle,dependencyRoot,contractCommand,contractTask,goldenPath}`，未配置 fail-closed；
- 测试 133/133（新增 deliberation 6 条 + verifier 拒绝回注 reopen 1 条，删除 discover 3 条）。

### 2026-08-18 真机实证（e2e16 + 确定性 gate 复现）

- **proposal→裁决→gate→同任务重跑全链路真实闭环**：27b 主动委托 → V4 Flash Builder 提交 loop-evolution proposal（5 回合/4 工具）→ 本地 baseline 构建 → C0/C1-C8/C6 全绿 → approved → profile gate 冷安装（C0 冒烟 pass、before/after 落盘）→ 同任务重跑 admissible=true（causal-workload）。
- 修复 6 个真实 bug（二次 stage、git archive 整树、依赖锚点、maxTokens 脱敏、workspaceRoot 串味、C6 cwd）；快照 `run-records/2026-08-18-loop-e2e-proposal-adjudication-gate.json`。
- 剩余：Builder 自由探索收敛性不稳（e2e17 卡重复 read_file 未提交），后续引导"最小必要探索后尽早 submit"。

## 当前进行中（loop 层放开，按序）

### Builder 基础重定（2026-08-18，优先于继续扩展候选网关）

用户确认：Builder 应是一个具有自身持久化极简 loop 的独立 agent，而非受限 JSON candidate generator；`loop-evolution` 应降为第一个 Builder capability skill/tool。Builder 对部署范围内状态具备全局读取、可在自身 workspace 自由探索/写入/构建/测试，并以真实工具反馈驱动多步修正；actor、builder 或 loop 的 live 变更一律以 proposal 交给独立 verifier/gate。JSON 保留为工具协议、journal 与交付格式，不作为认知或单文件写入边界。规格：`docs/builder-foundation-spec.md`。

`loopBaseline`、固定 fallback 文案与扩大的 acquisition attempts 临时修补已从当前工作树撤出。基础 Kernel 已补齐：全局文件/目录读取、持久 workspace 多文件读写、命令 stdout/stderr/exit-code 反馈及通用 proposal freeze；`npm run check`、`npm test`（124/124）、`npm run build` 全绿。下一实现步骤：建立 Builder 基础 profile 与 capability 注册协议，再把现有 Git/generated gateway 收编为 `loop-evolution` capability。

插件拼装基线（2026-08-18）：Capability 可自由新增并声明它要求的 verifier set；Verifier 以可插拔、固定版本/hash 的治理插件形式存在；Gate 对 immutable proposal + 完整同 hash 的 required reports 执行 fail-closed 授权，缺报告、超时、错误、not_run、stale evidence 或 before-snapshot 冲突一律不放行。`loop-evolution` 的首个 verifier set 及实现顺序见 `docs/plugin-composition-spec.md`。

Builder 洁净重绘（2026-08-18）：`src/builder/capabilities.ts` 提供最小起始工具集与 capability registry，`loop-evolution` 作为首个声明式插件注册；capability 只提供上下文，不替 Builder 规定路线。隔离实测 `eval/run-records/2026-08-18-builder-free-loop-observation.json`：故意错误 actor loop 基线 0/3，官方 V4 Flash 单次 Builder run（8 turns/7 tools）读取源码与需求、根据第一次 oracle 路径错误反馈修正、重写 loop，最终外部 oracle 3/3；未安装、未调用 verifier/gate。

Actor ↔ Builder 通信基础（2026-08-18）：actor 的主动委托不再同步等待 Builder。`meta_auto(exploreLoop=true)` 先持久化 immutable Builder run，再进入 single-flight 后台 job queue 并立刻返回 `jobId/runId`；`meta_builder_status`、`meta_builder_message`、`meta_builder_events` 和新增 `meta_builder_control` 分别提供状态、原话 inbox、composite cursor 事件流和 pause/cancel/resume。job 的 request/runId 在 scheduled/running/paused/waiting_for_input/cancelled/finished 中保留。真机隔离运行记录 `eval/run-records/2026-08-18-actor-builder-async-communication.json` 仍只证明非阻塞委托；本轮新增的是零成本确定性协议闭环，尚无新的真机性能声明。

Actor evidence pack（2026-08-18）：新增 `src/evidence/index.ts`，主动委托前冻结三层证据：原始 frames/events 等文件引用及 hash、确定性 runtime digest、可自由书写的 `actor-handoff.md`（含未知项）。Builder 收到 manifest 入口后可继续读取原始文件，摘要不是信息边界。真实隔离 actor 会话 pack 仍在 `/chenzute/dsh-src/eval/meta-workspace-actor-loop-async-20260818/workspace/actor-loop-async-20260818/evidence/`；它证明素材可恢复和主动委托非阻塞，不虚构 loop 演进效果。代码接线已补：Builder submit 后自动进入 deliberation（verifier/gate），应用后同任务重跑。

1. **A 收编（已完成）**：可运行构建产物已进入 `vendored/serial-tool-calls/`；`loop-candidates/serial-tool-calls.manifest.json` 固定上游 commit、候选 delta（并行 10→1）、目录 SHA-256 与入口。
2. **候选状态/边界（已完成代码，122/122）**：`src/candidates/` 实现 `staging → pending → verified → approved → installed`（及 rejected）、契约证据要求、before/after 安装记录、失败 rollback；builder Git acquisition 只能写 staging，需 HTTPS allowlist、固定 ref/commit/hash，不能直接写正式 vendored。builder-generated 另受固定 baseline、精确 hash 替换、路径/大小/无 symlink 限制。
3. **完整报告（已完成）**：正式 profile 下 C0/C1-C4/C7/C8 与 C6(L1-L5) 都通过，报告见 `eval/meta-workspace-loop-adapter-20260817/reports/profile-candidate-full-contract.json`。
4. **真实替换/gate（已完成，隔离 runtime）**：`src/candidates/profile.ts` + `profile-gate.ts` 在组合前替换 entry，严格校验 artifact hash，记录 before/after；`meta-workspace-loop-gate-final-20260817` 中 installed candidate 的 actor 重跑全绿，fault-injected C0 mismatch 自动 rollback。
5. **候选网关/自主获取/E2E（Git 通道完成；generated 通道待补真实链路）**：`allowLoopCandidates` 默认关闭；开启后仅 `meta_auto(discoverLoopCandidate=true)` 可调用独立 BuilderKernel。loop draft/工具反馈/journal 与 config/tool/skill builder 复用同一 bounded driver；提交后 core importer 才能 HTTPS 拉取。source 缺 entry 时，只允许固定的 `sandboxed-dsh-workspace` 无网络 build，build recipe/hash 写 manifest。builder-generated 只接受固定 DSH baseline commit、`agent-loop/src/**/*.ts`、exact beforeHash/after 替换、文件数/字节数/无 symlink 限制，并仍只进入 staging。控制候选完整证据见 `eval/run-records/2026-08-17-loop-autonomous-final-lifecycle-proof.json`；generated 首次真实拉取因 codeload 429 清理 staging，registry 无残留，未获验收。
6. **BuilderKernel（完成）**：`docs/builder-kernel-spec.md` 将 Tycho 的 bounded tool loop、workspace、verify feedback 与 Loom 权限/状态一一映射。`BuilderDriver` 以严格 JSON `tool | continue | submit | abort` 运行有上限的真实 LLM 微循环；Kernel 自动写 decision/tool/error journal 与 snapshots，allowlist 为 `read_input/read_journal/write_world_model/write_plan/write_candidate_draft/inspect_staging/preflight_staging_entry`，无 shell/任意文件/裁决能力。`submit` 无 payload，只冻结已预检 draft；verifier、probe 失败、gate/install rollback 全会 `reopenFromFeedback()` 建立新的 immutable run 并在 `previous-attempt.json` 回注。官方 V4 Flash 成功实证见 `eval/run-records/2026-08-17-builder-kernel-real-feedback-proof.json`：项目真实 `Validator` 产生 rejection，第三个官方 builder run 读取该 report 后以 4-turn/3-tool 提交（无 install）。
7. **并行归因与真实对照（完成，低成本）**：直接 27b（thinking disabled）真实生成两个 native tool calls；DSH 也在同一 turn/step 保留两调用。随后用两个 1000ms、显式 `isConcurrencySafe` 的隔离工具验证 cap：原版 loop overlap、tool span **1017ms**；已安装 serial candidate 串行、**2024ms**（**1.99×**），两侧 C0/C1-C4/C7/C8 全绿、0 error frame。因此该候选是安全/顺序策略，**不构成吞吐提升**；完整 record 为 `eval/run-records/2026-08-17-loop-parallel-safe-real-behavior-comparison.json`。官方/候选 scheduler 的 parallel-safe 与 cap=1 语义另有零模型 42/42 测试复核。

## 环境（2026-08-17 05:40 实测）

- Node v22.20.0 / npm 10.9.3 / pnpm 11.21.0（`/chenzute/dsh-src/tools/bin/pnpm`）；`dsh` 不在 PATH。
- dsh checkout `/chenzute/dsh-src/deepseek-harness` 存在；插件类型链 devDependencies `file:` 正常。
- `dist/index.js` 已构建；`npm run check` ✓；`npm test` 148/148 ✓；`npm run build` ✓；`git diff --check` ✓。
- 候选 fork 已构建 `lib/index.js`，`DEFAULT_MAX_PARALLEL_TOOL_CALLS = 1` ✓。
- env 文件在位（600）：`.env-27b`（本地 actor）、`.env-deepseek`（官方 V4 Flash builder/评审门）；禁止打印/提交。
- 契约跑法模板：

```bash
set -a; . /chenzute/dsh-src/eval/.env-27b; set +a
export DSH_CMD='/chenzute/dsh-src/tools/bin/pnpm dsh' DSH_CWD=/chenzute/dsh-src/deepseek-harness
export DSH_META_VALIDATE_ROOT=/chenzute/dsh-src/eval/meta-workspace-<name>
node scripts/contract-runner.mjs check /chenzute/dsh-src/eval/overlay-contract-candidate-fork.yml '<task>' loop-contract/golden-current.json
```

- golden 快照：`loop-contract/golden-current.json`（71 事件）；候选 overlays 在 `/chenzute/dsh-src/eval/overlay-contract-*.yml`。**任何候选运行必须带** `--expected-entry <candidate entry>`，C0 不通过即不允许花模型费用。
- run 快照：`/chenzute/dsh-src/eval/run-records/`（含 2026-08-17-loop-contract-bh3-*.json）。

## 已完成的里程碑（v1 实证；详见 docs/project-status.md + run-log）

- 发布：dsh-loom@1.0.4（npm latest），tags v1.0.2/v1.0.3/v1.0.4；便携 CLI `dsh-loom try` 已发布（真机留档待做）。
- 从零成长：off 0/3 → L1-L5 全过；严格同任务集 off 0/3 → on 3/3。
- 宿主闭环：host-demo pass=true；meta_auto/meta_iterate 真实链路（评审门 → builder → 隔离探测 → verifier → gate）。
- 演示留档：model-swap、supervisor-swap、scheduled-notify、preferences、refine-skill、actor-progress-qa。
- loop 契约 runner：record/check/rollback/--regression/--report/--profile + C0 entry-resolution 已实现；正式 profile adapter、完整三件套、cold gate 安装与回滚均已有隔离实证。旧单纯 overlay 差分证据仍仅是“官方 loop 上的环境/runner 验证”。

## 决策记录（保持简短；细节见 docs/research/08 等）

- 角色：builder（迭代者）+ verifier（固定式核验）完全分离；verifier 不通过强制回炉，无 force-apply。
- 文件优先：上下文不可信，状态落盘 `$DSH_HOME/meta-validate/`。
- 模型分工：actor = 本地 27b；builder/评审门 = 官方 V4 Flash。
- loop 放开门槛：完整契约报告三件套（C1-C8 + C6 回归 + 实装 before/after）；builder 必须自主选候选。
- dsh 约束（2026-08-17 新发现）：`PatchOptions.name` 不是更新字段；`--patch` 无法把 `agent-loop` 从官方包换成候选路径。gate 必须在完整 entry tree/宿主 Loader 级别做替换，并以 C0 验证实际解析入口。
- v1 锁定：`agent`/`agent-loop`/`meta-validate` 行禁止修改。

## 待用户决策/待办

- 下一步顺序：先在 codeload 限流解除后重跑 generated baseline→edit→sandbox build；成功后用独立 verifier 跑 C0/C1–C8/C6，再做 gate before/after、actor 重跑和 rollback；全部通过后，才跑 12 个 parallel-safe 延迟工具的 cap=10 对 cap=20 性能对照。任一供应链/契约/回滚失败都只记 rejected，不宣称性能提升。
- awesome-dsh-plugin PR：fork 分支 `ZTCNO0NE:add-dsh-loom` 已推；仓库满 1 天后（北京时间 08-17 20:35 后）`gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --base main --head ZTCNO0NE:add-dsh-loom --title "Add ZTCNO0NE/dsh-loom to the plugin list"`。
- README 竞品定位段（prime-agent 合并 + 偏好沉淀证据）已入库（commit `386269a`），如需调整再改。
- 曝光待办：GitHub Discussions 自荐 → 其他 awesome 列表 PR → Discord/公众号/掘金/知乎。
- 官方 DeepSeek key 曾短暂泄漏进 git 历史（已 force push），建议用户撤销换新（未确认）。

## 风险与注意

- 烧钱敏感：优先本地 27b / 零成本验证；官方调用（builder/评审门/基准）跑前确认。
- dsh v0.1 developer preview，接口会变；注入点收敛 `src/index.ts`。
- 候选 fork 在 dsh checkout 内，上游更新会冲突 → 尽快定收编。
- 每次运行必须留档（run-log + run-records）；未留档不算完成。

## 里程碑

| 里程碑 | 状态 |
| --- | --- |
| M0-M4（config/tool/skill 进化 + gate + 回滚） | 完成 |
| v1.0.0-v1.0.4（监督员/后台/通知/偏好/便携 CLI） | 完成 |
| loop 契约 runner + golden + C0 entry-resolution | 完成（正式 Loader adapter + 自主候选实装均有 C0） |
| 完整契约报告三件套 + 候选 loop 网关 | 完成（正式 profile、C0–C8/C6、冷 gate、staging 网关均有隔离实证） |
| v1.1 减法定稿 + 单一路线接线（deliberation/evidence/拒绝回注/同任务重跑） | 完成（代码 148/148；loop 真机端到端待配置 runtime） |
| builder 自主选择候选 loop + 端到端案例 | 收敛为 v1.1 单一路线：builder-generated + 本地 baseline；外部 Git acquisition 已砍 |
| Tycho 型 BuilderKernel 微循环 + 拒绝回注 | 完成（官方 V4 Flash patch/loop-candidate run + verifier feedback 证据） |
| 自主 loop 最后一公里 | 完成（staging → C0–C8/C6 → installed → actor 重跑 → rollback/restore） |
| loom-bench / Web 成长面板 / `dsh-loom try` 真机留档 | 后续 |
