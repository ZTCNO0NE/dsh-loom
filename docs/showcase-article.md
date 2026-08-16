# Agent 怎么安全地改自己？我给 DeepSeek Harness 写了第二个验证器

先说结论：agent 不能在自己运行的 loop 里改自己的 loop。所有“运行时自进化”的尝试，只要绕开这条纪律，都会退化成自我欺骗。我写了一个给 DeepSeek Harness 的插件 `dsh-meta-validate`，用 `observe → propose → validate → cold-apply → rollback` 五步，让 agent 安全地长出新工具。

它跑出来的结果：一个从零开始的 agent，在真实模型驱动下自己长出了写文件、列目录、跑命令、读文件的工具，以及编辑验证、JSON 验证两个技能。严格同任务集对照：**off 0/3 → on 3/3，Δsuccess +3**，测试 **69/69** 全绿。

![总览：智能体安全地改自己](docs/figures/fig1-architecture.png)

## 一、问题：agent 怎么改自己？

DeepSeek Harness 把模型、工具、技能、会话、存储、Agent Loop、调度全部插件化了。这很好，但也逼出一个问题：agent 怎么**安全地**改自己？

热替换是自指困境。agent 在自己运行的循环里替换自己运行的循环，等于自己给自己当裁判。改了验证器，验证就失效；改了循环，谁保证新循环还是它？

答案只有一个：**执行修改的人必须站在 loop 外面**。

## 二、五个组件，一条回路

### 1. 观察（observer）

订阅 actor 的事件流，采集失败信号。连续失败、用户纠正、回归失败、可复用战术，都归类成 `EvolutionSignal`，落盘 `signals.jsonl`。

触发分三层：actor 主动请求、宿主硬触发（回合边界确定性规则）、外部兜底。actor 陷入困境时，不能依赖它自己唤起自己。

### 2. 迭代（builder）

独立角色，与 actor 不共享会话状态。输入是需求、信号、真实轨迹、当前配置。输出候选 patch，必须**自带预期轨迹**——预测的配置树、工具输出、事件序列。

只给结论不给预测的 patch，无法验证。

### 3. 核验（verifier）

这是整个插件的核心，参考了 Tycho（ARC-AGI-3 求解 agent，arXiv 2607.28287）。Tycho 的验证不是“独立 LLM 主观审查”，而是**世界模型仿真预测与真实帧的确定性完全对齐**：逐转移、逐格、逐字段/哈希比对，第一次分歧即判失败。

映射到插件里：

- 独立模型实例，防止自我确认偏误。
- 回归集覆盖被修改组件的行为面。
- 候选在隔离环境真实执行，预期轨迹与真实轨迹逐字段对齐。
- **verdict 由确定性对齐 + 回归集 + 配置不变性决定，LLM 不进判定**。

不通过就是强制回炉，没有降阈值放行。带收敛预算 `maxIterations`，超限升级人工。

### 4. 冷替换（gate）

预约队列 + 回合边界停机 + 原子切换 + 冒烟验证 + 失败回滚。应用前记录 before/after 快照，版本号递增，历史留痕。

### 5. 回滚

改错了自动还原。换 loop 不等于换壳丢记忆：会话事件流、快照与新 loop 之间有 schema 契约。

![自进化回路](docs/figures/fig2-loop.png)

## 三、信任根基（TCB）

验证器、回归集、签名公钥所在路径，对 actor **只读**。被修改的 actor 永远够不到验证链路。

这是设计里最重要的一句话：**如果修改者能改验证者，自进化就退化成自我欺骗。**

第一版只允许改 `config | tool | skill`，loop 层不放。等验证链路成熟，再评估。

![为什么不能热替换](docs/figures/fig3-cold.png)

## 四、硬核证据：从零成长

实验设计：actor 从 bare loop 开始，什么都不给。任务分五级：

- L1：写文件
- L2：列目录
- L3：编辑并验证
- L4：行为级技能
- L5：泛化到新领域

off 基线：bare actor **0/3**，写文件、列目录、编辑验证全失败。前提成立。

然后插件开始工作：硬触发 → 评审门 → builder（DeepSeek V4 Flash）→ 隔离探测 → verifier → gate 安装。

成长轨迹：

| 阶段 | 结果 |
| --- | --- |
| off | 0/3 全失败 |
| L1 | 长出 fs-write 工具，重试成功 |
| L2 | 长出 ls-dir 工具，L1 回归通过 |
| L3 | 长出 bash-run、file-read，L1/L2 回归全绿 |
| L4 | 长出 edit-verify 技能，行为级改变生效 |
| L5 | 泛化任务触发 json-verify，新领域通过 |

严格同任务集：**off 0/3 → on 3/3**。不是换任务刷分，是同一组任务，插件开和关。

宿主内闭环也跑通了：dsh 进程里的 27b 调用 `meta.auto`，一路走到 verifier approved、gate applied，`host-demo` 可重复验收 **pass=true**。

![从零成长](docs/figures/fig4-growth.png)

## 五、成本与边界（诚实声明）

验证成本 = 一轮完整任务 token，用最小回归集控制。成本已记账：L1 样例 builder ~974 in / 4681 out，评审门 ~182/118。

诚实说边界：

- loop 层修改未放开，这是设计项，不是缺陷。
- verifier 是准入门槛，上线后真实运行 + observer 观察才是最终裁判。
- dsh v0.1 是 developer preview，接口会变，注入点收敛在 `src/index.ts`。

## 写在最后

自进化这个方向，真正难的不是“让模型写代码”，而是**谁在验证、谁在执行、谁在兜底**。

我的答案是：builder 负责想，verifier 负责对，gate 负责换，actor 负责跑。修改者和核验者彻底分离，信任根基只读，冷替换加回滚。

代码仓库：`dsh-meta-validate`（公开地址待定）。

参考：
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Tycho（ARC-AGI-3，arXiv 2607.28287）](https://arxiv.org/abs/2607.28287)
- [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)
