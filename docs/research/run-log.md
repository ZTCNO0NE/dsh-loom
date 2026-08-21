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

### 2026-08-17 builder-autonomy-fallback-hardening

- 发现并修正自主性缺口：429 以前只以错误字符串回注，且 builder 没有 pinned baseline 的可读视图，无法可靠从 Git 拉取切换到 generated edit。
- 现在 importer feedback 结构化为 `failureClass`/`retryable`/`allowedStrategies`；重开 run 的首个 prompt 强制读取 `previous_attempt`，在 `switch_git_source`、`builder_generated`、`abort` 中选择，最多 3 个 immutable attempts。
- `read_input(loop_baseline)` 新增 core-authored、固定 commit 的只读 catalog；内容来自 Git object（不是 dirty working tree），包含允许源文件的 hash/内容。builder 仍无 shell、网络、verifier、gate、install 权限。
- 检查：`npm run check`、`npm test` **125/125**、`npm run build`、`git diff --check` 全绿；这改善了决策闭环，但不替代 generated candidate 的真实 acquisition/C0–C8/C6/gate 证据。

### 2026-08-18 actor-builder-async-communication

- 实现：`meta_auto(exploreLoop=true)` 先创建 immutable Builder run，再提交到既有 single-flight 后台 job queue，并立即返回 `jobId` 与 `runId`。`meta_builder_status(jobId|runId)` 读取 durable run 的 state、model/tool 计数、inbox 数、journal tail 和 proposal 摘要；`meta_builder_message(jobId|runId,message)` 只追加 actor inbox，下一 Builder 微循环自动取得消息。job JSON 在 scheduled/running/finished/failed 全程保留 request/runId，故 actor 可一直以 jobId 定位同一 run。
- 真机：隔离 overlay `eval/overlay-actor-loop-async-20260818.yml`，actor=本地 27b，Builder=官方 V4 Flash，Builder 限制为 2 model turns/2 tool steps/512 tokens；任务保持“更换更强 loop 基座，不要只改业务参数”。actor 实际调用 `meta_auto(exploreLoop=true)`；trajectory 显示 tool call `17:46:32.422Z`、tool result `17:46:32.506Z`，返回 **84ms**。Builder 在 `17:46:33.955Z` 才进入 exploring，说明 actor 获得 job/run 标识时未等待 Builder 完成。
- 结果：actor 如实向用户报告 `scheduled`、jobId、runId、仅观察、未安装；后台 Builder 因刻意的小预算在 1 turn/0 tool 后 abort。job、journal、run 和 cost log 均已持久化；run record 为 `eval/run-records/2026-08-18-actor-builder-async-communication.json`。没有 verifier、gate、候选导入或安装。
- 覆盖：新增 gateway 单测覆盖 create → status → message → next Builder prompt sees inbox；本项目 `npm test` **128/128**、`npm run check`、`npm run build`、`git diff --check` 通过。该次证明非阻塞委托与持久状态可见；跨用户后续回合的真实 `status → message → Builder next turn` 将在常驻 actor 会话中补测，headless CLI 单次进程不是其完整替代。

### 2026-08-18 actor-evidence-pack-real-session

- 实现：新增 `src/evidence/index.ts` 与 `createActorEvidencePack()`。每次主动 Builder 委托前冻结三层材料：原始 `frames/events/requirements/signals/triggers/profile` 的路径、行数、字节数和 SHA-256；脱敏 config snapshot；确定性 `RuntimeDigest`；以及可自由书写的 `actor-handoff.md`（用户目标、Actor 观察、已知信号、未知项）。原始日志不复制，manifest 只建立带 watermark 的引用，Builder 可继续读取原文件。
- 数据：使用真实隔离 actor 会话 `/chenzute/dsh-src/eval/meta-workspace-actor-loop-async-20260818` 生成 pack，实际统计 **826 frames、8 normalized events、1 turn、1 tool call、0 tool errors**；27b actor 的要求和“Builder 后台 abort、未安装”的自然语言观察写入 handoff。pack 目录：`workspace/actor-loop-async-20260818/evidence/`，manifest 为 `evidence-1786990115790-fc933eeab5/manifest.json`。
- 结论：三层叠加已经能把真实会话事实、已知统计问题和自由语义假设同时交给 Builder；system-reminder 等噪声只保留在 raw refs，handoff 做了截断/省略。此 pack 证明的是素材可恢复性与非阻塞委托，不是 loop 演进效果；下一实验必须让 Builder 读取该 manifest，自主选择候选，经 verifier/gate 后同任务 before/after 重跑。
- 验证：新增 `src/tests/evidence.test.ts`；`npm run check`、focused evidence test、`npm run build`、`git diff --check` 通过。完整套件将在本轮代码收束后重跑。

### 2026-08-18 v1-1-route-cut-and-adjudication（减法定稿 + 单一路线接线）

- 内容：按用户定义把 v1.1 收敛为单一路线——用户主动委托 → 三层 evidence pack → Builder 自由探索 → verifier/gate 裁决 → actor 同任务重跑 → 用户看到改了什么/为什么/效果。
- 砍除：`discoverLoopCandidate` / Git 获取从插件入口与 gateway 移除；`CandidateImporter` 只保留 builder-generated + 本地固定 baseline（无网络）；Builder 基础工具面移除旧 `write_candidate_draft` / `inspect_staging` / `preflight_staging_entry`；被动触发链从激活路径移除（代码暂留归档）。
- 新增：`src/deliberation/index.ts`（`adjudicatePatch` / `adjudicateLoop` / 裁决分发，fail-closed）；`meta_auto(exploreLoop=true)` 后台 job 在 Builder submit 后自动裁决：patch → Validator + Gate + 同任务隔离重跑 + 台账/报告；loop → 本地 baseline 构建 → contract-runner C0/C1-C8/C6（配置后启用）→ profile gate 冷安装。
- 配置新增：`allowLoopCandidates.{baselineRoot,baseBundle,dependencyRoot,additionalDependencyRoots,contractCommand,contractTask,goldenPath}`；未配置时 loop 裁决 fail-closed。
- 测试：**132/132**（新增 deliberation 6 条；删除 discover 3 条）；`npm run check` / `npm run build` / `git diff --check` 全绿。
- 结论与下一步：代码路线闭环已接；loop 真实端到端需配置 loop runtime（baselineRoot/baseBundle/dependencyRoot/contractCommand/goldenPath）后跑一次真机案例（用户已允许烧钱）。

### 2026-08-18 builder-rejection-reopen（validator 拒绝回注 Builder）

- 缺口：新 Builder 探索路径在 verifier/gate 拒绝后只记录结果，没有像旧 Proposer 路径那样回注；Builder 看不到拒绝原因，无法再改。
- 修复：`LoopCandidateGateway.reopenExploration(runId, report)` 基于 `BuilderKernel.reopenFromRejection` 重开不可变 run，把拒绝报告写入 `previous-attempt.json`（Builder 首轮即可 `read_input(previous_attempt)` 看到），actor inbox 消息随附到下一 run；后台 job 最多 `allowLoopCandidates.builderMaxReopenAttempts` 次（默认 3），每次拒绝后自动重开并再跑 Builder → 裁决。
- 测试：**133/133**（新增 reopen 单测：拒绝报告可读 + inbox 保留）；`npm run check` / `npm run build` / `git diff --check` 全绿。

### 2026-08-18 loop-e2e-proposal-adjudication-gate（真实 proposal→裁决→冷安装→同任务重跑）

- 链路：27b actor 主动调用 `meta_auto(exploreLoop=true)` → V4 Flash Builder（5 回合/4 工具：read_file、sha256sum、git rev-parse、write_submission）→ `loop-evolution` proposal → 本地 baseline git archive 整树 + builder edits + bwrap 无网络构建 → contract-runner profile 模式（**C0 pass、C1-C8 pass、C6 fromzero L1-L5 pass**）→ approved → profile gate 冷安装（C0 冒烟 pass、before/after 落盘）→ 同任务重跑（baseline/installed 均 exit 0，**admissible=true，claimLevel=causal-workload**；installed 1.52× 更慢与串行语义一致，不宣称性能提升）。
- 修复的真实 bug：① `adjudicateLoop` 在 importer 已 stage 后二次 stage（candidate already exists）；② importer 只拷包目录 → 沙箱构建缺 workspace 引用，改为 git archive 整树；③ candidate profile 依赖锚点缺 `dsh-invariants` → dependencyRoot 用仓库级 node_modules；④ 契约 overlay 的 `maxTokens` 被脱敏成 `***` → 重建 llm 行恢复 8192；⑤ 契约 overlay 继承主会话 workspaceRoot 导致 frames 落错处 → 删除，由 `DSH_META_VALIDATE_ROOT` 接管；⑥ `--regression` 的 fromzero-verify 相对路径以 dsh checkout 为 cwd → 固定为插件仓库根。
- 产物：e2e16 workspace（builder runs/proposal/registry/install report/comparison）；确定性复现脚本 `eval/gate-e2e-verify.mjs`；快照 `run-records/2026-08-18-loop-e2e-proposal-adjudication-gate.json`。
- 结论与剩余：proposal→裁决→gate→重跑链路真实闭环；Builder 自由探索的收敛性仍不稳（e2e17 attempt 1 卡重复 read_file 未提交），属模型行为问题，后续可引导"完成最小必要探索后尽早 submit"。

### 2026-08-18 builder-boundary-hardening（异常回注、重载状态、比较证据、重复反馈）

- 裁决阶段的 patch/loop/import/install 异常现在统一包装为 `rejected` report，交给现有 immutable reopen；不会再因异常直接把 job 终止为 `failed` 而丢失 Builder 反馈。
- 宿主重载扫描持久 jobs，将无人执行的 `scheduled/running` 标记为 `interrupted`，保留 run/journal/evidence，避免假装后台任务仍在运行。当前策略是安全中断后由 actor 重新委托，不伪造自动续跑。
- comparison schema 升为 v2 并增加 `rollbackRequired`。要求 rollback 证明但没有显式 `rollbackPass=true` 时，`admissible=false`；普通同任务 replay 明确声明 rollback 不在该 comparison 范围。
- 重复工具动作改为按“动作相同且反馈 hash 连续不变”计数；文件或命令反馈发生变化时不会因重复动作提前 abort。
- 本轮确定性验证：`npm run check`、`npm test` **139/139**、`npm run build`、`git diff --check` 全部通过。

### 2026-08-18 actor-builder-durable-conversation（协议与继承）

- Builder inbox 由单一 `text` 扩展为保留 `rawUserText`、`actorMemo`、`evidenceRefs` 的持久消息；旧 text 消息兼容读取。Actor memo 是非权威解释，Builder prompt 明确同时呈现原话、解释和待确认 message id。
- 新增 Builder event log：run/state、actor message receipt、tool complete/fail、`message_ack`、`builder_update`、proposal draft。它只记录可审计摘要，不记录隐藏思维链；Gateway 与 `meta_builder_events(afterSeq, limit)` 为 Actor 提供 cursor 读取。
- Builder 可调用 `acknowledge_message` 回传理解/下一步/追问，或 `publish_progress` 回传阶段摘要。Actor 保持用户接口和解释职责，用户的丰富控制仍通过开放自然语言 inbox 进入 Builder。
- `previousRun` 资产清单绑定旧 run 的 workspace 与关键文件 hash；rejection 和 `meta_auto(... resumeJobId=...)` 创建新 immutable run 时都带入。host restart 不盲目重放中断命令，而是由 Actor 明确恢复到带资产的新 run。
- 确定性覆盖：Kernel 原文/memo/event/继承、Driver 回执 prompt、Gateway event cursor/resume；`npm run check`、`npm test` **142/142**、`npm run build`、`git diff --check` 通过。真机多轮 Actor 会话验证待后续单独运行。

### 2026-08-18 actor-builder-session-protocol-hardening（幂等、冻结提交与生命周期）

- 消息协议：`idempotencyKey` 同内容重试只保留一条 inbox/event；同 key 不同原文、memo 或 evidence refs 直接拒绝。Builder 提交前必须对本 run 全部 Actor 消息产生 `message_ack`，否则不能冻结提交。
- 事件协议：Gateway 返回 `lineageId:runId:seq` composite cursor；reopen 后旧 cursor 明确 `reset=true` 并从新 immutable run 的 `run_created` 开始，避免不同 run 的 seq 碰撞漏读。
- 提交证据：`submission/manifest.json` 绑定 proposal/input/target-before hash 和 evidence/artifact refs。legacy staging draft 在 preflight 时补写同一 manifest；提交时发现声明产物或证据被修改/删除即 fail-closed。
- 生命周期：新增 Kernel `pause` / `cancel`，Builder `request_input` 产生 typed `needs_input` event 并进入 `waiting_for_input`；Actor-facing `meta_builder_control` 的 `resume` 创建 `previousRun` 资产继承的新 attempt，并重新使用完整 Builder→裁决→gate executor，不重放中断副作用。job 如实落盘 paused/waiting_for_input/cancelled。
- 确定性验证：`npm run check`、`npm test` **148/148**、`npm run build`、`git diff --check` 全绿；所有测试均使用临时隔离目录，未调用官方 API、未触碰生产/profile。仍需单独留档一次真实 Actor 多轮 pause→message→resume 演示。

### 2026-08-18 real-actor-builder-mid-guidance（真实多轮中途指导）

- 实验角色：本次由测试驱动器扮演用户与 Actor，Builder 使用官方 DeepSeek V4 Flash（`thinking=disabled`，maxTokens=2048）；只使用新建隔离目录 `/chenzute/dsh-src/eval/meta-workspace-actor-builder-guidance-2026-08-18T074405558Z`，未触碰 actor profile、生产服务或用户 workspace。
- 初始用户原话：要求检查 actor loop 的可验证改进点，允许小改/重建/替换，但必须基于真实反馈，提交后由 verifier/gate 裁决，不能把未安装候选说成已生效。
- 中途用户指导：把“真实并发安全与任务成功”置于“单纯降低并发数”之前；若只是串行化且没有提升证据，必须如实说明或请求确认。消息带 `idempotencyKey=guidance-turn-1`，原文、Actor memo 均进入 durable inbox。
- 生命周期实测：初始 run `builder-1787039045558-793a3afd` 在 1 model turn/1 tool 后收到指导并被 pause；随后创建同 lineage 的新 immutable run `builder-1787039048618-5c0053cf`，`previous-run.json` 继承旧资产。新 run 首轮对初始请求和中途指导均产生 `message_ack`，证明指导跨 run 可见。
- 结果：新 run 10 model turns/10 tool steps 后 `aborted`，无 proposal、无 verifier/gate、无安装；最终失败原因是 `builder model-turn budget exhausted`。期间三次 `list_directory` 使用不可用相对目录而失败，说明“全局读权限”目前仍缺少明确的源码根目录/探索入口投影；Builder 能看到指导，但没有收敛到提交。
- 发现并修复：同一消息重复 `acknowledge_message` 以前会重复写 `message_ack` 事件，已改为 Kernel 幂等回执并加入回归测试。该修复不改变本次真机记录，后续重跑需确认重复回执不再占用回合。
- 证据：`/chenzute/dsh-src/eval/run-records/2026-08-18T074405558Z-real-actor-builder-mid-guidance.json`。结论等级为 **communication-and-lifecycle-proof / no-adjudication**：证明用户中途指导的原文保真、事件回执、pause→immutable resume 和跨 run 继承；不证明候选质量、verifier/gate 通过或 loop 性能提升。

### 2026-08-18 real-actor-builder-mid-guidance-rooted（补充源码根目录后的复验）

- 为区分“上下文入口缺失”和 Builder 自身收敛问题，第二次实验只增加了 `/chenzute/dsh-src/deepseek-harness`、`packages/core/agent-loop/src/constants.ts` 两个事实，并保留同一中途指导、pause→resume 操作。其余探索路线仍由 Builder 自主决定。
- Builder 成功读取并列出源码，未出现第一次的目录错误；但在 18 model turns/18 tools 内仍多次读取相同源码、重复调用 acknowledge（Kernel 已不再重复写 message_ack 事件），最终 `builder model-turn budget exhausted`，无 proposal、无 verifier/gate、无安装。
- 证据：`/chenzute/dsh-src/eval/run-records/2026-08-18T074750285Z-real-actor-builder-mid-guidance-rooted.json`。该复验把问题定位为 Builder 的收敛/提交纪律，而非 Actor→Builder 消息丢失或路径不可见。结论仍为 **communication-and-lifecycle-proof / no-adjudication**。

### 2026-08-18 capability-runtime-simulation-and-builder-rerun

- 架构落地：Builder Kernel 保留生命周期、journal、workspace、消息与提交冻结；新增 `BuilderCapabilityRuntimeRegistry`，capability 可以注入自己的 runtime tool。`loop-evolution` 和 `workspace-simulation` 由 capability 提供，核心不解释 capability 语义。
- 新增 `SimulationRunner`：在 Builder-owned workspace 中写入 fixtures、运行命令、记录 stdout/stderr/exit code/duration、输入/fixture/output/report hash；fixture 路径不能逃逸 workspace。simulation 状态只有 `passed/failed/inconclusive`，不等价 verifier verdict。
- 新增 `compareSimulationToReal`，并运行同一 actor contract 的仿真与隔离真实副本对照（sum/reverse/unknown 三例）：simulation 与 real 的 exitCode/stdout/stderr 全部一致，`consistent=true`，证据 `/chenzute/dsh-src/eval/run-records/2026-08-18-workspace-simulation-real-consistency.json`，claimLevel=`mechanism-consistent`。该实验只证明仿真执行器与对应隔离命令的一致性，不证明真实 DSH profile/live loop 的高保真。
- 新增结构化 Builder → Actor `request_input`：支持 `clarification`、`choice`、`verification`、options、whyNow、evidenceRefs、blocking。Kernel 只持久化并暂停；Actor 负责向用户解释/转交，用户回复后由 Actor resume 新 immutable run。
- 真实 Builder 复测：官方 V4 Flash，注册 `workspace-simulation` capability，18 model turns/36 tool budget。结果仍为 18 次重复读取 requirements/source，未调用 simulation、未写 submission、未进入 verifier/gate；记录 `/chenzute/dsh-src/eval/run-records/2026-08-18-builder-simulation-capability-real-run.json`。结论：仿真入口已存在且可用，但工具加入本身未解决开放任务的方向收敛；下一实验必须真实触发 choice/clarification，让用户选择明确目标后再跑同一 Builder。
- 官方 Builder 最小 choice 测试：任务明确声明“吞吐 vs 顺序安全”不能从任何文件/仿真推导，V4 Flash 在 1 model turn/1 tool 后调用 `request_input(kind=choice)` 并进入 `waiting_for_input`；记录 `/chenzute/dsh-src/eval/run-records/2026-08-18-builder-official-clarification-request.json`。说明 Builder 可触发持久 Actor 交互协议；但内容复用了 prompt 的示例 options，故只计 protocol invocation proof，不计“模型依据证据提出高质量问题”。
- 完整 action 归因：`builder-simulation-capability-real-run` 的 18 个 tool steps 中，requirements 被读取 15 次、错误 actor source 被读取 3 次；没有读取 durable world model/plan/journal，也没有 workspace 写入、命令执行、simulation、clarification 或 submission。该 trace 不能证明隐藏思维不存在，但证明 Builder 没有把思考转化为可观察的状态推进。为后续区分“模型看到了什么”和“模型做了什么”，`BuilderDriver` 新增 prompt hash、可见状态、上一工具反馈 hash 的 journal 记录，不保存隐藏思维链。
- 上层使命补强 + 重复读取反馈复测：Builder prompt 增加“帮助 Actor 提升用户体验/任务成功率/安全”的使命与完成定义；read_file/read_input/list_directory/read_journal 对同一 hash 返回 `observation.newInformation=false` 和 `unchangedSinceSeq`。官方 V4 Flash 仍在 18 turns 内重复读 requirements/source，虽已看到 unchanged 反馈，仍未仿真、提问或提交。记录 `/chenzute/dsh-src/eval/run-records/2026-08-18-builder-mission-unchanged-feedback-rerun.json`。结论：使命目标是正确的上层目标，但不能替代任务方向和确定性进展机制。

### 2026-08-18 builder-phase-evidence-guards

- Kernel 落地：`BuilderRunRecord.phase` 持久化 observing/hypothesizing/baseline_simulating/exploring/candidate_simulating/waiting/ready/submitted 等公开里程碑；phase 仅用于观察和恢复，不是探索路线白名单。旧 run 缺 phase 时按 state 兼容读取。
- 负向约束：`request_input(kind=choice)` 至少两个唯一选项；`kind=verification` 必须有 `whyNow` 与 evidenceRefs。非法请求 fail-closed，错误写入 journal 作为下一回合反馈；正常读写、命令、capability 调用仍开放。
- 确定性验证：新增 Kernel guard/phase 测试，完整套件 **154/154**，`npm run check`、`npm run build`、`git diff --check` 通过。
- 官方 V4 Flash 观察记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-phase-guard-real-run.json`；18 model turns/18 tool steps，仍重复读取 requirements（及 actor source），没有 world-model/plan、simulation、choice、submission，最终预算中止。phase guard 没有改变模型的开放任务收敛性；当前结论仍为 **kernel-protocol-proof / no-adjudication**，下一步应以明确的用户 choice 或可验证目标重跑，而不是继续增加工具白名单。

### 2026-08-18 builder-direction-awareness

- **缺证据/缺方向、无显式提问指令**：V4 Flash 在 1 回合选择 `abort`，理由明确指出“无源码、无 oracle、无用户偏好，无法安全提交改进候选”。记录 `/chenzute/dsh-src/eval/run-records/2026-08-18-builder-direction-awareness-no-explicit-ask.json`。结论：能识别缺口，但不一定主动沟通。
- **可读源码 + 可仿真，但产品优先级不可推导、无显式‘请提问’指令**：V4 Flash 先读 actor source 与 requirements，第三回合主动调用 `request_input(kind=choice)`；问题为“需要用户确认哪一项优先级？”，选项为 throughput/ordering，带 `whyNow`、`evidenceRefs=[journal:5,journal:8]`、`blocking=true`，Kernel phase=`waiting_for_actor`。记录 `/chenzute/dsh-src/eval/run-records/2026-08-18-builder-direction-choice-no-explicit-ask.json`。
- 结论等级：**direction-awareness + actor-choice-protocol-proof**。Builder 已能在仍有可探索事实、但无法从证据决定产品取舍时主动向 Actor 请求选择；下一步是回传用户原话/selectedOption，resume 新 immutable run，验证它是否改变 hypothesis/nextIntent 并继续 simulation→submit。

### 2026-08-18 builder-direction-choice-resume-e2e

- 第一 run 在 3 turns/3 tools 后主动发出 choice；Actor 将用户原话“用户选择优先吞吐，但不得牺牲已定义的安全契约；请验证候选后继续”与 `selectedOption=throughput` 写入旧 run inbox，并创建新 immutable run，继承旧 run 的 workspace/journal/assets hash。
- 第二 run 首轮 `acknowledge_message` 的理解为“throughput-first while preserving the safety contract”，证明原话、选择和 Actor memo 都被 Builder 看见并正确解释。
- 但第二 run 在 8 turns/8 tools 内再次读取相同 source/requirements，仅执行一次无关 `probe`；没有 world-model/plan 更新、没有 workspace simulation、没有 submission，最终 budget abort。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-direction-choice-resume-e2e.json`。
- 结论等级：**choice-delivery-and-resume-proof / post-choice-convergence-failed**。当前瓶颈已从“能否发现方向不足”转为“收到选择后能否把选择转成公开 hypothesis/nextIntent，并立即进入实验和提交”。

### 2026-08-18 builder-prompt-visible-audit

- 新增 `BuilderKernel.recordPromptVisible()` 与每 run 的 `state/prompt-visible.jsonl`。记录脱敏 prompt 文本、原始 hash/bytes、state/phase、上一工具结果 hash、pending message ids；不记录隐藏思维链，且 `promptVisible` 纳入 previousRun 只读资产继承。
- 确定性测试：BuilderDriver/Kernel focused tests 19/19，随后 `npm run check`、`npm run build`、`git diff --check` 通过。
- 官方 V4 Flash 复跑：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-prompt-visible-audit.json`；prompt-visible 路径为 `/data1/chenzute/cache/tmp/dsh-loom-builder-simulation-DKknjv/workspace/simulation-loop/builder-runs/builder-1787050726389-8252ff57/state/prompt-visible.jsonl`。首轮已看到错误 actor source、requirements、完成定义和 capability；第 7/8 回合 prompt 明确带有 `newInformation=false`/`unchangedSinceSeq`。
- 行为：18 回合中 requirements 被读取 14 次、actor source 4 次，仍未 world-model/plan/simulation/submission。结论：重复 read 不是 Builder 看不到反馈；它在可见反馈明确无新增的情况下仍选择相同工具，属于模型 action policy/上下文注意力收敛问题。

### 2026-08-18 builder-progress-ab-comparison

- 实验开关：A=`BuilderDriver.progressBanner=true`，仅把“unchanged read”提示放到 prompt 末尾；B=`BuilderKernelOptions.repeatReadRejectAfter=2`，对相同目标/相同反馈的第 3 次 read 确定性拒绝。默认生产路径不启用。
- 同任务、V4 Flash、10 model turns/12 tool budget：
  - A：4 次 read、2 次 unchanged，0 simulation；产生 2 次 `write_submission` draft，但未执行最终 submit，预算 abort。
  - B：4 次 read、2 次 unchanged；`read_workspace_file` 第 3 次被 Kernel reject，之后模型转向 `write_workspace_file` 和 candidate workspace 读取，0 simulation/0 submission，预算 abort。
- 记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-progress-ab-comparison.json`。
- 结论：banner 是概率性文本提示，不能强制转向；Kernel reject 确实改变 action 分布（由重复 read 转向 workspace 写入），但还不能保证 simulation→submit。下一步应测试 reject 后要求公开 progress artifact（hypothesis/plan）是否能继续提高收敛，而不是把所有探索路径固定化。

### 2026-08-18 builder-compact-progress-state-real-run

- 目的：验证 `state/progress-state.json` 是否能在不把完整 actor/target/journal 灌入每轮 prompt 的前提下，帮助官方 V4 Flash 恢复方向并减少无进展读取。
- 实验：复用 `run-builder-simulation.mjs` 的故意错误 actor loop、同一 requirements/source/oracle，Builder 使用官方 `deepseek-v4-flash`，18 model turns/36 tool budget；代码先 `npm run build`，记录写入 `/chenzute/dsh-src/eval/run-records/2026-08-18-builder-progress-state-real-run.json`。本实验只创建隔离临时 workspace，未安装候选、未触碰 actor profile/生产服务。
- 结构证据：每回合 prompt 注入 compact progress state；原始 actor/target 只带 hash、keys 和可按需读取入口；journal 仅带尾部反馈；`prompt-visible.jsonl` 记录 progressStateVersion/hash。prompt 平均 **11,574 bytes**、首回合 9,479 bytes；此前同任务 prompt-visible 审计平均约 **12,859 bytes**、首回合 9,641 bytes，输入规模约下降 10%。
- 行为结果：18/18 model turns 和 18/18 tool steps；18 次均为同一 `read_file`，其中首两次有信息、后续 **16 次 `newInformation=false`**；未写 `world-model`/`plan`，未调用 simulation，未写/提交 proposal，最终 `builder model-turn budget exhausted`。最终 progress state 如实落盘 `unchangedReadStreak=16`、`state=aborted`、`lastAction=abort`。
- 结论等级：**context-reduction-and-state-audit-proof / action-convergence-failed**。状态表已经成为持久记忆和 Actor 可见状态，但仅注入状态没有改变该模型的 action policy；不能宣称减少了重复读取或带来 loop 性能提升。下一步只做受控实验：将 kernel 的无进展反馈与 progress artifact 绑定，比较是否进入 simulation→submit，再决定是否默认开启重复读取负向约束。

### 2026-08-18 builder-progress-checkpoint-real-run

- 实现：新增默认关闭的 `BuilderKernelOptions.enforceProgressCheckpoints`。当 `repeatReadRejectAfter=2` 触发连续无新信息读取拒绝时，公开 `progress-state.json.progressRequirement`；先要求 `declare_direction`（`world_model.hypothesis + nextIntent` 或 `plan`，也可提问/提交），再要求 `produce_evidence`（simulation、workspace 命令/编辑、提问或提交）。不满足的动作被 fail-closed，原因同时进入 journal 和下一回合 prompt。新增 `allowLoopCandidates.repeatReadRejectAfter` / `enforceProgressCheckpoints` 配置，默认值分别为 `0` / `false`，不改变生产默认自由探索。
- 确定性验证：Kernel 测试 **15/15**；随后 `npm run check`、`npm test` **159/159**、`npm run build`、`git diff --check` 均通过。测试证明 checkpoint 只在实验开关开启且无进展后生效，能按 `declare_direction → produce_evidence → none` 恢复。
- 官方低预算复跑 A（12 turns/24 tools/2500 maxTokens）：记录 `/chenzute/dsh-src/eval/run-records/2026-08-18-builder-progress-checkpoint-real-run.json`。V4 Flash 在重复 read 被拒后实际完成 `write_world_model → baseline simulation → candidate simulation`，而不是继续读；但候选仿真因未生成 actor-loop 文件而失败，最终 12 turns 预算中止，无 submission。
- 官方复跑 B（18 turns/36 tools/2500 maxTokens，同一开关）：记录 `/chenzute/dsh-src/eval/run-records/2026-08-18-builder-progress-checkpoint-real-run-18.json`。工具链为 3 次 `write_world_model`、3 次 simulation（均执行并有 passed/failed 反馈）、4 次重复读取拒绝；仍未写 workspace candidate 或 submission，最终预算中止。它证明 checkpoint 能把模型从纯 read 死循环推入“公开假设→仿真”，但不能保证语义上有效的候选或交付。
- 诊断：尾插原始 error、纯 prompt banner 和强制单一工具都不足以保证语义收敛。确定性节点适合强制“可审计动作类别/产物存在”，不适合替模型决定候选内容；simulation capability 过于通用时，模型会以低价值 `fixture.mjs` 仿真满足动作要求。下一步应先改进 simulation 输入与候选 artifact 的关联审计，再评估是否需要更硬的 candidate-edit→candidate-simulation→submission 证据节点；不能把本轮计为真实演进或性能提升。

### 2026-08-18 tycho-builder-source-comparison

- 源码核查范围：`tycho/agent/builder.py`、`tycho/agent/dispatcher.py`、`tycho/agent/wm_signal.py`、`tycho/workspace/agent_tools.py`、`tycho/agent/agent.py` 与 Builder prompt/tests。
- 关键事实：Tycho 没有重复 read reject、phase 白名单或强制下一工具。它用“单一可证伪目标 + pass 开始自动 verify diagnosis + 语义编辑后立即反馈 + bounded pass/fresh report + 外部 divergence trigger”形成循环。持久记忆是 `world_model.py`、`notes/world_model.md`、`world_model_report.md`，不是每轮回放完整工具日志。
- 迁移结论：Loom 不能照搬 Tycho 的窄目标（我们还要候选、verifier/gate 和真实 replay），但应先做 `evidence-diagnosis → bounded Builder pass → fresh report → external re-trigger` 的结构实验。当前二级断路器只保留为默认关闭的保险丝，暂不继续增加 phase 节点；本次比较未改变生产路径。

### 2026-08-18 multi-agent-loop-patterns-review（只读）

- 审阅范围：本地 Prime Agent 的 RLM/harness/refine/daemon 文档与实现；OpenHands SDK 的 event-sourced conversation 和 `StuckDetector`；SWE-agent 的 action-observation、reviewer/retry；LangGraph 的 persistence/interrupt/time-travel 文档；AutoGen `BaseGroupChat` 的 termination/pause/resume/state。学习文档：`docs/research/builder-loop-patterns-comparison.md`。
- 核查结论：重复工具调用不等价于“没有反馈”，而是可见性、信息增量、语义推进、交付推进四层中的语义推进失败。纯 prompt 尾插是概率信号；单一 Kernel reject 只能改变动作分布，不能保证候选语义收敛。
- 建议的 Loom 结构保持 Builder 开放探索和 verifier/gate 独立：pass 启动有确定性 diagnosis；pass 内有预算和 candidate-linked feedback；结束必须产生 fresh report/proposal/needs_input/abort；stuck 由 Controller 按 action+observation 模式诊断后结束 pass；只有外部 divergence/rejection/用户新方向创建新 immutable attempt。未修改运行时代码或测试。

### 2026-08-18 pass-diagnosis-spec

- 将 pass 入口明确为 `evidence-diagnosis`，不是泛化问题列表：允许多个 secondary observations，但必须选择一个 `primaryObjective`。
- 诊断字段固定为 symptom、problemClass、scope/baseline hash、firstDivergence、evidenceRefs、successCriteria、nonGoals、unknowns、passBudget 和 fresh exit；“loop 更智能”必须先翻译为收敛、任务成功、延迟/成本或可用性中的一个可观测目标。
- 本轮只改规格与交接文档；没有运行模型、没有修改 Builder 代码。
- Pass 责任边界补充为“固定外壳、可维护内核”：治理合同由 Controller/Actor/Verifier 固定，Builder 只能版本化维护 working diagnosis；target、验收标准、预算或安全边界变化必须通过 `diagnosis_revision` 进入 choice 或新 immutable pass。
- 根据用户方向补充 diagnosis-first：对“更智能/全面优化”等开放请求，先产出带 evidence/unknowns/cost 的 1–3 个候选方向，再通过 Actor 向用户询问；选择后创建 implementation pass。无明确目标时允许再次询问，但采用小上限并在无答案时暂停，不反复读文件。

### 2026-08-18 diagnosis-first 实装与官方低预算审计

- 实装：`BuilderRunMode` 增加 `diagnosis | implementation`；diagnosis run 只允许 `write_diagnosis_report`，报告要求 1–3 个方向、每方向 evidenceRefs/unknowns、带 whyNow/evidenceRefs/至少两个 options 的 blocking question。报告写入后落 `state/diagnosis-report.json`、发 `diagnosis_report` event、进入 `waiting_for_input`；diagnosis pass 禁止 proposal/submit。`LoopCandidateGateway` 把 report 投影到 `meta_builder_status`，用户回复后 `resumeExploration` 创建同 lineage 的新 immutable `implementation` run，并继承前 run 的只读资产和用户原话。
- 确定性闭环：新增 Kernel、Driver 与 Gateway 测试覆盖报告结构、禁止诊断提交、模式专属完成合同、Actor 可见投影、用户选择→新 implementation run→proposal freeze；`npm run check`、`npm test` **162/162**、`npm run build`、`git diff --check` 均通过。
- 首次官方审计（同任务、V4 Flash、thinking disabled、6 turns/8 tools/1200 maxTokens）暴露了真实实现缺陷：Builder 5 次读（3 次无新信息）后预算 abort，未写 diagnosis report。`prompt-visible.jsonl` 证明原因是 Driver 在 diagnosis prompt 内同时保留通用的 `write_submission→submit` 完成定义和 proposal/submit 示例，和 diagnosis-only 合同冲突；不是缺少 actor source 或报告工具。
- 修正：将完成定义、硬性回合规则、示例和 capability 交付文案按 run mode 分支；diagnosis prompt 只保留 `write_diagnosis_report` 作为完成出口，Kernel 也拒绝 `write_submission`。这不限制 implementation run 的自由探索，也不让 Kernel 决定认知路线。
- 修正后同预算官方复跑：4 turns/4 tools：`acknowledge_message → read requirements → read actor source → write_diagnosis_report`；0 次无新增读取，产出 task-success/convergence/latency 三个方向和三选一问题，正确进入 `waiting_for_input`。原始 record：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-diagnosis-first-official-low-budget.json`；完整 A/B：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-diagnosis-first-prompt-contract-ab.json`。
- 结论等级：**diagnosis-and-user-alignment-improvement**。它明确改善了开放请求的方向收敛与用户对齐；尚未跑用户选择后的官方 implementation pass，故不宣称 proposal、verifier/gate、安装、actor task 成功或 loop 性能提升。

### 2026-08-18 compact-prompt + context-index 快速审计

- 实验性实现：每个 Builder run 新增不可变 `state/context-index.json`，列出 actor/target/inbox/journal/progress/world-model/plan/previous-run/events/workspace/submission 的地址与一行概述；`read_input(context_index)` 可按需读取。新增 `BuilderDriver.compactPrompt`，只注入系统流转/通讯/权限规则、最小 JSON tool protocol、index 入口、pending Actor 原话、progress state 和 feedback hash；不再回放原始 snapshot、长 capability 描述、完整 index 或 task 正文。默认未开启。
- 协议审计：首次 compact 复跑暴露 V4 Flash 使用 `{tool,input}` 和 `{name,input}` 两种等价包装，而旧 parser 只支持字段平铺，造成工具意图被误判。已兼容三种无语义差异的 JSON 包装，并以 Driver 回归测试覆盖；这不是扩大 Builder 权限。
- 官方真实复跑：同一“顺序安全 vs 吞吐”模糊用户请求、V4 Flash、thinking disabled、7 turn 上限。prompt 从此前约 12–13KB 降至最终 **3,386–3,839 bytes**。模型能够读取 requirements、确认 Actor 原话并读取 actor snapshot，但仍在 7 turns 内重复 `read_input(actor)`，未发 `request_input`，最终预算 abort；无 workspace edit、proposal、verifier/gate 或安装。完整记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-minimal-user-guided-ambiguity-to-implementation-official.json`。
- 结论等级：**context-footprint-reduction / communication-convergence-not-improved**。索引方案有效减少约 70% prompt bytes，且恢复了 compact JSON 协议互操作；但单一该变量未使 Builder 在此模糊任务中自主提问，不能默认开启或宣称性能/任务提升。下一步应将“为什么当前证据不足、可问的具体问题”作为 Actor evidence pack 的显式事实，再与保持自主选择的 Builder prompt 做一次独立对照；不能用强制 `request_input` 掩盖该缺口。

### 2026-08-18 builder-short-context-progress-checkpoint-closed-loop-official

- 目的：在不灌入全量 snapshot/journal 的前提下，给定一个明确、可证伪的严格依赖顺序目标，观察 `compactPrompt + repeatReadRejectAfter=2 + enforceProgressCheckpoints=true` 是否能完成候选→oracle→submission；实验操作者由 Actor 角色扮演用户并在公开停滞后介入。
- 运行记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-short-context-progress-checkpoint-closed-loop-official.json`。隔离 fixture 为错误的 `Promise.all` actor loop、严格顺序 oracle 和 proposal contract；未触碰 live actor/profile/生产服务。
- 为保持实验有效，补上四个确定性协议缺口：compact prompt 注入最近一条 1.2KB 工具反馈；`input`/`params` wrapper 归一化；首个完整 JSON 对象容错尾随 `}`；无参数 workspace command 合法。无新增权限或强制认知路线。
- 初始 run（6 turns）触发无进展拒绝，Builder 写出公开 plan 但仍未候选；用户观察后按真实协议创建 immutable resume run，并转交原话要求停止重复读取、编辑候选、运行 oracle 后提交。
- resume run 成功写出 `actor-loop.mjs`，但真实 oracle 失败：`TypeError: run is not a function`。该失败被记录为 rejection feedback 并尝试新 run；最终 run 在重复目录探索中预算耗尽，没有修复、`write_submission`、proposal、verifier/gate/install 或 replay。
- 结论：**short-context-observation-and-user-retrigger-proof / candidate-edit-observed / oracle-repair-and-submission-failed**。断路器阻断无进展读并促成公开 plan；用户指导能促成候选编辑；两者都不能保证候选语义正确或交付收敛。本记录不是 loop 性能提升证据。

### 2026-08-18 builder-oracle-rejection-fresh-pass-convergence-rate-official

- 独立测量 3 个 fresh immutable repair runs；每个起点均为真实 oracle rejection：候选导出 `runActorLoop`，oracle 要求 `run`，错误为 `TypeError: run is not a function`。
- 配置：V4 Flash、thinking disabled、compact prompt、`repeatReadRejectAfter=2`、`enforceProgressCheckpoints=true`、每个 pass 最多 20 model turns / 40 tool steps / 2400 maxTokens。
- 成功定义：新 workspace candidate + oracle exit 0/`strict-order-pass` + `write_submission→submit`。verifier/gate/install 不计入本指标。
- 记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-oracle-rejection-fresh-pass-convergence-rate-official.json`；结果 **0/3，0%**。三次均 `aborted` at 20 turns，candidate=false、oracle未运行、proposal=false；unchanged-read rejection 分别为 5、4、4 次。
- 动作审计：Builder 反复读取 `previous_attempt`/`actor`，偶尔写 world-model/plan，但没有进入“读取旧候选→编辑导出→运行 oracle”链路。20 回合预算已足以排除单纯回合不足解释。
- 结论：rejection 回注的持久化链路存在，但当前模型对 rejection 的语义修复收敛率为 **0%**；断路器是停滞保险丝，不是修复规划器。不能据此宣称 Builder 已具备 Tycho 式失败后自我修复能力。

### 2026-08-18 builder-oracle-rejection-fresh-pass-thinking-enabled-official

- 归因复验：保持同一 oracle rejection、fresh immutable run、20 turns/40 tools 与 compact context，只把官方 V4 Flash `thinking` 显式设为 `enabled`，maxTokens 提高到 4800。记录：`/chenzute/dsh-src/eval/run-records/2026-08-18-builder-oracle-rejection-fresh-pass-thinking-enabled-official.json`。
- 结果 **0/1**：没有 candidate、oracle 或 proposal。动作比 disabled 多出 context-index 读取和一次 workspace command 尝试，但 command 被输出为 `find . -maxdepth 3 -type f | sort` 的单个 executable；Kernel 的 argv-only runner 返回 `spawnSync ... EACCES`。随后模型回到 index/world-model/repeated-read 回路。
- 解释边界：此结果不等于 V4 Flash 不能修复 `export run` 这个简单 bug；它表明打开 thinking 仍不能自动弥补当前 agent 的候选定位、shell/argv 工具表达与 repair-action policy。默认生产/常规 Builder 路径仍关闭 thinking。

### 2026-08-19 artifact-provenance-navigation-foundation

- 问题定义：此前 `previous-attempt.json` 已持久化 rejection，但错误文本没有成为可查询的“consumer → actual input → producer/prior run → source interface”关系；官方 repair runs 因而未被证明能从 `run is not a function` 自主定位旧 candidate。
- 上游审计：Tycho `f68912a`（Apache-2.0）提供 schema-first tool/verify-state/semantic-edit feedback 原则，但不是通用成品 agent；本机 Prime Agent `97b994c3d7c45ca1ae635190e91e9e58ddf2577c`（MIT）是开放 Builder runtime 的后续 adapter 参考。尝试浅拉 OpenHands 官方仓库时远端 HTTPS 传输无进展，已终止临时 clone，未引入半成品或第三方代码。
- 实装：新增 `src/builder/provenance.ts` 与每 run 的 `state/provenance.json`。图只记录 factual artifact/edge：actor handoff、target-before、failure report、prior run/assets、workspace、source、candidate、submission、verification report 与 `consumes|produces|tests|reports_on|derived_from`；ID 由 role/path/hash 稳定生成。
- 工具：新增 `trace_artifact`、`inspect_file`、`search_text` 与 `read_input(provenance)`；`search_text` 使用 argv 形式 `rg`，不会把 shell pipeline 当 executable。compact prompt 只投影 graph 入口和 failure/candidate IDs，完整图按需读取。系统纪律只要求错误先作为 artifact 指针被追踪，不给出修复结论，也不强制 Builder 经过固定 phase。
- 确定性验证：新增 rejection→candidate trace、exports/interface inspect、search、compact-protocol schema 回归；`npm test` **172/172**、`npm run check`、`npm run build`、`git diff --check` 均通过。没有运行官方模型、没有触碰 profile/生产环境。
- 结论等级：**causal-navigation-contract-proved / model-repair-convergence-not-yet-measured**。下一次官方对照必须只提供 rejection + graph（不直接提供 export 修复答案），测量 `trace → inspect → edit → oracle → submit` 是否完成。

### 2026-08-19 builder-oracle-rejection-provenance-convergence-rate-official

- 直接复测 V4 Flash（未先跑新的 baseline）：3 个独立 fresh immutable repair pass；每个 pass 先构造失败 candidate `runActorLoop`，由真实 Node oracle 产生 `TypeError: run is not a function`，原 run 提交后由 `reopenFromRejection` 创建 repair run。图中确定性存在 failure→candidate `consumes` 与 oracle→candidate `tests` 边；未把 `export run` 作为 prompt repair card 注入。
- 配置：`deepseek-v4-flash`、thinking disabled、compact prompt、20 model turns/40 tools/2400 maxTokens、`repeatReadRejectAfter=2`、`enforceProgressCheckpoints=true`；新增变量仅是 provenance graph 和 `trace_artifact`/`inspect_file`/`search_text`。
- 记录：`/chenzute/dsh-src/eval/run-records/2026-08-19-builder-oracle-rejection-provenance-convergence-rate-official.json`。成功条件：workspace candidate 存在、oracle exit 0/`strict-order-pass`、proposal 存在且 Builder state submitted。
- 结果：**0/3，0%**。三次 repair run 都读取 `read_input(provenance)`（2/3 首轮），所有 prompt-visible 均有 Artifact/provenance graph 和 failure IDs；但 causal actions 全为 false：没有 trace、inspect、search、workspace edit、oracle command 或 submit。分别 20 turns/17 tools、20/16、20/15 后 budget abort。
- 动作序列不是纯无反馈 read：以 `read_input(provenance|actor|context_index)` 后反复 `write_world_model` 为主，说明 V4 Flash 看见图谱仍没有将其采纳为新的 action primitive。此次不能把“图谱存在”误报为 repair 策略提升。

### 2026-08-19 rejection-facts-in-prompt（失败事实直灌修复）

- 审计 0/3 根因：compact prompt 只给图谱指针（failureIds/candidateIds）与 feedback index（hash），`TypeError: candidate.run is not a function` 原文只存在于 `input/previous-attempt.json`；三次 run 均未读 previous_attempt、未 trace，**模型从未看见问题原文**，动作退化为 read_input(actor|provenance|context_index) → 同一 hash 的 write_world_model。
- 修复：`BuilderDriver.compactPrompt` 在存在 rejection 时注入 `Previous attempt rejection (facts, not pointers)`：verdict、failureSummary（≤1200 字符）、firstDivergence、previousCandidatePath、oraclePath，并显式指示"修复 previousCandidatePath 使其满足 oracle，然后运行 oracle 并提交"。
- 测试：新增 compact prompt 失败事实单测；全量 **173/173**、check/build/diff-check 绿。
- 状态：尚未跑 V4 Flash A/B，不宣称修复收敛已改善；下一步用同一 fixture 单跑一次 fresh repair pass 对照。

### 2026-08-19 rejection-repair-convergence-1of3（失败事实+路径语义+终态信号 复测）

- 复测序列（同一 fixture、20 turns/40 tools/2400 tokens、thinking disabled、compact prompt）：
  1. 仅加 rejection facts：**0/3**。模型写 world model 明示"候选没导出 run，需修复"，但三次 `write_workspace_file` 写上一轮绝对路径全部被拒（workspace escapes）。
  2. 加 prior-workspace 路径映射：**0/3**，但第 3 次编辑成功；文件落成 `workspace/workspace/actor-loop.mjs`（提示语误导"workspace/actor-loop.mjs"为相对路径）。
  3. 加 `workspace/` 前缀归一化 + 提示改为 `actor-loop.mjs`：**0/3**，2/3 写出正确候选且 post-check oracle `strict-order-pass`；但成功后模型直接 `submit`，缺 draft 的报错被 driver 静默吞掉，5 次 submit 全部失败。
  4. 加 submit 决策错误回显 journal：**1/3（33%）**——第 2 次完整闭环：修复导出 → oracle exit 0 `strict-order-pass` → write_submission → submit，proposal 带 evidence；第 1 次仍重复读取、第 3 次反复编辑+重跑 oracle（最终文件被覆盖成坏候选）未提交。
- 四个确定性修复：compact prompt 注入 rejection facts；prior-run workspace 绝对路径映射到当前 run；`workspace/` 前缀归一化（含 read/write 结果返回归一化相对路径）；driver 对 submit/continue 等决策错误落 journal 反馈（不再静默）。
- 记录：`run-records/2026-08-19-builder-oracle-rejection-{facts,workspace-map,workspace-normalize,ready-to-submit,submit-feedback}-convergence-rate-official.json`；成功样本 `submit-feedback` 记录 attempt 2。
- 结论：收敛从 0% 到 33% 的增益来自"问题可见 + 工具路径语义正确 + 失败反馈可见"，不是提升回合数；剩余失败模式是模型在成功信号后仍继续编辑/覆盖候选，提交纪律仍不稳。
- 结论等级：**causal-navigation-visible / causal-navigation-adoption-failed / repair-convergence=0%**。下一诊断应分析完整 provenance artifact 的表征与 runtime action surface；不要再以更多 token、更多尾插文本或更多固定 checkpoint 掩盖该失败。

### 2026-08-19 marker-verified completion guard

- 观察到的唯一剩余失败是：Builder 在自己的 `run_workspace_command` 已返回 `strict-order-pass` 后，仍继续写 workspace，最终覆盖已通过的候选。该状态不是普通探索 phase，而是任务声明的可验证成功条件。
- 实装：`successMarker` 命中使 run 进入 `ready_to_submit` 后，Driver 只接受 `write_submission`、`submit` 或 `abort`。其它决策不执行、不触碰 workspace，并以可见 journal error 回给模型；若要继续实验须从外部开 fresh immutable run。这样既保留成功前的开放探索，也不让成功后无意义编辑破坏已验证内容。
- 确定性回归：`oracle pass → write_workspace_file(overwrite) → write_submission → submit`，覆盖写被拒、proposal 正常冻结并提交；全量 `npm test` **178/178**、`npm run check`、`npm run build`、`git diff --check` 通过。
- 官方 record：`/chenzute/dsh-src/eval/run-records/2026-08-19-builder-oracle-rejection-completion-guard-convergence-rate-official.json`，同配置 fresh 3 pass。它不构成 Guard A/B：三次都没有发生“Builder 自己看到 marker 成功后还要编辑”的前提；第 3 次的成功仅由外部 post-check 发现，Builder 没有运行 oracle。因此记录的 0/3 不可解释为 Guard 无效或模型回归，停止继续请求，待采用强制触发该前提的独立对照。

### 2026-08-19 real-agent-loop-delayed-prepare-builder-observation

- 新的真实 package oracle 在每个 immutable Builder workspace 物化完整 pinned DSH archive，并注入 `packages/core/agent-loop/tests/delayed-prepare-regression.spec.ts`。基线确定性失败：`parallel-safe prepares were serialized: second prepare never entered before the first gate`。这不是 fixture candidate；目标与候选范围仍是实际 `packages/core/agent-loop/src/tool-calls.ts`。
- 修复两个工具语义缺口：host-assigned、格式受校验的 run id 让 immutable actor/target 从创建时绑定自身 workspace；`read_file`/`list_directory` 的相对路径现在以 Builder workspace 为基准，绝对路径仍保持全局只读。工具失败回显已包含已解析路径。
- 新增通用 `apply_workspace_patch`：Builder 可用 standard unified git diff 对其 workspace 做最小改动；Kernel 先 `git apply --check` 后应用，并保存 patch snapshot。它不是领域路线或 verifier 绕过，proposal 仍须经现有 importer/verifier/gate。
- 官方 V4 Flash fresh run `builder-1787101206741-969c8d44`（30 turns/30 tools）仍 **未编辑、未 proposal、未进入 verifier/gate**。它复现 delayed-prepare failure、读到真实 workspace 源码并写出正确假设，却持续在 regression command 与 source reads 间循环，未调用新 patch tool。
- 结论：本轮证明并补齐了真实任务的 workspace/path/edit-tool 基础合同；没有证明该模型在复杂调度重构上自主收敛，更没有性能、安装或 gate 声明。下一步应比较成熟 coding-agent runtime/adapter 的 action policy，而非再累积 prompt 或 phase 特例。

### 2026-08-19 terra-loom-builder-transport-probe

- 接入：新增极小 OpenAI-compatible JSON/SSE transport；`gpt-5.6-terra` 作为可选 `llm.provider`，只从进程环境读取 key，不落盘。该分支不发送 DeepSeek 专有的 `thinking` 字段；该供应商的 SSE 对复杂请求未及时首 token 时可明确采用 non-streaming JSON fallback。所有 Builder/Kernel/verifier/gate 权限边界保持不变。
- 兼容性：`/v1/models` 显示实际 ID 为 `gpt-5.6-terra`，而非 `openai/gpt-5.6-terra`；后者返回 `model_not_found`。无流式 `response_format=json_object` 短 ping 2.5 秒返回 `{ok:true}`。
- 真任务尝试：同一真实 `delayed-prepare-regression` Builder run（真实 `tool-calls.ts`，20 turn/36 tool/1600 token）在非流式 fallback 的第一复杂 decision 约 30 秒仍未返回，已人工取消以避免无界消耗。没有 model decision、工具调用、源码 edit、proposal、verifier、gate、install 或性能声明。
- 留档：`/chenzute/dsh-src/eval/run-records/2026-08-19-terra-loom-builder-transport-probe.json`。结论是 **short-request transport works / real Builder proposal-to-gate not evaluated due provider latency**，不是 Terra 能力失败或 Loom 链路失败。

### 2026-08-19 terra-native-decision-real-builder-observation

- 受控定位：同一约 7KB Loom prompt 移除 `response_format=json_object` 后，Terra 约 5 秒能生成合法 `run_workspace_command` decision；原生 `builder_decision` function-call probe 约 4.7 秒返回相同动作。结论是该网关的 constrained JSON decoding 对复杂 Builder 请求严重延迟，而非输入长度或模型不可用。
- 实装：OpenAI-compatible adapter 增加 provider capabilities：Terra 使用 non-streaming response、无 `response_format`、一个通用 `builder_decision` native function；函数参数 `{decision:{…}}` 在 Driver 解包后仍走原有严格 JSON/allowlist 校验。它不向模型授予 Kernel 工具以外的权限，verifier/gate/install 边界不变。
- fresh run `builder-1787115999050-f2a0741b`：20 model turns/20 tool steps 后 budget abort；实际完成 delayed-prepare regression 复现、真实 `tool-calls.ts` 读取、journal 读取、world model 写入并明确正确 hypothesis。未编辑、未写 proposal，故未进入 verifier/gate/install。
- 事实性新缺口：模型尝试 `search_text` 时，Kernel 返回 `search_text requires at least one available root`；workspace-relative source root 没有可用默认根。此为通用 discovery 工具合同问题，下一轮应修复并以 fresh run 测量，不能人工代替 Builder 写候选。
- 验证：新增原生 function envelope 的 Driver 单测；全量 **181/181**、`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-19 terra-native-decision-search-root-rerun

- 修复：`search_text.roots` 的相对路径现与 `read_file/list_directory` 一致，从 Builder immutable workspace 解析；绝对路径仍是全局只读。新增相对 `src` root 回归。
- fresh run `builder-1787116500737-5d93a8fd`：native action、真实 baseline regression、真实源码 read 均完成；此前失败的 workspace-relative `search_text` 本次 **exit 0**。模型再次写出正确 hypothesis：不要 await 每个 `startCall/prepare`，而是启动 preparation lifecycle 并保持 cap/ordered commit/barrier。
- 结果：仍为 20 model turns/20 tool steps budget abort；无 edit、candidate、proposal、verifier、gate、install 或性能结论。由此排除 transport、文本/原生工具可见性、native envelope、workspace path、search root 五类确定性断链；剩余是该模型在真实调度重构上的 edit/submit 行动策略未收敛。停止本轮请求，不能以手工修复替代 Builder。
- 验证：全量 **182/182**、`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-19 workspace-loop-submission-compiler

- 收敛性减法：Builder 不再需要手填 builder-generated `beforeHash`、完整 edits、package/build 元数据。首次 workspace 写入或 unified patch 前，Kernel 保存对应原始源码快照；`compile_loop_submission(rationale, expectedOutcome?)` 只可用于 loop_candidate，并从快照与当前 workspace 确定性生成完整 `loop-evolution` proposal。
- 安全边界：只收集 `packages/core/agent-loop/src/**/*.ts`、最多 4 个真实变更；仍要求 actor target-before 的 40 位 baseline commit。Compiler 只冻结 proposal；CandidateImporter 仍重新校验 hash/路径/大小、构建，独立 verifier/gate 仍拥有唯一放行权。
- native transport：当前工作树已具备每个 Builder 工具的 OpenAI function schema，Terra 返回的真实 function call 会被转换为同一 JSON decision，再走原先严格 allowlist；不是 generic `builder_decision` 的特权旁路。
- 覆盖：新增 workspace edit → compile → submit → proposal 断言；全量 **183/183**、`npm run check`、`npm run build`、`git diff --check` 通过。下一次真实 Terra fresh run 应测 `edit → regression → compile_loop_submission → submit`，仅提交成功后进入独立 verifier/gate。

### 2026-08-19 terra-workspace-compiler-fresh-run

- fresh `builder-1787122031074-1db65f36` 使用 per-tool native functions 和新 task contract：测试通过后仅需 `compile_loop_submission(rationale)`，不再要求模型手写 hash/manifest。
- 结果仍为 20 model turns/20 tool steps budget abort：真实 baseline regression、源码读与正确 hypothesis 均发生，但没有 workspace edit、测试通过、compiler、proposal 或 submit。
- 归因：compiler 已通过确定性 edit→proposal 回归，但在这次真实任务从未进入其前提；当前瓶颈明确是 **hypothesis → edit action policy**，而不是 delivery protocol、verifier/gate 或 Terraform transport。不得进入 verifier/gate，更不能宣称性能提升。

### 2026-08-19 terra-40turn-action-policy-control

- 受控变量：保持同一真实 delayed-prepare task、native per-tool functions、workspace compiler、512 output token；只将预算从 20 model turns/36 tools 提至 **40 model turns/64 tools**。
- fresh `builder-1787122252477-689953e7`：40 model turns/40 tool steps 后 budget abort；持续正确陈述 `fillPool await startCall` 串行化 prepare 的 hypothesis，并重复真实 regression/source/journal 行为。
- 关键负结果：**0 workspace edit、0 target regression pass、0 original suite pass、0 compile_loop_submission、0 proposal**。因此预算不足不是这条任务的充分解释；不能再用加回合、加 token 或 submission 提示解释/掩盖 action-policy 停滞。
- 后续方向：若继续，应换用成熟 coding runtime 的动作/trajectory policy，或做原生工具 surface 的独立 A/B；不能把外部 runtime 的 patch 包装为 Loom Builder 自主 proposal。

### 2026-08-19 terra-per-tool-native-schema-rerun

- 实装：BuilderDriver 现在把每项 base action（read/search/inspect/workspace patch/command/submission/submit/abort 等）作为独立 OpenAI function schema 传给支持该 surface 的 transport；Terra response 的 function name + arguments 确定性转换回原 decision，再接受 Kernel 同一 allowlist 校验。没有把执行权移进 adapter。
- fresh run `builder-1787118050503-6f31c089`：首步不同于前两次，先以 `write_world_model` 写出正确 delayed-prepare hypothesis，后续使用真实 regression command、source read、journal/context input；中途一次 `inspect_file` 返回 file unavailable。20 turns/20 steps 后仍未 edit 或 proposal。
- 结论：per-tool native schema 证明可用，并改变了动作选择，但没有让该复杂 package 重构在本预算内收敛。此后不应继续以 prompt/工具表面补丁掩盖结果；需要比较成熟 coding runtime 的 planning policy，或换一个由 Builder 自主选择的更小、可验收 pass。无 verifier/gate/install 或性能声明。

### 2026-08-19 mini-swe-runtime-real-scheduler-adapter-probe

- 同一 pinned DSH archive、同一真实 `delayed-prepare-regression.spec.ts`、同一原有 `tool-calls.spec.ts` 对照。mini-SWE-agent（Terra）在自身 8 个 action 内完成：复现基线失败、读取实际 scheduler、编辑 `packages/core/agent-loop/src/tool-calls.ts`、让新增回归通过；随后主动将新增回归与原 suite 一起运行，发现 `failure quiescence` 反例（不应在另一 slot failure 后启动 tool body），再根据该反馈增加 prepare 后 failure check。
- 最终 host 独立复跑两个测试文件：**22/22 pass**。轨迹：`/chenzute/dsh-src/eval/real-agent-loop-builder/workspace/real-agent-loop/builder-runs/builder-1787122877676-a2635cb1/mini-swe-agent-trajectory.json`。这是实际 `diagnose → edit → test → regression repair` 的正证据，不是人工候选。
- Kernel 由该 workspace diff 编译 proposal 后，独立 CandidateImporter 正确拒绝：Compiler 的 `beforeHash` 对字符串使用协议 `sha256(JSON.stringify(value))`，Importer 按原文件 bytes 验证，故发生 `beforeHash mismatch`。这暴露的是 Loom compiler/importer cross-boundary 合同漏洞，不是 mini-SWE 模型编辑错误。
- 已修复 Compiler 使用 raw file-content SHA-256，并增加回归断言；全量 **183/183**、check/build/diff-check 通过。旧 proposal 不得手改 hash 复用；必须以新 immutable mini run 重新生成 edit→tests→compile→submit，Importer 接收后才能做 C0–C8/C6、冷 gate、回滚和 replay。
- 修复后复跑曾因当前进程没有可用 Terra API credential 而在调用前失败；没有把 supplied key 写入任何文件或记录。故该条目的正式候选/importer/gate 状态仍为 **未证明**。

### 2026-08-19 mini-swe-runtime-real-scheduler-e2e

- 新 fresh immutable run `builder-1787123618188-d57a45a7` 在同一真实任务完成自主闭环：baseline delayed-prepare fail → 读真实 source/tests → edit `tool-calls.ts` → focused oracle pass → 原 `tool-calls.spec.ts` + oracle **22/22 pass** → runtime 完成意图。模型总 11 actions；一次对 archive workspace 的 `git diff` 无效被工具反馈后，仍正确完成，没有人工改候选。
- 提交链路：Kernel 从 run 的 immutable before/after snapshot 生成 builder-generated proposal；CandidateImporter 以 pinned `47f943859bef60e4160492346772ded9b24f765a` 重新 materialize、精确 before-hash 校验、无网络 bwrap build，成功 stage。旧 Compiler 使用 protocol `sha256(JSON.stringify(string))`、Importer 使用 raw bytes 的不兼容已修复，旧 proposal 未复用。
- 构建/运行环境的两项真缺口均保持 fail-closed：host DSH `node_modules` 的顶层 pnpm link 指向旧 eval path；git archive 又不带 vendor generated types。评测为明确的 read-only dependency+vendor snapshot 构建，并用 host 已构建 checkout 的 Node+tsx CLI entry 做 cold Loader runtime；不让 builder workspace 兼任 actor runtime。
- 完整 contract report：`meta-workspace-mini-swe-agent-e2e-20260819/runtime/reports/builder-1787123618188-d57a45a7-contract-4.json`，**C0/C1/C2/C3/C4/C6/C7/C8 全 pass**，candidate actor exit 0。修复 runner C6：`allPass` 字段存在不再等于 pass，必须匹配 `"allPass": true`；`fromzero-verify` 可继承 verifier 的 `DSH_CMD`/`DSH_CWD`，避免 pnpm dependency-status repair 伪失败。
- 独立 state machine 与 gate：`staging → pending → verified → approved → installed`，cold Loader C0 smoke pass。same-task replay baseline/installed 都输出 `ok`（29,997ms / 29,297ms）；comparison admissible，但一对单样本不构成性能提升结论。cold rollback 后 profile home 不存在、CLI 明确拒绝该 profile、registry 回到 `approved`。
- 结论：mini-SWE-agent 是当前最合适的 Builder **execution runtime**；Loom 继续拥有 candidate compiler、independent verifier/gate 与 rollback。正式产品接入仍需将 runtime 的 source materialization 和 self-contained build snapshot 显式配置化，不能把 eval command 当作默认运行路径。

### 2026-08-19 mini-swe-candidate-prepare-overlap-measurement

- 为避免错把“pool cap 10→20”的旧性能协议套到并未修改 cap 的当前候选，针对实际 diff 做了隔离、无 profile 安装的因果测量。baseline 与 `builder-1787123618188-d57a45a7` 各在 immutable workspace 运行 5 次；2/4/8 个 parallel tools、pool cap 等于 calls 数、每个 `prepare()` 固定 100ms、body 为 0ms。
- `prepare` 首至末进入 span 的中位数：baseline **102.1 / 304.5 / 707.2ms**；candidate **0.55 / 0.76 / 1.41ms**。两侧均到达全部 prepare；candidate 的 delayed-prepare oracle 与原 `tool-calls` suite 再次为 **22/22 pass**。
- raw record：`/chenzute/dsh-src/eval/run-records/2026-08-19-mini-swe-prepare-overlap-benchmark.json`；审计及范围说明：`docs/research/2026-08-19-mini-swe-runtime-evidence-audit.md`。临时 benchmark fixture 在测量后删除，未改变 profile、生产或候选源码。
- 结论严格限为：**Builder 自主候选修复了真实 scheduler 的 prepare 串行瓶颈，并在该受控路径获得可重复时延改善**。尚无 16-call、body latency、exclusive/abort/failure 压力或带 raw actor frames 的端到端任务，因此不得宣称 actor 整体性能提升。

### 2026-08-19 mini-swe-runtime-negative-boundaries

- 新增确定性负向覆盖：mini runtime trajectory 的 exit status 非 `Submitted`，或 runtime 退出而没有 trajectory，均返回 `submitted=false`；不能进入 Kernel compiler。
- 新增 workspace scope 覆盖：即使 runtime workspace 出现范围外 `README.md` 改动，`compile_loop_submission` 仍因没有捕获到 `packages/core/agent-loop/src/**/*.ts` 改动而失败，proposal 保持为空。因此“runtime 写过文件”不等于“可以交付/安装候选”。
- 全量 `npm test` **187/187**、`npm run check`、`npm run build`、`git diff --check` 通过。仍缺真正恶意 runtime 同时修改允许和范围外文件的 archive→Importer E2E，以及 timeout/partial/rejection-reopen runtime matrix；不得把当前单元保障扩大为完整供应链对抗性证明。

### 2026-08-19 mini-swe-malformed-trajectory-fail-closed

- 审计发现 `runMiniSwe()` 在 runtime 写出损坏 JSON trajectory 时会直接抛出，虽不能提交候选，但 Gateway 不能稳定将它记为同一个受控 failure path。
- 修复：trajectory parse 失败现在返回 `submitted=false`、零 turns/steps 以及 `mini-SWE trajectory is unreadable` 错误；Gateway 的既有未提交分支会 abort 并持久化结果。没有 fallback 到 live workspace，也没有 proposal。
- 新增 malformed trajectory adapter 回归，以及 Gateway E2E：临时 pinned git archive 被 materialize 后，伪 runtime 写出损坏 trajectory；`runExploration` 返回 aborted，持久 status 没有 proposal。全量 `npm test` **189/189**、`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-19 mini-swe-timeout-partial-reopen

- adapter 新增 parseable partial trajectory（无 terminal exit）和 subprocess wall-timeout 回归；二者均 fail-closed，不可提交。
- 发现并修复 mini rejection reopen 断链：旧 `reopenExploration` 仅建 immutable run，未为其 materialize/capture mini workspace；后续 runtime 无基线可编译。现 child run 重新从 pinned baseline materialize、capture before。mini task 也带入完整 Actor inbox；durable Submitted 后 Kernel 写入事实性 receipt，满足提交前消息确认合同。
- Gateway fake-runtime E2E：首次允许范围内 loop edit → submitted → 模拟 verifier rejection → child run 保持 baseline bytes → 第二次 runtime edit → submitted。全量 `npm test` **193/193**、`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-19 actor-evolution-config-ingress

- 新增 `ActorEvolutionGateway`，作为不依附 loop gateway 的通用 execution ingress。首个 plan 是 `config-evolution`：host 写入 isolated `actor-config.json` 并 capture before；mini-SWE 的 durable Submitted 触发 Kernel `compile_config_submission`，生成既有 `patch-evolution` envelope，而非新建 config verifier/gate。
- fake-runtime E2E：runtime 改写 config 并额外写入 `outside.txt`；冻结 proposal 只包含 host 固定的 `targetId` 与 config after，outside scratch 不进入 payload。此证明 runtime/compile 边界，不代表 runtime 可直接安装。
- `runMiniSwe` 的执行签名不再要求并未使用的 baseline/dependency 字段，使 config/tool/skill 的 isolated workspace plan 可复用同一 adapter；loop materialization 仍在其 host-owned gateway 中完成。
- 全量 `npm test` **194/194**、`npm run check`、`npm run build`、`git diff --check` 通过。下一步：把 config ingress 接入 controller 的 `meta_auto` capability dispatch，并用现有 Validator/Gate 运行一次真实 approval/rollback E2E；随后迁移 tool/skill bundle compiler。

### 2026-08-19 actor-evolution-config-adjudication

- config ingress 现已接到既有裁决合同的确定性 E2E：mini-SWE → `compile_config_submission` → `classifyBuilderProposal` → `adjudicatePatch` → **Validator** → 既有 **Gate** before/after write + smoke。没有新增 config verifier 或 bypass。
- 验证 fixture 提供 expected trajectory 与真实 frames；Validator approved 后 Gate 将 live fixture `{model:'before'}` 更新为 `{model:'after'}`。runtime workspace 的范围外 scratch 仍不进入 payload。
- 这是 host-independent contract E2E，不是 `meta_auto`/真实 DSH profile 冷运行，故不得说正式 config runtime 已上线。全量 `npm test` **195/195**、`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-19 actor-evolution-skill-module-compiler-recheck

- 修正 skill fixture 的 frontmatter 写入后，`ActorEvolutionGateway` 的 skill module ingress 定向 E2E 已重跑通过：mini runtime 只写 `actor-module/`，Kernel 从受限 bundle 编译现有 `patch-evolution` insert envelope。
- 全量 `npm test` **198/198**、`npm run check`、`npm run build`、`git diff --check` 均通过。此为 compiler/ingress 证据，仍不是 skill load/probe、Gate 冷安装或 rollback 证据。

### 2026-08-19 actor-evolution-module-adjudication-and-reopen

- 修复通用 module compiler 的 verifier staging 断链：此前 mini runtime 的 bundle 只存在于 run workspace，而 `Validator.runModuleLoadCheck` 按合同只读取 verifier-owned staging；现在 Kernel 在冻结 proposal 时把已编译的受限 bundle 写入该 staging，路径逃逸仍 fail-closed。
- tool E2E 现覆盖 mini-SWE → module compiler → frozen staging → existing module-load Validator → existing insert Gate。它证明没有绕过旧 validator/gate，也不是 live DSH profile 安装。
- `ActorEvolutionGateway.reopen` 对 config/tool/skill 建立与 loop 同义的 rejection 路径：submitted → rejection report → fresh immutable run；config 从 prior captured before baseline 重物化，module 从新的空 allowlisted root 开始，prior report 与 Actor messages 由 Kernel read-only lineage 继承。
- 全量 `npm test` **199/199**、`npm run check`、`npm run build`、`git diff --check` 通过。下一步仍是 skill 的真实 catalog/load/probe + Gate rollback、Controller capability dispatch 与 composition 专用合同。

### 2026-08-19 actor-evolution-skill-gate-rollback

- skill path 新增同构裁决 E2E：mini-SWE 在 isolated `actor-module/` 写 SKILL bundle → Kernel compiler 冻结并 verifier-stage → existing `Validator` catalog/probe contract → existing skill `Gate` install。cold smoke 被刻意设为失败后，`removeSkill` 被调用，安装状态回到未安装。
- 同时修复 `adjudicatePatch` 的证据缺失：Gate 失败此前只返回 rejected report，丢弃原始 `ApplyResult`；现在 rejected result 保留它，调用方能分辨 verifier 未通过与 Gate 已 apply 后 rollback。
- 该 catalog/probe 为确定性 test double，结论仅为 contract/Gate rollback 闭环，不是 live DSH profile cold load。全量 `npm test` **200/200**、`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-19 actor-composition-contract-foundation

- capability registry 现声明 config/tool/skill 的 compiler+verifier+gate metadata；`actor-composition` 被声明为 draft-only，直到专用 ingress/compiler 接入。
- 新增独立 composition graph verifier 与 transactional Gate（不复用/伪装为普通 patch Gate）：只接受 controller allowlisted targets，检查 bounded/unique operations、unique targets、supported kinds、required trajectories、valid dependency refs、DAG 与 hash binding。Gate 仅在 approved 且同 hash report 下按拓扑序 apply；cold smoke 或 apply 出错时按反序 rollback，stale report 零副作用。
- 测试覆盖 unauthorized/cyclic graph rejection、two-node transaction cold-smoke rollback、hash-drift no-touch。全量 `npm test` **204/204**、`npm run check`、`npm run build`、`git diff --check` 通过。尚未证明 mini-SWE composition workspace compiler、真实 DSH transactional cold apply 或 actor replay。

### 2026-08-19 actor-composition-mini-swe-ingress

- composition compiler 现从 isolated workspace 的 `composition/<node>/config.json` 或 `composition/<node>/module/` 生成 graph envelope；node id、target id/kind、dependency graph、before snapshot、entry 与 expected trajectory 全部来自 host plan，runtime 只能影响 after artifacts。缺 artifact、无 config diff、越界 module file/size/entry 都 fail-closed。
- `ActorEvolutionGateway.start/runComposition` 已 materialize host plan、把 builder 任务限定到 graph node directories，并在 durable mini-SWE Submitted 后调用 host compiler + Kernel `write_submission → submit`。定向 E2E 覆盖一 config + 一 dependent tool，确认结果是 `actor-composition` envelope 而非被错误降格为普通 patch。
- 全量 `npm test` **206/206**、`npm run check`、`npm run build`、`git diff --check` 通过。尚缺 Controller dispatch（composition verifier + transaction Gate）、真实 DSH cold transaction/replay 与 rejection reopen materializer。

### 2026-08-19 mini-swe-adversarial-archive-importer-e2e

- 新增真实链路 fixture：mini runtime 在同一 run 同时修改 allowlisted `packages/core/agent-loop/src/tool-calls.ts` 与 workspace 根 `outside.txt`，并产生 durable Submitted trajectory。
- Kernel 只从 allowlisted source diff 编译 builder-generated proposal；CandidateImporter 用 pinned local git archive 重新物化 tree、精确 beforeHash 应用 edit、在 networkless bwrap recipe build 后 stage。最终 artifact 含 `tool-calls.ts` 合法 change，**不含** `outside.txt`，而原 Builder workspace 保留该文件供审计。
- 这证明 workspace 额外写入不会污染 archive/importer candidate，不代表 runtime 可绕过 allowlist。全量 `npm test` **207/207**、`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-19 terra-runtime-alias-health

- Terra adapter 接受 runtime-facing `LOOM_TERRA_API_KEY`/`LOOM_TERRA_BASE_URL`，并继续兼容既有 `DSH_TERRA_*`；凭据只来自进程环境，未写入任何记录。
- 实际 OpenAI-compatible native-tool health probe 约 3 秒返回合法 `builder_decision` wrapper，确认 transport、credential discovery 与 native tool response 可用。此为短健康检查，不是 Builder implementation pass、proposal、verifier/gate/install 或性能结论。
- 全量 `npm test` **208/208**、`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-19 composition-adjudication-release-audit

- `actor-composition` 的 graph verifier、逐 operation verifier 聚合与 transaction Gate 已有确定性合同测试：任一 child verifier 拒绝时 Gate 零触碰；图通过后才按依赖顺序 apply，cold smoke 失败按逆序 rollback，hash 漂移报告零副作用。
- 审计发现它尚不应被接入 `meta_auto`：现有入口没有可信的 controller-owned composition plan/materializer 输入。若直接接受 Builder 或用户提供的 graph，会把非可信多目标 payload 误当 host plan，破坏 capability/compiler 的 TCB 边界。故保持 capability 已注册但不调度；这是真实 release blocker，而非可由单测绿灯覆盖的缺口。
- 本次未发起模型请求、未触碰 profile/生产。全量 `npm test` **209/209**、`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-19 composition-controller-plan-registry

- 新增 `CompositionPlanRegistry`，将 composition request 限制为 host-registered plan ID；registry 在 materialize 前验证 plan 的唯一/有界 node 与 target、config before、module entry、trajectory 和依赖引用，返回 deep clone，避免 caller 修改已注册的 graph。
- 全量 **211/211**、`npm run check`、`npm run build`、`git diff --check` 通过。该项只是可信 ingress 底座；尚未把 registry、mini-SWE execution、per-component verifier 和 transaction Gate 接入 `meta_auto`，故不构成安装/回滚证据。

### 2026-08-19 composition-controller-seam

- 新增可注入 `CompositionController`：外部请求只能给 registered `planId`，Controller 依次 resolve host plan、启动 mini-SWE composition workspace、要求 durable Submitted/frozen envelope，再运行每个 child verifier 和 transaction Gate。
- 定向 E2E 验证两个节点（config → tool）均通过 verifier 后才进入 Gate，且 Gate 的 apply 顺序为 config、tool。此前 fixture 把普通 `-c` 参数误解析为 cwd，已仅接受 `environment.cwd=`；这是测试工具解析修复，不是 runtime 行为变更。
- 尚未接入 DSH `meta_auto` 参数/config 及真实 loader gate，故仍不构成 profile 安装或 rollback 结论。
- 全量 `npm test` **212/212**、`npm run check`、`npm run build`、`git diff --check` 通过。

### 2026-08-19 composition-controller-child-reject

- 为 Controller seam 补 runtime-generated envelope 的负例：mini-SWE 生成 config → tool composition，config verifier pass、tool verifier reject。断言 transaction Gate 的 snapshot/apply/rollback 都未调用，结果为 `rejected` 并带 tool 原因。
- 定向 `composition-controller` **2/2**、`npm run check` 通过；这锁定了“任一组件失败零副作用”，但不替代真实 DSH loader transaction adapter。

### 2026-08-19 npm-package-hygiene-audit

- `npm pack --dry-run` 发现旧构建会带入 `dist/fromzero/**` 的历史 runtime 示例。已将 build 改为先清理全部 `dist`，prepack 明确移除 `dist/fromzero` 与 `dist/meta-workspace`；复跑 tarball 从 86 变为 77 个文件，检查确认无两类路径。
- 同时用 lockfile-only install 将根 lockfile version 从历史 `0.1.0` 对齐 package `1.1.0`。全量 **213/213**、check/build/diff-check 均通过；这修的是发布物卫生，不改变 runtime 权限或性能结论。
## 2026-08-19 — mini-swe-candidate scheduler boundary timing

Ran the same `mixed-exclusive`, `abort-draining`, and injected internal `failure-draining` workload in independent baseline and candidate workspaces through the real `Context + AgentLoop + ToolRuntime + AgentRegistry` stack. Both Vitest runs passed (2/2 each). Raw event frames and tool start/end timing are persisted at `/chenzute/dsh-src/eval/run-records/2026-08-19-mini-swe-prepare-boundaries-baseline-raw-frames.json` and `/chenzute/dsh-src/eval/run-records/2026-08-19-mini-swe-prepare-boundaries-candidate-raw-frames.json`. Candidate preserved every exclusive barrier, did not dispatch post-cancel work, emitted the three synthetic `ABORTED_BEFORE_DISPATCH` results, and drained the one started body before terminal scheduler error. This is safety timing evidence, not a general performance claim.
## 2026-08-19 — cold Loader 16-call raw Actor workload

Re-imported the original Builder proposal after separating the build workspace from the immutable runtime artifact (`package.json + lib/**`, no build-time dependency links). Both a baseline `headless` profile and the isolated candidate Loader profile then cold-started through the real DSH CLI with the same Loader-mounted scripted adapter. Each generated 16 parallel-safe 100ms body calls and completed the task. Timelines are `/chenzute/dsh-src/eval/run-records/2026-08-19-cold-loader-16-baseline-timeline.json` and `/chenzute/dsh-src/eval/run-records/2026-08-19-cold-loader-16-candidate-timeline.json`; durable raw session frames remain in their isolated DSH homes. Both had 16 starts/ends and about a 112–113ms body window. This proves cold Loader task execution and no apparent concurrency regression, not prepare-overlap acceleration: the test tool has no delayed prepare path.

## 2026-08-19 — cold Loader independent contract, Gate install, repeated replay, and rollback

The re-imported Builder-generated candidate `cold-loader-prepare-20260819` passed an independent real `contract-runner` report at `/chenzute/dsh-src/eval/meta-workspace-cold-loader-20260819/runtime/reports/cold-loader-prepare-20260819-contract.json`: C0, C1–C4, C6/from-zero L1–L5, C7, and C8 are all pass. Two evaluator faults were fixed rather than bypassed: non-interactive Loom DSH subprocesses now set `CI=true`, and C6 fixture modules moved from build-cleaned `dist/fromzero/**` to stable versioned `fixtures/fromzero/**`. The verifier then transitioned staging → pending → verified → approved; the profile Gate installed from an empty snapshot and C0 smoke passed. Its receipt is `runtime/candidates/installations/cold-loader-prepare-20260819.json`.

After install, five independent cold CLI trials per side ran the same external Loader-mounted scripted task (16 concurrency-safe 100ms execute-body calls). All ten completed 16/16. Median baseline/installed wall were 5992.9/5763.6ms; start spans 1.664/1.651ms and body windows 111.02/111.95ms. Raw CLI output and per-trial timeline are under `/chenzute/dsh-src/eval/run-records/2026-08-19-cold-loader-16-gate-installed-repeated/`. This is strictly Loader task completion/non-regression: it contains no delayed `prepare()` path, so it is not performance evidence for the candidate's prepare-overlap change.

Finally, a Gate-owned installed-candidate rollback wrote a separate immutable receipt (`runtime/candidates/installations/cold-loader-prepare-20260819.rollback.json`) while preserving the install receipt. It removed only the owned isolated profile (`exists=true → false`) and returned the registry to approved. No DSH checkout, user profile, or production service was changed.

## 2026-08-19 — real refine skill cold Loader E2E

Eval-only runner `/chenzute/dsh-src/eval/run-real-refine-skill.mjs` exercised the complete skill path without touching the DSH checkout or a user skill root. Fresh mini-SWE pass `builder-1787149918682-c881e8a5` produced exactly one isolated `actor-module/refine-evidence-20260819/SKILL.md` bundle and emitted durable `Submitted` after five model API calls. The frozen proposal was normal `patch-evolution`/`targetKind=skill`; it was not hand-authored or directly installed.

`Validator.skillIsolation` used real DSH CLI catalog dumps and a fresh scripted cold actor process. It approved the candidate (`skill isolation: pass`). The existing Gate then installed into an eval-owned root. A separate cold DSH CLI process actually called the `skill` tool and its scripted LLM only emitted `skill-body-loaded` after finding `EVIDENCE_REFINEMENT_MARKER` in the returned tool result. The exact sequence is recorded in `/chenzute/dsh-src/eval/run-records/2026-08-19-real-refine-skill/report.json`: before install `skill-body-missing`; after Gate apply `skill-body-loaded`; after Gate-owned smoke-failure rollback, the skill directory was absent and cold probe returned `skill-body-missing` again.

Two failed harness attempts remain intentionally visible: the first lacked the mini runtime's explicit host-owned model environment bridge; the second handed the filesystem provider the staging collection rather than the candidate's one-level skill root and then omitted the required skill name from its scripted probe response. The production adapter now accepts optional host-owned `MiniSweRuntimeOptions.env`; it is passed only to the child process and a regression verifies it is absent from the durable trajectory. These were evaluator/adapter defects, not artificial success conditions. This E2E proves artifact generation, independent catalog/load verification, Gate install, true Loader invocation, and rollback; it does not prove model instruction adherence or general refine success rate.

## 2026-08-19 — refine trigger/use acceptance

An eval-only cold DSH Actor pass received a concrete boundary input: a prior focused check failed and the user explicitly asked for a refine review without changing configuration. Its deterministic trigger policy issued `skill(refine-evidence-20260819)`; the fresh DSH tool result contained the installed skill body marker, after which the actor emitted the required evidence-first output fields: `Observed failure`, `Falsifiable hypothesis`, `Smallest safe check`, `Proposed next step`, and `Limits`. Raw output and ordered trigger/body events are in `/chenzute/dsh-src/eval/run-records/2026-08-19-refine-trigger-acceptance.json`.

This closes the appropriate v1 assertion: a defined, user-visible trigger boundary can cause the installed refine skill to be loaded and used in a real Actor session. It deliberately does not claim that an arbitrary model will choose the trigger or obey skill text under all open-ended tasks; those are future multi-model/long-horizon evaluation questions.

## 2026-08-20 — Windows product Config rollback and Linux 1.2.30 smoke

Windows product plan `evolution-1787230109885-juuho59t` had already completed a real mini-SWE Config edit, independent approval, settings-backed Gate installation, and cold Actor use of `deepseek-chat`. After installing the latest local `1.2.30` tarball, startup recovery reconciled stale job `job-1787230144504-64tjei` from `running` to `finished` using the immutable completed plan. A new headless Actor then invoked `meta_evolution_control(action=rollback_recent)`. Gate verified no post-install drift, restored its owned before snapshot through the same settings adapter, required exact readback, wrote a separate receipt with `rolledBack:true`, appended `installed-rollback`, and removed the target from harness applied state. `settings.yaml` returned to `deepseek-v4-flash`.

Fresh cold session `session-3194fa19-fe76-4aa4-ae6e-7aafc46175c3` returned `SETTINGS_ROLLBACK_COLD_OK`; its raw `request/header`, `request/context`, and `assistant/message` all identify `deepseek-official/deepseek-v4-flash`. Raw plan, job, receipt, compressed/expanded session and summary are under `/chenzute/dsh-src/eval/run-records/2026-08-20-windows-config-rollback/`. The previous Windows Skill product plan `evolution-1787223815362-p9dkjuiv` is also preserved under `/chenzute/dsh-src/eval/run-records/2026-08-20-windows-skill-product-e2e/`: mini-SWE submitted, verifier recorded `cold-skill-load`, Gate applied, and the installed bundle remains present. Product-card Skill rollback remains intentionally unavailable; the independent real-refine-skill record supplies Gate install/load/rollback evidence.

The same local `dsh-loom-1.2.30.tgz` was then installed under an isolated Linux `DSH_HOME`. Setup installed bundled mini-SWE `2.4.6`, generated its absolute patch, composed `meta-validate` plus `loom-skill-filesystem`, and booted an isolated Web profile at HTTP 200 with a non-empty response. Raw config, patch, Web response and summary are under `/chenzute/dsh-src/eval/run-records/2026-08-20-linux-1.2.30-smoke/`. Release verification: 261/261 tests, TypeScript check, build, diff-check, and pack dry-run pass. The public evidence index is `docs/evidence/v1.2.30.md`.
# 2026-08-19 — v1.2 双轨控制面与矩阵账本（确定性实现）

- 产品轨：`meta_auto` 新增 `evolutionMode=plan|execute`。Plan 持久化 user-evolution immutable plan；Config 使用 host-selected existing-row snapshot 并拒绝 credential-bearing rows，Skill 使用 host-generated kebab-case entry。Execute 只接收 planId，运行 ActorEvolutionGateway/mini-SWE，再进入原有 `classifyBuilderProposal → Validator → Gate` 链，unknown/malformed proposal 不会安装。
- 研究轨：新增 `src/loop-experiments/matrix.ts`，固定 `scheduler-prepare-overlap`、`oracle-rejection-repair`、`cross-file-semantic-repair` 三题 × 3 slots，记录 turn/tool/first edit/tests/submission/adjudication/replay/rollback/time/cost，failures 永久保留；发布资格为九槽完整且每题至少一条严格完整闭环。
- 验证：222/222 Vitest、TypeScript check、build、diff-check、pack dry-run 均通过。没有运行模型或伪造任何 E2E record；所以 v1.2 真实产品 E2E 与 Loop matrix 门槛仍未满足。

## 2026-08-19 — v1.2 first live test slots (not release evidence yet)

Fresh mini-SWE Skill rerun `builder-1787154571104-7f66fa2c` submitted an isolated bundle; the existing independent verifier approved it, Gate applied it, cold Loader probes completed before/after/rollback. It remains a Gateway-level rerun and deliberately does not satisfy the new `meta_auto` product-entry assertion.

Fresh scheduler matrix attempt 1 (`builder-1787154678894-60b94e7b`) materialized a new immutable DSH archive, reproduced the host oracle `parallel-safe prepares were serialized`, then mini-SWE edited source and passed both required tests (`delayed-prepare-regression.spec.ts`, `tool-calls.spec.ts`) before submitting a formal proposal. Raw record: `/chenzute/dsh-src/eval/run-records/2026-08-19-v12-loop-matrix/scheduler-prepare-overlap-attempt-1.json`. It has not yet had independent C0–C8, Gate, cold replay, or rollback, so it is **not** a complete matrix success and must not count toward the release threshold.

## 2026-08-20 — oracle repair matrix attempts 1–3

Three fresh immutable official-V4-Flash repair runs used the same failed candidate, immutable rejection, and strict local oracle. All aborted at 20 model turns with an empty/non-JSON model decision before any tool call; all have zero edits, oracle calls, and submissions. Raw record: `/chenzute/dsh-src/eval/run-records/2026-08-19-v12-loop-matrix/oracle-rejection-repair-attempts-1-3.json`. This is a repeated runtime/model-response contract failure, not evidence that the model inspected the source and failed to repair it. Per the one-variable rule, the next oracle repair control must change only the execution runtime to mini-SWE/Terra; it must not add prompt text, guards, or turn budget.

## 2026-08-20 — v1.2 executor decision

Loom-native is no longer a production Loop source-editing executor. `meta_auto(exploreLoop=true)` now fail-closes unless `executionRuntime=mini-swe`; the configuration default is mini-SWE. Loom-native remains the durable diagnosis/clarification kernel only: it can hold evidence, questions and user choices, after which a fresh immutable mini-SWE implementation pass materializes the workspace. Legacy native-loop tests remain only as protocol compatibility regressions and are excluded from v1.2 matrix/release evidence. A deterministic gateway test covers this split.

The formal Loop and product gateways now pass a host-only mini-SWE child environment: Terra or official route credentials are mapped to the executor's OpenAI-compatible variables and `MSWEA_CONFIGURED=true` removes interactive global setup. The mapping object is passed only to the spawned process; it is not serialized into a plan, task prompt, workspace, trajectory, or evidence artifact. Deterministic mapping and no-trajectory-leak coverage accompanies the existing runtime adapter test.

## 2026-08-20 — product-track user experience baseline

The Plan/Execute surface now separates durable internal artifacts from user-facing state. Plan responses omit before snapshots and raw evidence paths while retaining target, risk, verification and evidence-count explanations. Execute atomically moves a plan to `queued` before adding a background job, preventing duplicate user confirmation from starting two implementation runs; Actor stays available. `meta_evolution_status(jobId|planId)` reads only the durable plan/job and presents wait/execute/applied/not-applied states plus the independent verdict explanation. This is a UI/protocol improvement only; it does not alter Verifier/Gate authority.

## 2026-08-20 — product task-card and Actor notification surface

Added a stable user task-card projection with phase, headline, target summary, current/next action, verification, risks, evidence count, actual available actions and terminal result limits. It is used consistently by Plan, queued Execute and status reads; deterministic coverage confirms raw evidence paths do not escape the card and Gate rejection becomes a visible `未生效` terminal state. Background start/completion notices read the same durable plan/card and tell the Actor that implementation is isolated and not yet effective, then accurately report `已生效` or `未生效` with the verifier/gate summary. No cancel/pause/rollback control is advertised because the product route has not implemented those actions yet.

## 2026-08-20 — oracle repair single-variable mini-SWE control

Keeping the failed candidate, strict local oracle, task text and completion contract unchanged, only the execution runtime was changed from the failing native official-V4-Flash adapter to mini-SWE/Terra. Fresh attempt 1 inspected both files, renamed `runActorLoop` to `run`, ran the oracle to `strict-order-pass`, wrote the requested outbox proposal, and submitted in 6 model turns. Raw record: `/chenzute/dsh-src/eval/run-records/2026-08-19-v12-loop-matrix/oracle-rejection-repair-mini-attempt-1.json`. This establishes a bounded implementation/oracle control, not a full Loom Loop candidate lifecycle: the fixture is not yet compiled by `LoopCandidateGateway` into a DSH package envelope and has not faced contract verification, Gate, cold replay, or rollback.

## 2026-08-21 — Windows mini-SWE soft-budget and shell-contract E2E

Failed run `builder-1787264098546-4cbde99f` produced a complete `builder-json-decision-output/SKILL.md` and passed its own structure checks, but consumed all 30 model calls on repeated inspection. Its durable terminal event was `LimitsExceeded`, so Loom correctly aborted without compiling or adjudicating the unsubmitted workspace.

The pinned non-interactive runner now injects a soft landing with two calls left and a final-call completion reminder. It never fabricates a `Submitted` exit. A fresh immutable redo through the Windows Web Actor main entry created plan `evolution-1787264820585-1hsxubuf` and run `builder-1787264820616-d190282d`; the runtime completed its final structure check, received the reminders, and emitted a real `Submitted` terminal event on call 30. The independent report approved 196/196 aligned events plus module-load and skill-isolation checks; Gate history records `skill-insert` with `cold-skill-load: pass`; the product plan reports `applied=true`, `effective=true`, and `restartRequired=false`.

The same trajectory exposed a separate platform contract failure: upstream mini-SWE `LocalEnvironment` uses `shell=True`, which is `cmd.exe` on Windows despite advertising a bash action. The model spent most calls discovering cmd quoting. Loom's pinned runner now routes only Windows local actions through Git Bash and fails closed if Git Bash is absent; POSIX behavior is unchanged. A Windows host probe executed a heredoc, pipe, relative write, line count, and readback successfully. Raw trajectory, plan, verifier status/report and filtered Gate history are under `/chenzute/dsh-src/eval/run-records/2026-08-21-windows-mini-swe-budget-shell/`.

## 2026-08-21 — portable runtime profile and six-run Windows stability

The initial Windows-only shell repair was generalized before release. Loom now executes every local action with an explicitly resolved Bash instead of host `shell=True`, maps action-local `python3` to a resolved interpreter, supports `LOOM_BASH`/`LOOM_PYTHON` deployment overrides, and fails closed for invalid explicit overrides. A compact runtime profile tells the implementation model which platform, shell, cwd/path contract, Python, Node and Git capabilities already exist. Windows automatic and explicit probes, invalid-override probes, and an isolated Linux mini-SWE 2.4.6 probe all exercised Bash/heredoc/pipe/relative paths/Python as applicable.

The default step ceiling is 40, with a 75% convergence checkpoint and stronger two-call/final-call notices; Loom still accepts only a real upstream `Submitted` exit. Six fresh immutable Windows Skill tasks all completed `Submitted → approved → Gate skill-insert → cold-load pass → effective=true`. Model turns were `9/8/5/5/6/5` (median 5.5) and tool executions `8/7/4/4/5/4` (median 4.5). The two dynamic-profile/40-limit attempts submitted at 6 and 5 turns with zero environment probes, zero non-zero tool results, and no checkpoint trigger. Raw records and the machine-readable aggregate are under `/chenzute/dsh-src/eval/run-records/2026-08-21-windows-mini-swe-stability-6/`. This is bounded Skill stability evidence, not a general complex-refactor success-rate claim.
## 2026-08-22 — v1.3 plugin evolution release candidate

- Linux two-plugin Builder E2E completed `baseline fail → source edit → required build/test → independent Verifier → Shadow Profile → cold Loader/integration → atomic activation → improved behavior → immutable restore → baseline fail`. Raw records: `/chenzute/dsh-src/eval/run-records/2026-08-21-plugin-evolution-v13-linux/`.
- The same two frozen tar SHA-256 values were exercised on Windows. The transaction passed 18 verifier checks, recovered a dead same-host activation lock, activated both packages as one unit, reproduced the coupled behavior, then restored both. Raw records: `/chenzute/dsh-src/eval/run-records/2026-08-21-plugin-evolution-v13-windows-lock-recovery/`.
- Public `dsh-find-plugin@0.3.7` was bound to exact npm integrity, repository commit and frozen tree hash. Official V4 Flash submitted after 15 turns/15 tool steps; independent build/probe, staging, activation and restore passed. Raw records: `/chenzute/dsh-src/eval/run-records/2026-08-21-plugin-evolution-v13-public-linux/`.
- Registry lifecycle `@huanlin/dsh-plugin-sleep@0.1.0` completed exact version/integrity freeze, Shadow Profile, cold Loader, activation and restore without Builder. Raw records: `/chenzute/dsh-src/eval/run-records/2026-08-21-plugin-lifecycle-v13-registry-linux/`.
- Publication audit fixed Windows npm-family shim execution, Windows file-spec normalization, structured stale locks, registry source provenance, setup Profile mismatch, preflight drift overwrite, and the README/startup activation bypass. Standalone setup without a real cold Loader now keeps plugin transactions disabled instead of claiming readiness.
- Public summary: `docs/evidence/v1.3.0.md`. Generated Hero/context raster images remain intentionally absent from this release.
- `dsh-loom@1.3.0` was published to npm. Fresh registry download was byte-identical to the tested tarball (SHA-256 `8b7f765baf5a6419694c772b824406426b85a4ccdb221ca70d9e7d57bcd2578f`).
