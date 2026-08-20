# dsh-loom（Loom · 织机）

**让 agent 的演进先经过独立验证，再决定是否冷应用。v1.2 的产品承诺是“用户可委托的 Config / Skill 演进”；Loop 则以公开成功率和失败轨迹的研究方式继续推进。**

[ZTCNO0NE/dsh-loom](https://github.com/ZTCNO0NE/dsh-loom)（对外品牌 **Loom · 织机**：把你的使用、纠正与失败"织"进 agent 的能力里）是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件。你可以把它理解为**给你的 agent 配了一个"外部教练团队"**：

- **Actor / 编排层**：接住用户需求、整理会话证据、提出候选并解释进度；
- **实现器**：确认后在隔离 workspace 实现候选；v1.2 的复杂实现 runtime 是 mini-SWE；
- **核验器**：把方案放进隔离环境真实跑一遍，和预期结果逐项核对，不通过就退回重做，**绝不让模型自己给自己当裁判**；
- **执行器**：只负责安装和回滚，改错了自动还原；
- **你的 agent**：在当前产品轨里由用户主动委托演进；长期自治仍在实验。

![架构总览：外部教练团队](docs/figures/fig-architecture.png)

> **v1.2 更新说明（2026-08）**
>
> 这份 README 保留 v1.0–v1.1 的图文、案例和历史实验。它们不是 v1.2 对“自动自治”的默认承诺。当前产品轨由用户主动发起：Actor 提出候选、用户确认、mini-SWE 在隔离 workspace 实现，独立 Verifier/Gate 决定是否生效。自动触发、长期自治、通用复杂源码重构与 Actor 整体性能仍在研究。

## v1.2：用户委托，不把内部过程扔给用户

![v1.2 用户主动演进任务卡](docs/figures/fig-v12-dialogue-task-card.svg)

用户只需描述想改善什么。Actor 基于当前会话的真实证据提出候选、风险与验收方式；确认前不会改动。确认后后台执行，不阻塞当前对话；用户只会看到关键节点：等待确认、开始隔离实现、独立裁决完成。

| 用户说的话 | Actor 任务卡会做什么 | v1.2 边界 |
| --- | --- | --- |
| “把这个配置调得更稳定” | 提出 Config 候选、风险与 cold replay/rollback 验收 | 只能改宿主已有且不含凭据的配置行 |
| “给我加一个复盘失败的技能” | 提出 Skill 候选，确认后生成隔离 bundle | entry 由宿主固定；加载、使用、回滚均需独立验证 |
| “确认执行” | 只确认当前会话的待确认任务 | 用户不需要 `planId`、路径、before snapshot 或隐藏推理 |
| “先取消” | 取消仍在排队、尚未获得 workspace 的任务 | 已运行的 mini-SWE pass 不强杀，避免破坏审计边界 |
| “按刚才的任务重做” | 用原意图建立新的 immutable plan | 不重开旧 workspace，不修改旧记录 |

当前实现的完整交互状态是：`等待确认 → 排队 → 隔离实现 → 独立裁决 → 已生效 / 未生效 / 未完成 / 已取消`。默认关闭主动演进；运行一次 `dsh-loom setup` 会在用户状态目录安装固定 mini-SWE runtime 并生成受控 patch，系统不会退化为直接改配置或直接安装。

## 它能帮你的 agent 做到什么（30 秒看懂）

| 你遇到的情况 | v1.0–v1.1 历史案例 / 设计方向 | **v1.2 标记** |
| --- | --- | --- |
| agent 连写文件都不会 | 从零成长实验：工具/技能由验证链安装，0/3 → 5/5 | 历史受控任务集，不等于通用自主成长率 |
| agent 缺某个能力 | 自动补工具、搜索、命令等 | 工具自动演进不在 v1.2 产品轨范围 |
| agent 行为习惯不对 | 生成行为技能，例如编辑后验证 | Skill 是产品轨；模型遵循率仍需后续评测 |
| 某个配置不合理 | 自动诊断、改超时等 | Config 是产品轨；需用户主动委托和确认 |
| 模型不匹配 / 太慢 / 太贵 | 历史模型替换案例 | 不是 v1.2 默认产品能力 |
| agent 空转/死循环 | 监督员自动唤起改进 | 自动触发是后续路线 |
| 你说一句话要改运行时 | 历史自动消化消息实验 | 现改为 Actor 给候选、用户确认 |
| 改进过程会不会卡住对话 | 后台预约与通知 | 已保留：任务卡只通知关键节点 |
| 你说“给它加个 refine 能力” | 生成 refine skill 的历史与真实 Loader 证据 | bundle 可生成/加载/回滚；不证明任意模型必遵循 |
| 你什么都不说，一直用 | 个性化与偏好沉淀方向 | 长期自治，暂不作产品承诺 |
| 同一个错反复犯 / 旧能力退化 | 回归保护与免疫记忆方向 | 研究/历史能力，不作为当前默认自动动作 |
| 复杂任务某环节卡进度 | 主动接手、补能力的设想 | 自动触发与复杂实现均未发布 |
| 新领域不会 / 工具老报错 | 泛化 skill 实验 | 产品范围当前只为明确委托的 Config / Skill |
| 时延 / token / 成本超预算 | 自动调度方向 | 不作当前产品能力或整体性能主张 |
| 要改 agent 自己的循环（loop） | 一切皆插件的长期方向 | 研究轨：mini-SWE 实现、Loom 编排，受矩阵门槛限制 |

## 它不是 dsh 极简模式

dsh 自带的"极简模式"（minimal agent preset）是**出厂配置**：预设只给两个工具、固定提示词、无压缩。极简模式（以及 dsh 任何预设）借助 dsh 的插件工具也能自己加装工具/技能——但那是"自己动手、自己判断"：没有独立验证、没有外部回滚、没有跨会话沉淀。

dsh-loom 是**运行中的治理回路**：它把 dsh 的一切——工具、技能、配置、模型，甚至 **Agent Loop / 运行时内核**——都当作**可替换的插件对象**。谁观察、谁决定该改、谁验证、谁安装、改错谁兜底，都由治理回路决定。v1 出于安全先锁 loop 层，但这是**策略开关，不是架构限制**；把内核也当插件来换，正是后续要做深的方向。

| 维度 | 极简模式 | dsh-loom 的架构方向 | **v1.2 当前标记** |
| --- | --- | --- | --- |
| 本质 | 静态预设（配置态） | 动态进化回路（治理态） | 用户主动委托的受控演进 |
| 加工具/技能 | 能自己动手，但无独立验证/无外部兜底 | 自动长出 + 隔离验证 + 失败回滚 | Skill 已进入产品轨；工具自动演进暂不发布 |
| 内核 / Agent Loop | 架构上是插件，但没有“改它”的回路 | 可替换插件，治理回路决定换不换 | 研究轨，mini-SWE 实现，未达稳定发布阈值 |
| 自己换模型 | 能改配置，但无评估、无验证 | 自动评估并安装的历史案例 | 当前不开放为默认产品能力 |
| 一句话改运行时 | 手动改配置 | 自动消化并执行的历史案例 | Actor 先给候选，用户确认后才执行 |
| 跨会话成长 | 无 | 技能/偏好/台账落盘 | 任务状态与 immutable plan 可持久化；长期自治未承诺 |

![极简模式 vs dsh-loom 对比](docs/figures/table-minimal-compare.png)

一句话：**极简模式能加装手脚，但内核没有可插拔的治理回路；dsh-loom 把内核也当成可替换插件——什么时候换、换对了没有、换坏了怎么还原，都由治理回路决定。**

## 一个完整的例子（读者视角）

你把一个本地 27B 模型接进 dsh，想让它帮你改代码。第一天它连"把内容写进文件"都做不到——不是模型笨，是它根本没有写文件的工具。

插件做了这些事，而你只做了一件事（继续用）：

1. 任务失败 → 监督员发现"连续失败" → 唤醒改进模型；
2. 改进模型看完失败记录和配置，设计了一个"写文件"工具，还预测了它应该产生的运行轨迹；
3. 核验器在隔离环境里真实验证：工具能加载、任务能完成、其他能力没被弄坏；
4. 执行器在回合边界安装这个工具；
5. 你的 agent 重试任务——成功了。

然后是第二个任务、第三个任务…… 工具一个个长出来，行为习惯（改完必须验证）也长出来。到最后，你甚至可以告诉它"模型太慢了，换一个"——**它会自己去换，而不是等你手动改配置**。

## 案例库（v1.0–v1.1 历史实验 + v1.2 新增）

### 案例 1：从零养大一个 agent

裸 agent（所有工具禁用）单独跑三个任务：写文件、列目录、编辑验证——**0/3 全失败**。插件介入后，改进模型逐级生成并安装：

- `fs-write` / `ls-dir` / `bash-run` / `file-read` 四个工具；
- `edit-verify`（编辑后必须验证）、`json-verify`（JSON 结构校验）两个行为技能；
- 每一级都经过隔离真实执行 + 完整核验 + 安装，且旧能力回归不降。

结果：**off 0/3 → on 5/5**，同任务集严格对照 **Δsuccess +3**。

```bash
npm run fromzero:all
```

### 案例 2：它自己决定换模型

你的 agent 被配置成 `qwen/qwen3.6-27b`，但路由到了根本不提供这个模型的官方 API——连"回复一句话"都失败。**没有任何人提示它换模型**，监督员唤醒改进模型后，它：

1. 把默认模型改成 `deepseek-v4-flash`（第一次安装）；
2. 安装后监督员再次被唤醒，它继续迭代，把模型改成 `deepseek-chat`（第二次安装）；
3. 用最终配置重跑，正常回复。

两次修改的 before/after 都完整留档。模型太慢、太贵、想节约成本时同理——它会自己评估并重新调度。

```bash
npm run supervisor-swap-demo
```

![案例 2：它自己决定换模型](docs/figures/fig-model-swap.svg)

### 案例 3：用户一句话，不需要 agent 自觉

你直接说："bash 命令 sleep 1 总是 500ms 就被杀掉，把超时调大。"——**没让 agent 调用任何特殊指令**。插件自动消化这条消息，监督员唤醒改进模型，它把超时从 500ms 调到 10000ms，核验通过、安装生效。

这条路线的意义：即使你的 agent 完全不知道自己该求助，宿主也能兜底。

```bash
npm run runtime-request-demo
```

### 案例 4：一句话，它给自己装上 refine 能力

你对 agent 说："遇到连续失败时，你要能自己发起一次复核和改进，别硬撑。"——它会把这句话变成自己的**能力**：

1. 改进模型理解需求后，生成一个"失败时主动请求改进"的行为技能（类似 prime-agent 的 refine 入口，但由 agent 自己长出来）；
2. 核验器在真实环境验证这个技能能被加载、指令有效；
3. 执行器把它装进技能库；
4. 之后 agent 在陌生任务上失败时，会**主动发起改进请求**，而不是硬撑或放弃。

**为什么值得单独说**：prime-agent 是当前自进化方向最具代表性的开源工程之一，核心就是 refine——任务失败时，actor 提出对自身 `harness_state` 的修改，宿主负责 apply 与回滚，第一次把"agent 改自己的运行状态"做成了可审计的工程协议。dsh-loom 的证明更小：**这个入口不需要预置**。两次独立复现产物一致：`/tmp/refine-skill-demo.txt` = `refine-skill-ok`。

这是**模拟，不是等价**。初版技能的完善程度取决于底层模型能力与需求复杂度：模型强、需求清晰，一次安装就能接近 prime-agent 的体验；模型弱、需求模糊，则需要多轮回炉补齐。prime-agent 的优势在工程化协议——actor/validator 分工、宿主状态管理、长期迭代打磨；dsh-loom 目前只是在行为技能层复刻其入口语义。

但「长出来」与「预置好」有一个本质差别：预置方案的能力边界由设计者定义，长出来的能力由需求本身驱动。随着需求不断攀升——更多失败模式、更复杂的治理协议、loop 层契约——这套一句话长出来的 refine 会一步步逼近，最终有望与预置方案并驾齐驱。

```bash
npm run refine-skill-demo
```

> 留档说明：refine 演示当前为产物证据留档；脚本退出问题已修复，正式快照可随时低成本补跑。

### 案例 4A：v1.2 中，用户把“想改什么”交给 Actor

v1.2 不要求用户记住内部工具参数，也不把候选 workspace 或推理过程展示出来。用户说“给我加一个复盘失败的技能”后，Actor 先给出一张任务卡：目标、风险、证据数量、验收方式，以及“是否执行”的问题。

确认后，mini-SWE 才在隔离 workspace 生成 bundle；Verifier 再检查 catalog/load，Gate 冷安装并回滚。真实 refine skill 的独立证据已经覆盖：**Builder 生成 bundle → Verifier approved → Gate applied → cold Loader 读到 skill 正文 → Gate rollback 后正文不可再加载**。这证明的是 artifact 交付链，不是“任何模型都会照着 skill 做”的承诺。

产品入口的 Config、Skill 各一条“Actor 自然语言请求 → 任务卡确认 → mini-SWE → Verifier/Gate → cold replay/rollback”真机 E2E 仍是发布门槛；在这两条记录补齐前，v1.2 只把该流程称为已实现控制面，不称为已发布体验。

### 案例 5：什么都不说，越用越懂你

你不需要发任何指令，只要正常用：写代码、改配置、跑命令。系统一直在记录你的使用模式和失败模式：

- 连续失败 → 自动改进；
- 你纠正过一次输出格式 → 之后同类任务自动按你的格式来；
- 你的垂直领域用得越多（嵌入式 / 数据 / 前端……），技能库就越往那个方向长。

这是**用出来的个性化**：改进不是你说出来的，是它观察出来的。

偏好沉淀已实测闭环：你纠正"输出用纯文本、不要 markdown 代码块"后，监督员唤起 → 改进模型更新 system-prompt 并声明偏好 → 核验通过 → 应用落盘（`preferences.json` 2 条、ledger 2 条）→ headless 下 `meta_growth` 可见。留档 `eval/run-records/preferences-demo.json`。

```bash
npm run preferences-demo
```

### 案例 6：你的垂直方向，长成你的专属技能库

用一段时间后，agent 的技能库会变成你的专属配置：编辑 JSON 必校验、发布前必跑回归、文件改完必报行数、遇到某类错误先查日志……这些不是手动装的，是改进模型从你的使用史里沉淀出来的。

每次进化都落盘（技能文件 + harness-state），下次启动继续生效——**跨会话的成长**。

### 案例 7：复杂任务卡进度，它主动接手

一个多阶段任务，你的 agent 卡在某个环节：按预期这一步只需要一两次工具调用，它却来回试了十几步，耗时远超这个环节应有的预算，进度却几乎没动。继续硬跑只是在浪费你的时间。

插件不会等它自己认输：监督员按**阶段预算和进度增量**做判定（耗时超预算 × 系数、进度增量低于阈值、一段时间无实质进展），主动暂停当前回合，把"阶段预算、实际消耗、最近帧、停滞快照"打包交给改进模型；改进模型判断是补能力、换方案还是改参数，核验通过后安装。

这期间你可以继续做别的事——改进在后台完成，完成后通知你 reload 即可。

### 案例 8：同一个坑不会掉第二次

你的 agent 反复栽在同一个错误上：同样的工具、同样的错误码，连续几次都失败。监督员识别出**重复失败模式**后唤起改进模型；修好后，这个失败用例自动沉淀进回归集——之后每次进化都会先跑它。

这是"免疫记忆"：能力只涨不跌，修过的坑不会再踩。

### 案例 9：换个领域也能上手

你的 agent 在熟悉的领域已经养成习惯（比如改完文件必验证）。遇到新领域任务（比如编辑 JSON），它沿用旧习惯只做了行数验证、没做结构校验——验证证据不足，任务判定失败。

监督员识别出**泛化缺口**：旧方法论覆盖不了新领域。改进模型补一个领域专用技能（JSON 结构校验），核验器验证真实可用后安装。之后新领域任务通过，旧领域行为也不退化。

```bash
npm run fromzero:all   # 含 L5 泛化：json-verify 技能
```

### 触发场景浓缩（S1–S8）

- S1 反复失败、S2 进度不足、S8 泛化缺口已展开为案例 7–9；
- **S3 用户纠正**：你纠正过一次 → 监督员理解意图，改进模型把纠正沉淀成偏好或技能；
- **S4 回归失败**：旧能力退化 → 强制修复，能力只涨不跌；
- **S5 回合异常**：回合超时 / 步骤超限 / 输出重复 / 无心跳 → 主动暂停，把现场打包交付给改进模型；
- **S6 资源异常**：P95 时延 / token / 成本超预算 → 自动调度（换模型、限输出、减重试）；
- **S7 能力不足**：工具错误率高、反复重试、输出合规率低 → 自动补工具或调配置；

![监督员触发场景 S1-S8 与免疫记忆](docs/figures/fig-triggers.svg)

### 更多案例：同一条回路的不同切面

- **免疫记忆**：每次修好的失败都会自动沉淀成回归集——同一个坑，你的 agent 不会掉进去第二次；
- **新项目 onboarding**：第一天它不熟悉你的仓库约定，几天后它自动掌握测试习惯、提交规范、目录结构，像来了很久的老成员；
- **技能包可导出、可分享**：你的专属技能库是一个普通目录，能打包带走；另一个 agent 或同事导入后，直接获得同一套行为习惯；
- **多 agent 团队**：每个 agent 有自己的教练团队，但共享同一个垂直技能库——一个人学会的教训，全队都会；
- **危机恢复**：改坏了自动回滚，回滚之后还会复盘：这次为什么错、下次怎么避免；
- **资源自适应**：内存紧张、磁盘不足、时延超标时，自动调整超时、并发和缓存策略，而不是硬扛到崩；
- **安全自适应**：发现权限过宽会自动收紧（比如把写权限降级为只读）；被拒绝的操作过多时会重新评估策略是否合理；
- **团队规范沉淀**：多个人的纠正（"输出别带 markdown"、"先跑测试再说完成"）会沉淀成团队的公共技能；
- **插件自举**：连 meta-validate 自己的治理规则，最终也由这套回路治理（v1 锁定，验证链路成熟后放开）；
- **可审计进化史**：每次改动都有 before/after、理由、验证证据和回放命令——适合需要合规追溯的场景。

### 与 dsh 理念的契合

![dsh 生态分层](docs/figures/fig-ecosystem-layer.png)

dsh 的理念是"一切皆插件、结构层开放"。在这条链路上：

- 工具 = 插件行，技能 = `SKILL.md` 文件，配置 = 插件配置——**它们都是可进化的对象**；
- 别人写插件，它自己长插件：未来新的工具模块、插件包、甚至 dsh 运行时配置，都可以由改进模型设计并安装（v1 从 `config | tool | skill` 开始）；
- 官方插件机制（bundle / insert）解决"怎么装"；dsh-loom 解决"装什么、什么时候装、装错了怎么办"；
- plugin-registry 控制台是人工管理安装态；dsh-loom 是自动治理进化；
- 静态 skills 目录靠手动维护；dsh-loom 让技能自动长出并带回归保护；
- 同一条链路的下一站：**运行时层**（权限/超时/工具参数/会话配置）、**loop 层**（循环更换与升级，验证链路成熟后放开）、**回归保护**（每次进化旧能力不许退化）。

模型调度（太慢、太贵、节约成本时自动换或重新调度）只是这条链路上最早跑通的一个示例。

## 它和别人不一样

![自指困境 vs 外部教练团队](docs/figures/fig-contrast.png)

1. **判断权整体上移**。多数自进化是"模型提议、模型评审、模型决定"，终审还是模型自己；这里改进模型只负责提议，核验器独立判定，执行器负责安装——**你的 agent 不参与对自己修改的最终判断**。
2. **核验是确定性的**。把方案放进隔离环境真实执行，预期轨迹和真实帧逐字段/哈希对齐（参考 Tycho），第一次分歧就退回重做；不用模型自评，不给模型当自己的裁判。
3. **改错了能还原，验证链碰不到**。所有修改都留 before/after 快照，安装失败自动回滚；核验器、回归集对 agent 只读；所有关键状态落盘文件（不信任上下文，因为压缩会丢、注意力会稀疏）。
4. **越用越懂你**。同样的回路既做"能力补齐"（工具/技能/配置/模型），也做"个性化沉淀"（纠正过的格式、你的领域习惯、你的垂直技能库）——改进不是一次性事件，是持续发生的。

### 与行业自进化方案的对照

![行业方案对照](docs/figures/table-industry-compare.png)

| 方案 | 它做什么 | dsh-loom 的不同点 |
| --- | --- | --- |
| Tycho（ARC-AGI-3 满分） | 离线求解：世界模型仿真 vs 真实帧确定性验证 | 借了帧对齐；但我们做的是**运行中的 agent 治理** |
| prime-agent | 预置 refine 协议：actor 提 harness_state 修改，宿主 apply/回滚 | 不预置入口：一句话长出 refine 行为技能（模拟非等价）+ 独立 verifier 硬校验 + 回炉/台账 |
| SAGE | 多 agent 协作，外部 verifier | 角色与 TCB 的物理隔离更彻底 |
| CoEvoSkills | 技能共进化 + 确定性验证 | 不止技能：工具/配置/模型 + 跨会话偏好沉淀 |
| RQGM | 评估者本身也被进化 | 安全分界：v1 verifier/loop 锁死，评估不可被进化 |
| self-refine / LLM-judge 类 | 同一模型内部自评 | 判断权整体上移，不给模型当自己的裁判 |

## 工作原理（一分钟）

![五步回路：观察 → 判断 → 设计 → 核验 → 安装](docs/figures/fig-loop.svg)

五步回路：**观察 → 判断 → 设计 → 核验 → 安装**。安装完成后监督员会再看一次，直到没有值得改的证据（多轮收敛）。

### 名词对照

| 文档术语 | 读者视角 | 职责 |
| --- | --- | --- |
| actor | 你的 agent | 干活的那个，只体验，不参与对自己的判断 |
| 监督员 / 唤起器 | 教练团的"监工" | 只看关键摘要（模型/时延/错误率/停滞），决定是否唤醒改进 |
| builder | 改进模型 | 看全量信息，设计方案（加工具/改技能/调配置/换模型） |
| verifier | 核验器 | 隔离真实执行 + 预期轨迹对齐，LLM 不进判定 |
| gate | 执行器 | 安装/回滚，agent 不可写 |

## 数据证据链

| 单元测试 | 从零成长 | 严格对照 | 宿主闭环 | 自主换模型 | 用户消息自动唤起 |
| --- | --- | --- | --- | --- | --- |
| **101/101** | **L1-L5 全过** | **off 0/3 → on 3/3** | **pass=true** | **qwen3.6-27b → v4-flash → deepseek-chat** | **自动改 runtime 配置** |

![严格同任务集对照](docs/figures/evidence-compare.png)
![从零成长 L1-L5](docs/figures/evidence-growth.png)

### v1.2 新增证据：把“测试绿”与“能力已发布”分开

| 证据项 | 当前可复核结果 | 可以说什么 | 不能说什么 |
| --- | --- | --- | --- |
| 工程回归 | **231/231** 全绿 | 双轨控制面、任务卡与 runtime adapter 有持续回归保护 | 不能替代真实模型成功率 |
| refine skill artifact | mini-SWE 生成 → verifier/gate → cold Loader → rollback 已跑通 | 隔离 skill bundle 的交付链可用 | 不证明任意 LLM 都会遵循该 skill |
| scheduler prepare-overlap | 真实 Builder 候选在 2/4/8/16 calls 的受控路径中缩短 prepare span | 该 scheduler 改动的因果 workload 有改善 | 不等于 Actor 整体性能提升 |
| Loop 复杂实现 | mini-SWE 有一条真实 source edit→tests→submit→gate→rollback 闭环 | mini-SWE 是已验证的实现 runtime 候选 | 不等于复杂源码重构已稳定可用 |
| 产品主入口 E2E | Config、Skill 各一条仍待补 | 任务卡/Plan/Execute 控制面已实现 | 未完成前不宣称用户可用发布 |

![版本迭代与证据轨迹](docs/figures/fig-version-evidence-trajectory.svg)

其他可查记录：

- 真实模型回炉：改进模型（V4 Flash）2 轮迭代后通过并安装；
- 改进模型提交前会主动申请隔离试运行（`probes[]`），失败回传修改；
- Terminal-Bench 2.1 官方 API 切片：fix-git **PASS（1.0）**（overfull 超时，基准阶段复测）；
- 成本记账：cost-log.jsonl，L1 样例改进模型 ~974 in / 4681 out；
- 一句话 refine 复刻 prime-agent 核心语义：产物证据两次独立复现（`/tmp/refine-skill-demo.txt` = `refine-skill-ok`），留档 `eval/run-records/refine-skill-demo.json`；
- 偏好沉淀闭环：pass=true，偏好 2 条落盘、ledger 2 条、headless 下 `meta_growth` 可见，留档 `eval/run-records/preferences-demo.json`。

## 快速开始：从零启动 DSH，到第一次任务卡

这是一条**用户主动委托**链：安装 → 检查插件 → 安装实现 runtime → 启动对话 → 用户确认 → 独立验证。不要跳步骤，也不需要手填 executable、config path 或内部 ID。

### 先选你的安装方式

| 你的情况 | 直接前往 | 使用的命令入口 |
| --- | --- | --- |
| Windows，正在从 DeepSeek Harness 源码目录运行 `pnpm dsh` | [Windows](#windows--powershell) | PowerShell wrapper |
| macOS，正在从 DeepSeek Harness 源码目录运行 `pnpm dsh` | [macOS](#macos--terminal) | Unix shell wrapper |
| Linux，正在从 DeepSeek Harness 源码目录运行 `pnpm dsh` | [Linux](#linux--shell) | Unix shell wrapper |
| 已将 `dsh` 与 `dsh-loom` 都装入系统 `PATH` | [全局 CLI](#全局-cli) | `dsh-loom` |

本页默认前三种“DSH 源码 checkout”用法。每个系统块都是一段完整、可从上到下执行的路径。

### 所有系统的前置条件

- Node `^22.19` 或 `>=24`，以及 pnpm；
- Python **>= 3.10**；
- 首次安装能访问 Python 依赖源（企业镜像、官方 PyPI 或 wheelhouse 均可）；
- 已按 DSH 文档配置一个可回复的 Actor 模型 provider。

> **重要：Builder 需要独立的模型凭据。** Loom 不会让 Actor 代替 Builder 工作。默认 Builder/Review Gate 使用 `deepseek-official` 的 `deepseek-v4-flash`，启动 DSH 的同一个终端必须设置 `DSH_META_API_KEY`（也兼容 `DEEPSEEK_API_KEY`）。如果改用 Terra，设置 `LOOM_TERRA_API_KEY` 和 `LOOM_TERRA_BASE_URL`，并将 Loom 的 `llm.provider` 配置为 `gpt-5.6-terra`。没有 Builder key 时，Web 仍可启动、状态工具仍可用，但 `meta_auto` 不会产生真实 proposal。密钥只放环境变量或 DSH 的本地凭据配置，不要写入 README、patch、workspace 或提交记录。

Windows PowerShell 示例（请替换为你自己的 key，不要把真实 key 提交）：

```powershell
$env:DSH_META_API_KEY = "<你的 Builder DeepSeek key>"
```

mini-SWE 2.4.6 本体已经随 Loom npm 包提供，不要求你的镜像存在 `mini-swe-agent`。`setup` 会先检查 Python 版本，再创建隔离 venv；不会改 DSH checkout、生产 profile 或凭据。

### Windows · PowerShell

在 **DeepSeek Harness 源码根目录** 打开 PowerShell。先确认 DSH 本身能启动；Loom 不负责修复 DSH checkout 的构建或 `tsx/esm` 环境问题：
```powershell
# 0. 在启动 DSH 的同一个 PowerShell 中配置 Loom 状态目录和独立 Builder key。
$env:DSH_META_VALIDATE_ROOT = "$env:USERPROFILE\.dsh\meta-validate"
$env:DSH_META_API_KEY = "<你的 Builder DeepSeek key>"
# Terra 用户改用：$env:LOOM_TERRA_API_KEY / $env:LOOM_TERRA_BASE_URL

pnpm dsh web
```

确认 DSH 可用后，按顺序执行：

```powershell
# 1. 安装 Loom 到 Web profile。
pnpm dsh plugin --profile web add dsh-loom@1.2.16

# 2. 检查插件确已加载；输出中必须有 meta-validate。
pnpm dsh web --dump-config

# 3. 安装 mini-SWE runtime；显式指定目录，后面的 patch 路径与 setup 输出完全一致。
$runtimeRoot = Join-Path $env:USERPROFILE ".dsh\meta-validate\runtime\mini-swe-agent-2.4.6"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-loom\bin\setup-windows.ps1" --runtime-root $runtimeRoot

# 4. 使用同一个绝对 patch 路径启动；不要改成相对 .meta-validate 路径。
$patch = Join-Path $runtimeRoot "loom-active-evolution.patch.yml"
pnpm dsh web --patch $patch
```

此路径专门处理 Windows 的 `Scripts\\python.exe` / `Scripts\\mini.exe` 和 profile bin 不进入 PowerShell `PATH` 的差异。若 `python --version` 小于 3.10 或找不到命令，安装 Python 3.10+ 并勾选 **Add Python to PATH**；conda/pyenv 用户可先设置 `$env:PYTHON` 为所需解释器。

如果你是在 DSH **源码 checkout** 中运行这段命令，`setup-windows.ps1` 会自动扫描 CLI 的完整宿主依赖闭包（包括开发依赖和 peer），并修复缺失的 `%USERPROFILE%\\.dsh\\profiles\\node_modules` 链接，不需要逐个处理 `dsh-tools` 或 `directory-picker-native`。若源码包缺少 `lib`，setup 会自动依次运行 DSH 根目录的 `pnpm run build:lib:host` 和 `pnpm run build:lib:client`；构建失败会在 setup 阶段明确退出，不会生成无效 patch。不会覆盖真实目录或删除用户文件。

### macOS · Terminal

在 **DeepSeek Harness 源码根目录** 打开 Terminal，先确认 `pnpm dsh web` 能启动，再按顺序执行：

```bash
# 0. 在启动 DSH 的同一个 Terminal 中配置 Loom 状态目录和独立 Builder key。
export DSH_META_VALIDATE_ROOT="$HOME/.dsh/meta-validate"
export DSH_META_API_KEY="<你的 Builder DeepSeek key>"
# Terra 用户改用：export LOOM_TERRA_API_KEY=... 和 export LOOM_TERRA_BASE_URL=...

# 1. 安装 Loom 并检查 Web profile。
pnpm dsh plugin --profile web add dsh-loom@1.2.16
pnpm dsh web --dump-config

# 2. 安装 runtime；显式目录确保 patch 路径可直接复用。
runtime_root="$HOME/.dsh/meta-validate/runtime/mini-swe-agent-2.4.6"
sh "$HOME/.dsh/profiles/web/node_modules/dsh-loom/bin/setup-unix.sh" --runtime-root "$runtime_root"

# 3. 启动 Web 对话。
pnpm dsh web --patch "$runtime_root/loom-active-evolution.patch.yml"
```

需要 `python3 --version` 为 3.10 或更高；没有时可使用 `brew install python`。Apple Silicon 与 Intel 均使用这一段命令。

### Linux · shell

在 **DeepSeek Harness 源码根目录** 打开 shell，先确认 `pnpm dsh web` 能启动，再按顺序执行：

```bash
# 0. 在启动 DSH 的同一个 shell 中配置 Loom 状态目录和独立 Builder key。
export DSH_META_VALIDATE_ROOT="$HOME/.dsh/meta-validate"
export DSH_META_API_KEY="<你的 Builder DeepSeek key>"
# Terra 用户改用：export LOOM_TERRA_API_KEY=... 和 export LOOM_TERRA_BASE_URL=...

# 1. 安装 Loom 并检查 Web profile。
pnpm dsh plugin --profile web add dsh-loom@1.2.16
pnpm dsh web --dump-config

# 2. 安装 runtime；显式目录确保 patch 路径可直接复用。
runtime_root="$HOME/.dsh/meta-validate/runtime/mini-swe-agent-2.4.6"
sh "$HOME/.dsh/profiles/web/node_modules/dsh-loom/bin/setup-unix.sh" --runtime-root "$runtime_root"

# 3. 启动 Web 对话。
pnpm dsh web --patch "$runtime_root/loom-active-evolution.patch.yml"
```

需要 `python3 >= 3.10` 和 venv 支持；Debian/Ubuntu 常用 `sudo apt install python3-venv`。若内部镜像缺少某个依赖，可临时切换官方 PyPI 或配置 wheelhouse。

### 全局 CLI

仅当 `dsh` 和 `dsh-loom` 都已在系统 `PATH` 时使用这段：

```bash
dsh-loom setup
dsh-loom start --profile web
```

### 持久 Web 对话（推荐）

Web 是长驻服务，适合任务卡、Builder 后台进度、确认、取消、重做和跨回合查看状态。源码 checkout 用户在 DSH 根目录执行：

```powershell
# Windows PowerShell
$env:DSH_META_API_KEY = "<你的 Builder key>"
$patch = "$runtimeRoot\loom-active-evolution.patch.yml"
pnpm dsh web --patch $patch
```

macOS/Linux：

```bash
export DSH_META_API_KEY="<你的 Builder key>"
pnpm dsh web --patch "$runtime_root/loom-active-evolution.patch.yml"
```

保持进程运行，然后打开 `http://localhost:3080`。用户直接提出需求、确认任务卡、询问演进进度，不需要填写 planId 或调用内部工具名。

### 一次性 CLI（诊断/脚本）

headless 只执行一轮任务并退出，适合健康检查或自动化，不提供持久 Web 对话：

```bash
pnpm dsh --profile headless --patch "$runtime_root/loom-active-evolution.patch.yml" \
  "查看当前 Loom 状态并报告 Builder 是否已配置"
```

从 GitHub 或 Loom 源码安装属于开发者路径；请改用 `pnpm dsh plugin --profile loom add "github:ZTCNO0NE/dsh-loom#main"` 或本地绝对路径，随后仍按你的系统块执行 setup 和启动。

> **当前发布边界：** runtime bootstrap 已可分发；Config、Skill 两条 Actor 主入口真机 E2E 仍是产品发布门槛。在这两条记录补齐前，主动演进是可安装的预览控制面，不把它宣传为已发布体验。

### 3. 第一次真实对话：从需求到任务卡

进入 DSH 对话后，按这个顺序说：

1. “给我加一个复盘失败的技能。”
2. Actor 应展示候选、风险、验收方式和“是否执行”的任务卡；此时尚未改动。
3. 你回复：“确认执行。”
4. Actor 通知任务进入隔离实现；你可以继续对话。
5. 你问：“演进进度怎么样？”只会看到关键状态。
6. 裁决结束后，Actor 明确说明“已生效 / 未生效 / 未完成”；排队时可说“先取消”，终态后可说“按刚才的任务重做”。

建议在本节预留三张真实截图：

<!-- screenshot placeholder: 图 B — 用户提出 refine 请求，Actor 返回 waiting_for_confirmation 任务卡 -->
<!-- screenshot placeholder: 图 C — 用户确认后，Actor 返回 implementing / verifying 的关键进度 -->
<!-- screenshot placeholder: 图 D — Gate verdict、是否生效和回滚边界的最终任务卡 -->

这三张图应遮掉 API key、绝对路径、workspace 内容和隐藏推理；保留用户原话、候选摘要、确认、阶段与最终 verdict 即可。

> 改进模型 / 监督员默认走 DeepSeek V4 Flash（`DEEPSEEK_API_KEY`）；你的 agent 可以接本地模型（示例 qwen3.6-27b）。换模型类案例需要目标模型在 agent 的路由上可用。

> 如果你也想亲眼看看「agent 自己长能力」是什么感觉，装一条命令就够了。从 0 开始的 agent，会像打一场自己的军备竞赛：从一无所有开始，先长出第一件工具，然后是技能、配置、模型，一步步武装自己，直到有一天换掉自己的内核、装上更聪明的 loop。
>
> ```bash
> npm run try
> ```
>
> 已装 npm 包的用户（任何机器）：
>
> ```bash
> dsh-loom try
> ```
>
> 详细手册与常见问题见 [docs/USAGE.md](docs/USAGE.md)；更多案例：`npm run fromzero:all`、`npm run supervisor-swap-demo`、`npm run scheduled-notify-demo`（都是真实模型跑通并留档）。

## 设计边界（诚实声明）

- **v1.2 产品轨只承诺用户主动委托的 `config | skill`**；tool、模型调度、自动触发与长期自治仍是路线图；
- **Loop 是研究轨**：Loom 负责证据、澄清与编排，mini-SWE 负责目标明确的实现；复杂重构要在固定 3×3 immutable matrix 中公开成功和失败，达阈值前不写成可用能力；
- 核验器是**准入门槛**，上线后真实运行 + 观察才是最终裁判；
- 性能只限已测的 scheduler prepare-overlap workload；不能由此推导 Actor 整体加速；
- 验证成本 = 一轮完整任务 token，用最小回归集控制；
- 行为类技能（如"编辑后必须验证"）是"显著提高概率"而非确定性保证，验收用 2 次尝试兜底；
- dsh v0.1 是 developer preview，接口会变；所有注入点收敛在 `src/index.ts`。

## 相关参考

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Tycho（ARC-AGI-3）](https://github.com/NIMI-research/Tycho)
- [SAGE：多智能体自进化（arXiv 2603.15255）](https://huggingface.co/papers/2603.15255)
- [CoEvoSkills：技能自进化与共进化验证（arXiv 2604.01687）](https://arxiv.org/abs/2604.01687)
- [Red Queen Gödel Machine（arXiv 2606.26294）](https://arxiv.org/abs/2606.26294)
- [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)
- [项目总览与验收细节](docs/project-status.md)
