# v1.1 单一路线规格（用户主动委托）

更新：2026-08-18。状态：**定稿，代码已接线**（loop 真机端到端待配置 loop runtime 后验证）。

## 1. 目标

减法后的 v1.1 只做一条闭环：

```text
用户主动委托
  → 三层 evidence pack 完整交付 Builder
  → Builder 阅读 actor 真实会话证据，自主选择并演进 config/tool/skill/loop
  → 独立 verifier + gate 裁决
  → actor 用同一任务重跑
  → 用户看到：具体改了什么、为什么改、效果是否提升
```

## 2. 入口（唯一）

- actor 调用 `meta_auto(exploreLoop=true, requirements, actorAssessment)`（`allowLoopCandidates.enabled=true` 时可用）；
- 立即返回 `jobId/runId`；后台 job 执行 Builder run；
- v1.1 **没有**被动触发、监督员自动唤起、外部 Git loop 发现；
- Builder 不跑完不阻塞 actor；actor 可用 `meta_builder_status` 查询、`meta_builder_message` 补充观察。

## 3. 证据交付（三层 evidence pack）

主动委托前冻结，作为 Builder 的**完整输入**：

```text
evidence/<id>/
  manifest.json        # watermark + hash + 原始文件引用（frames/events/requirements/signals/triggers/profile/config snapshot）
  actor-handoff.md     # 用户目标、actor 自然语言观察、已知信号、未知项
  deterministicDigest  # 确定性运行时指标（错误/延迟/停滞/工具统计）
```

- `manifest.json` 只建立带 SHA-256 的引用，不复制原始轨迹；Builder 必须能继续读原始文件；
- `actor-handoff.md` 允许自由描述怀疑与上下文，但不是 verifier 结论；
- 摘要不是信息边界。

## 4. Builder

- 独立持久化 run（BuilderKernel + BuilderDriver）：workspace 多文件读写、真实命令 stdout/stderr/exit 反馈、journal、actor inbox；
- 自由选择：`patch`（config/tool/skill）或 `loop`（builder-generated 源码编辑 → 固定 baseline → 无网络构建）；
- 只冻结 proposal（`write_submission`），无 verifier/gate/install 权限；
- `abort` 是合法自主结论，不要求每次都改。

## 5. 裁决（verifier → gate）

| Proposal | verifier | gate |
| --- | --- | --- |
| patch（config/tool/skill） | 现有 Validator：预期 vs 真实帧对齐 + 回归 + 隔离探测 | snapshot → 原子写 → 冒烟 → 回滚 |
| loop（builder-generated） | 固定 baseline 应用 edits → 无网络构建 → C0/C1-C8/C6（contract-runner） | registry verified/approved → profile gate 冷安装 → C0 冒烟 → 回滚 |

- Gate fail-closed：缺报告、超时、错误、not_run、stale evidence、before 冲突一律不放行；
- verifier 不通过 = 强制回注 Builder 下一 immutable run（reopenFromRejection），无 force-apply。

## 6. 重跑与用户报告

- 应用后以**同一任务**（requirements 原文）在隔离 profile + 新配置/loop 下重跑 actor；
- 对比 before/after：任务成功、关键帧、时延/错误率；
- 用户可见：完成通知 + `meta_growth`/台账条目，内容 = 改了什么（target/kind/diff）、为什么（handoff/信号摘要）、效果（before vs after、verdict、applied）。

## 7. 砍除清单（v1.1 不做）

- `discoverLoopCandidate` / 外部 Git loop 发现与拉取（`CandidateImporter` 的 git 通道）；
- 被动触发链（AutoPilot / ReviewGate / TurnBoundaryHook）从激活路径移除，代码暂留作归档，不接线；
- `meta_iterate` / `meta_request_validate` 不再是主动委托入口（`meta_auto(exploreLoop=true)` 唯一）；
- 性能对照实验（12-probe cap 对照）与 performance verifier，除非 proposal 显式声明性能提升；
- 旧 `write_candidate_draft` / `inspect_staging` / `preflight_staging_entry` 工具面从 Builder 基础工具移除。

## 8. 验收定义

1. `npm run check`、`npm test`、`npm run build` 全绿；
2. 单测覆盖：evidence pack → builder run → proposal 冻结 → patch/loop 裁决 → gate 应用/回滚 → 同任务重跑记录 → 用户报告；
3. 真机案例：27b actor 主动委托（小预算）→ V4 Flash Builder 阅读证据 → 至少一次 proposal 经 verifier/gate 应用或合法 abort，全部留档 run-log + run-records。

## 9. 实现状态（2026-08-18）

- 已实现：`src/deliberation/index.ts`（patch/loop 裁决，fail-closed）；`meta_auto(exploreLoop=true)` 后台 job 在 Builder submit 后自动裁决；patch 应用后同任务隔离重跑 + 台账/报告/通知；`CandidateImporter` 只保留 builder-generated + 本地固定 baseline（无网络）；Builder 基础工具移除旧 draft/staging 三件。
- 已砍：`discoverLoopCandidate` / Git 获取入口；被动触发链从激活路径移除（代码暂留归档）。
- 配置（loop leg 启用条件）：`allowLoopCandidates.{baselineRoot,baseBundle,dependencyRoot,contractCommand,contractTask,goldenPath}`；未配置时 loop 裁决 fail-closed（`loop runtime not configured`）。
- 测试：132/132（新增 deliberation 6 条）；`npm run check` / `npm run build` / `git diff --check` 全绿。
