# CURRENT.md — 当前状态与交接

更新：2026-08-16

## 一句话状态

**v1 已冻结（2026-08-16，版本 1.0.0，品牌 Loom · 织机）**：核心自进化回路 + 监督员体系 + 预约式后台执行 + 进化通讯（通知/台账/偏好）全部落地；测试 **99/99**；从零成长、自主换模型、用户消息自动唤起、actor 答"优化进度"均已实证。v1.1 待办：refine-skill demo 干净重跑、偏好沉淀端到端 demo。详细状态见 `docs/project-status.md`。

## 已完成的

- 项目结构：`src/{observer,meta,validate,gate}/` + `src/types.ts` + `src/index.ts`。
- 核心类型：`MetaPatch`、`ValidationReport`、`AppliedMetaPatch`、`EvolutionSignal`、`SignalThresholds`、`RegressionCase`（`src/types.ts`）。
- bundle 清单：`package.json`（`dsh.bundle` 声明）、`cordis.patch.yml`（`mode: observe`，阈值与回归目录可配）。
- 设计文档：`docs/architecture.md`（支柱/分层放开/收敛纪律/路线图 M0-M4/风险清单）。
- 开发手册：`docs/plugin-development.md`（官方流程整理 + 两张图）。
- 背景材料：`references/background-prime-agent-learn.py`。
- 参考系补全：validate 以 Tycho（ARC-AGI-3，arXiv:2607.28287）为主参考——actor/validate 分离 + 世界模型仿真预测与真实帧完全对齐；已同步 README、architecture、plugin-development、REFERENCES。
- 前置 L0：pnpm 11.21（`/chenzute/dsh-src/tools/bin/pnpm`）、deepseek-harness `47f9438` 克隆并构建、本项目类型链到源码构建产物、`npm run check` 通过、dsh web（mock LLM）验证启动。
- 前置 L1：量化验收标准草案已落地 `docs/research/01-eval-and-acceptance.md`（指标/基线/阈值，待 L5 确认）。
- 前置 L2：参考源全部重新拉取并编目 `docs/research/00-source-map.md`（tycho `f68912a`、prime-agent `97b994c`、arc-agi3 `4743e7d`、onebot `ef160ed`、plugin-registry `6dab4de`）。
- 基准任务集落本地：Terminal-Bench 2.1 `7131e43`（91 任务）、DeepSWE `435ee89`（~116 任务）、CyberGym 框架 `7656b71`（数据 ~240GB 按需）、verifiers `be6faf6`（自迭代 bench 参考形态），全部在 `/chenzute/dsh-src/eval/`。

## 下一步（M1，按文件）

> 实测注记（2026-08-16）：Terminal-Bench 2.1 本地切片首跑（27b + qwen-coder）→ 1/2 通过（fix-git PASS、overfull 超时），管线已通；本机容器 GitHub/Docker Hub 不通，用了 npmmirror/dockerproxy/pip 补丁，详见 `/chenzute/dsh-src/eval/README.md`。

## 对外展示（2026-08-16）

- README v2 已定稿（观察者立意版）：借势（dsh 一周 4 万星 + 700+ 插件生态）→ 反差（一切皆插件，但插件不会自己装自己）→ 证据墙 → 核心卖点 =「模型无法自己进化自己，进化需要一个外部观察者」；安全降为底线，builder/verifier 双协作让 actor 长出原本没有的能力（一切皆可被安全修改）。
- README v3（痛点设计版，2026-08-16）：开头通俗比喻（揪头发/运动员兼裁判/运行中改自己）→ 三层自指困境（看不见/验证不了/替换不了，含 Gödel 第二不完备定理引用）→ 行业证据表（ARC-AGI-3 Tycho 79.07→100.00、SAGE、CoEvoSkills、RQGM、Gödel）→ 观察者设计。
- README v3 已加入「区别段」（2026-08-16，用户定稿）：不点名竞品；表述 = 多数实现困在同一层（自评/代码围栏），我们把判断权整体上移到被修改者之上，从更上层接管判断，跳脱自指困境。
- README v4 顺序重构（2026-08-16）：开头先点名下我们做了什么（第二个验证器：observe→propose→validate→cold-apply→rollback）→ 问题（通俗自指困境）→ 痛点三层（专业）→ 前沿证据表 → 评判（多数实现困在同一层）→ 我们的做法（判断权上移）；证据墙已并入「硬核数据证据链」（汇总墙 + 明细表）。
- 生态竞品警示（2026-08-16）：`ZK-Andy/dsh-continual-evolve` 已在做 harness 状态自进化（版本化/审计/回滚/benchmark 门禁，238 测试）。README 钩子已从「没人做这件事」改为「绝大多数在做记忆/UI/小游戏，做成可验证闭环的几乎没有」；差异化靠：builder/verifier 角色分离 + 确定性帧对齐 + TCB + 从零成长硬证据。
- 待办：4 张手绘插图（fig1-architecture / fig2-loop / fig3-cold / fig4-growth）尚未生成，README 暂未嵌图；SHOWCASE.md 待与 README 合并或删除。
- 插图方向更新（2026-08-16，用户否决卡通/三格漫画/sketch-notes 路线）：改为「Qwen 硬核背景 + PIL/SVG 精确标注 + 真实数据图」；已生成 3 张 1536×1024 无文字背景试样：`/data2/chenzute/t2i/output/obs_hero_blueprint.png`（暗蓝堡垒蓝图）、`obs_hero_console.png`（等距机房控制台）、`obs_contrast_split.png`（左右对比：自指困境 vs 观察者协作）；等待用户选风格后做 PIL 覆盖层。
- 插图 v2 细化（2026-08-16）：按「故事→构图分区→元素细节→光线材质→留白」重写分镜稿并重生成：`obs_hero_blueprint_v2.png`、`obs_hero_console_v2.png`、`obs_contrast_split_v2.png`（用户反馈两张 hero 可用，蓝图主用/控制台备用）。
- 其他配图已交付（2026-08-16）：`docs/figures/evidence-compare.png`（严格同任务 off 0/3→on 3/3，真实 run-records）、`evidence-growth.png`（L1-L5 成长 + builder 轮次）、`evidence-cost.png`（builder/gate token 成本）、`fig-loop.svg`（五步回路工程图：观察者/TCB/actor 三区 + 回合边界 + 回滚分支）。待办：VLM 定位元素后给两张 hero 与对比图做 PIL 标注层。
- README 大改版后配图同步（2026-08-16）：证据图改 90/90、术语改「改进模型/评审门」；`fig-loop.svg` 重画为新五步「观察→判断→设计→核验→安装」（外部教练团队：观察器/监督员/改进模型 + TCB：核验器/执行器 + 你的 agent）；PIL 标注成品：`fig-architecture.png`（蓝图 hero）、`fig-architecture-console.png`（控制台 hero 备用）、`fig-contrast.png`（左右对比）。标注位置按分镜稿预设坐标，未经 VLM 校验；用户人工查看后可再调。
- 新增两张场景图（2026-08-16）：`fig-model-swap.svg`（案例 2 自主换模型：qwen3.6-27b ✗ → v4-flash 安装 1 → deepseek-chat 安装 2 → 正常回复，含可审计留档）、`fig-triggers.svg`（S1-S8 触发场景 → 监督员/改进模型/核验器/执行器管道 + 免疫记忆循环）；`fig-loop.svg` 可进化对象补充「/ 模型」。
- 发布冲刺（2026-08-16）：README 已落 6 图（hero/换模型/触发/对比/回路/证据×2）+ OG 社交卡 `docs/figures/og.png` + 应急封面 `docs/figures/cover-article.png`；掘金草稿已建（7674103602086395947，分类人工智能，标签 Agent，仅 1 标签为平台限制）；知乎专用版已生成（SVG 全转 PNG：fig-loop/fig-model-swap/fig-triggers.png），草稿创建中；Qwen 专属封面 `cover_coach_growth` 仍在后台生成，完成后可替换草稿封面。
- 草稿已交付（2026-08-16）：掘金草稿 https://juejin.cn/editor/drafts/7674103602086395947 ；知乎草稿 https://zhuanlan.zhihu.com/p/2072409637643612656 （SVG→PNG 后成功，SVG 直传知乎会超时）。文章文件：`docs/publish/juejin-20260816-dsh-meta-validate.md` 与 `zhihu-20260816-dsh-meta-validate.md`（PNG 版）。Qwen 专属封面首次生成 VAE OOM，已用 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` 重试（后台运行中），成功后再换两草稿封面。
- 知乎已发布（2026-08-16）：https://zhuanlan.zhihu.com/p/2072409637643612656 ；掘金草稿已同步最新（99/99、Loom · 织机、三步上手、Qwen 封面 cover-coach-final.png），停在草稿态 https://juejin.cn/editor/drafts/7674103602086395947 。`npm test` 实测 99/99。遗留：文章结尾仓库地址仍是占位「地址稍后补充」，知乎线上已可见，需要尽快替换。
- 仓库改名（2026-08-16）：对外仓库 = `ZTCNO0NE/dsh-loom`（https://github.com/ZTCNO0NE/dsh-loom）。知乎已原地更新（dsh-meta-validate→dsh-loom + 链接，PATCH+原地发布 200），掘金草稿已同步，README 标题/首段已改。遗留：包内 package.json name 仍是 dsh-meta-validate，与仓库名不一致，后续可决定是否改包名。

前置：**L5 路线修订已完成**——`docs/architecture.md` 已并入角色三分/三层触发/固定式完整核验/回炉硬约束/帧与文件优先；`docs/m1-plan.md` 含 M1 任务拆分与 I6/I9/I15 默认 schema（**待用户确认**）。**后台运行**：原生 dsh + 27b 自建冒烟集基线（`/chenzute/dsh-src/eval/baseline/`，完成后记 run-log）。确认 3 个默认值后进入 M1 编码。

1. `src/observer/index.ts`
   - `onEvent`：订阅 actor 事件流（`ctx.on('tool/result'`、session 事件），把失败/用户纠正/回归失败/可复用战术归类为 `EvolutionSignal`。
   - `collect`：按阈值过滤（已有骨架逻辑）。
2. `src/meta/propose.ts`
   - `propose`：独立模型调用（与 actor 不同角色 prompt，不共享会话状态）。
   - 输入：信号 + 当前组合配置快照（`--dump-config` 产物）。
   - 输出：候选 `MetaPatch`（config 层优先；`targetKind` 仅 `config | tool | skill`）**+ 预期轨迹**（validator 的对齐基准）。
3. `src/index.ts`
   - 事件订阅接线：actor 事件 -> `observer.onEvent` -> 阈值收集 -> `proposer.propose` -> `gate.enqueue`（propose 模式）。
   - 用 `@deepseek-ai/dsh-tools` 的 `defineTool` 注册工具：`meta.propose` / `meta.validate` / `meta.apply`。
   - Config 接线：`cordis.patch.yml` 的 `mode`、`thresholds`、`regressionDir`。

## 决策记录

- 开发环境：Windows 本机写代码/文档/类型检查；Linux 服务器跑 dsh 真机验证、隔离冒烟、回归集与发布前验收。若在 Windows 快速体验 dsh，用 WSL2，不用原生 Windows（bash 沙箱兼容问题）。
- 三档模式：observe -> propose -> apply；当前 `mode: observe`，只采集不动作。
- 验证器隔离：优先用 dsh 的 plugin-group + `isolate` 机制（`docs/plugin-development.md` 3.6），或临时 profile 跑冒烟。
- validate 判定方式：学 Tycho 的确定性对齐（仿真预测 vs 真实帧，逐格/哈希），不做 LLM 主观打分；prime-agent 只参考冷替换与回滚（见 `docs/architecture.md` 2.3）。
- 评测先行：先落地量化验收标准（`docs/research/01-eval-and-acceptance.md`）再做实现；所有参考源从公开源重新拉取，不用本机旧副本。
- 回滚模板：参考 prime-agent refine 的 before/after 快照 + rollback（见背景材料 learn.py 数据模型章节）。

## 风险与注意

- **运行留档纪律**：每次基准/评测运行必须追加 `docs/research/run-log.md`（模板见该文件），并在 `/chenzute/dsh-src/eval/run-records/` 存结果快照；未留档不算完成。
- M1 完成（2026-08-16）：`npm run check` 全绿、`npm test` 11/11；dsh headless + overlay 加载插件并落盘 workspace。细节见 `docs/m1-plan.md` §4。
- 触发频率设计（2026-08-16）：**两级频率控制**——确定性前置（阈值，免费）+ 独立 LLM 评审门（prime-agent review gate 风格，判 shouldRefine/focus）→ 才启动 builder；评审门只能否决启动、不能批准 patch（verifier 唯一验收）；频率用阈值 × 值得率 × 冷却上限三个旋钮收敛，不拍死。详见 08 §15。
- 模型分工（2026-08-16 用户确认，暂定）：**actor = 本地 27b（qwen/qwen3.6-27b）**，**builder + 评审门 = DeepSeek 官方 V4 Flash（deepseek-v4-flash）**；官方适配器 `src/llm/official.ts`（OpenAI 兼容 SSE + JSON 模式，读 `DEEPSEEK_BASE_URL/DEEPSEEK_API_KEY`）；`demo:b1` 已切换为 V4 Flash builder 并验证通过。官方 key 存 `.env-deepseek`（600）。
- 主实验方向（2026-08-16 用户确认）：**从零成长实验**——actor 从 bare loop 开始，builder 按用户意图逐步补齐工具/技能/提示词，直到完成任务；新任务超出再触发 builder 继续完善。设计见 `docs/research/10-builder-capability-experiment.md` §9。**M4 最小集由此逼出**：insert 新行语义 + skill/tool patch + 模块写入 + 隔离加载校验。
- 从零实验进度（2026-08-16）：**步骤 1 完成**——bare-loop off 基线 0/3（L1/L2/L3 全失败，run-log 已记），从零前提成立。下一步：**M4 最小集**（insert 新行 + skill/tool patch + 模块写入 + 隔离加载校验）。
- **M4 最小集完成**（2026-08-16）：insert 新行（gate insert/回滚/冲突）、builder 模块草稿写入 staging、verifier 隔离加载即校验（node --check）、isolation insert overlay；测试 **56/56** 全绿。遗留：.ts 模块校验、skill 白名单细化、从零端到端 L1-L5。详见 `docs/m4-plan.md`。
- **从零成长 L1 闭环成功**（2026-08-16）：bare actor（off 0/3）→ 硬触发/评审门 → V4 Flash builder 产出 fs-write 工具 insert patch → 隔离 probe 真实执行 → verifier approved → 安装 → 升级后 actor 重试 L1 成功。run-log「from-zero-L1」已记。下一步：L2（加 bash 工具）。
- **从零成长 L2 闭环成功**（2026-08-16）：builder 一次产出 ls-dir 工具，verifier approved，升级后 actor L2 成功且 **L1 回归通过**。成长轨迹：off 0/3 → L1 ✓ → L2 ✓。下一步 L3（编辑+验证，可能引入 skill 层）。
- **从零成长 L3 闭环成功**（2026-08-16）：两级迭代（bash-run、file-read），升级后 actor 完整 L3 任务成功，**L1/L2 回归全绿**。成长轨迹：off 0/3 → L1 ✓ → L2 ✓ → L3 ✓。下一步 L4：泛化/行为级任务（skill 层候选）。
- **从零成长 L4 闭环成功**（2026-08-16）：builder 产出 edit-verify 技能（SKILL.md），隔离 probe 真实加载 → approved → 安装；**无验证提示的任务中 actor 自动 wc -l 并报告行数**（技能层行为改变生效），L1/L3 回归通过。成长轨迹：off 0/3 → L1 ✓ → L2 ✓ → L3 ✓ → L4 ✓。下一步 L5 泛化。
- **从零成长 L5 泛化闭环成功**（2026-08-16）：off 尝试只做行数验证（缺 JSON 校验）→ builder 新增 json-verify 技能 → probe 真实加载 → approved → 重试 "valid ✓"。成长轨迹：**off 0/3 → L1-L5 全部 ✓（含泛化）**，从零成长实验四关卡完成。
- **skill patch 已接入插件 gate**（2026-08-16）：installSkill/removeSkill/skillExists + skillRoot 配置 + 回滚/冲突留痕；测试 **59/59** 全绿。详见 m4-plan M4.6。
- **从零成长可重复验收完成**（2026-08-16）：`npm run fromzero:verify` 全绿（L1-L5，L4 第 2 次尝试）；对照总结 `docs/research/from-zero-summary.md`（off 0/3 vs on 5/5，builder 6 轮，回归不降）。
- **token 成本记账接入**（2026-08-16）：官方适配器捕获 usage（流内去重）→ Proposer/ReviewGate onUsage → `cost-log.jsonl`；L1 实测 builder ~974 in/4681 out、gate ~182/118。测试仍 59/59。
- **严格同任务集对照完成**（2026-08-16）：`npm run fromzero:compare`——L1/L2/L3 同任务集 **off 0/3 → on 3/3，Δsuccess +3**（记录 `eval/run-records/fromzero-strict-comparison.json`）。
- **M4 全部闭合**（2026-08-16）：skill 隔离验证已接入 verifier 通用路径（`skillIsolation` + `skillStagingRoot` + catalog probe，未配置/探测失败即拒）；测试 **62/62** 全绿。
- **通用循环驱动从零成长验证**（2026-08-16）：`fromzero:loop-demo`（stub）证明 IterationLoop+gate ops 可直接完成工具/技能 insert（各 1 次迭代 applied）；测试 **64/64** 全绿。
- **真实模型完整通用路径闭环**（2026-08-16）：`fromzero:generic-real`——AutoPilot（硬触发→评审门→builder→collectFrames 隔离探测→verifier→gate insert）真实 V4 Flash 跑 L3a，**2 轮迭代（真实回炉）后 approved+applied**，重试通过；测试 **65/65**。
- **collectFrames 接入宿主触发路径**（2026-08-16）：`meta.iterate` / `meta.auto` / TurnBoundaryHook 共用的 loop 现在都会在 builder 后跑真实隔离探测再验证；测试 **69/69** 全绿。
- **一键验收链**（2026-08-16）：`npm run fromzero:all`（默认 verify+compare；`-- --fresh` 全量重跑）实跑全绿——L1-L5 全过 + 严格 Δsuccess +3/3，记录 `eval/run-records/fromzero-all.json`。
- **宿主路径首跑**（2026-08-16）：dsh 内 27b 调 `meta.auto`/`meta.iterate` 真实触发闭环（2 次×3 轮，均卡 isolation probe exit=1）；已修工具返回 undefined 与 meta/actor 环境拆分；**待查：父 dsh 环境内子进程 ERR_MODULE_NOT_FOUND（shell 复现成功）**。
- **宿主路径闭环成功**（2026-08-16）：dsh 内 27b 调 `meta.auto` → 评审门/builder（V4 Flash）→ collectFrames 隔离探测 → verifier **approved** → gate **insert 应用（applied=true）**。修复双隔离/嵌套目录/schema 约束/env 清理；成本记账接入 index。测试 69/69。
- **宿主演示可重复验收**（2026-08-16）：`npm run host-demo` 实跑 **pass=true**（产物证据判据），记录 `eval/run-records/host-demo.json`。
- **项目总览文档**（2026-08-16）：`docs/project-status.md` 归档设计/证据/命令/遗留，README 已链接。
- 角色口径（2026-08-16 用户确认）：validator 子系统 = **builder（迭代者，看用户需求）+ verifier（核验者，只看预期 vs 真实帧）**；actor 只执行/感受/产出真实帧，不自行迭代、不改自己 loop。详见 `docs/research/08-actor-validator-protocol.md` §8。
- 迭代闭环（2026-08-16 用户确认）：builder 与 verifier **完全分离**；verifier 第一版**固定式 + 完整验证**（全量指标/全量回归，不抽样）；builder 自评（置信度/完整度/自跑确定性自检）达标才提交；**verifier 不通过强制回炉补完整性**，无 force-apply；带收敛预算（maxIterations，超限升级人工）。详见 08 §10。
- 文件优先（2026-08-16 用户确认）：**上下文不可完全信任**（compaction 丢细节、注意力稀疏、记忆不可靠）；actor/builder/verifier/gate 内部关键状态一律落盘到 `$DSH_HOME/meta-validate/`（trajectory/builder world-model/signals/patches/history），恢复只读文件不依赖 LLM 摘要；验证器重放需 `persistenceCompression: 'none'`。详见 08 §11。
- v1 信息闭环（2026-08-16 核对）：**08 §12 信息目录 I1-I15 已定**，补齐 7 个缺口（requirements/triggers/run 产物/smoke/哈希并入 report 等）；每个消费者输入都有生产者。L5 剩余确认：I6 世界模型 v1 最小 schema、I9 预期轨迹格式终稿、I15 冒烟范围。
- builder/actor 边界（2026-08-16 确认）：builder 只看 actor 可观察行为（帧），不看完整 runtime；不直接改 actor；想实测走 `probe-request` → verifier 隔离执行（与正式验证同路径），不调起生产 actor。详见 08 §13。
- 两级验证环（2026-08-16 确认）：**隔离验证是准入门槛不是最终裁判**；最终裁判 = 上线后真实 actor 运行 + observer 观察（expectedOutcome/回归/新失败），不达标回滚并带真实帧证据多轮回炉。详见 08 §14。
- 验证集落地（2026-08-16）：`docs/research/09-validation-sets.md`——合成集 A1-A4（功能验收，离线确定性）+ 任务对照集 B1-B4（效果验收）+ 基线锚点；**已跑基线**：TB 2.1 切片 1/2、自建冒烟集 5/5（run-log 两条）。
- dsh v0.1 是 developer preview，接口会变；注入点收敛在 `src/index.ts`。
- patch 按行覆盖且 **config 整行替换不深合并**：写 bundle 的 patch 要重述整行所有键。
- GitHub 安装 dsh 插件需要 `prepare` 脚本 + pnpm `allowBuilds`；我们分发优先 npm/tarball/本地 link。
- 验证成本：跑一次回归 = 一轮完整任务 token；用最小回归集 + 冒烟任务控制。
- 信任根基泄漏：任何让 actor 可写验证链路的设计都是泄漏。

## 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 骨架：类型、接口、目录、配置层、文档 | 完成 |
| M1 | observer 事件采集 + proposer 独立模型 + 工具注册 | 下一步 |
| M2 | validator（Tycho 对齐式）：预期轨迹 + 回归集 + 隔离执行；gate 人工确认应用 + 回滚 | 待 M1 |
| M3 | gate 自动应用（回合边界执行），全程留痕 | 待 M2 |
| M4 | 放开 tool/skill 层；评估 loop 层契约测试 | 待 M3 |
