# BuilderKernel v1

> 2026-08-18 修订：本文记录 v1 的封闭 JSON Kernel 和兼容路径。新的架构基线是 [`builder-foundation-spec.md`](./builder-foundation-spec.md)：Builder 是具有全局读取、持久 workspace 与真实命令反馈的极简基础 loop；`loop-evolution` 是 capability，不是 Kernel 内置候选网关。新能力以 `read_file`、`list_directory`、workspace 文件读写、`run_workspace_command` 与 `write_submission` 实现；本文的 `candidate.json`/preflight 只为既有 patch/candidate 流程保留。

## 目标

Builder 是独立、有限步、可恢复的工具 agent；不是一次 JSON 调用，也不是拥有验收权的长驻 actor。它在自己的 workspace 内把输入证据转成一个可提交的草稿。verifier 和 gate 保持在它的写权限之外。

## 与 Tycho 的一一映射

| Tycho | Loom BuilderKernel | 不同点 |
| --- | --- | --- |
| `WorldModelBuilder.build()` 的短工具循环 | `BuilderKernel.run()` 的有限 model/tool steps | 每个 run 新建短会话，不共享 actor history |
| game workspace（frames/diffs/attempts） | immutable `input/actor-snapshot.json`、`target-before.json`、previous report refs | actor 是运行中的系统，故所有输入必须带 event/config watermark |
| `notes/world_model.md` | `state/world-model.json` | 结构化、版本/hash 化 |
| builder tool trace + tool result 回填 | `state/journal.jsonl` + 下一步 prompt 的 journal tail | journal 由内核写，LLM 不可伪造 |
| 自动 `[verify state]` | `input/previous-attempt.json` 和受限 preflight 结果 | preflight 不是正式 verdict |
| agent-authored workspace file | `staging/` 草稿 | 不可写 vendored、registry 后续状态、verifier/gate |
| sandboxed Python | allowlisted read/git/static-preflight actions | v1 不提供通用 shell、网络仅 Git importer |
| `verify.py`/`plan.py` | verifier 的只读预检副本 | 只有独立 verifier 可标记 verified/approved |

## 目录和恢复协议

```
workspace/<session>/builder-runs/<run-id>/
  input/actor-snapshot.json      # 触发时需求、frames/config/telemetry refs + hashes
  input/target-before.json       # 修改前 target/profile/candidate 状态
  input/previous-attempt.json    # 上次 proposal/report/probe 结果（可空）
  state/world-model.json         # builder 的结构化理解
  state/plan.json                # 当前有限步计划
  state/journal.jsonl            # core 写入的 model/tool/error 事件
  state/snapshots.jsonl          # 每个副作用后的 hash
  staging/                       # builder 唯一可写草稿
  preflight/                     # 非权威的确定性预检输出
  submission/proposal.json       # freeze 后的提交物
```

每一条 journal 记录包含 seq、kind、input snapshot hash、action、结果摘要、error、before/after refs、时间。重启时只读这些文件恢复；没有 journal 的未完成动作视为失败，不猜测成功。

## 权限与状态

Builder 可以读 actor snapshot、旧报告、candidate registry 和自身目录；可写自身 run 目录及 importer 创建的 staging。它不能改 actor、生产 profile、vendored、verifier、回归集、gate，也不能把 candidate 推进到 `pending` 之后。只有 `submit` 把不可变 staging 草稿交给 verifier；verifier 成功后才允许既有状态机继续推进。loop candidate discovery 复用同一个 Kernel，只是 draft schema 为 `{ candidate: CandidateAcquisitionRequest, rationale }`；提交后 core importer 才能做 allowlisted HTTPS acquisition。若 source 缺 entry，唯一可用的源码构建是固定的 `sandboxed-dsh-workspace` recipe：bubblewrap 无网络、candidate workspace 可写、依赖树只读，builder 不能提供 shell 文本。

### builder-generated 候选

Builder 也可以在没有合适外部候选时提出自有 loop 修改，但这不是泛用文件写入权限。draft 必须声明固定的 DeepSeek Harness baseline（完整 40 位 commit），并提供 `source.edits[]`：每项只有仓库相对 `packages/core/agent-loop/src/**/*.ts` 路径、完整 `beforeHash` 和完整 `after` 文件内容。核心在 baseline archive 上逐项检查路径、无 symlink、before hash、最多 4 个文件、单文件最多 48 KiB、总替换最多 96 KiB 后才应用；重复路径、路径逃逸、shell 文本、hash 不匹配或超限都会拒绝并经 `previous-attempt.json` 回注。

Generated candidate 强制使用固定的 networkless `sandboxed-dsh-workspace` build recipe，并在 manifest 中记录 baseline URI/ref、edit-plan hash 以及每个文件的 before/after hash。生成修改只会创建 `staging` 记录；它不能直接写正式 `vendored`，也不能批准、安装或跳过完整 C0/C1–C8/C6、冷替换和 rollback 验收。

## 执行状态机

```
created -> exploring <-> preflighting -> ready_to_submit -> submitted
                |                     |
                +------ aborted ------+
```

每次模型回复只能选择 `tool`、`continue`、`submit`、`abort`。Kernel 对每个 tool action 先记 journal，再执行 allowlisted action，再记结果；下一次模型调用附带 plan、world model、journal tail 和 snapshot index。限制为可配置的 model turns、tool steps、token、wall time；耗尽时持久化 `aborted`，不触发 verifier。

兼容 action 是 `read_input`、`read_journal`、`write_world_model`、`write_plan`、`write_candidate_draft`、`inspect_staging`、`preflight_staging_entry`。基础 loop 另提供全局 `read_file` / `list_directory`、Builder workspace 的读写、带 stdout/stderr/exit code 回传的 `run_workspace_command`，以及通用 `write_submission`。后者写入 proposal draft，`submit` 只冻结它，永不执行安装。旧 `write_candidate_draft` 仍要求 preflight，保证既有 patch/candidate 流程兼容。

`BuilderDriver` 是真实执行器：每一 model turn 都只能返回严格 JSON `tool | continue | submit | abort`，Kernel 先落 model decision，再落 tool result/error；下一 turn 的 prompt 读入 journal tail。model turn、tool step、tokens、wall time 都由配置上限控制，超限永远 `aborted`。因此“模型声称已经检查过”不构成记录，只有 Kernel journal/snapshots 构成记录。

候选 importer、verifier、probe 或 gate 的失败均作为 immutable `previous-attempt.json` 回注。Builder 自己选择是否读取、如何探索、是否修复或 abort；Kernel 不再以固定 fallback 文案替它指定策略。

## 验收边界

Builder preflight 的成功只表示“值得提交”；独立 verifier 的 fresh-process 契约/回归成功才表示“可批准”。每次 verifier 拒绝会形成新的 immutable `previous-attempt.json`，开启新的 builder run，而不是修改旧 run 历史。

Kernel 以 `reopenFromRejection()` 记录被拒绝 run 的报告 hash，并创建新 run。`IterationLoop` 对 verifier rejection、builder-requested probe failure、以及 gate/install rollback 都调用该入口；报告中的 first divergence、回归、probe 和 rollback 信息都作为新 run 的 `previous-attempt` 输入。`patches/<patch-id>/builder-run.json` 建立 patch/run 对应，`builder/resume.json` 只指向下一次可恢复 run；旧 run 永远保留为审计记录。

提交 draft 的结构化规范化/锁定目标检查若失败，也不是静默丢弃：核心将 `proposal_normalization` rejection（含 proposal hash 与错误）写入下一 run 的 `previous-attempt`，供同一有限循环修正。
