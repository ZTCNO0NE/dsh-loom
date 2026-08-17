# 运行记录（Run Log）

规则：**每次基准/评测/验收运行都必须在本文件追加一条记录**，并在 `/chenzute/dsh-src/eval/run-records/` 存结果快照。缺任何一项都视为未记录。

## 条目模板

```markdown
### YYYY-MM-DD <运行名>

- 基准/任务集：<名称 + 版本/commit>
- 任务切片：<任务列表>
- Agent/模型：<agent 名> + <model id>，端点 <base_url>
- 配置：<config 文件路径>；n_attempts / 超时 / 并发
- 结果：<PASS/FAIL 列表、reward、通过率>
- 指标：耗时、input/output tokens、cost（如有）
- 产物路径：<jobs 目录 / run-records 快照>
- 本地补丁/偏差：<改了哪些官方内容，影响口径与否>
- 结论与下一步：<一句话结论 + 后续动作>
```

## 记录

### 2026-08-16 tb21-local27b-smoke（首次冒烟）

- 基准/任务集：Terminal-Bench 2.1（harbor-framework/terminal-bench-2-1，commit `7131e43`）
- 任务切片：`fix-git`、`overfull-hbox`（均为 easy）
- Agent/模型：Harbor `qwen-coder` + `qwen/qwen3.6-27b`，端点 `http://124.221.77.140:4000/v1`
- 配置：`/chenzute/dsh-src/eval/tb21-local27b-smoke.yaml`；n_attempts=1，并发 1，agent setup 超时 ×2
- 结果：fix-git **PASS（1.0）**；overfull-hbox **FAIL（0.0，AgentTimeoutError）**；通过率 1/2（50%）
- 指标：25m21s；input 752,861 / output 15,581 tokens；cost 未计
- 产物路径：`/chenzute/dsh-src/eval/jobs/tb21-local27b-smoke/`；快照 `run-records/2026-08-16-tb21-local27b-smoke-result.json`
- 本地补丁/偏差：Harbor qwen_code.py（跳过 nvm，npmmirror 装 Node22，npm --prefix /usr/local）；任务 test.sh（pip 替代 uv，Python 3.11/镜像自带版本替代 3.13）；镜像经 dockerproxy 拉取。**非官方口径**。
- 结论与下一步：管线打通（Harbor→容器→27b→验证器）。下一步 L3 知识消化；overfull 可用更长 agent 预算复测；官方口径需先解决容器 GitHub/Docker Hub 出口。

### 2026-08-16 dsh-baseline-smoke（原生 dsh + 27b 自建冒烟集基线）

- 基准/任务集：自建冒烟集（`/chenzute/dsh-src/eval/baseline/tasks.json`，5 任务：file-write/bash-math/git-status-file/file-edit/capital）
- Agent/模型：dsh headless（`--profile headless --patch overlay-local-27b.yml`）+ `qwen/qwen3.6-27b`，端点 `http://124.221.77.140:4000/v1`
- 配置：overlay-local-27b.yml；每任务 timeout 600s；外部断言判定
- 结果：**5/5 PASS（100%）**
- 指标：5 任务全部外部断言通过；逐任务输出见 `baseline/results/`（token 未单独统计）
- 产物路径：`/chenzute/dsh-src/eval/baseline/results/summary.json`
- 本地补丁/偏差：无（原生 dsh；bash 工具可用；git-status 输出反映 terminal-bench 本地 test.sh 补丁属预期）
- 结论与下一步：作为插件效果对照的**基线锚点**（插件开/关对比的 off 侧）；M3 效果验收 B1/B2 直接对表此基线。

### 2026-08-16 b1-observed（B1 真实事件观测 + 真实数据回环）

- 基准/任务集：B1 自建失败场景——fs write 到 /etc/hosts（沙箱拒绝）连续 3 次
- Agent/模型：dsh headless + `qwen/qwen3.6-27b`；插件 observe 模式
- 配置：`overlay-mv-b1.yml`（fs-sandbox workspace-write；独立 session b1-observe）
- 结果：
  - **真实事件捕获成功**：`tools/result` emit（isError=true）→ 3 条 tool-error 落盘 `b1-observe/trajectory/events.jsonl`；
  - 硬触发命中：`repeated_failure >= 3`；
  - 真实 27b builder 产出候选（tool-fs sandbox → sandbox_permissions，selfCheck 0.85/0.8）；
  - verifier 对齐真实帧 → **rejected（first_divergence@0：预期 turn/start vs 实际 tool/result）**，正确触发回炉。
- 产物：`meta-workspace/workspace/b1-observe/events.jsonl`、`b1-iterate/patches/<id>/report.json`
- 结论：真实链路（tools/result → observer → 硬触发 → builder → verifier → 回炉）全通；下一步：让 builder 预期轨迹与真实帧类型对齐（含 turn/start 等），跑完整自动回炉到 approved，再与 off 侧基线对比 Δsuccess。
- 追加（2026-08-16）：builder 切换为 **DeepSeek 官方 V4 Flash**（JSON 模式适配器 `src/llm/official.ts`）重跑同一真实事件回环——产出候选（tool-fs sandbox → sandbox_permissions，selfCheck 0.9/0.8），verifier 以真实帧拒绝（first_divergence@0），回炉闭环正常。模型分工：actor=本地 27b，builder/评审门=官方 V4 Flash。

### 2026-08-16 from-zero-off（从零实验 off 基线：bare-loop actor）

- 基准/任务集：任务阶梯 L1（写文件）/ L2（列目录）/ L3（编辑+验证），外部断言判定（`baseline/bare-tasks.json`）
- Agent/模型：dsh headless + **bare-loop（全部 agent 工具禁用，overlay-bare.yml）** + 本地 27b
- 配置：`overlay-bare.yml`（无工具）；每任务 timeout 300s
- 结果：**0/3 PASS**——L1 写文件失败、L2 列目录失败、L3 编辑验证失败（修正过 L2：原算术题被 bare actor 凭记忆答对，换成必须查文件系统的任务）
- 产物：`baseline/results-bare-off/summary.json`（含逐任务输出）
- 结论：从零前提成立——bare actor 单独无法完成任何一级；后续每级能力必须由 builder 补齐（M4 insert 新行 + 模块写入 + 隔离加载校验）。

### 2026-08-16 from-zero-L1（从零成长第一级：builder 给 bare actor 加 fs-write 工具）

- 触发：L1 回归失败（hard trigger）→ 评审门（V4 Flash）shouldRefine=true
- builder（官方 V4 Flash）：产出 **insert patch**——新工具行 `fs-write` + `index.mjs` 模块（defineTool 契约），selfCheck 0.9/0.8
- 隔离核验：composed=true（无无关行变化）→ probe 真实跑 L1 任务 exit 0、文件创建成功 → 模块加载校验通过
- verifier：**approved**（对齐通过、coverage 通过、回归全绿）
- 安装：模块写入 `dist/fromzero/<id>/`，overlay `fromzero-l1-tool.yml`
- **升级后 actor 重试 L1：成功**（/tmp/dsh-fromzero-l1.txt = l1-ok，之前 off 0/3）
- 过程中修复：模块缺 `inject: ['tools']`（探针抓到）、parameters schema 格式错误（探针抓到）、parseDump 行尾差异、coverage 语义（claim 是语义短语→用带名工具事件判定）、null 字段语义（error 严格/其它宽松）
- 结论：**从零成长第一级完整闭环跑通**——bare → builder 加工具 → 验证 → 安装 → actor 变强；下一步 L2（列目录/加 bash 工具）。

### 2026-08-16 from-zero-L2（从零成长第二级：builder 加 ls-dir 工具）

- 触发：L2 回归失败 → 评审门（V4 Flash）shouldRefine=true（rationale 明确"L1 已通过，这是新回归"）
- builder（官方 V4 Flash）：一次产出 insert patch——`ls-dir-tool` + `tools/ls-dir/index.mjs`，selfCheck 0.95/0.9
- 隔离核验：composed=true → probe 真实跑 L2（输出含 l3-file.txt）→ verifier **approved**
- 安装：`dist/fromzero/<id>/` + `fromzero-l2-tool.yml`
- **升级后 actor 重试：L2 成功（列出 l3-file.txt）；L1 回归成功（l1-ok）**——新能力不破坏旧能力
- 结论：成长轨迹 off 0/3 → L1 ✓ → L2 ✓（回归内建验证通过）；下一步 L3（编辑+验证，可能涉及 skill 层）。

### 2026-08-16 from-zero-L3（从零成长第三级：编辑+验证）

- L3 需要两个能力：执行命令 + 读取文件 → 两级 builder 迭代：
  - **L3a**：builder 产出 `bash-run` 工具（child_process 执行命令），probe 真实跑 `wc -l` 输出含 "1" → approved → 安装 `fromzero-l3a-tool.yml`；
  - **L3b**：builder 产出 `file-read` 工具，probe 真实读文件输出含 "old-value" → approved → 安装 `fromzero-l3b-tool.yml`；
- **升级后 actor 完整 L3 任务成功**：替换 old-value→new-value + `wc -l` 报告 1 行；
- **回归全绿**：L1（l1-ok）、L2（列出 l3-file.txt）均通过；
- 说明：skill 层（SKILL.md 文件发现机制）暂未引入，留给"编辑后必须验证"的行为级任务（L4 候选）；L3 用工具补齐。
- 结论：成长轨迹 **off 0/3 → L1 ✓ → L2 ✓ → L3 ✓（每级回归不降）**；builder（V4 Flash）四轮工具产出全部一次通过。

### 2026-08-16 from-zero-L4（从零成长第四级：技能层行为改变）

- 任务：编辑文件（**任务不提验证**），验收 = 文件改对 + 输出含行数（证明"编辑后自动验证"行为）
- builder（V4 Flash）：产出 `edit-verify` 技能（`edit-verify/SKILL.md`，frontmatter name/description + 正文"编辑后必须 wc -l 并报告行数"）
- 隔离核验：staging 技能根（repo 工作区内）→ probe 真实调 `skill` 工具加载 edit-verify（输出含技能正文 wc -l）→ **approved**
- 安装：`deepseek-harness/.dsh/skills/edit-verify/SKILL.md`（项目根技能，rank 100）
- **行为测试成功**：无验证提示的任务，actor 自动执行验证并回复"文件行数为 1 行"——技能层行为改变生效
- 回归：L1（l1-ok）、L3（new-value）通过
- 过程中修复：技能必须 `<name>/SKILL.md` 目录束布局；staging 必须在沙箱工作区内（fs 可读）；probe overlay 漏 `--patch` 前缀；probe 校验改为"输出含技能正文"（防报错文本假阳性）
- 结论：成长轨迹 **off 0/3 → L1 ✓ → L2 ✓ → L3 ✓ → L4 ✓（技能层行为级改变）**；builder 已证明能产出工具行与技能文件并经过真实加载校验。

### 2026-08-16 from-zero-L5（从零成长第五级：泛化）

- 新领域任务：编辑 JSON（name old→new），验收 = 文件仍是合法 JSON + 输出含校验证据（valid）
- **off 尝试（现有 L1-L4 actor）**：文件改对了（合法 JSON、name=new），但只做了行数验证（edit-verify 技能的 wc -l），**没做 JSON 结构校验** → 泛化失败（行为可迁移但不充分）
- builder（V4 Flash）：产出 `json-verify` 技能（SKILL.md，正文要求 `python3 -m json.tool` 校验并报告 valid）→ 隔离 probe 真实加载（内容含 json.tool）→ **approved** → 安装
- **重试成功**：actor 修改后运行校验，回复 "JSON 校验结果：valid ✓"（同时保留了行数报告）
- 结论：**泛化成立**——旧方法论（行数验证）可迁移但不足以覆盖新领域，循环正确识别缺口并让 builder 补领域专用验证；成长轨迹 **off 0/3 → L1 ✓ → L2 ✓ → L3 ✓ → L4 ✓ → L5 ✓（泛化）**。

### 2026-08-16 from-zero-verify（从零成长可重复验收）

- `npm run fromzero:verify`：校验当前已安装产物（4 工具 overlay + 2 技能 + 0 缺失）并重跑 L1-L5 全任务；
- 结果：**allPass=true**（L1/L2/L3/L5 一次过，L4 第 2 次尝试通过——如实记录行为级技能的随机性）；
- 产物：`eval/run-records/from-zero-verify.json`；
- 对照总结：`docs/research/from-zero-summary.md`（off 0/3 vs on 5/5，builder 6 轮迭代，回归全绿）。

### 2026-08-16 from-zero-generic-real（真实模型走插件完整通用路径）

- 链路：AutoPilot（硬触发 regression_failure → 评审门 V4 Flash shouldRefine=true → builder → **collectFrames 隔离探测**（candidate boot + 真实跑 `wc -l`）→ verifier → gate insert 应用）
- 结果：**iterations=2（真实回炉）**——第一轮被拒，builder 带 previousReport 修正后第二轮 approved；`tool-bash-run` 安装到 `fromzero-generic-l3a-tool.yml`；
- 重试：升级后 actor 跑 `wc -l` → "1 行"（passed）；
- 成本：cost-log 带 runId（`generic-<ts>`）；
- 工程意义：IterationLoop 新增 `collectFrames` 钩子（builder 后取真实帧再验证）与 builder 调用重试（空响应瞬态 3 次重试）；fromzero 实验脚本逻辑已可在插件完整路径上复现。

### 2026-08-16 fromzero-all（一键验收链）

- `npm run fromzero:all`（默认快速）：verify **allPass=true**（L1-L5 全部第 1 次尝试通过）+ compare **off 0/3 → on 3/3（Δsuccess +3）**；
- 记录：`eval/run-records/fromzero-all.json`；
- `--fresh` 模式支持全量重跑 builder 各层后再验收。

### 2026-08-16 host-demo（宿主路径端到端首跑）

- 在 dsh 进程内由 27b 调用 `meta.auto` / `meta.iterate`，宿主完整闭环**真实执行**：两次调用 × 各 3 次迭代，全部 rejected（isolation probe exit=1）；
- 发现并修复：工具返回值含 `undefined` → dsh 拒绝 lossless JSON（新增 `cleanToolResult`）；meta 模型与 actor 端点环境拆分（`DSH_META_BASE_URL/API_KEY` 官方，`DEEPSEEK_*` 本地）；
- 待查：隔离探测子进程在**父 dsh 环境内**报 `ERR_MODULE_NOT_FOUND`，但相同 overlay 在 shell 手动复现成功——父进程环境差异（候选：TSX/NODE env）未定位；修后重跑。

### 2026-08-16 host-demo-success（宿主路径端到端闭环成功）

- dsh 进程内 27b 调用 `meta.auto`（requirements 触发 user_correction 硬触发）→ 评审门（V4 Flash）→ builder（V4 Flash）产出 bash-run insert → collectFrames 隔离探测 → verifier **approved** → gate **insert 应用（applied=true）**；
- 修复链：双隔离（validator 自带 isolation 与 collectFrames 冲突，loop 改用无 isolation 的 validator）；工具返回值 undefined（cleanToolResult）；meta/actor 环境拆分（DSH_META_*）；install 嵌套目录；builder 模块 schema 约束（required:false / additionalProperties / 模板示例）；子进程 env 清理；
- 产物：`host-demo/history.jsonl`（insert）、status approved（iteration 1）、`installed/host-demo/<patch>/index.mjs`；
- 成本记账：index 已接线 onUsage（builder/gate → cost-log），本次运行后生效；
- 结论：**宿主驱动的真实自进化闭环打通**——模型调用工具触发，插件完成 提议→验证→应用 全流程。

### 2026-08-16 host-demo-repeatable（宿主演示固化为可重复验收）

- `npm run host-demo`：自动清 workspace → 启动 dsh headless（27b 调 meta.auto）→ 以**产物证据**（history insert / status approved / installed index.mjs）判 pass；
- 实跑：**pass=true**（exit 0，applied/approved/installedModule 全 true），记录 `eval/run-records/host-demo.json`。

### 2026-08-16 dsh-baseline-official-v4flash（官方 API 基线）

- 基准/任务集：自建冒烟集（同 tasks.json，5 任务）
- Agent/模型：dsh headless + **DeepSeek 官方 API `deepseek-v4-flash`**（`https://api.deepseek.com`）
- 配置：`overlay-deepseek.yml`；每任务 timeout 600s；外部断言判定
- 结果：**5/5 PASS（100%）**
- 指标：总耗时约 90s；输出见 `baseline/results-official/`（token 未单独统计）
- 产物：`/chenzute/dsh-src/eval/baseline/results-official/summary.json`
- 本地补丁/偏差：无（官方 API；bash 工具可用）
- 结论：官方 V4 Flash 基线锚点（off 侧）；与本地 27b 基线（5/5）同为插件效果对照基准；官方 key 已存 `.env-deepseek`（600），可用于 verifier 与基准测试。

### 2026-08-16 tb21-v4flash-rerun（官方 API 切片重跑）

- 基准/任务集：Terminal-Bench 2.1（harbor-framework/terminal-bench-2-1，commit `7131e43`）
- 任务切片：`fix-git`、`overfull-hbox`
- Agent/模型：Harbor `qwen-coder` + `openai/deepseek-v4-flash`（官方 API `https://api.deepseek.com`）
- 配置：`/chenzute/dsh-src/eval/tb21-v4flash-rerun.yaml`；n_attempts=1，并发 1，agent/verifier 超时 ×2
- 结果：fix-git **PASS（1.0）**；overfull-hbox **FAIL（0.0，AgentTimeoutError）**；通过率 1/2（50%）
- 指标：总耗时约 32m；input 1,728,919 / output 99,737 tokens；cost 未计
- 产物路径：`/chenzute/dsh-src/eval/jobs/tb21-v4flash-rerun/`
- 本地补丁/偏差：test.sh 在 apt 前切换到 Aliyun 镜像（只改下载源，不改语义）；pip 替代 uv（本机容器 GitHub 不通）。**仍属本地 infra 偏差，非完全官方口径**。
- 结论与下一步：fix-git 官方 V4 Flash 真实 PASS（首跑因验证器 apt 超时被误杀，镜像补丁解决）；overfull 需要更长 agent 预算或更强模型，留待基准阶段复测。

### 2026-08-16 route-A-input-complete（builder 输入完备化 + probe-request）

- 内容：
  - 完整轨迹帧：`session/event` 全局订阅 → `trajectory/frames.jsonl`（turn/tool/assistant 帧，args/result/error 截断预览），最近 40 条注入 builder prompt（≤12k）；
  - 遥测：`trajectory/actor-profile.json`（回合数/平均·最大回合时延/工具调用数/错误率/每工具时延），builder prompt 注入；
  - probe-request：patch 可带 `probes[]`（≤3 条，每条 ≤300 字），verifier/隔离器提交前试运行，失败回传 builder 回炉（`patches/<id>/probes.jsonl` 留痕），全部通过才进正式核验；
  - config 快照真实化（loader 行 id/name/config，脱敏，关键行优先排序）；
  - `meta-validate` 行加入 lockedTargets（builder 不能改自己）。
- 测试：**83/83**（新增 frames/telemetry/probes 归一化/loop probe 回炉测试）。
- 意义：builder 第一次能"看到"actor 的完整行为时间线、快慢与错误率，并能在提交前主动隔离试运行候选——路线 A 核心闭环；长时间基准按用户指示延后。

### 2026-08-16 supervisor-swap-demo（唤起器→builder→换模型 快速案例）

- 场景：actor 配置 `agent-default-model=qwen/qwen3.6-27b` 但路由到官方 API（官方不支持该模型）→ **完全无法工作**（off FAIL，`INVALID_REQUEST: supported models are deepseek-v4-pro or deepseek-v4-flash`）
- 链路：biased 唤起器（确定性证据存在时强制唤起，LLM 只提供 focus 不能否决）→ builder（全量感知：config 快照 + 遥测 + 帧）→ 隔离 probe → verifier approved → gate overlay + harness-state apply → **结束后重新唤起**（post-loop）
- 结果（`run-records/supervisor-swap-demo.json`）：
  - 第 1 轮：builder 自主把模型从 `qwen/qwen3.6-27b` 换成 **`deepseek-v4-flash`**（第一次 apply）；
  - post-loop 重新唤起：builder 再次迭代，模型改为 `deepseek-chat`（第二次 apply，builder 自选）；
  - 重跑：以最终 overlay 启动，回复 `hello。` 成功；
  - `before` 追踪正确（第二次 before=`deepseek-v4-flash`，证明基线合并生效）。
- 产物：`meta-workspace/workspace/supervisor-swap-demo/`（history 2×apply、harness-state、overlays）
- 测试：**87/87**；新增：biased invoker（证据强制唤起）、post-loop re-invoke、runtime digest 停滞检测、review.decideOnDigest。

### 2026-08-16 scheduled-refine-and-stall-abort（预约式后台执行 + 监督员主动暂停）

- **预约式后台执行**：`scheduled=true` 时 meta.auto/meta.iterate 立即返回 `{scheduled, jobId}`；单飞队列后台跑完回路（supervisor→builder→probe→verifier→gate），job 状态落盘 `workspace/<session>/jobs/<id>.json`（scheduled/running/finished/failed）；完成/失败通过 `agent.inject` 向会话注入插件通知（form: notice，"reload 后生效"）。默认 `scheduled=false` 保持同步，demo 与既有验收命令不变。
- **监督员主动暂停（轮询）**：`reviewGate.stallAbort`（enabled/maxTurnSeconds=300/maxStepsPerTurn=30/checkIntervalMs=30s）定时检测；回合超限且非 refine 运行中 → `agent.cancel({kind:'hook', reason:'dsh-meta-validate:stall-abort'}, {keepInbox:true})` 回合级中止 + `handoff/stall.jsonl` 留痕（turnAge/steps/repeatedText/lastFrameAge）+ 注入 agent-error 信号 → 空闲时唤起 builder 接管（强制信息打包交付）。refine 运行期间跳过，避免打断正常 builder 流程。
- 测试：**92/92**（新增 checkStall abort/handoff、refineRunning 跳过、turnboundary root/sessionId 接线）。

### 2026-08-16 scheduled-notify-demo（预约式后台执行 + 进化通讯首跑）

- 场景：actor 调 meta.auto（scheduled=true）→ 立即返回 → 后台跑回路 → 启动/完成通知注入 → 台账/周报沉淀
- 结果：**pass=true**（`run-records/scheduled-notify-demo.json`）
  - job finished：`target=bash-sandbox（config）verdict=approved applied=true`
  - 台账 2 条（post-loop 第二轮 builder 自选 timeoutMs 60000→30000，S3-user-correction）
  - 通知两条落盘 `notices.jsonl`：启动"正在后台优化：…完成会通知你" / 完成"优化完成：target=…reload 后生效"
  - `growth/report.md` 两条人话记录
- 过程中发现并修复：
  1. **显式需求被监督员否决**：meta.auto 带 requirements 走 user_correction，监督员可 veto → 修复：显式 requirements（S9）强制唤起（autopilot forcedEvidence 加 `Boolean(requirements)`）；
  2. **ctx.agents 需要 inject**：插件 `inject` 加 `'agents'`，通知函数加 try/catch 兜底 + `notices.jsonl` 文件留痕；
  3. **stall-abort 定时器在 agent 上下文失效后崩溃**（cannot get required service "agents" in inactive context）→ checkStall 整体 try/catch，abort 改为 best-effort。
- 测试：99/99（新增 S9 强制唤起、插件 notice 不触发自身进化、growth 模块）。

### 2026-08-16 actor-progress-qa-demo（actor 回答"优化进度怎么样？"）

- 交互：用户不接触任何插件工具，直接问 actor"优化进度怎么样？"
- 结果：**actor 主动调用 `meta.status` 查询并如实回答**（帧证据：`tool/call name=meta.status`；同时先调用了 `meta.auto`）
- 通知链路同步验证：start/progress/completion 三条通知（notices.jsonl）
- 结论：**用户零学习成本，问 actor 即可看到优化进度**；`meta.growth` 提供成长/偏好查询（本 demo 未触发，单测覆盖）
- 记录：`run-records/actor-progress-qa-demo.json`（手动补录，headless 进程手动终止）

### 2026-08-16 publish-and-usability（npm 发布 + 真机可用验证）

- **发布**：dsh-loom@1.0.0 → npm（2026-08-16）；发现并修复工具名 bug 后发 **1.0.1**（`meta.*` → `meta_*`，官方 API 函数名只允许 `^[a-zA-Z0-9_-]+$`，本地 27b 代理不校验所以之前未暴露）。
- **真机可用验证（1.0.1）**：全新 DSH_HOME → `dsh plugin --profile headless add dsh-loom@1.0.1` → `dsh --profile headless "调用 meta_status..."` → **exit 0，actor 成功调用 meta_status 并返回 JSON**（`{"mode":"observe","growthCount":0,...}`）。
- 备注：`--profile demo` 一次性 headless 运行会挂起（demo profile 含 web UI 生命周期，不退出），脚本/CI 请用 headless profile；交互使用走 web 正常。
- **GitHub**：`ZTCNO0NE/dsh-loom` 已推送源码（src/docs/figures，scripts 不提交）；提交 `a296c3d`（76580a2..a296c3d）；HEAD 已扫描无密钥泄漏（scripts/.env/eval 均不入库）。
- 测试 99/99。

### 2026-08-17 refine-skill-demo 证据归档（含多轮排障）

- **结论：行为已验证（两次独立复现）**，未再为"脚本退出"烧钱：
  - 00:48 与 01:01 两次 phase C 中，actor 按 builder 生成的 `actor-refine` 技能调用 meta_auto → builder 产出 fs-write 工具（history `insert z3brid` applied）→ actor 用新工具写出 `/tmp/refine-skill-demo.txt`，内容 `refine-skill-ok`（两次均实测确认）。
- **排障清单（本轮修复的真实 bug）**：
  1. 回合计时跨回合不归零 → 监督员每 30s 误杀回合（observer turn/end 未重置 turnStartAt）；
  2. 官方 V4 Flash JSON 模式先吐 reasoning_content 吃满 max_tokens → content 为空（适配器 reasoning off + 空流抛错）；
  3. 清洗 key 时环境变量名写错（DSH_META_* vs DEEPSEEK_*）；
  4. preferences demo 探针本地/官方 key 串味；
  5. gate 空流致命 → fail-open（监督员不可用时偏向唤起）+ 回合边界异常落盘不崩进程；
  6. `ctx.loader` 未注入 → insert 失败（inject 加 loader + 容错）；
  7. 旧技能正文 `meta.auto`（改名后工具不存在）+ 匹配器不识别 → 已改 meta_auto；
  8. execFileSync 超时只杀 pnpm、真 node 占住 stdout 管道导致脚本永久挂起 → 改为 spawn + 进程组 SIGKILL。
- **状态**：为控制成本已停止全部 demo；脚本终止问题已修但未重跑留档；run-record 为重建（两次观察证据），后续如需正式 run-record 可低成本重跑（phase C 仅本地 27b + 一次 builder）。

### 2026-08-17 preferences-demo（偏好沉淀端到端，正式 PASS）

- 场景：用户要求"回复一律纯文本、不要 markdown，并长期记住"（无任何内部词）。
- 链路：监督员唤起（S3-user-correction）→ builder（V4 Flash）自主产出 system-prompt 更新 + 声明 preferences → 隔离探针 → verifier approved（coverage 修复后）→ gate 应用（2 轮，post-loop）→ preferences.json 落盘 → headless 调 meta_growth 可见。
- 结果：**pass=true**（run-records/preferences-demo.json）：fired、ledgerCount=2、preferences 2 条（output-format ×2 合并）、preferenceVisible=true。
- 修复：① verifier coverage 允许 nameAliases（config/persona 无命名事件，探针目标即覆盖证据）；② 最终 meta_growth headless 缺 LOCAL overlay（actor 模型路由错）；③ harness 脚本补 onApplied（ledger/report 落盘）。
- 测试：101/101。

### 2026-08-17 loop-contract-bh3（行为差异实证：并行度 10→1 候选 fork）

- 基准/任务集：loop 层契约探针（bh3，C1-C4/C7/C8）
- 任务切片：单回合「同一条回复消息里发出两个 bash 工具调用（两个 tool_calls 一起：echo A / echo B，不要分两步）」
- Agent/模型：dsh headless + `qwen/qwen3.6-27b`（本地 `http://124.221.77.140:4000/v1`）
- 配置：`overlay-contract.yml`（原版 loop）vs `overlay-contract-candidate-fork.yml`（候选 = `@deepseek-ai/dsh-agent-loop-candidate` 本地 fork，`DEFAULT_MAX_PARALLEL_TOOL_CALLS` 10→1）
- 结果：**两者 C1-C4/C7/C8 全绿**（原版 114 事件、候选 131 事件；事件数差异为模型非确定性）；核心序列完全一致；**maxParallelAdjacency 均为 1**——27b 在明确要求下仍未在同一条 assistant 消息里并发发出两个 tool/call
- 指标：纯本地 27b，无官方 token 成本
- 产物路径：`/tmp/bh3-original.txt`、`/tmp/bh3-candidate-fork.txt`（契约摘要）；`eval/meta-workspace-bh3-{original,candidate-fork}/workspace/loom-contract/trajectory/frames.jsonl`（完整帧）；快照 `run-records/2026-08-17-loop-contract-bh3-{original,candidate-fork}.json`
- 本地补丁/偏差：候选 loop 是本地 fork（源码在 `/chenzute/dsh-src/deepseek-harness/packages/core/dsh-agent-loop-candidate`，**尚未收编进本项目仓库**）
- 结论与下一步：**行为确实变了（代码层 10→1），契约未坏（C1-C8 全绿）**；但模型层行为差异当前不可观测（27b 不并发发工具），实证证据落为「代码 diff + 契约全绿」，不再为此烧模型轮次。下一步：确定候选源码收编方式，再实现「完整契约报告」（C1-C8 + C6 回归 + 真实安装前后 before/after）并作为 agent-loop 放开准入门槛。

### 2026-08-17 loop-vendoring-and-entry-resolution（A 收编 + 防假阳性修正）

- A 收编完成：`vendored/serial-tool-calls/` 保存候选可运行构建产物；`loop-candidates/serial-tool-calls.manifest.json` 固定上游 commit `47f943859bef60e4160492346772ded9b24f765a`、10→1 delta、入口与目录 hash。
- 新代码：`src/candidates/` 提供候选生命周期、验证证据门、before/after 安装记录、rollback 与受限 Git importer；本项目检查全绿，测试 **104/104**。
- runner：新增 `--report`、C6 同 overlay 回归、每 probe 隔离 frames，以及 `--expected-entry` 的 **C0** 检查。
- 真实核查：`dsh --profile headless --patch overlay-contract-candidate-fork.yml --dump-config` 解析出的 `agent-loop.name` 是 `@deepseek-ai/dsh-agent-loop`，而不是候选路径。原因是 include 的 `PatchOptions.name` 为 matcher（name mismatch 会跳过 patch），不能更新模块名。
- 因此：此前/本轮在该 overlay 下得到的 C1-C8/C6 只能说明官方 loop 环境可跑，**不构成候选 fork 已加载或真实冷替换的证据**。一次 gate smoke 的 C3 帧混合失败已自动 rollback；修正 frame isolation 后的“成功”同样因 C0 缺失被撤销。运行目录已恢复。
- 下一步：实现完整 profile/宿主 Loader entry replacement adapter；要求 C0=pass 后，才重跑三件套并允许 candidate 从 approved 进入 installed。

### 2026-08-17 candidate-profile-proof（真实候选 entry 的短 probe）

- 临时 profile 在 eval workspace 中创建：自定义 `@loom/candidate-base` bundle 复制 DSH base bundle，并在**组合前**把 `agent-loop` 行改为候选 `lib/index.js`；随后叠加官方 `@deepseek-ai/dsh-headless` bundle。
- `--dump-config` 已解析到候选绝对入口（C0 pass）；同 profile 下真实 headless actor probe 的 **C1/C2/C3/C4/C7/C8 全绿**，132 events，exit 0。
- 报告：`/chenzute/dsh-src/eval/meta-workspace-loop-gate-JAAWGH/reports/profile-candidate-contract.json`。
- 局限：C6 脚本尚未支持传入 profile（当前只会叠加 overlay），因此此条是“候选真的加载且协议 probe 通过”，不是完整三件套；下一步将 profile generator/entry assertion 收敛为 gate adapter，再把同一 profile 注入 C6 与 before/after/rollback。

### 2026-08-17 vendored-loader-gate（正式 profile 替换 + 完整三件套 + 冷安装）

- 正式 adapter：`src/candidates/profile.ts` 在 runtime-owned DSH_HOME 中复制 base bundle，并在 Loader 组合**之前**把 `agent-loop` entry 改为隔离的 vendored candidate；不改 DSH checkout 或用户 profile。source-run 的 module-local scheduler Symbol 由受记录的 `scheduler-symbol-v1` Loader bridge 兼容，vendored 原件及其 hash 保持不变。
- C0/C1-C4/C7/C8：`meta-workspace-loop-adapter-20260817/reports/profile-candidate-contract.json` 全绿（实际 resolved entry 为 runtime `@loom/candidate-loop/lib/index.js`）。
- C6：`profile-candidate-full-contract.json` 全绿；`from-zero-verify.json` 明确记录 `profile=loom-serial-tool-calls` 和其 isolated `profileHome`，L1-L5 全过（L4 第 2 次通过）。
- 实装：`meta-workspace-loop-gate-final-20260817/candidates/installations/serial-tool-calls.json` 记录 `before.exists=false → after.exists=true`、C0 smoke pass、状态 installed；随后同一 gate profile actor 重跑 `reports/gate-installed-actor-contract.json`，C0/C1-C4/C7/C8 全绿。
- C5 回滚演练：同目录 `installations/serial-loop-rollback.json` 注入错误 entry-resolution；gate 创建的 profile 被自动移除，`before.exists=false`、`after.exists=false`、`rollback.succeeded=true`。保留已安装 serial candidate，未触碰生产/用户 profile。

### 2026-08-17 loop-candidate-autonomy-proof（meta.auto 候选网关 → builder 发现 → staging）

- 任务：本地 27b actor 调用 `meta_auto(discoverLoopCandidate=true)`；独立 V4 Flash builder 只生成候选请求，候选来源限制在指定公开 GitHub 上游。
- 配置：`/chenzute/dsh-src/eval/overlay-loop-candidate-autonomy.yml`；`allowLoopCandidates.enabled=true`、Git host allowlist 仅 `github.com`、独立 runtime root；actor 继续本地 LiteLLM，builder 使用官方接口且 `thinking.type=disabled`。
- 结果：**PASS**。builder 输出 `agentloop` 请求；importer 用解析后的 commit `7d06bc0cac89c9bd0c9d8510a3e12972919948e2` 从 HTTPS GitHub 来源拉取并记录 content hash `5c949c2f6abc817226fddeea2f07091f1010112badad8c71b47697cd149a7bac`。
- 状态：注册表中唯一记录为 **staging**；没有 `pending`、`verified`、`approved`、`installed` 或 installation record。候选未执行 build、未被加载，也未改变 actor loop。
- 传输修正：本环境对 Git smart-HTTP clone 有不稳定超时；GitHub 来源改为 GitHub API 将 ref 解析为 commit + codeload 归档拉取。来源仍是 allowlisted HTTPS Git URL，commit/hash 固定；非 GitHub allowlist 来源仍走 shallow partial Git clone。
- 产物：`/chenzute/dsh-src/eval/run-records/2026-08-17-loop-candidate-autonomy-proof.json`；runtime registry/discovery/artifact 路径均写入该快照。
- 结论：③候选网关、④builder 自主请求/受限拉取/暂存、⑤端到端 staging 案例完成；该外部候选尚无正式契约证据，必须继续 verifier 三件套后才可能进入 pending 之后的状态。

### 2026-08-17 builder-kernel-real-feedback-proof（官方 BuilderDriver 微循环 + 拒绝回注）

- 运行：官方 `deepseek-v4-flash`，适配器请求固定 `thinking: { type: 'disabled' }`；隔离 workspace 为 `eval/meta-workspace-builder-kernel-real3-20260817`，没有 install、没有生产路径写入。
- 第一个 run：模型依次选择 `write_candidate_draft → preflight_staging_entry → submit`，3 个 model turns、2 个 allowlisted tool actions、0 errors；Kernel 冻结的是已预检 draft，builder 无 verifier/gate/install 调用能力。
- 回注：先以刻意 rejection 演练 durable handoff；随后用项目真实的确定性 `Validator` 对第一份 candidate 的空 actual frames 执行对齐，得到 `rejected`（`first_divergence at 0: fields (missing event)`）。真实 report 通过 `patches/<patch>/builder-run.json` 关联旧 run；`reopenFromFeedback()` 新建 immutable run，并把完整 report/first divergence 放到 `input/previous-attempt.json`。
- 第二个 run 完成一次 handoff 演练；**第三个 run** 消费真实 `Validator` rejection 后完成 `write_candidate_draft → inspect_staging → preflight_staging_entry → submit`，4 个 model turns、3 个 allowlisted tool actions、0 errors；其 `previousAttemptPresent=true`、`previousAttemptSource=verifier`。这证明拒绝信息不是只留在 loop 变量，而是可恢复地进入下一次 builder 思考。
- 产物：`/chenzute/dsh-src/eval/run-records/2026-08-17-builder-kernel-real-feedback-proof.json`；全量 journal/snapshots/report 在上述隔离 workspace 下。此前两次协议探索均按预算 `aborted`，无提交/安装；最终证据仅以上述成功 run 与真实 Validator report 为准。

### 2026-08-17 loop-autonomous-final-lifecycle-proof（自主 source → build → verifier → gate → rollback）

- builder：官方 `deepseek-v4-flash`（`thinking.type=disabled`）在同一 BuilderKernel run 内用 `write_candidate_draft → preflight_staging_entry → submit` 选择 `deepseek-ai/deepseek-harness` 的 `agent-loop`，resolved commit `47f943859bef60e4160492346772ded9b24f765a`。
- build：Git archive 源码没有 `lib/index.js`；importer 因此使用固定 `sandboxed-dsh-workspace` 受限 recipe，在 `bwrap --unshare-all`（无网络）内以只读 DSH dependency tree 构建，artifact hash 为 `97d8449e91df8c88cd625cb5de27579514c62a6d2809b5d822acbc3514824269`。builder 没有 shell 或 build command 权限。
- verifier：C0/C1-C4/C7/C8 全绿，完整 C6 from-zero L1-L5 `allPass=true`；独立 lifecycle controller 才将 record 推进到 approved。
- gate：before.exists=false cold install、C0 smoke pass、actor 安装后重跑全绿；对同候选注入 C0 mismatch 后 `rolled_back`、`rollback.succeeded=true`，再按同 hash re-install，最终 actor 重跑仍全绿，registry 状态 `installed`。
- 边界：全部路径是 `/chenzute/dsh-src/eval/meta-workspace-loop-autonomous-final6-20260817/runtime`，生产/用户 profile 均未写入。候选是 baseline control，不把它夸大为性能改进。
- 产物：`/chenzute/dsh-src/eval/run-records/2026-08-17-loop-autonomous-final-lifecycle-proof.json`。

### 2026-08-17 final-builder-kernel-and-lifecycle-audit

- 最终静态审计确认：BuilderKernel 仅暴露 `read_input/read_journal/write_world_model/write_plan/write_candidate_draft/inspect_staging/preflight_staging_entry`；journal、快照、状态转换均由核心写入。`submit` 只能冻结已预检 draft，不携带可偷换的 payload。
- 裁决回注确认：verifier rejection、builder probe failure、gate/install rollback 都被持久化为反馈，并由 `reopenFromRejection()` 创建新的 immutable builder run；下一 run 从 `input/previous-attempt.json` 读取 rejection/first divergence/probe/rollback 信息。
- 最终全测：`npm run check`、`npm test`（**120/120**）、`npm run build`、`git diff --check` 全部通过。终局 lifecycle record 不变；所有验证仍只在隔离 eval runtime，未触碰生产或用户 profile。

### 2026-08-17 loop-parallel-attribution-comparison（27b / DSH / scheduler 三段对照）

- 成本控制：仅 3 次原始本地 27b 请求（其中两次 256-token 默认思考截断）和原版/已安装候选各 1 次短 actor run；未调用官方 API，未触碰生产或用户 profile。
- 模型层：`thinking: { type: 'disabled' }` 的 27b 真实返回两条 native tool call（`probe_alpha(A)`、`probe_beta(B)`，162 completion tokens，10.6s）。这否定了“27b 不能在单回复中产生两条调用”的假设。
- actor 层：原版与已冷安装的 `serial-tool-calls` 都记录同一 turn/step 两条 `bash` tool/call，且 C0/C1-C4/C7/C8 通过；loop 没有折叠模型输出。
- scheduler 层：两条 `sleep 1; echo` 的 bash 均是 exclusive；原版 call span 2123ms、candidate 2143ms，第二条均在第一条 result 后才开始。故串行来自工具安全 barrier，不是模型，也不是 10→1 cap。
- 复核：官方 loop 与 candidate loop 的 scheduler tests 共 **42/42** 通过，覆盖 parallel-safe calls 真并发和 `maxParallelToolCalls=1` 真串行。
- 结论：本轮完成责任归因，**未**证明 serial candidate 带来提升；要证明提升必须用两个延迟、`isConcurrencySafe` 的真实工具重跑同一 actor benchmark。完整 machine record：`/chenzute/dsh-src/eval/run-records/2026-08-17-loop-parallel-attribution-comparison.json`。
- 工程修正：`scripts/contract-runner.mjs` 的 optional flag positional parser 已修；未传某 optional flag 不再误删 command mode。

### 2026-08-17 loop-parallel-safe-real-behavior-comparison（真实并行吞吐对照）

- 设计：在隔离 eval 路径注册 `delay_probe_a` / `delay_probe_b`；二者各 delay 1000ms、无共享可变状态、显式 `isConcurrencySafe: () => true`。actor=本地 27b，`thinking=disabled`、`maxTokens=2048`，同一 prompt 强制单回复两调用；原版 profile 对比已冷安装 `serial-tool-calls` profile。
- 原版实测：同一 turn/step 两 call 相隔 **4ms**；两 result 在约 1.02s 后抵达，tool span **1017ms**，真实 overlap=true。
- candidate 实测：同一 turn/step 两 call，但第二 call 在第一 result 后启动；tool span **2024ms**，overlap=false。candidate 比原版多 **1007ms**，墙钟比 **1.99×**。
- 两侧：C0/C1-C4/C7/C8 均 pass、exit=0、0 error frame；没有生产、用户 profile 或官方 API 写入/调用。先前 C1 只允许 `call→result`，会误拒合法并发轨迹，已扩展为允许并发组中的连续 `call` / `result`，随后原版与 candidate 契约均重跑通过。
- 结论：这给出了 cap=1 的真实可观测效果，但它是吞吐退化而非提升；`serial-tool-calls` 只能以安全/顺序策略定位，不能作为 actor 性能成长案例。完整 record：`/chenzute/dsh-src/eval/run-records/2026-08-17-loop-parallel-safe-real-behavior-comparison.json`。

### 2026-08-17 builder-generated-loop-ingress（受限自有修改通道，尚待真实 acquisition）

- 实现：`CandidateImporter` 新增 `builder-generated` source；固定 40 位 DSH baseline commit，核心只接受 `packages/core/agent-loop/src/**/*.ts` 的 exact `beforeHash` + 完整 `after` 替换。
- 限制：最多 4 个文件、单文件 48 KiB、总替换 96 KiB；拒绝路径逃逸、重复路径、symlink、空/超限内容和 hash 不匹配；强制 `sandboxed-dsh-workspace` 无网络 build。manifest 记录 baseline、edit-plan hash 及每文件 before/after hash；候选仍只进入 staging。
- 验证：新增精确替换、hash mismatch、路径 allowlist 单元测试；当前 `npm run check` 与 `npm test` **122/122** 通过，尚未宣称真实 loop 性能提升，也尚未用网络 acquisition/build/verifier/gate 证明 generated candidate。
- 真实尝试：隔离 runtime `meta-workspace-builder-generated-acquisition-20260817` 使用 baseline `47f943859bef60e4160492346772ded9b24f765a` 和 `constants.ts` 10→20 edit；GitHub API 解析成功后，codeload 返回 HTTP **429**，importer 清理了临时 staging，registry 无残留记录。该次只记为外部限流阻断，不计入候选通过或失败。

### 2026-08-17 loop-generated-edit-build-local（网络阻断下的机制证据）

- 为避免把 codeload 429 当成代码失败，从同一固定 baseline commit 做隔离 `git archive`，再由 `applyBuilderGeneratedEdits` 应用 `constants.ts` 的 10→20 exact edit。
- 结果：beforeHash 校验、afterHash、artifact hash 和固定 `bwrap --unshare-all` networkless build 全部通过，入口产物为 `packages/core/agent-loop/lib/index.js`。
- 该记录明确是 `claimLevel=mechanism-only`；没有外部 acquisition、C0/C1–C8/C6、gate、actor 或 rollback，不得作为候选安装或性能提升证据。机器记录：`/chenzute/dsh-src/eval/run-records/2026-08-17-loop-generated-edit-build-local.json`。
- P1 12-way probe harness 已准备：`parallel-probe-plugin.mjs` 保留 A/B 兼容并新增 `delay_probe_01`–`delay_probe_12`；plugin SHA-256 为 `4e21f7d99db2382791a97b413917d25228cf4c0e8fabb1bdda3a1ab978255e62`。
