# CURRENT.md — 当前状态与交接

## 2026-08-21 Actor 任务卡交互补全（待发布）

- 修复任务卡宣称有 `view_evidence`、控制工具却没有真实分支的问题。用户现在可通过自然语言查看本轮 immutable evidence pack 的脱敏索引：帧/事件/来源数量、工具错误统计、信号类型和独立裁决状态；不返回原始内容、绝对路径、hash、凭据或隐藏推理，manifest 缺失时 fail closed，不拿实时会话冒充冻结证据。
- 修复 `jobStatus=running` 遮蔽 `plan.state=verifying`：任务卡与超时进度通知以 immutable plan 阶段为权威，能真实区分 Builder 隔离实现和 Verifier/Gate 裁决；仍只发低频关键节点，不广播普通工具步骤。
- 补齐 waiting-for-confirmation 的安全取消。用户说“取消”会按阶段路由：未确认 plan 直接取消并释放会话；queued job 仍只在未被 worker 接手时取消；implementing/verifying 继续拒绝强杀。旧 plan/evidence 保持只读，后续可创建新任务。
- 持久任务卡现在能跨轮恢复用户安全的候选标题、验收摘要和确认问题，不恢复内部 target 路由、用户原文或 Actor 隐藏解释。新增最近任务历史视图，只显示时间、目标、阶段、outcome 与 verdict，不返回 plan/job/run ID。
- 新 plan 现在会在任何写盘前同时检查 pending 与 active 会话锁；进行中任务不会被覆盖，也不会先生成一条随后才被拒绝的孤儿 immutable plan。
- 自然语言 Plan 新增确定性澄清前置：缺方向时先给“新技能 / 已有配置”选择，Config 只列宿主真实存在、可编辑且无 credential 字段的目标，Skill 名称不合法时由 Actor 协助转为 kebab-case；澄清前不冻结 evidence、不创建 run。Plan 可在 runtime/key 未就绪时先展示方案并把缺口列为风险，Execute 仍严格 fail closed。
- 定向 16/16、全量 **275/275**、TypeScript check、build 与 diff-check 均通过。当前改动尚未发 npm/GitHub 版本；Benchmark 下载/运行保持暂停，不与另一条执行计划争用范围。

## 2026-08-21 Qwen3.6-35B-A3B Q6 独立 runtime canary 已启动

- 为隔离 scheduler、LiteLLM 与 9B helper 的延迟，已停止 `qwen36-agent-pool-gateway.service`；服务当前为 `inactive`，其 9B llama.cpp 子进程已退出。生产 4000/4010 未改配置、未重启，但 12341 停止期间不应作为推理入口。
- Q6 模型以 transient user service `qwen36-35b-a3b-canary.service` 启动在 `127.0.0.1:12424`：128K context、parallel=1、batch/ubatch=2048/512、layer split=0.70/0.30、Q8 KV、Flash Attention、全 GPU offload、无 slot-save/cache-ram。
- 精简 Codex Responses adapter 以 `qwen36-35b-a3b-adapter-canary-4021.service` 启动在 `127.0.0.1:4021`，上游直连 12424；narrator、terminal semantic judge、Smart Progress 模型调用和 sidecar 均关闭。4011/4012 已被既有本地服务占用，因此未使用。
- 直连稳定短请求 decode 85.27 tok/s；原生 Responses 流式总时长 7.31s、adapter 内部 TTFT 426ms、尾处理 1ms，对应 llama decode 45.14 tok/s。后一个数据受 GPU1 外部训练 99–100% 利用污染，不作为最终 27B/35B 对比结论。
- 原生 Responses 非流式返回最终文本；结构化工具 smoke 在 3.18s 内产出 `function_call add({"a":17,"b":25})`。推理专项文档、脚本、provenance 与原始结果已统一迁移到 `/chenzute/inference-acceleration-lab/`，入口为该目录 `README.md`。
- 固定 prompt 的 GPU1 contention `2 warm-up + 5 measured` 记录也已迁移到 `/chenzute/inference-acceleration-lab/results/2026-08-21-gpu1-contention-v1/`。每轮 48/52 prompt tokens cached、256 decode tokens；decode 为 44.55/44.58/52.22/54.70/74.69 token/s，中位 52.22，GPU1 的 163 个 200ms 时间点平均 utilization 约 97.27%。在外部训练停止后须以同命令复跑，当前不得宣称 52.22 是空闲性能或训练净损失。

## 2026-08-21 Loom Benchmark 计划冻结与首个候选模型落地

- 本地 Benchmark 与模型筛选计划已冻结到 `docs/research/loom-benchmark-localization-plan.md`（commit `0b7a599`）。首轮主表固定为 Terminal-Bench 2.1、SWE-bench Verified 与 SkillsBench v1.1；benchmark 仓库、metadata 与 Docker 镜像下载暂缓，未执行 Docker prune。
- 首个 bake-off 候选 `Qwen3.6-35B-A3B` 的 Unsloth GGUF `UD-Q6_K` 已下载到 `/data2/chenzute/models/Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q6_K.gguf`。文件为 `29,308,320,736` bytes（约 27.30 GiB），`.aria2` 控制文件已消失。
- 完整 SHA-256 校验通过：`4fe53b148b46f9b88830e2a3055c5b15c3a4d1e3ddc9a1384a108d8b9d59f043`，与下载源 ETag 一致。模型旁已写 `model-provenance.json`；纯文本 Coding/Agent 实验未下载视觉 projector。
- 下一步（用户恢复 Benchmark 工作后）：先做本地推理 runtime/model-load smoke，冻结 context、sampling、tool schema 与总预算；再下载轻量 benchmark metadata 并生成 `bench-source-lock.json`，不直接进入五级 Loom 主实验。

## 2026-08-21 README 双层门面

- 参考 Reactive Resume 的公开首页信息架构，将原根 README 迁到 `docs/README-detailed.md`，保留全部案例、系统安装、架构、实验与边界；迁移后的图片/文档相对链接已同步改写。
- 新根 README 聚焦 Hero、一句话价值、CTA、一个插件/一套演进栈、三分钟跨平台启动、第一次自然语言任务卡、5 项真实证据和文档索引。品牌定位为 **Harness Evolution Distribution / Agent 演进整合包**，不是单一 Skill。
- 对外边界：可称统一演进控制面，当前稳定管理明确委托的新 Skill bundle 与既有 Config；不能称通用包管理器，也不宣称已支持任意已安装 Skill 的原位版本升级。开放 catalog、SemVer 依赖/冲突、来源签名、组合原子事务与团队 Skill catalog 列为下一阶段。
- 详细手册中已将工程回归更新为 266/266，并把 Config/Skill 产品主入口从“待补”修正为已完成真实 Windows 闭环。尚未更改 package 版本或发布。

## 2026-08-21 v1.2.32 已发布：mini-SWE 弹性预算与通用 runtime profile

- 失败 run `builder-1787264098546-4cbde99f` 已完成完整 Skill 内容与结构检查，但把 30 次模型调用全部耗尽，终态 `LimitsExceeded`，因此没有 submission、Verifier 或 Gate。它不是空白 JSON 问题。
- runner 新增软预算着陆：剩余 2 次调用时要求停止重复探索、最多做一次必要修正；最后 1 次要求已有可用候选时执行正式 completion command。它不自动提交文件，轨迹仍必须真实 `Submitted`，独立 compiler/Verifier/Gate 没有旁路。
- Windows Web 主入口 fresh redo：Actor 先把“Loom 系统”误当 targetId 被校验拒绝；用户澄清后以原目标 `skill/builder-json-decision-output` 创建新 immutable plan `evolution-1787264820585-1hsxubuf`、run `builder-1787264820616-d190282d`。第 29/30 次调用收到软提醒，终态真实 `Submitted`；Verifier `approved`（196/196 alignment、module load 与 skill isolation pass），Gate `skill-insert`，cold-skill-load pass，任务 `completed/effective=true/restartRequired=false`。
- 同一轨迹暴露 upstream `LocalEnvironment` 以 `shell=True` 选择宿主默认 shell；Windows 因此落到 `cmd.exe`，与 bash action 合同断裂。Loom runner 现在所有平台都显式启动 Bash：Windows 自动发现 Git Bash，POSIX 从 PATH 解析；支持 `LOOM_BASH`/`LOOM_PYTHON` 覆盖，错误显式覆盖 fail closed。action-local `python3` 固定映射到已解析解释器，模型收到精简动态 runtime profile，不再猜 `/workspace` 或重复探查已声明能力。
- 默认上限从 30 提到 40，并在 75%/剩余 2/剩余 1 回合提供渐进式收敛提示；这只是弹性上限，不自动提交、不绕过独立裁决。小预算阈值重合时，final/2-call 提示优先于 75% checkpoint。
- 六条独立 Windows product-entry Skill run 全部真实 `Submitted → approved → Gate skill-insert → cold-load pass → effective=true`。model turns 为 `9/8/5/5/6/5`（中位 5.5），tool executions `8/7/4/4/5/4`（中位 4.5）。动态 profile 的 attempts 5–6 分别 6/5 回合即提交，0 环境探查、0 非零工具结果、未触发 75% checkpoint，说明 40 回合上限没有拖长简单任务。attempt 6 原始 JSON 中文正常；此前乱码仅为 PowerShell/SSH 显示。
- Windows 自动/显式覆盖、错误覆盖 fail-closed，以及 Linux 隔离 mini-SWE 2.4.6 的 Bash/heredoc/pipe/relative-path/python3 probes 均已完成。聚合记录：`/chenzute/dsh-src/eval/run-records/2026-08-21-windows-mini-swe-stability-6/report.json`；release evidence：`docs/evidence/v1.2.32.md`。
- `1.2.32` 已发布到 npm latest 与 GitHub Release。npm shasum `d156d89ed79317373b35a70a7c36fc2c79e2df86`、integrity `sha512-XrRHc/t0QrtwK2ho96PKXWpGCR3GfLQYFfH6EuNn8wbtFk8QljQF2ru041vRpxmJjykFPRORo7jCi7xhuF/skg==`；GitHub asset 与 npm pack 使用同一 tar 字节。正式 registry 包随后安装到 Windows `web/loom` profile，setup 成功，冷 Web listener PID `123876`、HTTP 200；package spec/version 都是 1.2.32，resolver-owned runner/config 含 `LoomLocalEnvironment`、checkpoint 与动态 profile。完整发布门：Python compile、TypeScript check、**266/266**、build、diff-check、pack 与 registry cold smoke 通过。

## 2026-08-21 v1.2.31 已发布：回滚后旧“待重启”文案冲突修复

- Windows `1.2.30` 实时核查：Web PID `120904`、HTTP 200、Loom 1.2.30；`harness-state.restartRequired=false`、`applied=[]`，最近任务 `evolution-1787230109885-juuho59t` 为 `rolledBack:true`。因此当前没有待重启变更，Actor 结论“仍需冷重启”是错误的。
- 根因是三个历史投影未随 rollback 更新：`latestJob.summary` 保留安装时“待重启”；completed progress 仍称“完成安装”；limitations 仍保留 cold restart 句。Actor 把它们和实时 false/已回滚混合后得出矛盾结论。
- 修复：`meta_status` 按 immutable plan 动态投影 user-evolution job 摘要；回滚任务卡显示“恢复安装前快照”；展示层过滤已失效的 cold-restart 限制；未来 rollback 同步更新持久 job summary；terminal recovery 让 `rolledBack` 优先于旧 `restartRequired`。
- Windows 换装本地测试包后冷启动 Web，真实 Actor 再次调用两项工具：任务卡 progress 为“已通过 Gate 恢复安装前快照 / 当前任务不再有待重启生效的变更”，旧 cold-restart limitation 已消失；`meta_status` 返回 `restartRequired:false`、job `finished`、summary `用户委托 config/agent-default-model：已回滚`，Actor 正确结论为“无需重启”。
- 验证：定向 13/13、全量 **262/262**、`npm run check`、`npm run build`、`git diff --check` 与 Windows 真机 cold restart 通过。Git tag/GitHub Release `v1.2.31` 已发布；npm `dsh-loom@1.2.31` 已成为 `latest`，shasum `5a46516fd325c912697aa02eec02962a5058e8f1`。

## 2026-08-20 v1.2.30 已发布

- Release code commit：`ef52da5`；annotated tag：`v1.2.30`；GitHub Release：<https://github.com/ZTCNO0NE/dsh-loom/releases/tag/v1.2.30>。
- GitHub asset `dsh-loom-1.2.30.tgz` 已核验 SHA-256 `a11d1e08043e61fbf483a2781540bb2b06820660c0db1d30a38973422b65d28a`。
- npm `dsh-loom@1.2.30` 已发布并成为 `latest`；registry shasum `5560f855167793ed2c974323efd8306fb0376bf1`，integrity `sha512-tl5QiBmmUbacOKM2JOPGlLdzAdjSx603uSlEgr251aOojWHoW7REY2hPiyDuWOHVSDYLJxl9qRX7Crzi9bEriA==`。
- 发布门槛证据、claim boundary 与原始记录哈希见 `docs/evidence/v1.2.30.md`。下一步不是继续补 Windows/Linux 安装补丁，而是按固定 Loop 矩阵推进复杂源码实现收敛率；产品轨只接收真实用户反馈修正。

## 2026-08-20 Windows Config settings adapter + Gate rollback 真机 E2E（通过）

- Windows 真机证明 loader overlay 不足以修改 `agent-default-model`：DSH `settings.yaml` 用户层优先于组合层，旧 `cold-config-overlay` 只证明可组合，不证明 Actor 真实使用新值。旧 approved record 保留为缺陷证据，不用于宣传。
- 新增 `src/evolution/host-config.ts`：`agent-default-model` 通过 Cordis `ctx.get('agentDefaultModel')` 读写 DSH settings-backed 有效值；Gate 仍同时留下 overlay/harness state，失败时 adapter 与 overlay 共同恢复。其他 Config target 保持 loader adapter，不扫描或盲改 settings。
- Windows PowerShell 5 会为 mini-SWE 写出的 JSON 加 UTF-8 BOM；`readJson()` 现仅剥离文件开头单个 U+FEFF，仍保持 JSON fail-closed。真实失败 run `builder-1787228059112-9d87961b` 因此修复从 compiler abort 进入后续裁决。
- 新 immutable plan `evolution-1787230109885-juuho59t` 完成 Builder 修改、proposal、Verifier/Gate 与安装；DSH `settings.yaml` 的非敏感 model 字段真实变为 `deepseek-chat`。随后全新 Windows headless Actor 返回 `SETTINGS_ADAPTER_COLD_OK`，原始 session `session-fa230988-c0cd-4060-a4c9-0f585e5a7cf5` 的 `request/header`、`request/context`、`assistant/message` 均记录 `deepseek-official/deepseek-chat`。
- 任务卡语义已锁定：Config approved 显示“待重启生效”，Skill approved 仍显示“已生效”，Gate rollback 后显示“已回滚”；旧持久记录缺少 `effective/restartRequired` 仍可读。
- `meta_evolution_control(action=rollback_recent)` 已由真实 Windows Actor 调用。Gate 对当前 settings 与 installed after 做漂移检查后，经同一个 settings adapter 恢复 before 并精确 readback，receipt `builder-1787230144516-33ff7956.json` 为 `rolledBack:true`；history 为 `installed-rollback`，harness applied 列表为空，`settings.yaml` 恢复 `deepseek-v4-flash`。没有手工删除 overlay 冒充 rollback。
- 新冷 Actor session `session-3194fa19-fe76-4aa4-ae6e-7aafc46175c3` 返回 `SETTINGS_ROLLBACK_COLD_OK`，其 `request/header`、`request/context`、`assistant/message` 三处均记录 `deepseek-official/deepseek-v4-flash`。
- 启动恢复已把 stale `job-1787230144504-64tjei` 按 completed plan 对账为 `finished`。Windows Web 使用本地 `1.2.30` tarball 返回 HTTP 200；Linux 隔离冷安装同一 tarball，mini-SWE 2.4.6、setup patch、Loom composition 和 Web HTTP 200 均通过。
- 发布前验证已完成：`npm test` **261/261**、`npm run check`、`npm run build`、`git diff --check`、`npm pack --dry-run` 全通过。证据索引：`docs/evidence/v1.2.30.md`；原始记录在 `/chenzute/dsh-src/eval/run-records/2026-08-20-{windows-config-rollback,windows-skill-product-e2e,linux-1.2.30-smoke}/`。剩余动作只有 commit/push/tag/GitHub release/npm publish 与 registry 核验。

## 2026-08-20 Builder 统一读取 DSH 用户凭据（Windows 真机通过，待发布）

- Loom 不再以 `process.env` 作为产品路径的 Builder 凭据来源：`src/index.ts` 注入 DSH `credentials` service，`BuilderCredentialResolver` 在每次 Builder/Review Gate LLM 请求及每次 mini-SWE spawn 前动态 `resolve()`。
- 凭据选择先由上层已选的 `llm.provider/model` 决定，而非扫描到任意 key 就使用：`deepseek-official → DEEPSEEK_API_KEY`；显式 `gpt-5.6-terra → OPENAI_API_KEY`（兼容旧 `LOOM_TERRA_API_KEY → DSH_TERRA_API_KEY`）。`llm.credentialRef` 是最高优先级的高级覆盖入口；所有 ref 再由 DSH credentials service 从 `.credentials.yaml`（或它自身的优先级来源）动态解析。
- mini-SWE 子进程仅得到临时 `OPENAI_API_KEY`，会删除父环境中的 provider key aliases；secret 不进入 config/prompt/journal/evidence/status。`meta_status` 只投影 provider/model/ref/configured/source。
- README 与 `docs/USAGE.md` 已改为默认在 DSH Settings/Models 或 `$DSH_HOME/.credentials.yaml` 配置一次 `DEEPSEEK_API_KEY`；不再要求用户每个 shell 设置 Builder 专属变量。
- 定向和全量验证：`npm test` **242/242**、`npm run check`、`npm run build`、`git diff --check` 通过；另以隔离 `DSH_HOME` 的真实 `pnpm dsh web --patch cordis.patch.yml --dump-config` 确认 Web composition 含 `credentials-local` 且 Loom row 正确加载。
- Windows Web 已使用 DSH credentials service 完成真实 Skill 与 Config 产品入口的 mini-SWE Builder 调用；未要求为 Builder 单独注入进程 key。`meta_status` 的脱敏投影与凭据优先级有确定性回归，发布版本固定为 `1.2.30`。
- 追加修复（尚未发布）：`PLUGIN_ROOT` 曾从 installed `dist/index.js` 错退两级到 profile `node_modules`，导致 vendored `runtime/mini-swe-agent-v2.4.6.yaml` 被误判缺失（`configPresent:false`）；改为退一级至实际 `dsh-loom` 包根。该问题与用户 setup 无关。
- Windows product E2E 又暴露了第二个真实路径问题：ActorEvolutionGateway 用 `${sessionId}:actor-evolution` 作为持久 Builder workspace 目录，Windows 禁止 `:`。已将持久角色 scope 统一为跨平台 `--`（同时覆盖 loop exploration）；旧失败 run 保留，只能通过 redo 建立新 immutable run。新增 protocol 回归断言 Windows 保留字符不会进入 scope。

## 2026-08-20 Windows 源码 checkout host peer 修复（进行中）

- Windows 真机启动已定位到 DSH 宿主缺口，而非 mini-SWE 或 patch 路径：源码版 `apps/cli/package.json` 将 `@deepseek-ai/dsh-tools` 放在 `devDependencies`，`healProfilesModuleFallback` 只扫描 `dependencies/peerDependencies`，因此 `%USERPROFILE%\\.dsh\\profiles\\node_modules` 缺少该 peer。
- `bin/dsh-loom.mjs setup` 现在会在当前目录或 `DSH_ROOT` 识别 DSH 源码 checkout，确认 `packages/core/tools/lib/index.js` 存在后，安全建立 `profiles/node_modules/@deepseek-ai/dsh-tools` junction/symlink；真实目录不会覆盖。若尚未构建则给出确定命令 `pnpm --filter @deepseek-ai/dsh-tools build`。
- README 与 `docs/USAGE.md` 已补充该差异及 Windows 排错路径。Node 语法检查、`npm run check`、mini-SWE 定向 4 tests、`git diff --check` 通过。
- 尚未发布 `1.2.9`，待用户用新 setup 在 Windows 重跑并确认 Loom profile 能完成冷启动；若仍缺其他 host peer，应继续按相同依赖闭包证据修复，不盲目把整套 DSH core vendored 进 Loom。
- `dsh-loom@1.2.9` 已发布并由 npm registry 核验（integrity `sha512-ZBv+GTCW4pS0hxnzNZRV8A50tyjpHCNly6X/qZ1cxSphF7INwZp82mvwGGZXvCA1Aah5FL33fonJaPdJd5jKsQ==`）。
- 复测仍出现同一错误，说明用户使用的 setup 未完成 host fallback。`1.2.10` 已改为：检测到源码 checkout 且 `dsh-tools/lib/index.js` 缺失时自动运行 `pnpm --filter @deepseek-ai/dsh-tools build`；构建失败会在 setup 阶段退出，不再生成“看似成功”的 patch。已构建、发布并核验 `dsh-loom@1.2.10`。
- Windows 实测显示 `@deepseek-ai/dsh-tools` 本身没有 package-local `build` script，1.2.10 的 filter 命令因此失败但仍继续。`1.2.11` 改用 DSH 根目录 `pnpm run build:lib:host`，并在 host 修复失败时立即退出；已发布并核验。
- Web 实测随后暴露同类的 `@deepseek-ai/dsh-client-ui-directory-picker-native` 缺口，确认不能继续单包补丁。setup 已改为扫描 DSH CLI 的 dependencies/devDependencies/peerDependencies 及递归闭包，一次性建立所有 host fallback；缺少 `lib` 时统一执行根目录 `pnpm run build:lib:host`。README/USAGE 已同步。当前仅本地验证通过，尚未发布新版本，待 Windows 重跑确认后再发。
- Windows 复测确认 client 包只有在 `pnpm run build:lib:client` 后才生成 `lib/index.js`。setup 现按 host→client 两阶段构建，README/USAGE 已同步；`dsh-loom@1.2.13` 已发布。下一步是用户重跑 setup 并确认 Web UI 冷启动。
- Linux 冷安装验证通过：源码闭包修复、mini-SWE venv、patch 生成均成功。过程中发现 `@types/*` 类型包没有 runtime `lib`，不应触发宿主构建；setup 已改按 `main`/`exports` 判断运行时入口。该修复待发布为 `1.2.14`。
- 文档补齐 Builder 独立凭据说明：默认 `DSH_META_API_KEY`/`DEEPSEEK_API_KEY`，Terra 使用 `LOOM_TERRA_API_KEY` + `LOOM_TERRA_BASE_URL`；明确 `dsh-loom` 是 bundle 而非 skill，Actor key 不会自动成为 Builder key。
- `meta_status` 新增脱敏 Builder health projection：provider、model、`credentialConfigured` 和缺失提示，不返回任何 key。`dsh-loom@1.2.15` 已发布；仍未开放通过 Actor 明文写入凭据，当前安全入口是启动 DSH 前设置环境变量。
- Linux 真机冷路径已验证：隔离 DSH_HOME → web profile 安装 Loom → `--dump-config` 发现 `meta-validate` → setup/mini-SWE/patch → Web 启动并收到 HTTP 200。过程中发现并修复 `CandidateImporter` 中重复的 builder-generated helper 声明（1.2.15 会使 Web import 抛 SyntaxError）；`dsh-loom@1.2.16` 已发布。定向 17 tests、check、build、diff-check 通过。
- Windows runtime lookup 统一：setup patch 现在同时写入 `workspaceRoot` 和 `activeEvolution.runtimeRoot`，不再依赖已运行 Web 宿主是否继承 User 级 `DSH_META_VALIDATE_ROOT`；`meta_status` 显示解析后的 runtime 路径、executable/config presence、ready/error。`dsh-loom@1.2.17` 已发布，check + mini runtime tests + build + diff-check 通过。

## 2026-08-20 文章插图版式调整

- 对外科普文章 `output/20260820-agent-work-package-and-self-evolution.md` 保留工程总览 SVG 与正文结构图，新增/保留水墨织机、档案纸、夜桥、织机河流、色彩花园五张近期诗意插图。
- 诗意插图不再附加“隐喻翻译”或图下注释，解释全部放回正文；源稿不引用 Qwen `generated-backgrounds` 图片。
- 已生成轻量 HTML 预览：`output/20260820-agent-work-package-and-self-evolution.preview-v11.html`；图片路径检查与 `git diff --check` 通过。

## 2026-08-20 知乎科普文章发布

- 发布前将 Mermaid 源码替换为知乎可上传的 PNG 图，并补齐全部图片 alt；知乎 preflight 通过，唯一 WARN 为长句统计。
- 文章已公开发布：<https://zhuanlan.zhihu.com/p/2073645917077612083>。
- 发布过程中第一次后台请求延迟返回，造成重复文章；已核对并删除重复 ID `2073645919174766986`，仅保留上述文章。
- 重新审校正文强调层级：加粗仅保留协议字段、核心定义、执行边界和事实/轨迹等关键概念；已通过原文章 ID 更新并重新发布，未产生新重复文章。
- 修复知乎框架图文字丢失：原 Mermaid SVG 的 `foreignObject` 经 librsvg 转 PNG 时未绘制节点文字；现改由 Chromium 渲染 SVG 后导出 PNG，并将 context/ledger 两图改为纵向大字号版（约 1000px 宽、1500px 高）。已更新同一知乎文章。

更新：2026-08-19 22:32（Asia/Shanghai）

## 2026-08-20 v1.2.8 修复 profile 隔离的 schemastery 依赖

- Windows 真机错误 `Cannot find module ... @deepseek-ai/schemastery/lib/index.mjs` 定位为 package manifest 缺陷：Loom 在 `src/index.ts` 直接 runtime import schemastery，但此前错误地只列为 `devDependency`。
- `@deepseek-ai/schemastery@^3.18.1` 已移入正式 `dependencies`；`cordis`、`dsh-tools` 保持 peer，因为它们必须与 DSH 宿主共享实例。
- 发布并从 npm registry 核验 `dsh-loom@1.2.8` manifest：dependencies 含 schemastery，peerDependencies 仅含 cordis/dsh-tools。profile 安装后应在 Loom 自身 node_modules 解析该模块，不再向 `%USERPROFILE%\.dsh\profiles\node_modules` 回溯。
- 发布前 check、定向 tests、build、pack dry-run、diff-check 已通过。

## 2026-08-20 v1.2.7 DSH profile 启动语法修正

- 根据 Windows 实测修正全部启动示例：Loom profile 必须使用 `pnpm dsh --profile loom --patch <absolute-patch>`；不能写成 `pnpm dsh web --profile loom ...`。
- 原因是 DSH 的 `web` 是固定 `--profile web` 别名，不能与 Loom profile 组合；`dsh-loom setup` 输出和 `start` 转发逻辑同步修正。
- README/USAGE 已明确该规则，并保留 `pnpm dsh web` 作为“先验证 DSH 默认 Web 是否可用”的独立检查。
- 发布前将运行 check、定向测试、build、pack dry-run、diff-check；版本目标 `1.2.7`。

## 2026-08-20 v1.2.6 路径与 DSH 启动文档修正

- 将 setup/启动示例改为显式 `runtimeRoot` + 同一绝对 `patch` 路径，消除 `%USERPROFILE%\.dsh\meta-validate` 与相对 `.meta-validate` 的混淆。
- 各平台文档要求先单独确认 DSH 自身可启动；不再把 `tsx/esm`、DSH 构建产物缺失等宿主问题误归因于 Loom。
- npm README 同步更新，发布 `dsh-loom@1.2.6`。

## 2026-08-20 快速开始重构（文档待随下次 release 发布）

- README 快速开始不再混合“总览、源码 checkout、全局 CLI、平台差异”在同一条流程中，改为开头选择表 → 统一前置条件 → Windows PowerShell / macOS Terminal / Linux shell / 全局 CLI 四条各自完整的连续命令。
- 三个源码 checkout 区块各自包含：安装固定版本 Loom、`--dump-config` 验证、平台 wrapper setup、正确顺序的 `pnpm dsh web --profile loom --patch ...` 启动；用户无需跨段落拼接命令。
- 文档明确 mini-SWE 本体已 vendored、Python >=3.10、依赖镜像边界，以及 Windows profile bin 不进入 PATH 的原因。`git diff --check` 通过。
- 根据 Windows 实测再次修正：不再在启动命令中写假设的相对 `.meta-validate`；各平台先显式设置 `runtime_root`，将 setup 生成的同一绝对 patch 路径传给 DSH。文档要求先独立验证 `pnpm dsh web`，把 DSH 的 `tsx/esm`/构建故障与 Loom runtime 安装分开排查。

## 2026-08-20 v1.2.5 Python 前置条件校验

- mini-SWE 2.4.6 的 `requires-python >=3.10` 现已从文档前置条件升级为 bootstrap 的确定性 preflight：创建 venv 前读取解释器版本，低于 3.10 或不可运行时清晰退出，不产生半初始化 runtime。
- README 的 Windows/macOS/Linux 区块统一声明 Python >=3.10、首次依赖源可访问和 DSH provider 已配置；Windows 支持 `$env:PYTHON` 指向 conda/pyenv 解释器。
- 发布并核验 `dsh-loom@1.2.5`；check、定向 tests、build、pack dry-run、diff-check 通过。

## 2026-08-20 v1.2.4 跨平台安装入口

- 快速开始已拆成 Windows PowerShell、macOS Terminal、Linux shell、全局 CLI 四个明确板块；每一块给出该系统的 setup 与 DSH 启动命令、Python 前置条件和网络/镜像边界。
- 包内新增 `bin/setup-windows.ps1` 与 `bin/setup-unix.sh`：前者保留用户 PYTHON override、默认 `python`，后者统一委托 Node CLI 的 Unix 逻辑；不复制 bootstrap 实现，平台路径仍由唯一的 Node 核心维护。
- 修正 setup 完成提示的 DSH 参数顺序为 `dsh web --profile ... --patch ...`。
- `check`、定向 tests、build、pack dry-run、diff-check 通过；tarball 确认含两个平台 wrapper、vendored source/config/provenance。待发布 npm `1.2.4`。

## 2026-08-20 v1.2.3 vendored mini-SWE supplier

- 针对用户实测的北航 PyPI 镜像不含 `mini-swe-agent`，将固定 commit 的 MIT mini-SWE 2.4.6 源码发行包 vendored 到 `runtime/mini-swe-agent-2.4.6.tar.gz`（约 1.1MB）；不携带平台相关 Python venv（原本地 checkout 约 466MB，主要是 `.venv`）。
- `dsh-loom setup` 优先从 npm 包内本地 tarball 安装 mini-SWE 本体，不再依赖用户 Python registry 提供该包；其余 Python 依赖仍需从可用镜像、官方 PyPI 或 wheelhouse 获取。
- provenance 安装说明、README/USAGE 镜像边界已更新；`--source` 仍可用于高级部署和本地测试。
- 发布 `dsh-loom@1.2.3`，npm registry 已核验；check、定向测试、build、pack dry-run、diff-check 通过，tarball 包含 vendored source/config/provenance。

## 2026-08-20 v1.2.2 Windows runtime bootstrap 修复

- 修复用户实测的 Windows 缺陷：`python3` 默认命令、Unix `bin/` venv 路径不适用于 Windows。
- bootstrap 现在按平台使用：Windows `python`、`Scripts\python.exe`、`Scripts\mini.exe`；Linux/macOS 继续使用 `python3`、`bin/python`、`bin/mini`。
- Python/venv/pip/DSH 启动失败现在输出具体诊断；`bundledMiniSwePaths` 主链 resolver 同步采用平台路径。
- 修复 `dsh-loom start` 调用 DSH 时的参数顺序（`web --profile ... --patch ...`），避免 DSH 报“web takes none of parent options”。
- README/USAGE 增加 Windows 源码 checkout 分支和 PATH/bin shim 说明。
- 发布 `dsh-loom@1.2.2`，registry 已核验该版本存在；check、定向测试、build、diff-check 通过。

## 2026-08-20 v1.2 一键 mini-SWE runtime（代码完成；首次实际 bootstrap 正在验证）

- npm 包现在随附固定的 `runtime/mini-swe-agent-v2.4.6.yaml` 与 `runtime/mini-swe-agent.provenance.json`（mini-SWE `2.4.6`、来源 commit、许可证）；`package.json` 明确将 runtime 纳入 tarball。
- 新增 `src/builder/bundled-mini-swe.ts`：默认从用户自己的 `$DSH_META_VALIDATE_ROOT/runtime/mini-swe-agent-2.4.6/bin/mini` 取 executable，从包内取 pinned config；显式 host override 仍保留给高级部署。
- `dsh-loom setup` 创建该用户缓存内的隔离 venv 并安装固定版本；`dsh-loom start --profile loom web` 会在缺失时先 setup，再自动携带生成的 active-evolution patch 启动 DSH。不会写入 npm 包、DSH checkout、生产 profile 或凭据。
- README/USAGE 快速开始已改为用户无需填写 executable/config path，并诚实说明首次 bootstrap 需要 Python 3、网络/PyPI；Config/Skill Actor 主入口 E2E 仍是产品发布门槛。
- 已通过 `npm run check`、全量 `npm test` **233/233**、`npm run build`、`npm pack --dry-run`（确认 runtime/config/provenance/bin 都在 tarball）与 `git diff --check`。本机 `--source /chenzute/dsh-src/mini-swe-agent` 的真实 bootstrap 已启动，依赖安装尚待完成确认；不应把此单次机器安装作为发行 E2E。

## 2026-08-20 README v1.2 叠加更新（文档完成）

- GitHub 图文 README 保留 v1.0–v1.1 的架构图、历史案例和可读性；不再以重写方式丢弃这些材料。
- 新增 v1.2 顶部状态框、Actor 任务卡流程图、三列表格（历史案例/设计方向/v1.2 标记）、refine 的 v1.2 artifact 交付案例，以及“测试绿不等于能力发布”的证据表。
- 新图 `docs/figures/fig-version-evidence-trajectory.svg` 同时展示工程回归 **101 → 133 → 231** 与研究主张的定性上下波动；图注明确下行是收回未被证据支撑的发布主张、不是性能倒退。
- README 明确：产品轨只承诺用户主动的 Config/Skill；Loop 为 mini-SWE 实现、Loom 编排的研究轨；Config/Skill 主入口真机 E2E 仍是发布门槛。
- README 的快速开始与 `docs/USAGE.md` 已从旧版“自动后台优化”改为 v1.2 全流程：DSH 首次启动 → Loom profile 安装/`--dump-config` → host-owned mini-SWE runtime 前置条件 → Actor 任务卡确认/状态/取消/重做，并预留三张真实对话截图位置。明确当前缺少可分发 runtime supplier，故普通 npm 用户尚不能一键开启主动演进。

## 2026-08-20 v1.2 产品轨：Actor 对话任务卡与会话委托（代码完成；真实主入口 E2E 待跑）

- 新增 durable `EvolutionTaskSession`：每个 Actor 会话保存当前待确认、进行中与最近终态的计划引用、用户原话、Actor 解释、候选与进度 cursor；它只是会话指针，plan/run 本体始终 immutable。新请求不能覆盖已有待确认或进行中任务。
- `meta_auto(plan)` 返回安全的 Actor 任务卡：没有 planId、target kind/id、workspace 路径、before snapshot 或隐藏推理；卡片新增候选、确认问题、controls、timeline、retryability。`meta_auto(execute)` 不再要求 Actor 提供 planId，默认只确认当前会话的待确认任务。
- 新增 `meta_evolution_control(status|cancel_queued)`：无需用户给内部 ID；只能取消仍在内存队列、尚未获得 workspace 的任务。已经 implementing/verifying 的 mini-SWE pass 明确拒绝强杀，避免破坏可审计边界。
- 用户卡状态为 waiting_for_confirmation → queued → implementing → verifying → completed | not_applied | not_completed | cancelled；`verifying` 只由 Controller 进入真实 adjudication 前写入。宿主重载把 queued/running job 与相应 plan 标记为 interrupted，绝不自动续跑。
- `redo=true` 对最近 rejected/aborted/cancelled/interrupted 任务创建新的 immutable plan，复用原用户意图与宿主目标，但重新冻结本次 evidence；不会重开或修改旧 plan/workspace。
- 失败通知不回显原始错误文本，user-evolution 统一投影为“未完成、未生效、已取消”卡片。新增会话存储回归；当前 `npm run check` 与 `npm test` **230/230** 通过。
- 仍待真实验收：Config 与 Skill 各一条完整 `Actor 自然语言请求 → 候选确认 → 后台 mini-SWE → Verifier/Gate → cold replay/rollback → Actor 结果解释` E2E，完成前不得把这层宣称为用户可用。

## 2026-08-20 v1.2 运行时收敛：Loom 编排，mini-SWE 实现

- 生产 `meta_auto(exploreLoop=true)` 现在只接受 `allowLoopCandidates.executionRuntime=mini-swe`；`loom-native` 配置会被明确拒绝，不能再作为源码编辑器进入 Loop 实现链。
- `executionRuntime` 默认已改为 `mini-swe`。Loom-native 只保留为 diagnosis/clarification pass：持久化 evidence、方向、choice 与 actor 通讯；用户/actor 选择后，implementation pass 自动物化 mini-SWE workspace，再交独立 Verifier/Gate。
- 保留旧 BuilderKernel/Driver 单测仅用于 durable protocol、inbox、proposal/rejection 兼容回归；它们不属于 v1.2 复杂源码实现矩阵，也不应再触发正式模型实验。
- 新增回归证明：当 mini-SWE 被选为 implementation runtime 时，diagnosis pass 不 materialize/调用 mini-SWE，仍由 Loom-native 生成 waiting_for_input；后续 implementation 才使用 mini-SWE。`candidate-gateway` 12/12、TypeScript check、diff-check 通过。
- mini-SWE 已接到正式主链的 child env：LoopCandidateGateway 与 ActorEvolutionGateway 均从 host env 映射 Terra/official OpenAI-compatible base URL/key 到子进程的 `OPENAI_*`，并设置 `MSWEA_CONFIGURED=true`。该 env 仅传 `runMiniSwe` child，不序列化到 plan/prompt/workspace/trajectory/evidence。新增 mapping tests；定向 17/17、check/build/diff-check 通过。
- 产品体验第一层：`meta_auto(plan)` 现在只返回 user-facing plan view（目标/风险/验收/证据数量），不回显 before snapshot 或内部 refs；`execute` 先 durable queue 再入后台 job，不阻塞 Actor，也不能重复排队；新增 `meta_evolution_status(jobId|planId)` 将 immutable plan/job 投影为等待确认、执行中、已生效或未生效及原因。controller queue 回归覆盖已补。
- 产品体验第二层：新增 `evolution/presentation.ts` stable task-card schema（phase/headline/current+next/actions/result），Plan/Execute/status 都返回此 card，且测试证明不会包含 raw evidence path。后台 job 开始/完成通知现在读取同一 card，向 Actor 注入“隔离实现中、尚未生效、独立裁决中”或“已生效/未生效+原因”，不再泛化为“优化完成、reload 后生效”。只展示真实存在的 `confirm_execute/view_status/view_evidence` 操作。

## 2026-08-19 v1.2 双轨控制面（代码完成；真实 E2E/矩阵未完成）

- `meta_auto` 已新增产品轨 `evolutionMode=plan|execute`。Plan 冻结 Actor evidence pack、宿主解析 config/skill target；Execute 只接收原有 immutable `planId`，经 `ActorEvolutionGateway → mini-SWE isolated workspace → compiler → Validator → Gate`，没有直接安装旁路。
- Config target 必须是宿主已有且不含 credential 字段的行；Skill id 必须 kebab-case，entry 固定为 `<id>/SKILL.md`。用户可提供意图，不能提供 before/path 或在 execute 时换目标。`activeEvolution` 默认关闭，必须明确配置 mini-SWE runtime。
- 新增 `src/evolution/controller.ts` durable plan controller 与 `src/loop-experiments/matrix.ts`。矩阵强制三层任务 × 三个 immutable slots，保留失败并按分类统计；只有每层至少一条完成 edit→tests→submit→Verifier/Gate→cold replay→rollback，且九槽齐全，`releaseEligible=true`。
- README 已重写为双轨边界；不再宣称自动自治、整体 Actor 性能或 Loop 已稳定可用。
- 本次验证：`npm test` **222/222**、`npm run check`、`npm run build`、`git diff --check`、`npm pack --dry-run` 全通过。注意工作树含既有用户未提交改动和 build `dist/`；未做 git commit/publish。
- 尚未完成且不可宣称：Config 与 Skill 各一条真实 **meta_auto 主入口** E2E；Loop 三层任务各 3 个 fresh run 与公开 raw records。现有 scheduler/refine records 只能作基线/先例，不自动计入 v1.2 阈值。

### 2026-08-19 v1.2 测试启动结果（未达阈值）

- fresh Skill runtime 复测：`builder-1787154571104-7f66fa2c` 真实 mini-SWE 提交，Verifier approved，Gate applied，cold Loader 安装前/后/rollback 后 probes 均 exit 0（正文载入断言在 raw report）。它复测的是 Gateway E2E，不是 `meta_auto` 入口，故不替代产品轨入口门槛。
- Loop matrix `scheduler-prepare-overlap` attempt 1：`builder-1787154678894-60b94e7b` 在新的 immutable DSH archive 先真实复现 `parallel-safe prepares were serialized`，随后 mini-SWE 修改源码并通过 host-required delayed-prepare regression + `tool-calls.spec.ts`，提交 formal proposal。raw: `/chenzute/dsh-src/eval/run-records/2026-08-19-v12-loop-matrix/scheduler-prepare-overlap-attempt-1.json`。尚未走 C0–C8/Gate/cold replay/rollback，因此是 implementation-pass success、**不是** matrix complete success。
- Loop matrix `oracle-rejection-repair` attempts 1–3：官方 V4 Flash adapter 三条 fresh immutable repair run 均在 20 model turns 后得到空白/非 JSON decision，0 tools、0 edit、0 oracle、0 submission；raw: `/chenzute/dsh-src/eval/run-records/2026-08-19-v12-loop-matrix/oracle-rejection-repair-attempts-1-3.json`。这是重复的 runtime/model-response contract 断链，不能归因于代码修复能力；遵循单变量纪律，下一次只切换为已验证能执行的 mini-SWE/Terra runtime，不再加 prompt 或预算。
- 单变量 mini-SWE/Terra control 已完成：`oracle-rejection-repair-mini-attempt-1.json` 在 6 model turns 内检查 candidate/oracle、将 `runActorLoop` 改为 `run`、真实获得 `strict-order-pass`、写出 `outbox/proposal.json` 并 Submitted。raw: `/chenzute/dsh-src/eval/run-records/2026-08-19-v12-loop-matrix/oracle-rejection-repair-mini-attempt-1.json`。这是 execution-runtime implementation/oracle 成功；该 eval fixture 尚未被 `LoopCandidateGateway` 编译成 DSH loop envelope，故仍未进入 Verifier/Gate/cold replay/rollback，不算 complete success。

## 2026-08-19 真实 refine skill：mini-SWE → verifier/Gate → cold Loader → rollback（已完成）

- fresh immutable mini-SWE pass `builder-1787149918682-c881e8a5` 在孤立 `actor-module/` 自主生成 `refine-evidence-20260819/SKILL.md`，并留下 durable `Submitted` trajectory（5 API calls）。bundle 含有效 frontmatter、`EVIDENCE_REFINEMENT_MARKER` 与可用的 evidence-first refine 流程：观察失败 → 可证伪假设 → 最小安全检查 → 窄变更 → 说明限度；没有人工补写 bundle。
- frozen `patch-evolution` proposal 经现有 `Validator.skillIsolation` 的真实 DSH `--dump-config` catalog diff 和冷 actor probe 通过，再由既有 `Gate` 安装到 eval-owned skill root。安装后的独立冷 DSH CLI process 实际调用 `skill(refine-evidence-20260819)`，脚本化 LLM 从 tool result 读取正文 marker；raw record：`/chenzute/dsh-src/eval/run-records/2026-08-19-real-refine-skill/report.json`。
- 强证据序列：安装前 cold probe=`skill-body-missing`；Verifier=`approved` 且 `skill isolation: pass`；Gate `applied=true`；安装后 cold probe=`skill-body-loaded`；Gate-owned rollback 后目录不存在且 cold probe 回到 `skill-body-missing`。全部路径在 `/chenzute/dsh-src/eval/meta-workspace-real-refine-20260819/`，未触碰 DSH checkout、用户 skill root、profile 或生产。
- 修复 mini-SWE adapter 的真实配置缺口：`MiniSweRuntimeOptions.env` 现在可由宿主显式传递模型 route/credential 环境，且只进入子进程、不进入 prompt/workspace/trajectory。新增回归覆盖。首次 run 因缺此 bridge abort；第二次/第三次 staging probe 暴露并修正了 eval harness 的 skill root depth 和 skill-name 回显断言，三次记录均保留，最终 pass 不掩盖前两次失败。
- 边界：这证明 Builder 能创建一个隔离、可加载且有用的 refine **skill artifact**，并证明 DSH Loader 返回了它的正文；它**不**证明任意 LLM 在开放任务中必然遵循该技能，亦不证明 actor 已具备自动触发 refine、复杂多文件改造成功率或整体性能提升。

### 2026-08-19 refine 的最小触发验收（已完成）

- 已补“上一次聚焦检查失败 + 用户要求复盘、先不要修改”的冷 DSH Actor E2E：`/chenzute/dsh-src/eval/run-records/2026-08-19-refine-trigger-acceptance.json`。Actor 的确定性触发 policy 实际发出 `skill(refine-evidence-20260819)`，并在 tool result 正文可见后输出五段计划：Observed failure、Falsifiable hypothesis、Smallest safe check、Proposed next step、Limits。
- 因而 v1 的触发边界可明确写为：**用户显式要求 refine/复盘/优化失败，或 Actor 已持有失败事实后要求证据式复盘**。这证明“触发→加载→使用输出结构”可运行；自动触发判别的召回率、真实模型遵循率与主观体验仍是后续统计评测，不作为当前门槛。

## 2026-08-19 cold Loader candidate 的正式裁决、安装与回滚（已完成）

- 新 immutable `builder-generated` candidate `cold-loader-prepare-20260819` 已以真实 `contract-runner` 得到一份完整报告：C0、C1–C4、C6（from-zero L1–L5）、C7、C8 全部 `pass`。报告：`/chenzute/dsh-src/eval/meta-workspace-cold-loader-20260819/runtime/reports/cold-loader-prepare-20260819-contract.json`。
- 期间发现并修复两个评测底座问题：① Loom 启动的非交互 `pnpm dsh` 子进程必须固定 `CI=true`，否则 pnpm 会在 pipe 下中止 modules 修复而造成假 C0 失败；② C6 不能引用会被 `build` 清理的 `dist/fromzero/**`，四个 test fixture 已迁到受版本控制的 `fixtures/fromzero/**`，eval overlay 引用稳定资产。两者均有确定性回归覆盖。
- Verifier 将 staging candidate 依次推进 `pending → verified → approved`；Gate 从空快照创建隔离 Loader profile，C0 entry smoke 通过，安装 receipt：`runtime/candidates/installations/cold-loader-prepare-20260819.json`。
- 安装后在真实 cold DSH CLI Loader 下重跑 5× baseline/installed 16 个 `isConcurrencySafe`、100ms body-delay calls；两侧均 16/16 完成。中位数：baseline wall 5992.9ms / start span 1.664ms / body window 111.02ms；installed 5763.6ms / 1.651ms / 111.95ms。完整原始 stdout/timeline：`/chenzute/dsh-src/eval/run-records/2026-08-19-cold-loader-16-gate-installed-repeated/report.json`。该 plugin 没有 delayed prepare，故结论严格限于 **cold Loader task completion/non-regression**，不把 229ms wall 差或此 workload 宣称为性能提升。
- 补齐 `rollbackInstalledCandidate`：已安装 profile 的 Gate-owned remove 会单独写 rollback receipt，不覆盖 install receipt；真实 receipt：`runtime/candidates/installations/cold-loader-prepare-20260819.rollback.json`，before `exists=true`、after `exists=false`，registry 回到 `approved`。生产/profile 未触及。

## 2026-08-19 20:12 性能边界时序补充（已完成，cold Loader 未完成）

- baseline 与 Builder candidate 各自以真实 `Context + AgentLoop + ToolRuntime + AgentRegistry + MockAdapter` 运行同一边界矩阵；原始 session frames/timeline 已持久化到 `/chenzute/dsh-src/eval/run-records/2026-08-19-mini-swe-prepare-boundaries-{baseline,candidate}-raw-frames.json`。
- mixed-exclusive：两边都先并行启动 `p1/p2`，均在其结束后启动 exclusive `x`，`p3/p4` 又均在 `x` 结束后启动；候选没有因 prepare 并发优化越过 barrier（baseline 158.9ms，candidate 155.0ms，均为单次边界观察，非性能声明）。
- abort-draining：pool=2 时两边只启动 `p1/p2`，取消后等待二者结束；`p3/p4/x` 都持久化为 `ABORTED_BEFORE_DISPATCH`。cancel→idle 为 baseline 87.5ms、candidate 88.5ms。
- failure-draining：注入 scheduler failure 后两边都只让已启动 `c2` drain，failure 时尚无 `turn/end`，随后才出现错误结束；没有新的 dispatch。failure→idle baseline 5.0ms、candidate 2.7ms（由受控 release 决定，不作加速比较）。
- 两边均通过隔离 workspace 的 Vitest benchmark；这补的是 safety/non-regression timing evidence，仍不等于 cold profile Loader 级 workload 或整体 Actor 性能。

## 2026-08-19 20:18 cold Loader workload 进展与真实缺口

- baseline 已经通过真实 DSH CLI cold process（`node --import tsx/esm apps/cli/src/bin.ts --profile headless`）及外部 Loader patch 完成一次 scripted mock tool round trip；这证明评测入口可走 Loader，而不是 Context fixture。
- 尝试从 approved candidate 的 gate artifact 重新物化隔离 Loader profile 时，`createCandidateProfile()` fail-closed：artifact 的 `node_modules/@deepseek-ai/cordis` 是 symlink。profile artifact hash 明确禁止 symlink，故不能把这个后续污染的 staging directory 当作可重装 artifact。
- 这是必须修复的 Importer/staging hygiene 问题：成功 stage 必须只保留 candidate package publish/runtime bytes（不含 build-time node_modules symlink），或用独立 immutable package artifact；不能手工忽略 hash 或复制 profile 来继续测试。cold Loader 16-call baseline/installed 对照暂停在此 gate，尚未形成结论。

## 2026-08-19 20:33 Importer runtime artifact 修复与 cold Loader smoke

- `CandidateImporter` 现将 build workspace 与 install artifact 分离：构建仍在完整 git archive staging tree 中运行，但 manifest 只指向 `candidates/artifacts/<id>` 下的 `package.json + lib/**` regular-file runtime copy。复制拒绝 symlink，显式排除 build-time `node_modules`；新增回归覆盖 source package 含 dependency symlink 时 artifact 仍可 hash。
- 用原始 Builder durable proposal 重新执行 Importer，产生新 immutable candidate `cold-loader-prepare-20260819`，artifact hash `cc712d…541e6d`；它可被 `createCandidateProfile()` 正常物化为 Loader profile。
- baseline 与新 candidate profile 已分别用真实 DSH CLI cold process、同一外部 mock Loader patch 完成一轮 tool round-trip。该结果只证明 runtime artifact hygiene + Loader 可重装，不替代 16-call repeated workload、verifier/gate promotion 或性能结论。

## 2026-08-19 20:38 cold profile Loader 16-call workload（第一轮完成）

- 为避免 Context fixture 冒充 Loader，新增 eval-only external CJS plugin：Loader 载入后注册 scripted adapter，首轮生成 16 个 `isConcurrencySafe` `cold_delay` calls，每个 body 固定 100ms。CJS `apply()` 内动态加载已构建 DSH modules，规避外置 `.ts` 在 Loader/tsx 中的 ESM require-cycle；DSH checkout 未修改。
- baseline headless profile 与 candidate `loom-cold-loader-prepare-20260819` 各在独立 DSH_HOME 的 cold CLI process 成功运行并输出 `16 delay tools completed`。原始 tool timeline：`/chenzute/dsh-src/eval/run-records/2026-08-19-cold-loader-16-{baseline,candidate}-timeline.json`；原始 actor session frames 为各自 DSH_HOME 下 zstd JSONL。
- 观测：两侧均 16/16 start/end；baseline start span 1.74ms、body window 112.0ms，candidate 1.71ms、113.2ms。这只证明通过真实 Loader 后候选仍保持 16-body并发与任务成功；该 plugin 没有 delayed `prepare()`，因此不能替代已有 prepare-overlap 因果 benchmark，也不能宣称 Loader workload 加速。

## 一句话状态

**`v1.1.0` 已完成双重正式发布**（GitHub release + npm latest）。本轮补齐了 capability runtime registry、共享 `SimulationRunner`、`workspace-simulation` capability 和结构化 clarification/choice/verification 请求；当前工作树 `npm run check`、`npm test`（**213/213**）、`npm run build`、`git diff --check` 已通过。生产与用户 profile 均未触及。

### 下一发布门槛（v1.2，未满足）

- npm `latest` 与 package 当前均为 `1.1.0`；工作树有 62 项待提交改动，不能把未提交实验直接发布。
- `actor-composition` 仍缺真实 DSH transaction adapter：不能复用单 patch Gate 伪装为原子多目标安装；必须以一个 staged composite artifact、一次冷 smoke 和可验证的全量回滚实现。
- 性能只能主张已测的 prepare-overlap 路径；发布前若要主张“真实性能提升”，必须补齐 16-call、body latency、exclusive/abort/failure quiescence 与 raw actor-frame workload 的同基线重复原始记录。未完成这些时可发布功能/安全修复，但 release notes 必须明确不作整体性能宣称。
- 打包审计已修：`npm run build` 先清空生成目录，`prepack` 删除 `dist/fromzero`/`dist/meta-workspace` 残留；dry-run tarball 由 86 缩至 77 文件且不含两类运行产物。`package-lock.json` 根版本也已从历史 `0.1.0` 同步到 `1.1.0`。

### 2026-08-19 性能证据补齐：16-call/body（进行中）

- Builder 真实 candidate `builder-1787123618188-d57a45a7` 对 pinned baseline 的 16-call 独立 scheduler matrix（每侧每档 5 次、pool=16、prepare=100ms）已完成：body=0ms 的 wall 中位数 **1645→133ms**、prepare span **1525→4.94ms**；body=50ms 的 wall **1695→180ms**、prepare span **1525→5.65ms**。两侧任务完整、0 error。record：`/chenzute/dsh-src/eval/run-records/2026-08-19-mini-swe-prepare-16call-body-benchmark.json`。
- 这可作“该 Builder 候选在其修改的 prepare-overlap scheduler workload 上的 causal-workload 改善”结论；仍不可称 Actor 整体性能提升。剩余：mixed exclusive、abort/failure-draining 的 raw timing，以及同一真实 Actor raw-frame workload 的重复 baseline/installed 对照。

### 2026-08-19 actor 通用 runtime 迁移：config compiler 底座（进行中）

- 统一迁移规格：`docs/actor-general-runtime-spec.md`。原则是统一 mini-SWE execution runtime + host workspace/compiler 入口，但复用既有 capability-specific verifier/gate；不把 loop 的 Importer/contract 错套到 config/tool/skill。
- Kernel 新增 `compile_config_submission`：从 host materialize 后、Kernel 捕获 before 的 `actor-config.json` 生成现有 `patch-evolution` envelope；runtime 只能影响 after config，不能自填 targetId、action、hash 或验收链。无变更、缺 metadata 或错误 targetKind 均 fail-closed。
- 当前仅完成 compiler + native tool schema + 单元闭环，**尚未**接入 mini-SWE Gateway、Validator/Gate 真实 E2E；不能称 config 已由 mini-SWE 演进。全量 190/190。
- `ActorEvolutionGateway` 已作为通用 execution ingress 接入 `config-evolution`：mini-SWE 编辑 isolated `actor-config.json` 后，Kernel 生成现有 `patch-evolution` envelope；范围外 scratch 不进入 proposal。该 envelope 已经穿过既有 Validator 与同一个 Gate（before/after + smoke）测试闭环；**尚未**从 `meta_auto` 调度或跑真实宿主 profile rollback E2E；全量当前 195/195。
- `ActorEvolutionGateway` 现支持共同的 tool/skill module ingress：mini-SWE 仅写 `actor-module/`，`compile_module_submission` 枚举受限 bundle、固定 targetId/kind/name/entry，产出已有 `patch-evolution` insert envelope。Compiler 将冻结 bundle 复制到 verifier-owned staging（Validator 不读取 runtime workspace）；tool 已穿过 mini-SWE → compiler → module-load Validator → Gate，skill compiler E2E 已通但仍需真实 skill load/probe/Gate rollback。
- config/tool/skill 的 ActorEvolutionGateway 新增统一 `reopen(runId, report)`：只允许 submitted run；通过 Kernel rejection lineage 建新 immutable run，config 重新物化 host-captured baseline、module 重建空 allowlisted bundle、完整 rejection report/Actor inbox 均继承只读资产。全量当前 **199/199**。
- skill 新增确定性 E2E：mini-SWE bundle → existing catalog probe verifier → existing skill Gate install → cold smoke fail → removeSkill rollback；Gate rollback `ApplyResult` 现会保留在 rejected adjudication，避免上层丢失“实际 apply 后已回滚”的证据。这个 catalog/probe 为 test double，尚不是真实 DSH profile 冷启动。全量当前 **200/200**。
- capability registry 现明确注册 config/tool/skill 与 `actor-composition`；前三者绑定既有 compiler/Validator/Gate。composition 新增独立 graph verifier + transactional Gate：controller allowlist、唯一 target、trajectory、依赖引用、DAG 和 proposal hash 全部 fail-closed；冷 smoke 失败按依赖反序 rollback，hash 漂移 report 不触碰 target。`ActorEvolutionGateway.start/runComposition` 已以 host-fixed graph/before snapshot materialize mini-SWE workspace，compiler 只冻结计划中的 config/module after artifacts；**Controller composition verifier/Gate dispatch 尚未接入**，所以仍不会经 `meta_auto` 安装。全量当前 **206/206**。
- adversarial archive→Importer E2E：mini runtime 同时改 allowlisted `tool-calls.ts` 并写 workspace `outside.txt`；Kernel compiler 仅生成 source edit，CandidateImporter 从 pinned git archive 重新物化、无网络 bwrap build、stage artifact。artifact 含允许源码改动且不含 `outside.txt`；runtime workspace 仍可观察该越界写入。全量当前 **207/207**。
- Terra adapter 现兼容 `LOOM_TERRA_API_KEY`/`LOOM_TERRA_BASE_URL`（保留 `DSH_TERRA_*`）；真实短 native-tool health check 约 3 秒返回合法 `{decision:…}` wrapper，Driver 可解包。该检查不构成 Builder proposal/gate 证据。全量当前 **208/208**。
- composition 新增 `CompositionPlanRegistry`：仅 Controller/宿主可预注册 plan，执行请求只能携带 plan ID；解析返回深拷贝，并在 workspace 创建前 fail-closed 检查 bounded/unique node+target、before snapshot、trajectory、module entry 与依赖引用。它解决了“不可把 Builder/user graph 当 host plan”的可信输入底座；下一步才是将 registry 接入 `meta_auto` 的 capability dispatch 与真实 transaction Gate。全量 **211/211**、check/build/diff-check 通过。
- `CompositionController` 已接上独立 runtime seam：`planId → registry resolve → ActorEvolutionGateway mini-SWE → frozen composition envelope → per-component verifier → transaction Gate`。定向 E2E 同时证明：所有 child verifier 通过后才按依赖顺序 apply；任一 runtime-produced child verifier 拒绝时 Gate 的 snapshot/apply/rollback 均为零调用。仍未接入 `meta_auto`/真实 DSH loader，因此不称为 production install。

### 2026-08-19 mini-SWE 失败/重开链路补齐

- adapter 覆盖 timeout、partial trajectory、malformed trajectory：均 `submitted=false`、不产生 proposal；malformed trajectory 已有 Gateway materialize→abort E2E。
- 修复 rejection reopen 的真实断链：mini-SWE child run 现在重新 materialize pinned baseline、重新 capture before snapshot；runtime task 接收完整 Actor inbox，并在 durable Submitted 后写事实性 receipt，再进行 Kernel compiler/submit。
- fake runtime E2E 已验证 `submit → verifier rejection → fresh immutable materialize → re-execute → submit`；全量当前 **193/193**。仍需正式模型的 rejection 修复率与同时修改范围内外文件的 Importer E2E。

### 2026-08-19 runtime / 性能证据审计（最新）

- `mini-SWE` 已在一个真实 DSH scheduler 重构中完成自主 diagnose → edit → targeted test → regression repair → Submitted，且随后经 Loom 的 Importer、C0–C8/C6、cold install、actor replay、rollback 验收；因此可称为**复杂 loop implementation 的已验证 execution runtime**，但默认 profile 尚未切换。
- 不是“actor 一切可改”：当前 mini runtime 只接入受限的 `agent-loop` capability（pinned baseline、`src/**/*.ts`、最多 4 文件）；config/tool/skill 与 composition 未统一为该 runtime，verifier/gate/meta-validate 仍必须是不可改 TCB。
- 新的 5× baseline/candidate 对照测到该候选实际改动的 `prepare` overlap：2/4/8 calls 的 prepare-span 中位数由 **102/304/707ms** 降至 **0.55/0.76/1.41ms**，候选 22/22 scheduler tests 通过。它证明受控调度路径改善，**不**证明整体 actor 性能；完整 raw record 与边界见 `docs/research/2026-08-19-mini-swe-runtime-evidence-audit.md`。
- mini runtime 新增负向回归：缺少 durable `Submitted` 的 trajectory、runtime 未产生 trajectory、或 trajectory 损坏，均不能形成提交；workspace 仅有范围外修改时也不能编译 proposal；malformed runtime 经 Gateway materialize→abort 的 E2E 已覆盖；全量当前为 189/189。
- 后续必须补：16-call/body latency/exclusive/abort/failure 与 actor raw-frame workload；mini timeout/partial trajectory/rejection reopen/adversarial runtime matrix；config/tool/skill/composition 的统一能力模型；可部署的受控 dependency/vendor snapshot supplier。

### 2026-08-19 mini-SWE-agent Builder runtime 对照：真实 edit/test 成功；正式候选待修复后复跑

- 在同一 pinned DSH archive、同一真实 `delayed-prepare-regression`、同一 `tool-calls.spec.ts` 下，`mini-SWE-agent`（Terra）自主完成：复现失败 → 定位 `fillPool()` 串行 `await prepare()` → 编辑真实 `packages/core/agent-loop/src/tool-calls.ts` → 首次定向回归通过 → 主动运行 scheduler suite、发现 failure-drain 语义回归 → 依据失败反馈修复 → **22/22** 两个测试文件通过。宿主从它的真实 workspace diff 编译了 loop proposal；轨迹在 `real-agent-loop-builder/.../mini-swe-agent-trajectory.json`。
- 这已证明成熟 coding runtime 的 `diagnose → edit → test → repair` 行动策略明显超过当前 Terra Loom JSON micro-loop（后者能正确诊断但 20/40 turns 均未编辑）。它是 **runtime adapter 选择的正向证据**，不是 gate/install 成功。
- 独立 `CandidateImporter` 随后正确 fail-closed：Compiler 将文件字符串交给通用 `sha256()`，该函数 hash `JSON.stringify(string)`，而 Importer 验证原始文件字节，导致 `beforeHash mismatch`。已修为专用原始文件内容 hash，并以 Compiler 输出的 raw hash 定向回归；全量 **183/183**、check/build/diff-check 通过。
- 不得手工改写旧 proposal 的 hash 来声称自主成功。需在修复后的 Kernel 上重新跑新的 immutable mini-SWE pass，确认其自主 edit→tests→compile→submit proposal 被 Importer 接收，之后才运行 C0–C8/C6、cold gate、rollback 与 workload replay。该复跑目前缺少只在旧进程中存在的 Terra key；未将 key 写入文件、命令或记录。

### 2026-08-19 mini-SWE-agent 真实全链路验收：通过，选为 Builder 执行 runtime

- 新 immutable pass `builder-1787123618188-d57a45a7`（Terra + mini-SWE）在真实 DSH archive 完成：baseline delayed-prepare 失败 → 读取 scheduler/tests → 编辑真实 `packages/core/agent-loop/src/tool-calls.ts` → targeted oracle 通过 → 原 suite 22/22 通过 → runtime 自己发出完成/提交意图。轨迹保存在该 run 的 `mini-swe-agent-trajectory.json`。
- Loom Kernel 由实际 workspace diff 编译 proposal；独立 Importer 重新 archive pinned `47f943…`、校验 raw-file before hash、应用 edit、无网络 bwrap build，成功 stage。中途发现并修复 Compiler 把字符串 JSON-hash 误当文件-content hash 的合同漏洞。
- 完整契约：C0、C1–C4、C6、C7、C8 全 pass；actor 真实冷运行 exit 0。期间发现并修正 C6 runner 将 `allPass:false` 错认作 pass，以及 C6 强制走 `pnpm dsh` 导致 host dependency repair 失败；现仅接受显式 `"allPass": true`，并继承 verifier 的直接 Node+tsx launch command。
- 独立 verifier/gate 状态机实跑 `staging → pending → verified → approved → installed`；Loader cold profile 的 C0 smoke pass。随后 baseline/installed 同任务 `reply with ok` 均 exit 0（30.0s / 29.3s，单样本仅记录、**不宣称性能提升**）。最后 cold rollback 移除仅 gate-owned profile、确认 profile 无法再解析，registry 回退 `approved`。
- 结论：**mini-SWE-agent 被选为 Loom 的可插拔 Builder 执行 runtime**；Loom Kernel/Importer/verifier/gate 仍是唯一控制面。当前为 eval adapter 的实证，不代表默认用户 Builder runtime 已切换；正式接入还需把 immutable workspace materialization 与 self-contained dependency/vendor snapshot 作为配置化 runtime adapter 实现。

### 2026-08-19 mini-SWE runtime 产品接入（可选，默认未切换）

- 已新增 `src/builder/mini-swe.ts` 与 `allowLoopCandidates.executionRuntime: loom-native | mini-swe`。mini mode 在 run 创建时以 pinned baseline archive materialize 独立 workspace、复制 host-owned dependency snapshot、由 Kernel 捕获 before bytes；runtime 的 durable `exit_status=Submitted` 才触发 `compile_loop_submission → submit`。
- 缺少 executable、configPath、baselineRoot、dependency snapshot 或合法预算会启动失败；不回退 live workspace/宿主依赖。默认 `loom-native` 未变，diagnosis-first 保持 native（mini-SWE 当前不承载 Actor 对话 pass）。
- 新增 fixture 回归覆盖 mini trajectory Submitted 识别；定向 tests 9/9、check/build/diff-check 通过。仍需把已验证的 eval snapshot 形成可部署的受控 snapshot 供应器，再开启某个 profile 的 mini mode。

### 2026-08-19 Terra 可选 Builder adapter：短请求可用，proposal→gate 未评估

- 新增 `gpt-5.6-terra` 可选 provider 与 OpenAI-compatible transport；Terra 走 non-streaming JSON fallback（此供应商对复杂 SSE 首 token 未及时返回），不会发送 DeepSeek `thinking` 字段，key 仅进程环境读取且未落盘。
- `/models` 的实际标识是 `gpt-5.6-terra`（非 `openai/gpt-5.6-terra`）；short JSON ping 2.5 秒 pass。真实 delayed-prepare Builder run 的第一复杂 decision 超约 30 秒无返回，已取消；**没有 proposal、verifier、gate、install 或性能结论**。
- 适配回归后全量 **180/180**、`npm run check`、`npm run build`、`git diff --check` 通过。记录：`/chenzute/dsh-src/eval/run-records/2026-08-19-terra-loom-builder-transport-probe.json`。如继续，应先确认该服务对长 JSON/coding 请求的 latency/SLA，或换可及时响应的 Terra route，再测 Builder 自主 proposal，之后才允许独立 gate。

### 2026-08-19 Terra native decision adapter：真实 action 已通，proposal→gate 仍未完成

- 查明 Terra 对复杂 prompt 的 `response_format=json_object` 严重延迟；移除后同一 7KB prompt 约 5 秒给出合法 action。Terra adapter 改为 non-streaming + 无 constrained JSON + 原生 `builder_decision` function；Driver 通用解包 `{decision:{…}}` 后仍进入既有 allowlist。
- 新 fresh run `builder-1787115999050-f2a0741b` 已真实复现 delayed-prepare、读真实源码/journal、写出正确调度 hypothesis；20 turns 后仍未 edit/proposal。它还触发 `search_text requires at least one available root`，暴露 workspace-relative search 的工具合同缺口。
- 因没有 Builder-generated proposal，**没有 verifier/gate/install/rollback 或性能提升结论**。本轮 **181/181**、check/build/diff-check 绿。下一步：修 `search_text` 的 workspace 默认根并做 fresh Terra run，只有自主 proposal 后再进入独立 gate。

### 2026-08-19 Terra search-root fresh rerun：确定性链路排除完毕，模型 edit/submit 尚未收敛

- `search_text` 相对 root 已改为 Builder workspace 解析，新增回归。fresh `builder-1787116500737-5d93a8fd` 确认 search exit 0，且再次正确诊断 `fillPool` 串行 await 根因。
- 仍在 20/20 turns、20 tools 时 abort，无 edit/proposal。因此该真实 package task 目前不能进入 verifier/gate；不要把 mini-SWE 的外部 edit 或人工改动包装为 Loom Builder 成功。
- 现已排除：Terra endpoint/model ID、复杂 JSON constrained decoding、文本工具误判、native decision wrapper、workspace 相对 read/list/search。下一步若继续应比较 **native per-tool function schemas** 或成熟 runtime adapter 的 action policy，而不是继续微调 prompt 或 gate。
- 当前验证 **182/182**、check/build/diff-check 绿；详细 record 同 `2026-08-19-terra-loom-builder-transport-probe.json`。

### 2026-08-19 workspace loop submission compiler：移除 hash/manifest 交付悬崖

- 已实现 `compile_loop_submission`：Kernel 在首次 workspace 写/patch 前捕获原始文件，随后从 before/after 自动编译 `loop-evolution` builder-generated proposal。Builder 只声明 rationale/expected outcome，不再手写 beforeHash、after edits、package/build 元数据。
- 编译只收集 agent-loop `src/**/*.ts` 的最多 4 个实际变化，仍绑定 `targetBefore.baselineCommit`；下游 CandidateImporter 与 verifier/gate 继续独立重新校验，没有任何自动安装或放行。
- 当前 native per-tool schemas 已由 Driver 提供给 Terra；新增 compiler 回归后 **183/183**、check/build/diff-check 绿。下一步：同一真实 delayed-prepare task fresh 跑 Terra；严格要求 Builder 自主 edit → 两组测试 → compile_loop_submission → submit，之后才可 gate。

### 2026-08-19 Terra compiler fresh run：交付障碍已排除，edit action 尚未收敛

- `builder-1787122031074-1db65f36` 已使用新 compiler 合同；仍 20/20 abort。它复现真实回归并再次形成正确 `fillPool` hypothesis，但无 workspace edit，因此 compiler/proposal/verifier/gate 都没有前提。
- 结论：下一步应对比 native **per-tool action policy**（或成熟 coding runtime），重点测 hypothesis→patch；不要再增加 submission prompt、hash 字段或 gate 逻辑。当前 183/183、check/build/diff-check 绿。

### 2026-08-19 Terra 40-turn control：预算不足已被排除

- `builder-1787122252477-689953e7` 在同一任务、同一工具/contract 下将预算提高到 40 turns/64 tools；仍 40/40 abort、0 edit、0 proposal，始终保持正确 `fillPool` hypothesis。
- 这排除“20 回合不足”作为主要解释。当前不应继续加 token、回合、prompt 或 submission/gate patch；若继续，应对照成熟 coding runtime 的 action policy，或严格 A/B 原生工具 surface。没有 Builder proposal，故 verifier/gate/install 仍不应运行。

### 2026-08-19 Terra per-tool native schema：action surface 完整，真实重构仍未收敛

- Builder base actions 现逐一作为原生 function schema 暴露；response 仍经 Driver/Kernal 的严格 allowlist。fresh `builder-1787118050503-6f31c089` 首步写出正确 hypothesis，实际执行 regression/source read，但 20 turns 后未 edit/proposal。
- 结论：原生逐工具表面不是这个任务剩余瓶颈；停止继续补 prompt/tool 表面。无 proposal 即无 verifier/gate/install。后续应转向成熟 runtime 的 planning policy 对照，或让 Builder 自主选更小的明确 pass。

### 2026-08-19 真实 agent-loop 延迟 prepare oracle：基础工具合同补齐，模型收敛未证实

- `eval/run-builder-real-agent-loop.mjs` 现在在每个 Builder workspace 物化 pinned DSH archive、隔离依赖并注入真实 package regression；baseline 稳定失败为 `parallel-safe prepares were serialized`，目标是 `packages/core/agent-loop/src/tool-calls.ts`，不是 fixture 候选。
- Builder Kernel 补齐 host-assigned validated run id、workspace-relative read/list（绝对路径仍全局 read）、含解析地址的失败反馈，以及 `apply_workspace_patch`（unified diff → `git apply --check` → apply → snapshot）。这解决源码坐标分裂、相对路径误解析和大文件只能覆写三类确定性缺口，不改变 verifier/gate 权限边界。
- 官方 V4 Flash 最新 fresh run `builder-1787101206741-969c8d44` 仍为 30 turns/30 tools abort：已复现真实失败、读真实 workspace 源码并形成正确 hypothesis，但没有调用 patch/edit、没有 proposal、没有 verifier/gate/install。不能宣称真实 loop 性能提升。
- 当前验证：**179/179**、`npm run check`、`npm run build`、`git diff --check` 通过。完整记录在 `docs/research/run-log.md` 的 `real-agent-loop-delayed-prepare-builder-observation`。
- 下一步：不继续堆 prompt/checkpoint；对照可选成熟 coding-agent adapter 的 action/runtime policy，再评估其在同一 oracle 上的 edit→tests→proposal 收敛率。只有 Builder 自主产出正式 candidate 后才进入 C0–C8/C6、cold gate、rollback 与 2/4/8/16 负载性能验收。

### 2026-08-19 通用溯因导航底座 + 成品 Agent 上游选型

- 不再把 oracle/verifier error 仅作为 prompt 文本回灌。每个 Builder run 新增 `state/provenance.json`：确定性记录 actor/target-before、rejection、prior run/assets、candidate、submission 与 manifest 的 artifact ID/hash/path/producer-consumer-test-report 关系；读取/检查源码时追加 source artifact。详见 `docs/artifact-provenance-navigation-spec.md`。
- 新增开放只读工具：`trace_artifact {artifact}`、`inspect_file {path}`、`search_text {query,roots?,maxResults?}`、`read_input(provenance)`。它们只给关系、接口和检索事实，不生成修复建议；Builder 仍自由决定读/改/仿真/提问/提交/abort，verifier/gate/install 权限没有变化。
- compact prompt 只带 provenance 入口、artifact 数量及当前 failure/candidate ID，完整图按需读；短上下文回归仍低于原 5KB 测试阈值。
- 成品 agent 参考已核：Prime Agent `97b994c3d7c45ca1ae635190e91e9e58ddf2577c`（MIT）是比 Tycho 更合适的开放 Builder runtime 参照；其持久 IPython、host-owned state 和工具语义将以可选 adapter 接入，而不直接嵌入完整 CLI/30+ 依赖或改变 Loom 的独立 verifier/gate。尝试浅拉 OpenHands 官方仓库时 HTTPS 传输持续卡住，已终止临时 clone，未写入仓库。
- 新增 Kernel/Driver 确定性覆盖：rejection→candidate factual trace、接口 inspect、全局文本 search、compact schema；全量 **172/172**、check/build/diff-check 通过。尚未跑官方 V4 Flash 的 graph-only repair 对照，故不声称模型修复收敛已改善。

### 2026-08-19 V4 Flash provenance-assisted oracle repair 复测

- 直接复测（未先跑新的对照）：3 个独立 fresh immutable repair pass；每次均先写入真实失败 candidate、运行 oracle 取得 `TypeError: run is not a function`，再经 `reopenFromRejection` 生成含 failure→candidate、oracle→tests→candidate 的 provenance 图。唯一新增变量为 `trace_artifact`/`inspect_file`/`search_text`/`read_input(provenance)`；其余维持 compact、20 model turns/40 tools/2400 tokens、thinking disabled、repeat-read guard/checkpoint。
- 记录：`/chenzute/dsh-src/eval/run-records/2026-08-19-builder-oracle-rejection-provenance-convergence-rate-official.json`。严格成功条件保持：新 candidate、oracle `strict-order-pass`、`write_submission → submit`。
- 结果 **0/3（0%）**。三次都实际读取了 `provenance`（2/3 首轮读取），prompt-visible 也确认 graph/failure ID 已送达；但没有一次调用 `trace_artifact`、`inspect_file`、`search_text`、workspace edit、oracle command 或 submit。动作退化为 `read_input(provenance|actor|context_index) → write_world_model`，20 turns 后 abort。
- 严格结论：图谱的可见性/持久化/工具可用性已证实，但“模型会主动把图谱转为查询操作”没有证实，且本 case 未改善 repair 收敛。下一步不应把结果包装成提升；需要审计为什么 `read_input(provenance)` 的完整图未能触发 edge traversal，再决定 runtime/tool surface 是否要转向成熟 agent adapter，而不是继续堆文本提示。

### 2026-08-19 builder 0/3 根因：模型从未看见失败原文（已修复，待 A/B）

- 审计结论：compact prompt 只有图谱指针与 hash，`candidate.run is not a function` 原文只藏在 previous-attempt.json；三次 run 均未读 previous_attempt、未 trace，模型从未看到问题文本，动作退化为 read_input→同一 hash 的 write_world_model。
- 修复：compact prompt 注入 rejection facts（failureSummary/previousCandidatePath/oraclePath + "fix the artifact → run oracle → submit"），新增单测；**173/173**。
- 待办：同一 fixture 单跑 V4 Flash fresh repair pass 对照，确认"问题可见"是否改善收敛。

### 2026-08-19 rejection-repair 复测：0/3 → 33%（1/3）

- 四个根因逐层修复后收敛：① 失败事实直灌 prompt（0/3）；② prior-run 绝对路径→当前 workspace 映射（0/3，但能写出候选）；③ `workspace/` 前缀归一化（0/3，2/3 oracle 通过）；④ submit 缺 draft 的报错回显 journal（**1/3 完整闭环**：修复导出→oracle strict-order-pass→write_submission→submit）。
- 剩余：成功信号后模型仍可能继续编辑并覆盖好候选（attempt 3），提交纪律不稳；不宣称已解决。
- 记录与代码：run-records 5 份 + `src/builder/{kernel,driver}.ts` 修复；测试 **177/177**。

### 2026-08-19 成功 marker 的终态保护（确定性通过；官方复测不可归因）

- `successMarker` 命中后，Driver 将该 bounded pass 视为已验证终态：只接受 `write_submission`、`submit` 或 `abort`。任何继续读/写/命令/continue 都被拒绝并写入 journal；若确需新实验，必须由外层创建 fresh immutable run。该限制只发生在目标声明的成功条件已满足后，不改变正常自由探索。
- 新增确定性回归覆盖“oracle 成功 → 模型尝试覆盖候选 → Kernel 拒绝 → write_submission → submit”，全量 **178/178**、check/build/diff-check 通过。
- 追加的官方 3-pass 记录 `2026-08-19-builder-oracle-rejection-completion-guard-convergence-rate-official.json` 为 **不可归因观察**：三次均未在 Builder 内部触发 `strict-order-pass` 后再编辑（第 3 次仅外部 post-check 碰巧通过，Builder 未执行 oracle），故 Guard 从未进入其前提；结果不能解释为 Guard 无效或收敛回归，已停止继续烧 token。

### 2026-08-18 23:15 短上下文 + 无进展跳转 + 用户中途指导闭环实验

- 本轮确定性收缩：compact prompt 保留 durable progress/index、pending 原话和**最近一条压缩真实工具反馈**（上限 1.2KB），不恢复全量 journal/snapshot；无进展断路器在声明一次 `world_model/plan` 后立即恢复自由探索，不再强制下一种工具。
- 另修复三项窄协议问题：兼容 `action.input`/`action.params` 等价包装；解析首个完整 JSON 决策以容忍供应商多余尾 `}`；`run_workspace_command` 的 `args` 可省略（默认为空数组）。`npm test` **169/169**、`npm run check`、`npm run build`、`git diff --check` 全绿。
- 官方 V4 Flash 实验记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-short-context-progress-checkpoint-closed-loop-official.json`；同一明确目标、`compactPrompt=true`、`repeatReadRejectAfter=2`、`enforceProgressCheckpoints=true`、thinking disabled。
- 初始 bounded run 6 回合：断路器触发后 Builder 写出 plan，但仍未候选；预算结束后按真实 immutable 协议创建新 run。用户原话指导“停止重复读取，直接写候选并运行 oracle”被原样写入新 run。
- 第二 run 真实写出 workspace candidate，但 oracle 报 `run is not a function`；这证明用户指导能把动作从重复读取推进到候选编辑，但尚未提交。
- oracle 失败作为 rejection feedback 回注尝试重开第三 run；该 run 再次在目录探索中耗尽预算，未修复、未 proposal、未进入 verifier/gate/install。
- 结论等级：**short-context-observation-and-user-retrigger-proof / candidate-edit-observed / oracle-repair-and-submission-failed**。不能宣称 Builder 已完成闭环或 loop 性能提升；compact context 与断路器只改善可观测停滞处理，不保证语义收敛。
- 当前不再增加 prompt/phase 补丁。下一步若继续，应把 candidate entry/export contract 作为 evidence pack 的明确事实，并单独评估“oracle rejection → fresh pass 修复”收敛率；verifier/gate 仍保持独立裁决。

### 2026-08-18 23:25 oracle rejection → fresh pass 修复收敛率

- 独立实验记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-oracle-rejection-fresh-pass-convergence-rate-official.json`。
- 设计：3 个独立 fresh immutable repair runs；每个都预置同一真实失败 `TypeError: run is not a function`，回注 `previous_attempt`/`previous_run`，`compactPrompt=true`，断路器开启，预算 20 model turns / 40 tool steps / 2400 maxTokens。
- 成功定义：fresh run 写出新候选、oracle exit 0 且输出 `strict-order-pass`，并完成 `write_submission → submit`。verifier/gate/install 不计入本指标。
- 结果：**0/3，收敛率 0%**。三次均未写候选、未运行 oracle、未 proposal；分别触发 5、4、4 次 unchanged-read rejection 后，仍在 `previous_attempt`/`actor`/错误路径间循环至 20 回合预算耗尽。
- 诊断：问题不是回合数不足，而是 Builder 没有把 `run is not a function` 转成“读取旧候选 → 修复导出 → oracle”动作链；断路器只迫使它重复写 world-model/plan，不能让它采用 rejection 的语义修复。
- 结论等级：**oracle-rejection-fresh-pass-convergence-rate = 0/3 (0%)**。当前不能宣称 rejection 回注已具备修复收敛性；不要继续通过增加回合数掩盖动作策略问题。

### 2026-08-18 23:46 V4 Flash thinking-enabled 单次复验

- 为区分“模型无推理预算”与“agent 工具策略”问题，`officialDeepSeekLlm` 新增显式 `thinking: 'enabled' | 'disabled'` 选项；默认仍为 disabled，只有本次隔离评测开启。reasoning chunk 不写入 journal 或用户可见状态，Driver 仍只消费最终 JSON content。
- 同一 fresh oracle-rejection repair 任务、20 turns/40 tools，输出预算提高至 4800；记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-oracle-rejection-fresh-pass-thinking-enabled-official.json`。
- 结果：**0/1**。thinking-enabled Builder 读取 context-index 并尝试 workspace command，但把 `find . -maxdepth 3 -type f | sort` 当作单一 executable（`spawnSync ... EACCES`），随后回到 index/world-model 循环；未写 candidate、未重跑 oracle、未提交。
- 结论：thinking 不是这条链路的充分修复。V4 Flash 对简单代码 bug 未被证明能力不足；这次证明当前 tool representation、previous-candidate 定位和 repair-action policy 仍让它无法把 rejection 转成编辑动作。当前全量 **170/170**、check/build/diff-check 均通过。

### 2026-08-18 diagnosis-first 已实装并完成官方对照审计

- Builder run 新增 `diagnosis | implementation`；开放 loop 请求在 `allowLoopCandidates.diagnosisFirst=true`（默认）时先进入 diagnosis。diagnosis 只允许落 `diagnosis-report.json`（1–3 个 evidence-backed directions + blocking question），随后 `waiting_for_input`；它不能 proposal/submit。Actor 可通过 `meta_builder_status` 查看报告，转交用户原话后 resume 生成同 lineage、带 previousRun 资产的新 immutable implementation run。
- 新增确定性端到端测试覆盖报告结构、诊断禁止提交、模式专属完成合同、status 投影、用户选择→新 implementation run→proposal freeze；当前全量 **162/162**，`npm run check`、`npm run build`、`git diff --check` 均通过。
- 官方 V4 Flash 低预算 A/B（同一错误 loop、同 6 turn/8 tool/1200 token 上限、thinking disabled）：修正前 prompt 内同时有 diagnosis report 与 write_submission→submit 两个冲突完成定义，结果 6 turns、5 read（3 unchanged）、无报告、abort；修正为模式专属合同后，4 turns：ack→读 requirements→读 source→写 diagnosis report，0 unchanged read，`waiting_for_input`。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-diagnosis-first-prompt-contract-ab.json`。
- 严格结论：已证明 **方向诊断/用户对齐改善**，尚未证明选择后的 implementation 收敛、proposal、verifier/gate、安装或 loop 性能提升。下一步：用上述 report 的用户选择（建议 `task-success`）运行一次独立 implementation pass，再按 proposal→裁决→gate/replay 的既有链路评估。

### 2026-08-18 compact prompt / context index 快速试验（默认未开启）

- `BuilderKernel` 新增 `state/context-index.json`，提供所有 durable input/state/workspace 的地址与概述；`read_input(context_index)` 可按需展开。`BuilderDriver.compactPrompt` 仅给流转/通讯/权限、最小 JSON protocol、index 入口、pending 原话、progress 和 feedback hash，不再默认灌入完整索引/长示例/任务正文。
- 官方 V4 Flash 同一模糊取舍任务实测 prompt **3.4–3.8KB**（此前约 12–13KB），但 7 turns 仍未主动 `request_input`，而是重复读 actor snapshot 后 budget abort。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-minimal-user-guided-ambiguity-to-implementation-official.json`。
- 所以只确认“上下文足迹显著降低、compact JSON wrapper 已兼容”，**不**确认 Builder 自主通讯/任务收敛改善；该选项保持实验性、默认关闭。当前确定性测试 **166/166**，`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-18 多系统 Builder 循环审阅（只读）

- 已对照 Tycho、Prime Agent、OpenHands SDK、SWE-agent、LangGraph 与 AutoGen，学习文档见 `docs/research/builder-loop-patterns-comparison.md`；本次未改运行时代码、未跑模型、未触碰生产/profile。
- 统一结论：Prime 的持久 kernel 解决连续性但不保证收敛；OpenHands 的窗口化 stuck detection 适合作为 Driver/Controller 诊断；SWE-agent/Tycho 都把“再试”放到有硬预算的独立 attempt/pass 和外部 reviewer/verifier；LangGraph/AutoGen 的图状态主要适合 checkpoint、interrupt、恢复及权限边界，而不应替 Builder 决定认知路线。
- 下一结构实验应是 `evidence-diagnosis → bounded pass → fresh report → external re-trigger`，而不是继续扩张 Kernel phase 或把某个工具设为必经节点；实验前保持当前断路器默认关闭。

### 2026-08-18 pass diagnosis 规格补充

- 在 `docs/builder-evolution-flow-spec.md` 新增 `evidence-diagnosis` 定义：问题列表可以有多个观察项，但每个 pass 只冻结一个 `primaryObjective`，并绑定 symptom、firstDivergence、evidenceRefs、successCriteria、nonGoals、unknowns、预算和出口。
- “loop 更智能”不再作为直接验收词；应先按真实证据拆成收敛、任务成功、延迟/成本或可用性 pass。若无法从证据推出优先级，Builder 发起带选项和证据的 choice，由 Actor/用户选择后创建新 immutable pass。
- Pass 采用“固定外壳、可维护内核”：Controller/Actor/Verifier 固定 lineage、scope、baseline、预算、权限、required artifacts、verifier/gate/replay 和硬约束；Builder 可版本化维护 hypothesis、known/unknowns、evidence、nextIntent 和实验计划。若改变 target、优先级或验收标准，必须提交 `diagnosis_revision`，由 Controller 保持、询问或创建新 immutable pass，不能静默换题。
- 新增 diagnosis-first 方向：开放目标先运行短诊断/对齐 pass，产出 1–3 个有证据的优化方向和未知项；无法从事实推出优先级时向用户发起 choice/clarification。用户选择后创建新的 immutable implementation pass；连续澄清设小上限，避免无限追问。已有明确可验收目标时仅记录 diagnosis-report，不重复询问。

### 2026-08-18 21:10 无进展断路器与官方复跑

- 新增默认关闭的 `enforceProgressCheckpoints`：连续 unchanged read 被拒后，Builder 必须先公开 `world_model.hypothesis + nextIntent`/plan，再产生 simulation、workspace 命令/编辑、提问或提交；要求、错误与下一意图均落盘到 `progress-state.json`、journal、prompt-visible。默认 `repeatReadRejectAfter=0`、`enforceProgressCheckpoints=false`，不缩小正常自由探索。
- 配置入口已接入 `allowLoopCandidates.repeatReadRejectAfter` 与 `allowLoopCandidates.enforceProgressCheckpoints`；`npm test` **159/159**、`npm run check`、`npm run build`、`git diff --check` 通过。
- 官方 V4 Flash 低预算 A（12 回合）从重复 read 推进到 `write_world_model → baseline simulation → candidate simulation`，但仿真因无候选文件失败而预算中止；B（18 回合）重复进入 3 次 world model + 3 次 simulation，仍未 workspace edit/submission，预算中止。记录见 `docs/research/run-log.md` 与两个 `run-records/2026-08-18-builder-progress-checkpoint-real-run*.json`。
- 结论：节点式确定性约束能消除纯 read 死循环并推进“状态→仿真”，但不能保证模型做出有价值候选。当前瓶颈从工具调用死循环转为低价值仿真/候选关联与提交收敛，不能宣称真实演进或性能提升。

### 2026-08-18 Tycho Builder 源码对照

- 已核查 Tycho `WorldModelBuilder`、`wm_signal`、`dispatcher`、工具执行器与 Builder prompt。Tycho 不靠重复读取拒绝或多级 phase；它依靠单一可证伪目标、启动前自动 verifier diagnosis、语义编辑后即时反馈、bounded pass/fresh report，以及外部 divergence 才重启下一 pass。
- 迁移方向：Loom 下一步应验证 `evidence-diagnosis → bounded pass → fresh builder report → external re-trigger`，而不是继续堆 Kernel 节点。当前二级断路器保留为默认关闭保险丝，三级扩展已撤回；对照记录见 `docs/research/tycho-builder-comparison.md`。

### 2026-08-18 20:15 Compact progress state 落地与官方复跑

- 每个 Builder run 新增公开、可审计的 `state/progress-state.json`：`state`、`phase`、`objective`、`hypothesis`、`known`、`unknowns`、`nextIntent`、`lastAction`、`lastObservationHash`、`unchangedReadStreak`、`pendingMessageIds`。Kernel 在状态迁移、工具反馈、Actor 消息、world-model/plan、提交/回滚边界自动维护；Builder 只能通过公开状态工具声明假设和下一意图，不记录隐藏思维链。
- `read_input` 新增 `progress_state`；Driver 每轮注入 compact state、少量 journal tail 和 hash/入口，不再默认灌入完整 actor/target/journal；`prompt-visible.jsonl` 额外绑定 `progressStateVersion/hash`。`meta_builder_status` 投影 progress state，Actor 可见当前方向与停滞信号。
- 确定性验证：`npm run check`、`npm test`（**158/158**）、`npm run build` 通过；新增 Kernel/Driver 状态恢复测试。
- 官方 V4 Flash 同任务低成本复跑记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-progress-state-real-run.json`。18/18 model turns 仍选择 `read_file`，其中 16 次反馈 `newInformation=false`；无 world-model/plan、simulation、submission，最终预算中止。prompt 平均约 11.6KB（此前审计约 12.9KB），说明上下文确实收缩且状态表被审计，但仅注入 compact state 尚未改变模型 action policy。
- 结论：状态表解决了“每轮恢复记忆依赖全量回放”的结构问题，但不宣称已解决收敛；下一实验应将 `unchangedReadStreak` 与一次性 progress artifact/负向无进展反馈做受控 A/B，再观察是否能进入 simulation→submit，不能直接把本轮算作性能提升。

### 2026-08-18 18:35 Builder flow guards 实装与真机观察

- `BuilderRunRecord` 新增可观察 `phase`（observing/hypothesizing/simulation/exploring/waiting/ready/submitted 等）；phase 只记录证据生产里程碑，不构成探索白名单，旧 run 可兼容读取。
- Kernel 已接入最小负向约束：`choice` 请求至少两个唯一选项、`whyNow` 与 evidenceRefs；`verification` 请求必须提供 `whyNow` 与 evidenceRefs；非法请求 fail-closed 并把错误反馈留在 journal，正常探索路径不受限制。
- 新增 Kernel 测试覆盖非法请求与 phase，当前 `npm test` **154/154**（本轮单测）/ 全量基线其余均绿，`npm run check`、`npm run build`、`git diff --check` 通过。
- 官方 V4 Flash 仿真 Builder 复跑记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-phase-guard-real-run.json`。18 model turns/18 tool steps 仍重复读取 requirements/actor source，未写 world-model、未调用 simulation、未提交；最终预算中止。结论：phase/evidence guards 已确定性生效，但不能替模型形成方向；当前智能化瓶颈仍是开放任务的策略收敛，需要下一轮 Actor choice/clarification 或更明确的可验证目标实验，不能宣称 Builder 已完成演进。

### 2026-08-18 18:45 Builder 方向缺失自识别实验

- 无提示式缺证据案例：Builder 在 1 model turn 内自行 abort，理由为“无源码、无 oracle、无用户偏好，无法安全提交改进候选”。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-direction-awareness-no-explicit-ask.json`。这证明它能识别信息/方向不足，但当时选择放弃，没有主动请求 Actor。
- 有源码、可仿真但产品取舍冲突案例：在没有直接命令“请提问”的前提下，Builder 读取源码和 requirements 后第 3 回合主动发出 `request_input(kind=choice)`，提出“优先吞吐还是优先严格顺序”，带 `whyNow`、`evidenceRefs`、`blocking=true`，进入 `waiting_for_actor`。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-direction-choice-no-explicit-ask.json`。
- 结论：Builder 已具备“知道方向不足”的能力；是否把缺口转成 Actor 通讯取决于任务是否仍有可探索证据。当前最小闭环已经成立：识别缺口 → 结构化 choice → Actor 转交用户 → resume。尚未做用户选择后的第二 run、仿真和提交。

### 2026-08-18 19:00 choice→resume 后续验证

- 真实两阶段记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-direction-choice-resume-e2e.json`。
- 第一 run：3 turns/3 tools，自主发出 choice，进入 `waiting_for_actor`。
- Actor 原样转交用户原话“优先吞吐，但不得牺牲安全契约”，并携带 `selectedOption=throughput`；第二 run 为新 immutable run，`previousRun` 带旧 workspace/journal/assets hash。Builder 首轮 `message_ack` 正确理解为“throughput-first while preserving safety contract”。通讯、选择保真、跨 run 继承均通过。
- 第二 run：8 turns/8 tools；重复读取已知 source/requirements，执行一次无关 `probe`，没有 `write_world_model`/`write_plan`/`invoke_capability(workspace-simulation)`/`write_submission`，最终预算中止。故本次不能证明 hypothesis/nextIntent 改变、仿真或提交成功；结论为 **choice-delivery-and-resume-proof / post-choice-convergence-failed**。

### 2026-08-18 19:20 prompt-visible 审计

- 新增 `state/prompt-visible.jsonl`：每回合保存脱敏后的实际 prompt、原始 hash/bytes、run state/phase、上一工具反馈 hash、pending message ids；不保存隐藏思维链。`previousRun` 资产清单也继承该证据文件。
- 真实复跑记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-prompt-visible-audit.json`；prompt 从 9,641 bytes 增长到约 13,307 bytes。Builder 第一轮已经看到错误 actor source 和 requirements，后续 prompt 明确包含 `observation.newInformation=false`、`unchangedSinceSeq`、完成定义“形成 hypothesis→simulation→submit”以及工具错误反馈。
- 但 18 回合中 requirements 被读取 14 次、actor source 4 次；重复 read 的 prompt 仍包含上一反馈和“不要重复读取”提示。说明不是输入不可见，而是模型在看到完整事实和无新增反馈后仍选择 read_file；当前最可能是模型 action policy/上下文注意力偏置，而非 evidence pack 缺失。

### 2026-08-18 19:35 progress banner vs Kernel reject A/B

- 新增实验开关：`BuilderDriver.progressBanner`（仅文本提示）与 `BuilderKernelOptions.repeatReadRejectAfter`（确定性拒绝 unchanged read；默认关闭，保持自由探索兼容）。新增测试后全量 **156/156**。
- 同一任务、同模型、同回合预算真实 A/B 记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-progress-ab-comparison.json`。
- A banner-only：10 turns/10 tools，4 次 source/requirements 读取（2 次 unchanged），0 simulation；产生 2 次 proposal draft，但未最终 submit，预算 abort。
- B Kernel reject（阈值 2）：10 turns/10 tools，4 次读取（2 次 unchanged）；重复 `read_workspace_file` 被 Kernel 明确拒绝后，Builder 转向 `write_workspace_file`/读取候选 workspace，未 simulation/submission，仍预算 abort。
- 结论：文本 banner 有一定帮助但不能强制切换；Kernel reject 能改变动作分布（从重复读取转向 workspace 写入），但单独仍不足以保证 simulation→submit。需要下一轮把 reject 后的错误反馈与最小 progress artifact/phase 绑定，再比较是否真正提高提交率。

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

### 2026-08-18 16:50 仿真能力与 Builder 复测

- `src/builder/capabilities.ts` 新增 runtime registry；`BuilderKernel` 只负责 capability tool dispatch、journal 和权限边界，`loop-evolution` 与 `workspace-simulation` 均以 capability 注入。
- `src/builder/simulation.ts` 新增共享 `SimulationRunner`：固定 workspace、fixture hash、命令反馈、reset-safe 文件边界、simulation report 和 `compareSimulationToReal`。仿真结果只有 `passed/failed/inconclusive`，不能直接变成 verifier approval。
- 结构化 `request_input` 现在支持 `clarification | choice | verification`、options、whyNow、evidenceRefs、blocking；Actor 可把 Builder 的方向问题交给用户，再以原话恢复新 immutable run。
- 仿真/隔离真实对照记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-workspace-simulation-real-consistency.json`。同一 actor contract 的 3 个案例 exit/stdout/stderr 完全一致，claimLevel 仅为 **mechanism-consistent**，不代表 DSH live loop 高保真。
- 重新运行官方 V4 Flash Builder（18 turns/36 tool budget，已注册 workspace-simulation）仍在 18 turns 内重复读取 requirements/source，未调用 simulation、未写 submission、未进入 verifier/gate；记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-simulation-capability-real-run.json`。结论：工具环境已能提供仿真入口，但开放任务仍缺方向收敛；下一步是用真实 `choice/clarification` 进行 Actor→用户→Builder 多轮指导实验。
- 官方 Builder 的最小不可判定选择实验已在 1 turn 进入 `waiting_for_input` 并发出 `needs_input(kind=choice)`，记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-official-clarification-request.json`。它证明真实模型可触发协议；该次 options 沿用 prompt 示例，尚不证明模型能根据证据生成高质量问题。下一实验必须让 Actor 回传用户选择、resume 新 immutable run，并检验该选择是否实际改变 Builder 路线。
- 对 `builder-simulation-capability-real-run` 完整 journal 的复核：18/18 tool steps 全是外部 `requirements.json`（15 次）或错误 actor source（3 次）`read_file`；没有 `read_input(world_model|plan|journal|previous_attempt)`、`write_plan`、`write_world_model`、`write_workspace_file`、`run_workspace_command`、`invoke_capability` 或 `request_input`。Builder 收到 immutable context 但没有形成可观察的世界模型/计划；当前行为更像“重复寻找下一段文本”而非 Tycho 式持续建模。`BuilderDriver` 已新增 prompt/context fingerprint journal（不记录思维链），下一次可区分模型看到了什么与它实际选择了什么。
- 上层使命 prompt、`newInformation=false/unchangedSinceSeq` 重复读取反馈接入后复跑，结果仍为 18 turns/18 reads/无 simulation/无 submission。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-mission-unchanged-feedback-rerun.json`。Builder 实际看到了“没有新增信息”但仍未改变策略，说明仅靠自然语言使命和提示性反馈不能保证收敛；下一步需要 Actor 澄清或确定性 progress transition，而不是继续堆 prompt 文案。
- 已冻结流程设计基线：`docs/builder-evolution-flow-spec.md`。采用 Prompt policy + Kernel phase/evidence guards + Capability runtime：默认事实→假设→基线仿真→候选仿真→提交→verifier→gate→replay；方向选择和真实验证请求是条件节点，不是每次固化必走。深度思考以公开 hypothesis/known/unknown/evidence/nextIntent artifact 定义，不记录隐藏思维链。

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

### 2026-08-19 Builder 自主稳定性复测（5 fresh passes）

- 记录：`/chenzute/dsh-src/eval/run-records/2026-08-19-builder-autonomous-stability-5pass-official.json`。
- 配置：V4 Flash、thinking disabled、compact prompt、每次 20 model turns / 40 tools / 2400 tokens，5 个独立 immutable repair pass。
- 严格成功定义：候选通过 oracle，并完成 `write_submission → submit`。结果 **0/5**；其中 **4/5（80%）** 写出了 oracle 通过的候选，但 **0/5** 生成 proposal draft、**0/5** submit，最终均因回合耗尽 abort。
- 诊断：成功 marker 已将 Kernel 置为 `ready_to_submit`，但模型随后直接尝试 `submit`（缺少 draft），没有先调用 `write_submission`；缺失 draft 的拒绝已回写 journal，但本轮仍未收敛。当前瓶颈是“候选修复成功后的 proposal 交付协议”，不是基本代码修复能力。
- 下一步应先做零模型的 `ready_to_submit → write_submission → submit` 确定性回归，再以单次低预算官方 run 验证交付率；暂不宣称 Builder 自主闭环稳定，也不继续增加无关 prompt/agent 框架。

### 2026-08-19 Builder 自主稳定性修复后复测（5/5）

- 修复两处交付/证据收敛缺口：① compact prompt 提供 loop proposal 的最小合法 envelope；submit 缺 draft 后，Kernel 持久化 `write_submission` obligation，下一回合不得再次 submit；② 成功配置下写入候选后，Kernel 要求下一步产生新证据（oracle/simulation/verification），避免编辑后无测试耗尽回合。
- 确定性回归仍为 **178/178**，`npm run check`、`npm run build`、`git diff --check` 全绿。
- 官方 V4 Flash、5 个 fresh immutable pass、每次 20 model turns / 40 tools / 2400 tokens：**5/5（100%）** 完成 `rejection → candidate edit → oracle strict-order-pass → proposal → submit`。记录：`/chenzute/dsh-src/eval/run-records/2026-08-19-builder-oracle-rejection-provenance-convergence-rate-official.json`；本轮每个 pass 均 `edited=true, oracleCommand=true, submitted=true`。
- 结论边界：证明的是 oracle-repair→proposal 交付稳定，不等于 verifier/gate/install/replay 或性能提升已证明；下一步可把同一 5/5 候选交给独立 verifier/gate 做完整冷链路复测。

### 2026-08-19 Builder 验收测试矩阵

- 新增 `docs/research/builder-acceptance-test-matrix.md`，将 A（自主修复交付）、B（独立 verifier/gate/install/rollback）、C（性能归因）分组，明确每组的证据与宣称门槛。
- 现有 B 组真实证据仍有效：C0–C8/C6 全绿、gate installed、before/after 与 Actor replay admissible=true；但 installed replay 为 baseline 的 **1.52× slower**，不能宣称性能提升。
- 现有 C 组并发安全对照同样未达门槛：候选 2024ms、原版 1017ms（1.99× slower），错误帧均为 0。下一步必须由 Builder 产出真正改变调度策略的候选，再按矩阵 C1–C3 重跑。
- 首次真实 C 组 Builder 试验（性能目标：独立 concurrency-safe 工具降时 ≥20%，保持顺序/错误传播）未收敛：20 回合、14 工具调用均停留在重复读取 requirements，未编辑候选、未运行 oracle、未提交，因此没有进入 verifier/gate/install，也没有性能结论。该失败说明性能目标虽已明确，但当前 Builder 仍缺少可操作的调度基座/入口定位；不应通过继续堆提示词把它包装成性能提升。
- 修复“已有 hypothesis 后重复读取仍回到 declare_direction”后，官方性能 rejection-repair 5-pass 复测为 **2/5（40%）**：3 次编辑并运行 oracle，但未完成 proposal/submit；2 次完整提交。记录：`/chenzute/dsh-src/eval/run-records/2026-08-19-builder-performance-repair-checkpoint-5pass-official.json`。性能 repair 尚未稳定，暂不进入 gate/install 性能宣称。
- 补齐性能候选入口契约后，30 回合官方 5-pass 复测为 **3/5（60%）**：成功样本均通过 `candidate.run(tools)`、约 251ms overlap oracle，并完成 proposal/submit；失败样本仍为候选质量或交付收敛波动。记录：`/chenzute/dsh-src/eval/run-records/2026-08-19-builder-performance-repair-export-contract-30turn-5pass-official.json`。契约已写入 `docs/research/builder-acceptance-test-matrix.md`，尚未达到进入 gate/install 的稳定性门槛。
- 继续审计发现第二个入口事实缺失：oracle 的 `tools[i]` 是可直接调用的 async 函数，`isConcurrencySafe` 是函数属性；部分候选错误调用 `tool.run()`。补齐任务契约后，官方 30 回合 3-pass 为 **3/3（100%）**，全部完成编辑、性能 oracle、proposal、submit。记录：`/chenzute/dsh-src/eval/run-records/2026-08-19-builder-performance-tool-interface-3pass-official.json`。下一步才可把这批候选送入独立 verifier/gate；尚未宣称真实性能提升。
- 新增 `docs/research/real-agent-loop-performance-task.md`，将下一轮目标收束到真实 `packages/core/agent-loop/src/tool-calls.ts`，明确入口、调度语义、回归边界与 2/4/8/16 负载门槛。fixture 3/3 只作为算法可行性证据，不能替代正式 package candidate。
- 正式源码预检完成：Loom **178/178**、check/build/diff-check 全绿；真实 `agent-loop/src/tool-calls.ts` 当前已具备 parallel group、bounded pool、model-order commit、exclusive barrier、abort/failure drain 语义。尚未生成真实源码 Builder candidate，因此没有虚构 gate/performance 结论；下一步需让 Builder 提交基于该文件的 package-level edits，再运行正式契约与冷安装。

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
