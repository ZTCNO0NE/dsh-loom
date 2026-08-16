# 阶梯设计：视野与知识补全（Front Stages）

更新：2026-08-16

状态：设计稿，待用户确认后执行。

## 0. 设计原则

- 前段只做"看与读"，不写实现：评测先行 -> 采集 -> 编目 -> 消化 -> 映射 -> 决策；代码从 M1 才开始。
- **测试先行**：先定义"怎么算好"（量化验收标准），再做实现；每个里程碑的完成定义必须绑定可量化指标与阈值。
- 所有外部资料**重新拉取**（不使用本机旧副本），按 commit/版本固定；笔记带出处（文件路径 + 行号或 API 签名），防止上游接口漂移。
- 参考源码放项目外（`/chenzute/dsh-src/…`），本项目只放结构化笔记（`docs/research/`），不污染交付物。
- 按问题读书，禁止整卷通读；论文只补概念，源码才是一手事实。
- 每一级有关卡（gate），过了才进下一级；任何一级暴露重大未知，先解决再走。

## 1. 总览

| 级 | 名称 | 主要产出 | 关卡（gate） |
|---|---|---|---|
| L0 | 环境底座 | 可运行的 dsh + 本项目类型检查通过 | `pnpm dsh web` 启动；`npm run check` 全绿 |
| L1 | 评测先行（测试先行） | `docs/research/01-eval-and-acceptance.md`：dsh 官方评测材料筛选 + 自迭代衡量数据集/方式 + 量化验收标准 | 每个指标/基线有出处；M1-M4 阈值草案落地 |
| L2 | 知识采集（全部重新拉取） | `docs/research/00-source-map.md`（全源落盘编目） | 清单每项重新拉取并记录 commit |
| L3 | 知识消化 | 契约级笔记 02-06 + 必备知识 Q&A | 关键问题 80%+ 有出处答案 |
| L4 | 映射与差距 | 三方映射表（含指标映射）+ 差距清单 + 决策清单 | 三份产出齐，RED 项有处置 |
| L5 | 路线修订 | 修订后的 M1/M2 任务、验收标准与量化阈值 | 用户确认决策清单后进入编码 |

## 2. 各级详情

### L0 环境底座（一次性）

目标：拿到能跑的 dsh 开发环境和本项目类型检查。

动作：

1. 安装 pnpm（当前环境有 Node 22.20 + npm，无 pnpm/corepack）：`npm install -g pnpm`。
2. 克隆 deepseek-harness 到固定目录：`/chenzute/dsh-src/deepseek-harness`（不放进本项目目录，避免嵌套污染）。
3. `pnpm install`；配 `DEEPSEEK_API_KEY`；`pnpm dsh web` 验证 Web UI 启动。
4. 本项目 `npm install`；把 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 类型链到 dsh 源码 checkout 的构建产物（`packages/<pkg>/lib/types`），**不链运行实例的 staging 目录**。
5. `npm run check` 全绿。

关卡：`pnpm dsh web` 能启动；`pnpm dsh --dump-config` 能看到基础组合树；本项目 `npm run check` 通过。

### L1 评测先行（测试先行，放在最前面）

目标：先回答"我们拿什么数据集、什么指标、什么基线来衡量 dsh 以及本插件的自迭代做得好不好"，落地一份量化验收标准，后续所有里程碑对表。

动作：

1. 在 deepseek-harness 官方材料（仓库 README、`docs/`、`packages/`、官方文章/论文链接）中**全文检索评测关键词**：`benchmark / bench / baseline / dataset / eval / evaluate / metric / score / leaderboard / self-improve / self-evolve / iterate / regression` 等，筛选出"评测 harness 自身"的材料：评测命令、脚本、数据集、基线分数、指标定义。
2. 检索**自迭代/自进化衡量**：dsh 或社区有没有衡量"迭代质量"的数据集与指标（改进率、回归率、成本/收益、收敛性）；Tycho 的 RHAE/scorecards、prime-agent 的 refinements 历史 / expectedOutcome 达成率作为参考口径。
3. 产出 `docs/research/01-eval-and-acceptance.md`，内容至少包括：
   - 候选数据集/任务集：每项含来源、规模、获取方式、用途；
   - 候选指标定义：每项含公式/口径、来源出处；
   - 候选基线：原生 dsh（插件开关对比）、Tycho/prime-agent 参考值；
   - 按里程碑（M1-M4）的量化验收阈值草案。
4. 把筛选出来的评测素材一并加入 L2 的拉取清单。

关卡：`01-eval-and-acceptance.md` 落地；每个指标/基线都有来源；阈值先定草案，L5 决策门确认；若 dsh 官方没有现成自迭代评测，明确写出"缺口 + 自建最小评测方案"。

### L2 知识采集（全部重新拉取）

目标：设计需要的原始资料全部从公开源**重新拉取**、落盘、编目（不使用本机旧副本）。

| 源 | 拉什么 | 重点 | 放哪 |
|---|---|---|---|
| deepseek-harness | 完整源码（L0 已克隆） | `packages/`、官方 `docs/user/develop/basic/*`、`cookbook/`、`subsystems/`、事件/session 文档、CLI 实现、评测相关材料（L1 筛出） | `/chenzute/dsh-src/deepseek-harness` |
| Tycho | 仓库 + 论文 arXiv:2607.28287 | `docs/ARCHITECTURE.md`、`wmlib verify/verify_outcome`、`workspace.py validated_plan`、`prompts/`、四种 policy 与结果、scorecard 证据 | `/chenzute/dsh-src/tycho` |
| prime-agent | 从公开源重新拉取（若源码不在公开网络，以可获取的公开版本为准并标注） | `refinement.ts` 关键函数、`applyRefinementProposal`、回滚与冲突检测、expectedOutcome 记录方式 | `/chenzute/dsh-src/prime-agent` |
| ARC-AGI-3 官方 | `arcprize/ARC-AGI-3-Agents` + docs.arcprize.org | agent 接口、评分（RHAE）、验证语义 | `/chenzute/dsh-src/arc-agi3` |
| 社区插件 | dsh-plugin-onebot、plugin-registry | 真实插件组织方式、make-dsh-plugin 引导 | `/chenzute/dsh-src/community` |
| 评测素材 | L1 筛出的 dsh 数据集/基准/评测脚本 | 按 `01-eval-and-acceptance.md` 的清单逐项落盘 | `/chenzute/dsh-src/eval` |
| 论文（可选） | Continual Harness / Self-Harness / DarwinX / SIA | 只读摘要与相关章节，标记"暂不必须" | 笔记内记录即可 |

产出：`docs/research/00-source-map.md`——每个源一行：路径、commit/版本、关键文件清单、阅读状态。

关卡：清单每项已重新拉取且记录固定 commit；prime-agent 若拉不到公开源码，标注差距并降级为只读笔记。

### L3 知识消化（契约级笔记）

目标：每个源产出"契约级"笔记——结论 + 出处，而不是通读流水账。

产出文件：

| 文件 | 内容 |
|---|---|
| `02-dsh-plugin-platform.md` | 插件生命周期、defineTool 全字段与执行管道、事件系统与 payload、Config/Schemastery、bundle/patch 覆盖规则、plugin-group/isolate、LLM 服务与独立调用、类型链接、构建分发 |
| `03-tycho-validate.md` | verifier 输入输出、对齐判定规则、UNKNOWN/coverage 语义、执行期帧哈希对齐、四种 policy 结果、隔离与完整性 |
| `04-prime-agent-cold-apply.md` | refine 管线、回合边界执行、原子写、before/after、回滚、baseline 冲突检测、scope 白名单；以及哪些不借鉴 |
| `05-arc-agi3-context.md` | 验证语义词表（exact replay / transition match / RHAE / 帧），用于统一"帧"的语言 |
| `06-key-questions.md` | 必备知识清单的 Q&A：每条有答案 + 出处；答不上来的标 RED 进差距清单（含 L1 的评测问题） |

方法：按问题读源码；Tycho 已完成首轮浅读（前一轮核对），本阶段补论文细节即可。

关卡：`06` 关键问题 80%+ 有出处答案；RED 项数量可控且有下一步处置。

### L4 映射与差距（知识 -> 设计输入）

目标：把知识变成设计输入，产出三份清单。

1. **三方映射表**：本插件四组件 × dsh 机制 × Tycho/prime-agent 参考：
   - observer -> dsh 事件流（哪些事件、payload 结构）
   - proposer -> 独立 LLM 调用 + `--dump-config` 快照
   - validator -> Tycho 对齐式验证（dsh 里"帧"= 什么，如何哈希）
   - gate -> prime-agent 冷替换 + dsh patch/回滚
2. **指标映射**：`01-eval-and-acceptance.md` 的量化指标 -> 四组件（observer 信号质量、proposer 补丁质量、validator 对齐率/覆盖率、gate 回滚成功率/成本）。
3. **差距清单**：关键未知与风险，例如：
   - dsh 事件 payload 里有没有失败/用户纠正/compaction 标记？
   - 运行时能不能读/写其他插件行的 config？有没有配置服务？
   - 独立 LLM 调用怎么保证不共享 actor 的会话状态？
   - 候选 patch 的"预期轨迹"在 dsh 里用什么格式表达、怎么对齐？
   - 评测缺口：自迭代质量有没有现成数据集/指标，没有的话自建最小评测方案是什么？
4. **决策清单**：需要用户拍板的问题（见第 5 节）。

关卡：三份产出齐；每条 RED 项都有"验证方法或降级方案"。

### L5 路线修订 + 决策门

目标：基于必备知识修订路线图，然后才进入 M1 编码。

动作：

1. 更新 `docs/architecture.md`（特别是 2.3 的"帧"定义与对齐口径）和 `CURRENT.md`。
2. 用 `01-eval-and-acceptance.md` 的阈值给 M1-M4 绑定验收标准，写入各里程碑完成定义。
3. 把 M1 拆成可验收任务：observer 事件订阅清单、阈值逻辑、proposer 独立模型调用、`meta.*` 工具注册、配置接线、`npm run check`。
4. 定义 M1 验收演示：dsh profile 加载本插件 + `--dump-config` 组合树含本插件行 + 一条"假信号 -> 候选 patch"的端到端 trace，并按 01 的指标量化。

关卡：用户确认决策清单与量化阈值后进入编码；M1 的验收标准写进 CURRENT.md。

## 3. 必备知识清单（核心问题）

### A. dsh / Cordis 插件平台

1. 插件最小形态：`apply(ctx)`、`name`、`inject`、`Config` schema；生命周期与 HMR 行为。
2. `defineTool` 完整字段、工具执行管道（pre/execute/post）、`tool/result` 事件结构。
3. 事件系统：事件种类（emit/serial/waterfall）、session 事件、失败/用户纠正/compaction 是否有事件与 payload。
4. Config：Schemastery 校验、默认值、HMR 重配；patch 整行覆盖不深合并的确切行为。
5. bundle/profile/patch：加载顺序、`dsh plugin add` 的安装行为、`--dump-config` 输出结构。
6. 服务隔离：plugin-group + `isolate` 的配置与限制。
7. LLM 服务：ctx 里如何发起独立模型调用？能否指定不同模型/角色？会话状态怎么隔离？
8. 配置读写：运行时读/写其他插件行 config 的途径（gate/proposer 依赖）。
9. 类型链接：`@deepseek-ai/cordis` / `dsh-tools` 链到源码构建产物的正确姿势。
10. 构建分发：`dsh.bundle`、`files`、`pnpm pack`、GitHub 安装的 `prepare` + `allowBuilds`。

### B. Tycho（validate 主参考）

1. actor / builder / verifier / planner 的边界与调用协议。
2. `verify()` 的输入输出：simulation_accuracy、strict、first_divergence、coverage 的精确定义。
3. UNKNOWN(-1) 语义与覆盖率阈值；no-op 凭空预测变化的判错规则。
4. 执行期帧对齐：`validated_plan_hint`、预期帧哈希、第一次偏差暂停。
5. 四种 policy 的差异与结果（为什么 actor-controlled builder 最优，自动 repair 反而差）。
6. 隔离与完整性：容器、无网络、只读根、workspace 挂载、manifest 哈希。

### C. prime-agent（冷替换/回滚参考）

1. refine 管线：review gate -> planRefinement -> applyRefinementProposal 的完整调用链。
2. 原子写（tmp + rename）、before/after 快照、确定性回滚的实现。
3. baseline 冲突检测与 scope 白名单（base prompt 不可改）。
4. 哪些可借鉴（回合边界、快照回滚），哪些不借鉴（LLM 主观判定式 validate）。

### D. ARC-AGI-3 背景（验证语义校准）

1. agent 接口与评分（RHAE）的粗粒度理解。
2. "exact replay / transition match"等验证词表的官方定义。
3. 本项目的"帧"与 ARC 的"帧"如何类比（dsh 事件序列 vs 游戏帧）。

### E. 评测与验收（测试先行）

1. dsh 官方有没有评测 harness 自身的 bench / 基线 / 数据集 / 评测命令？分别是什么、怎么跑？
2. 有没有现成的"自迭代/自进化质量"衡量方式（数据集 + 指标）？
3. 参考口径：Tycho 的 RHAE/scorecards 怎么算；prime-agent 怎么记录 expectedOutcome 达成/失败？
4. 我们每个里程碑绑定哪些指标、阈值多少（草案）？
5. 最小回归集/冒烟任务集的第一版范围来自哪些数据集？

## 4. 范围边界

- 全部参考源**重新拉取**，不依赖本机旧副本（如 `E:\prime-agent-main`）。
- 不碰：生产 adapter、systemd 服务、live/压力流量、模型目录、加密目录（全局环境边界，见根 AGENTS.md）。
- 前段不写实现、不建 profile、不安装插件；L0 的 `pnpm install` 与源码构建除外。
- 论文只读摘要与必要章节；深挖前先问"它是否改变设计"。
- 拉取的参考仓库一律只读；本项目 git 只提交本项目文件与笔记。

## 5. 决策门（L5 需要用户拍板的问题，先列出来）

1. **"帧"的定义**：dsh 里对齐的最小单位是什么？候选一：工具结果事件序列；候选二：配置树快照；候选三：两者结合。
2. **预期轨迹格式**：JSON 事件序列 / 可执行断言脚本 / 哈希清单，第一版选哪个？
3. **对齐口径**：完全一致才 approved（Tycho strict），还是允许 UNKNOWN/coverage 语义？
4. **第一版回归集范围**：哪些冒烟任务算"最小回归集"？
5. **量化验收阈值**：`01-eval-and-acceptance.md` 的阈值草案是否作为各里程碑完成定义？

## 6. 当前环境现状（起点）

- Node 22.20 ✓ / npm 10.9.3 ✓ / pnpm ✗（需装）
- deepseek-harness 源码 ✗（需克隆）
- Tycho：已浅读仓库（前一轮），论文细节待补
- prime-agent：待从公开源重新拉取
- 评测素材：待 L1 筛选
