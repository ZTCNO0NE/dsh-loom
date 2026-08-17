# BuilderKernel v1

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

## 执行状态机

```
created -> exploring <-> preflighting -> ready_to_submit -> submitted
                |                     |
                +------ aborted ------+
```

每次模型回复只能选择 `tool`、`continue`、`submit`、`abort`。Kernel 对每个 tool action 先记 journal，再执行 allowlisted action，再记结果；下一次模型调用附带 plan、world model、journal tail 和 snapshot index。限制为可配置的 model turns、tool steps、token、wall time；耗尽时持久化 `aborted`，不触发 verifier。

v1 action allowlist 是 `read_input`、`read_journal`、`write_world_model`、`write_plan`、`write_candidate_draft`、`inspect_staging`、`preflight_staging_entry`。`write_candidate_draft` 是唯一的候选内容写入动作：它只能原子写 `staging/candidate.json`，不是泛用文件写入器；已有 draft 时须先 inspect/preflight，只有 preflight 明确报错才允许覆写修复。`inspect_staging` 只能读取当前 run 的 `staging/` 下的既有文件，任何路径逃逸都会被 Kernel 拒绝并写 error journal。`preflight_staging_entry` 对 draft 的 JSON、非空 module entry 与受限路径作确定性静态检查，成功后才把 run 标为 `ready_to_submit`。`submit` 没有模型 payload；它只能在该状态冻结 `submission/proposal.json` 为已预检的 `candidate.json`，因此不存在提交时偷换内容；它不调用 verifier。

`BuilderDriver` 是真实执行器：每一 model turn 都只能返回严格 JSON `tool | continue | submit | abort`，Kernel 先落 model decision，再落 tool result/error；下一 turn 的 prompt 读入 journal tail。model turn、tool step、tokens、wall time 都由配置上限控制，超限永远 `aborted`。因此“模型声称已经检查过”不构成记录，只有 Kernel journal/snapshots 构成记录。

## 验收边界

Builder preflight 的成功只表示“值得提交”；独立 verifier 的 fresh-process 契约/回归成功才表示“可批准”。每次 verifier 拒绝会形成新的 immutable `previous-attempt.json`，开启新的 builder run，而不是修改旧 run 历史。

Kernel 以 `reopenFromRejection()` 记录被拒绝 run 的报告 hash，并创建新 run。`IterationLoop` 对 verifier rejection、builder-requested probe failure、以及 gate/install rollback 都调用该入口；报告中的 first divergence、回归、probe 和 rollback 信息都作为新 run 的 `previous-attempt` 输入。`patches/<patch-id>/builder-run.json` 建立 patch/run 对应，`builder/resume.json` 只指向下一次可恢复 run；旧 run 永远保留为审计记录。

提交 draft 的结构化规范化/锁定目标检查若失败，也不是静默丢弃：核心将 `proposal_normalization` rejection（含 proposal hash 与错误）写入下一 run 的 `previous-attempt`，供同一有限循环修正。
