# 必备知识 Q&A（L3 产出）

更新：2026-08-16。规则：每条有答案 + 出处；答不上来标 **RED** 进"待查/决策"区。出处为 `docs/research/0x-*.md` 或 dsh/Tycho/prime-agent 仓库路径。

## A. dsh / Cordis 插件平台

| # | 问题 | 答案 | 出处 |
|---|---|---|---|
| A1 | 插件最小形态与生命周期 | apply(ctx, config) + name + inject；注册项自动清理；HMR 卸载重载 | 02 §1 |
| A2 | defineTool 完整字段与管道 | name/description/parameters/output/render/execute + finalizeContent/timeoutMs/isConcurrencySafe/present*；pre→execute→post→tool/result | 02 §3 |
| A3 | 事件系统与失败/纠正信号 | emit/serial/waterfall；agent/error、tool/result.error、user/message、compaction/* 已确认存在 | 02 §4 |
| A4 | Config/Schemastery | 同名 schema 校验+默认值；加载失败即 loud fail；禁止普通对象 | 02 §2 |
| A5 | bundle/profile/patch | 加载顺序 4 层；insert/按 id 整行覆盖；本地绝对路径、bundle 用包名 | 02 §6 |
| A6 | plugin-group/isolate | group + isolate 可隔离服务实例，validator 可用 | 02 §7 |
| A7 | 独立 LLM 调用 | ctx.llm.stream/prepareCall + 独立 provider/model/sessionId/purpose；不注入 actor 历史即隔离会话状态 | 02 §5 |
| A8 | 运行时读/写其他行 config | **RED-R1**：只有 dump-config/静态 patch 层确认；运行时配置服务 API 未定位 | — |
| A9 | 类型链接 | file: 链源码构建产物 lib/types；不链 staging | 02 §8 |
| A10 | 构建分发 | tsc NodeNext；dsh.bundle；files；npm/tarball/本地 link 优先 | 02 §9 |

## B. Tycho（validate 主参考）

| # | 问题 | 答案 | 出处 |
|---|---|---|---|
| B1 | 组件边界 | actor/builder/verifier/planner/workspace/harness 分离 | 03 §1 |
| B2 | verify() 输入输出 | 帧/转移 + world_model → simulation_accuracy/strict/first_divergence/coverage 等 | 03 §3 |
| B3 | UNKNOWN/no-op 规则 | -1 仅真未知；no-op 假变化判错；覆盖率阈值 0.75 | 03 §3 |
| B4 | 执行期帧对齐 | validated_plan.json + grid SHA-256；第一偏差暂停 | 03 §5 |
| B5 | 四种 policy | orchestrator 88.49 最高；trigger 自动 repair 83.07（模型对≠行动对） | 03 §6 |
| B6 | 隔离与完整性 | 无网络、只读根、manifest SHA-256 | 03 §7 |

## C. prime-agent（冷替换/回滚参考）

| # | 问题 | 答案 | 出处 |
|---|---|---|---|
| C1 | refine 管线 | review gate → planRefinement → applyRefinementProposal（回合边界） | 04 §2 |
| C2 | 原子写/快照 | tmp+rename 原子替换；before/after 全字段留痕 | 04 §2 |
| C3 | 冲突检测/白名单 | baseline 比对拒绝"plan 期间被改"；kind/action/base_prompt 白名单 | 04 §2 |
| C4 | 借鉴 vs 不借鉴 | 借鉴：回合边界/冲突检测/原子写/确定性回滚；不借鉴：LLM 主观判定 validate | 04 §5 |

## D. ARC-AGI-3 背景

| # | 问题 | 答案 | 出处 |
|---|---|---|---|
| D1 | agent 接口 | Agent ABC：choose_action/is_done/MAX_ACTIONS=80；FrameData | 05 §2 |
| D2 | 验证词表 | frame/action/transition match/exact replay/RHAE | 05 §4 |
| D3 | 帧的类比 | ARC 帧 = dsh 事件/工具结果/配置树快照序列 | 05 §4 |

## E. 评测与验收（测试先行）

| # | 问题 | 答案 | 出处 |
|---|---|---|---|
| E1 | dsh 官方有没有 harness 自身 bench | **没有 in-repo bench/数据集**；BENCHMARK.md 只指 Python SDK；对外基准（Terminal-Bench 2.1 82.7/87.9、DeepSWE 62.7、CyberGym 83.3）已记录 | 01 §2.1 |
| E2 | 自迭代衡量现成方式 | 无统一基准；prime-agent 用 refine 历史/expectedOutcome；缺口 + 自建方案 | 01 §2.3/§7 |
| E3 | Tycho/prime-agent 口径 | RHAE 公式与 scorecards；prime-agent RefinementResult/expectedOutcome | 03 §6、04 §2 |
| E4 | 每里程碑阈值 | 草案在 01 §6（M1 信号准确率/合成集、M2 对齐率 100%、M3 回滚率 100% 等），待 L5 确认 | 01 §6 |
| E5 | 最小回归集范围 | acp-snapshot + headless JSONL + 自建 5-10 冒烟 + TB/DeepSWE 进阶；已实测 TB 切片 1/2 | 01 §4、run-log.md |

## RED / 待查 / 决策点

| ID | 问题 | 处置 |
|---|---|---|
| R1 | dsh 运行时读/写其他插件行 config 的公开 API（gate 依赖） | **已解决**：`ctx.loader.entries()` / `ctx.loader.update(id, {config})`（vendor/loader README 行 40-42）；持久化另写 patch 文件。详见 07 §3 |
| R2 | `user/message` 的 source 枚举有没有明确的"纠正"语义 | **已解决（启发式）**：kind 只有 user/plugin/model/tool（message.ts 行 100-105），无原生 correction；用"失败后紧跟 user 消息"启发式或自定义 source kind。详见 07 §3 |
| R3 | 独立验证器模型实例隔离能做到什么程度（单进程多 sessionId vs plugin-group vs 独立 profile/进程） | **分层决策**：会话级先做；plugin-group 服务级；进程级留 M2 对抗场景。详见 07 §3 |
| R4 | 本地任务补丁（pip 替代 uv 等）对分数可复现性的影响 | 已记录（eval README）；官方口径需先解决容器 GitHub/Docker Hub 出口 |
| R5 | overfull-hbox 超时是能力还是预算问题 | 可加 agent 超时复测（run-log 已列下一步） |
