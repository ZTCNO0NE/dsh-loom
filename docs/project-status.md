# dsh-meta-validate 项目总览（2026-08-16）

## v1 冻结（2026-08-16）

- 对外品牌：**Loom · 织机**（把使用、纠正与失败"织"进 agent 的能力）；包名/插件 id 保持 `dsh-meta-validate`，版本 **1.0.0**。
- 功能冻结范围：角色三分（agent/监督员/改进模型/核验器/执行器）、observe→judge→design→verify→install 回路、config/tool/skill 进化、自主换模型、用户消息自动唤起、预约式后台执行、进化通讯（启动/进度/完成通知 + growth 台账/偏好/报告）、监督员偏向唤起 + post-loop + 轮询主动暂停、TCB 自锁（agent/agent-loop/meta-validate）。
- 验收基准：`npm test` **101/101**；fromzero L1-L5（0/3→5/5，Δsuccess+3）；host-demo pass=true；supervisor-swap（qwen→v4-flash→deepseek-chat）pass；scheduled-notify（三条通知 + 台账）pass；actor-progress-qa（actor 答"优化进度怎么样？"）pass；preferences-demo pass=true；TB 官方切片 fix-git PASS（1/2）。
- **v1.1 完成（2026-08-17）**：① refine-skill —— builder 造出 `actor-refine` 技能，actor 在全新失败场景自己调 meta_auto、builder 装 fs-write、actor 写出目标文件（两次独立产物证据，见 run-log）；② 偏好沉淀 —— builder 自主更新 system-prompt + 声明 preferences → preferences.json → meta_growth 可见（pass=true，run-records/preferences-demo.json）；③ 周期定时报告与长基准（用户指示延后）。
- 版本：**1.0.3**（含 reasoning 空流、loader inject、coverage nameAliases、回合计时、gate fail-open、spawn 进程组等修复）。

## 一句话

为 DeepSeek Harness 开发"第二个验证器"插件：让 actor 通过 **observe -> propose -> validate -> cold-apply -> rollback** 安全地自我进化——修改者（builder）与核验者（verifier）完全分离，固定式完整核验，冷替换由 gate 执行。

## 设计要点（详见 docs/architecture.md 与 docs/research/08）

- 角色三分：builder（迭代者，看用户需求）/ verifier（核验者，固定式，只看预期 vs 真实帧）/ actor（体验者，只执行并产出真实帧）；
- 两级环：隔离验证是准入门槛，上线后真实运行是最终裁判；verifier 不通过强制回炉，带 maxIterations 收敛预算；
- 文件优先：`$DSH_HOME/meta-validate/` 持久化（trajectory / world-model / signals / patches / history / cost-log），不信任上下文；
- TCB：builder 输出（含代码）默认不可信；verifier/回归集对 actor 只读；install/rollback 只由 gate 执行；
- 三层触发：actor 主动（meta_request_validate）/ 宿主硬触发（回合边界确定性规则）/ 外部兜底。

## 实现状态

- **M0-M4 全闭合**：Config schema、文件协议、observer、builder（世界模型/self-check/回炉）、verifier（对齐/回归/不变性/模块加载校验/skill 隔离）、gate（应用/回滚/insert/skill）、评审门（两级频率控制）、回合边界挂接（agent/turn-stopping + agent/status）、collectFrames（builder 后真实隔离探测）、成本记账（cost-log + runId）；
- **路线 A（builder 输入完备化 + probe-request，2026-08-16）**：
  - 完整轨迹帧：`session/event` 全局订阅 → `trajectory/frames.jsonl`，最近 40 条注入 builder prompt（args/result/error 截断预览）；
  - 遥测：`trajectory/actor-profile.json`（回合数/平均·最大回合时延/工具调用数/错误率/每工具时延）注入 builder prompt；
  - probe-request：patch 可带 `probes[]`（≤3 条、每条 ≤300 字），提交前由隔离器试运行，失败回传 builder 回炉（`patches/<id>/probes.jsonl` 留痕），全部通过才进 verifier；
  - config 快照真实化：loader 行 id/name/config + 脱敏 + 关键行优先 + **启动基线合并**（dsh 回合间会重建 loader 树，重复 update 不再丢行）；
  - TCB 自锁：`agent`/`agent-loop`/`meta-validate` 行禁止 builder 修改。
- **测试 83/83**（`npm test`）。

## 核心证据

### 从零成长（run-log「from-zero-*」）

- off 基线：bare actor 0/3（写文件/列目录/编辑验证全失败）；
- L1-L5 全过：fs-write、ls-dir、bash-run、file-read 工具 + edit-verify、json-verify 技能（全部 builder 生成、verifier 验收、gate 安装）；
- 严格同任务集：**off 0/3 -> on 3/3（Δsuccess +3）**（`fromzero-strict-comparison.json`）；
- 泛化：JSON 新领域任务触发 json-verify 技能（"valid ✓"）。

### 宿主闭环（run-log「host-demo-success / host-demo-repeatable」）

- dsh 进程内 27b 调用 `meta_auto` → 评审门/builder（V4 Flash）→ collectFrames 隔离探测 → verifier **approved** → gate **insert 应用（applied=true）**；
- `npm run host-demo` 可重复验收：**pass=true**（产物证据：history insert / status approved / installed module）。

### 基准与成本

- 官方 V4 Flash 自建冒烟 5/5；本地 27b Terminal-Bench 2.1 切片 1/2（含本地验证脚本偏离，非官方口径）；
- **TB 2.1 官方 API 切片（V4 Flash，重跑）**：fix-git **PASS（1.0）**、overfull-hbox 超时（0.0），通过率 1/2；fix-git 首跑因验证器 apt 超时被误杀，Aliyun 镜像补丁后真分到手（`jobs/tb21-v4flash-rerun/`）；
- **config-update demo（builder 自主改现有配置）**：需求仅给用户级目标，builder 自行诊断并产出 `action=update`（timeoutMs 值由 builder 决定，多次运行分别为 10000/30000/60000），verifier 真实帧验收 → 持久化 overlay + harness-state 应用 → 重跑通过（`run-records/config-update-demo.json`）；
- builder/gate token 已计量（cost-log，L1 样例 builder ~974 in/4681 out）。

## 验收命令

| 命令 | 内容 |
|---|---|
| `npm test` | 69/69 单测 |
| `npm run fromzero:verify` | L1-L5 已安装态全任务 |
| `npm run fromzero:compare` | 严格 Δsuccess |
| `npm run fromzero:all` | 一键验收链（`-- --fresh` 全量重跑） |
| `npm run fromzero:generic-real` | 脚本驱动的完整通用路径（真实模型） |
| `npm run host-demo` | 宿主内自进化闭环验收 |
| `npm run config-update-demo` | builder 自主改现有 config 行端到端 |
| `npm run repeat-update-demo` | 同进程重复 update 同一行（基线合并回归） |
| `npm run refine-skill-demo` | builder 给 actor 造 refine 机制（技能） |
| `npm run model-swap-demo` | 探针：builder 是否自主提出换 actor 模型 |

## 已知遗留

- 无（.ts 工具模块加载校验已支持；loop 层修改仍未放开属设计项）；
- fromzero-l1..l5 实验脚本可逐步迁移到插件通用工具路径（stub 与真实通用路径已证明等价，脚本保留为端到端证据）；
- overfull-hbox 官方切片 AgentTimeoutError，需更长 agent 预算或更强模型复测；
- refine-skill-demo / model-swap-demo 已有脚本与部分证据，等待干净的完整实跑（长时间基准按用户指示延后）；
- loop 层修改仍未放开（M4 之后的设计项）；
- 行为级技能（L4）是"显著提高概率"而非确定性保证（验收已用 2 次尝试兜底）。

## 后续设计（待定）

- **预约式后台执行（已落地）**：`scheduled=true` 时 meta_auto/meta_iterate 立即返回 `{scheduled, jobId}`，单飞队列后台跑完回路，job 状态落盘，完成/失败通过 agent.inject 注入"reload 后生效"通知；默认 `scheduled=false` 保持同步（demo 兼容）。测试 92/92。
- **主动暂停（已落地）**：`reviewGate.stallAbort`（默认 maxTurnSeconds=300 / maxStepsPerTurn=30 / checkIntervalMs=30s）轮询检测，超限且非 refine 运行时 → 回合级 abort（keepInbox）+ `handoff/stall.jsonl` 留痕 + 注入 agent-error 信号 → 空闲时唤起 builder。测试 92/92。
- **案例方向实现顺序**：技能包分享、多 agent 共享技能库、插件自举等，后续再定。
- **监督员触发场景规格**：见 `docs/supervisor-trigger-scenarios.md`（S1-S10：重复失败/进度不足/用户纠正/回归/回合异常/资源异常/能力不足/泛化缺口/显式请求/战术迁移；含判定公式、证据、动作、收敛语义与可配参数）。
- **进化通讯与沉淀（已落地）**：见 `docs/evolution-communication.md`——启动/完成/失败 `agent.inject` 通知（notify 开关）、`growth/ledger.jsonl`、`growth/preferences.json`（builder 声明偏好按 scope+value 合并）、`growth/report.md`、`meta_growth` 工具、`meta_status` 增强（latestJob+growthCount）；测试 97/97；待做：进度通知接线与周期聚合 report。
