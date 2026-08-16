
planRefinement
export async function planRefinement(	
messages: AgentMessage[],	
state: HarnessState,	
history: RefinementResult[],	
model: Model<any>,	
apiKey: string,	
options: RefineOptions = {},	
headers?: Record<string, string>,	
signal?: AbortSignal,	
thinkingLevel?: ThinkingLevel,
): Promise<RefinementPlan> 
它是独立的一次llm调用，输入是包含最近对话轨迹messages,
当前harness全貌 HarnessState，以及历史refine记录RefinementResult[]
输出是一份严格json的修改方案，只读不些，不碰文件。
输出：{summary, rationale, expectedOutcome, edits:[{action: create|update|delete, kind: prompt|memory|skill|subagent, id, title, content, reference, arguments, ...}]}


调用位置： refine命令、模型awit refine模型主动认为需要调用（）、回合间隔/compaction自动触发refine（需要先过review gate再plan调用）
_planRefine 会额外先记录一份baselineState。

plan和apply分开：从plan独立调用到->apply替换期间，内核rlm.harness或另一个会话可能会改写同一个文件，比如？
所以在apply前重读文件、baseline比对。if changed in this phase，报 entry changed during refinement planing。插入到plan结果之后发给模型，
模型看到这句话会主动弃用本次改变，防止套接在过期状态上出现静默覆盖问题。

refinementEvent、RefinementResult[] 这里的refiner是refine过程中的主体。沿用、替换、回滚？
harness_state.json 与 refinements.json 还有其他什么文件，区别是啥？
harness摘要是从哪里全量中抽出来的？
用于构建system prompt ，插入位置呢？怎么维护每次发送的上下文，尾部放置避免prefill失效，怎么管理的？ skill/memory区别，tool call彼此之间在上下文中
的位置？
overviewForPrompt 从哪读出来的？给refiner LLM发送的时候是用它构建全量的。
我知道这里是两部分解耦开，一个负责refine审阅修改runtime的上下文并是维护skill/memory，另一个负责主体的runtime控制，解开是有意义的，
参考typo它就是actor探索与validate分开，这里主体就是actor去负责解决问题，validate负责对actor 维护。

applyRefinementProposal 的原子写是针对主体写，
writeFileSync(tempPath,) 生成harness_state.json.<pid>.<uuid>.tmp ->原子替换 renameSync(tempPath,statePath) 整体替换 绝不可能只写一半
_applyRefine 这里断开agent 阻塞主会话->重读文件->比对baseline->原子保存->global?追加refinement.json->重建system prompt->恢复agent

rlh.harness(run(...)) 由ipython内核执行，harness_state.json 两个写入口：
内核路径:rlm.harness.create_memory(...)/update_skill(...)
宿主路径:/refine /refine.run ->applyRefinementProposal->saveHarnessState
两个路径都是单独调用llm的吗？独立的上下文空间对吗？

内核：先比mtime 发现宿主修改过就重载 sync_from_disk,
宿主侧在llm出完方案后、apply前立刻重读文件
rlm.harness是即时的、没有审核门的
/refine 是有审核，自动触发有review gate 是啥？

## 答疑与区分（2026-08-15）

### Q1 refiner 是 refine 过程的主体？沿用/替换/回滚怎么定
- refiner = planRefinement 里的那一次独立 LLM 调用，它是"审查者/维护者"，不是主 agent。
- 沿用：edits 里不包含该条目（或 edits 为空数组）→ 文件不动。
- 替换：update 同一 id → version+1，before/after 都留档。
- 回滚有两类，要区分：
  1. 确定性回滚：/refine --rollback <id>（或 refine.run 带 rollbackId）→ rollbackProposal 直接用 before 快照反向生成 edit，不走 LLM，改什么就还原什么。
  2. LLM 修复：refiner 看到历史里 expectedOutcome 没达成、或用户纠正过，用 update/delete 覆盖——这算替换/删除，不算 rollback 字段。
- refiner 的决策输入里明确写了 "If prior refinements caused issues, rollback or replace the faulty editable entries"（REFINEMENT_SYSTEM_PROMPT）。

### Q2 文件清单与区别
| 文件 | 位置 | 内容/用途 |
|---|---|---|
| harness_state.json (local) | session-artifacts/<session-id>/harness/ | 本会话的 prompt/memory/skill/subagent + refinements 记录 |
| harness_state.json (global) | ~/.prime/agent/harness/ | 跨会话账本 |
| refinements.jsonl | ~/.prime/agent/harness/ | 全局 refine 历史，追加式，跨会话回滚依据（注意是 .jsonl 不是 .json） |
| 会话 JSONL 的 custom 条目 prime-agent.refinement | 会话转录 | 本地 refine 结果（含 harnessStatePath），本地回滚依据 |
| kernel-state.dill / kernel-state.json | session-artifacts/<session-id>/ | 内核命名空间快照，不是 harness |

关键区分：local 的 refine 只写会话 JSONL，不写 refinements.jsonl；只有 global 的才追加 refinements.jsonl。

### Q3 harness 摘要从哪抽
同一份全量数据、两种渲染：
- 数据源：loadHarnessState(global) + loadHarnessState(local) → mergeHarnessStates（agent-session.ts 的 _loadMergedHarnessState）。
- 给主模型：formatHarnessStateForPrompt → 每类 6 条、内容 180 字符、最近 5 条 refine → 注入 system prompt。
- 给 refiner：overviewForPrompt → 每类 40 条、240 字符 → 注入 planRefinement 的 user prompt。
不是"从摘要反推全量"，而是同一个对象两种截断。

### Q4 system prompt 插入位置与上下文管理
默认 RLM prompt 尾部顺序：buildRlmPrompt（固定基础前缀）→ subagent guidance → harness 摘要 → Additional Guidance → 项目上下文。custom prompt 类似：customPrompt → 项目上下文 → skills → 日期/cwd → child doctrine → harness 摘要。
- 每次 prompt 构建都重新 loadHarnessState + 重新格式化，所以 harness 修改"下一回合即生效"。
- 固定前缀在前、动态摘要靠后：前缀逐回合字节相同（利于 provider 的 KV 缓存），最新状态放在注意力更近的尾部。注意：代码注释只解释了 subagent guidance 的排序理由，没有"避免 prefill 失败"的说法——那是你的推断，可作为设计意图，但别当成代码事实。
- skill vs memory：memory 是声明性事实/偏好；skill 是可执行程序，必须带 reference{type:"python",import,callable} + arguments 契约。system prompt 里只有摘要，SKILL.md 全量由模型用 ipython 按需读。
- tool call 不在 system prompt 里：它们以 assistant 消息的 toolCall 块 + 紧随其后的 toolResult 消息出现在消息历史中，与 system prompt 相互独立。
RLM是啥意思?大致是递归调用自己，多次调用上下文切片。
这里的整个发送的body是都顺序包含？system prompt 我问的是tool 的定义description，元数据发送的时候位置，一整个顺序发给我

### Q5 overviewForPrompt 从哪读
和摘要同一个来源（merge 后的 planningState，来自那两个 harness_state.json），只是格式化参数更全，专供 refiner LLM。

### Q6 actor/validate 分工（你的理解成立，精确化）
成立，但注意：refiner 不是常驻代理，是宿主发起的一次性 LLM 调用（completeSimple，且强制非 reasoning 保证输出纯 JSON）。actor（主 agent）在主场上下文里解决问题，可顺手 rlm.harness 直改；validate（refine 子系统）= 独立 LLM 提案 + 宿主确定性校验（validateEdit、baseline 冲突检测、原子写、回滚）。与 typo 的 actor/validate 类比成立；区别是这里 validate 是"一次调用 + 确定性落盘"，不是独立循环。

### Q7 原子写针对谁
只针对宿主侧写路径：saveHarnessState 在 _applyRefine 里调用（tmp 写入 → renameSync 原子替换）。内核侧 Python 的 HarnessState.save() 是直接 open("w") 写，非原子。内核侧防的是"覆盖别人"，不防"写一半"；原子写防的是"读者看到半个文件"（读者 = 内核 rlm.harness、其他会话的 prompt 构建）。
那内核不怕写一半被别人读吗？比如其他会话？
### Q8 两个写入口是两次独立 LLM 调用吗
不是，这是关键区分：
- rlm.harness.create_memory/update_skill：主模型在主上下文里直接执行的一次 Python CRUD，没有第二次 LLM、没有独立上下文、没有审核门。它写的时候"脑子里的上下文就是主会话上下文"。
- /refine 或 refine.run：宿主发起第二次、独立的 LLM 调用（输入 = 轨迹快照 8 万字符 + overview + 历史 + scope 政策），输出 JSON 提案，宿主校验后落盘。与主会话上下文隔离。
- 共同点：写同一个 harness_state.json；内核侧 mtime 重读 + 宿主侧 apply 前重读，双向防互踩。
rlm.harness是模型自己可以触发的调用，所以依据的是自己这一轮的上下文，什么是审核门？什么是轨迹快照？历史会额外包含什么？scope政策有啥？
然后宿主发起二次调用期间，内核rlm.harness会触发create吗？ 如果触发那意味着是同时至少两个llm同时在被使用？
### Q9 review gate 是什么
reviewAutoRefine：又一个独立 LLM 调用（AUTO_REFINE_REVIEW_SYSTEM_PROMPT），输入 trigger（turn_interval/compaction）+ harness 现状 + 历史 + 最近 4 万字符轨迹，输出 {shouldRefine, rationale, instructions}。shouldRefine=false 就直接跳过 plan。显式 /refine、refine.run 设 skipReview=true 跳过此门。意义：自动 refine 不能每个 checkpoint 都跑完整 plan（贵），先用便宜的门判断"这段轨迹值不值得沉淀"。
这里的harness现状就是状态里的内容对吗？
自动审阅门又是谁会触发？/refine吗？还是模型自己调用？
### 两处纠错（你笔记里的）
1. "entry changed during refinement planning 插入到 plan 结果之后发给模型，模型看到会主动弃用本次改变"——不准确。这是编辑级失败（applied:false, error:"entry changed during refinement planning"），记录在 AppliedRefinementEdit/RefinementResult 里留痕；不是把一句话发给模型让它放弃。效果是"这条 edit 不生效"，不是"让模型改主意"。
记录了编辑级失败，那rlm调用或/refine 调用完成后但是写入失败，不需要回送给模型吗？
2. 笔记里写 rlh.harness(run(...))——正确名字是 rlm.harness；并且 rlm(...)（递归委托子代理）与 rlm.harness（状态账本 CRUD）是两个不同对象，别混。rlm.run() 内部是 host_request("rlm.run") 开子代理；rlm.harness.create_memory() 是直接写 JSON 账本。
rlm啥意思，crud啥意思？

我是不是对整体多个llm协作改动没有观念？还是你没梳理清楚脉络？对于关键名词也没做解释？
整体几个llm？3个？

## 第二轮答疑与总图（2026-08-15）

### 总图：整体几个 LLM
```mermaid
sequenceDiagram
    participant H as 宿主 AgentSession
    participant A as 主 agent（常驻）
    participant G as review gate（一次性）
    participant R as refiner（一次性）
    participant F as harness_state.json

    loop 每回合
        A->>A: system + messages + tools（streaming）
    end
    Note over A: 模型可顺手 rlm.harness 直改（无 LLM、无审核门）
    A->>F: rlm.harness.create_memory / update_skill ...
    Note over A: 或预约 refine.run（回合结束才执行）
    A->>R: refine.run（{"scheduled": true} 立即返回）
    Note over H: 回合边界 checkpoint（shouldStopAfterTurn）
    alt 自动触发（turn_interval / compact）
        H->>G: reviewAutoRefine（轨迹40k + harness + 历史）
        G-->>H: shouldRefine = true/false
        G->>R: true 才继续
    else 显式 /refine 或 refine.run
        R->>R: 跳过 review gate
    end
    R->>R: planRefinement（轨迹80k + overview + 历史 + scope 政策）
    R-->>H: JSON edits 提案
    H->>F: apply：校验 + 原子写 + before/after 快照
    H->>H: 重建 system prompt（含新 harness 摘要）
    H->>A: 自动继续回合
```

关键心智模型：主模型是唯一"常驻的演员"，其余全是宿主在特定时机拉起的一次性审查调用。gate 和 refiner 不是代理、没有自己的循环；它们用独立输入、不共享主模型的上下文，但共享同一个持久化文件（harness_state.json）。同一会话内主模型和它们不在同一时刻运行（refine 跑在回合边界，apply 时甚至断开 agent）；真正的并发发生在不同会话/进程之间（rlm 孩子、另一个窗口的 /refine）。

### 名词解释
- RLM：Recursive Language Model。这个仓库里具体指运行时设计——持久 IPython 是"变量环境"，rlm(...) 是"函数调用"（递归子代理），harness 是"持久状态"。rlm() 孩子是独立 AgentSession（独立内核、独立上下文切片），可再递归，深度受 RLM_MAX_DEPTH 限制。
- CRUD：Create / Read / Update / Delete，增删改查。rlm.harness 的 create_memory / update_memory / delete_memory / get 就是。
- 审核门（review gate）：自动 refine 的前置判断——独立 LLM 先回答"这段轨迹值不值得沉淀"，不值得就跳过 plan。显式 /refine 和 refine.run 都跳过它。
- 轨迹快照：不是全量转录，是 serializeConversation(convertToLlm(messages)).slice(-80_000)（plan）或 -40_000（gate）——对话转成 LLM 消息后取尾部一段。
- 历史额外包含：mergeRefinementHistory(global 的 refinements.jsonl + 会话 custom 条目)，每条是完整 RefinementResult：summary、appliedEdits（含 before/after 全字段）、expectedOutcome、rollbackOf、scope；格式化后最近 20 条喂给 refiner。
- scope 政策：REFINEMENT_SYSTEM_PROMPT + planRefinement 按 local/global 拼的 scopeInstruction：默认 local；global 只允许稳定跨会话教训；local refine 时 global 条目只读；基础 system prompt 不可改。
- "harness 现状"就是状态内容：是。gate 用 _loadMergedHarnessState()（local+global 合并内存对象），喂给 LLM 时用 overviewForPrompt 渲染。

### 请求 body 完整顺序（Anthropic 默认 provider）
```json
{
  "model": "...",
  "messages": [ ... ],
  "max_tokens": N,
  "stream": true,
  "system": [{ "type": "text", "text": "<整个systemPrompt>", "cache_control": {...} }],
  "temperature": ...,
  "tools": [{ "name": "ipython", "description": "...", "input_schema": {JSON Schema}, "cache_control": {...} }],
  "thinking": {...}
}
```
tools 是顶层并列参数，不在 system 也不在 messages 里；工具定义（name/description/input_schema）一次请求只出现一次。tool 的调用和结果在 messages 内部按时间顺序出现——assistant 消息的 content 里有 tool_use 块，紧接着的 user 消息里有 tool_result 块。harness 摘要位于 systemPrompt 的尾部（在 system 参数里）。

### 内核非原子写会被别人读到一半吗
风险真实存在，但分层看：local 文件是会话私有的，其他会话不读，风险为零；global 文件才共享，可能被其他会话的 prompt 构建或 refiner 读到。兜底：load 时 try/except JSON.parse，坏文件降级为空状态、不抛异常，下次 save 重写干净（refinement.ts:292 注释明说；Python load() 同样容错）。所以读到一半不会崩，但可能读到空/旧数据。mtime 防的是"覆盖"，不防"写一半"；官方推荐路径 /refine 才是原子写。模型直写 global 必须显式传 global_=True，默认 local，风险面很小。

### 宿主 plan 期间内核 rlm.harness 会触发 create 吗？同时两个 LLM？
refine.run 只是"预约"。模型在回合剩余部分继续干活时完全可以再调 rlm.harness.create——顺序发生（先模型直写，回合结束宿主才开始 plan），不是同时。plan 期间主模型已停（回合边界），apply 阶段甚至断开 agent，同一会话内不存在两个 agent 循环同时跑。真正的并发在跨会话/跨进程：另一个会话的 /refine 写 global 文件、本内核 detached asyncio task 在 cell idle 后继续发请求、rlm 子代理与父并发。baseline 冲突检测就是为"plan 到 apply 之间文件被改"准备的。

### 编辑失败要回送模型吗
现状是不回送明细：refine.run 立即返回 {scheduled:true}；真正的结果（含 applied/failed）写进会话 custom 条目，并发出 refine_complete / refine_failed 事件。TUI 只对 refine_failed 弹错误，refine_complete 不提示。模型靠重建后的 system prompt（harness 摘要）看到成功的改动，看不到失败原因。两种失败要区分：编辑级失败（validate/冲突）留在 result.appliedEdits（applied:false, error）；整体保存或 LLM 调用失败走 refine_failed。要让模型看到明细，需要扩展监听 refine_complete 后注入一条消息——目前代码里没有这条链路。

### 谁触发自动审阅门
宿主，不是 /refine，也不是模型。AgentSession 在 message_end / 回合边界自动检查：autoRefine.enabled（默认 true）+ 回合间隔（默认 25 个 assistant 回合）或 compaction 后（默认开启）。显式 /refine 和 refine.run 都设 skipReview=true，跳过门直接 plan。

## 图表集（Mermaid，2026-08-15）

### 1. RLM 运行时架构（来自 docs/rlm-runtime.md）
```mermaid
flowchart TD
    session["AgentSession · TypeScript<br/>IPython tool + host request handlers"]
    manager["KernelManager · TypeScript<br/>execution + comm dispatch"]
    kernel["IPython kernel process · Python"]
    runtime["prime-agent-runtime<br/>rlm module + Python skills"]
    code["Model-executed Python code"]

    session -->|"owns"| manager
    manager <-->|"Jupyter protocol over ZeroMQ"| kernel
    kernel --> runtime --> code
    code -->|"rlm.run · goal.* · agent_message.*"| runtime
    runtime -->|"comm target: host.request"| manager
    manager -->|"typed dispatch"| session
```

### 2. RLM 主循环（来自 docs/rlm.md）
```mermaid
flowchart LR
    task["Task + working context"]
    parent["Parent model"]
    kernel["Persistent IPython kernel"]
    data["Files · data · shell commands"]
    skills["Python-backed skills"]
    children["rlm(...) child agents"]
    answer["Answer or next turn"]

    task --> parent
    parent -->|"IPython call"| kernel
    kernel <-->|"inspect · search · transform"| data
    kernel <-->|"call functions"| skills
    kernel -->|"spawn focused work"| children
    children -->|"agent messages · files"| parent
    kernel -->|"admission handle"| parent
    parent --> answer
```

### 3. 委托流程（rlm.run，来自 docs/rlm-runtime.md）
```mermaid
sequenceDiagram
    participant M as Parent model
    participant H as Parent AgentSession
    participant K as IPython kernel
    participant C as Child AgentSession
    participant P as Model provider

    M->>H: IPython tool call
    H->>K: execute await rlm("inspect the API")
    K->>H: host.request · rlm.run
    H->>H: check depth and resolve model
    H->>H: admit child task and update registry
    H-->>K: RLMSpawnHandle
    K-->>H: tool output
    H-->>M: IPython result
    H->>C: create child runtime and prompt
    loop Child agent loop
        C->>P: stream model request
        P-->>C: response or tool call
    end
    C-->>H: explicit agent_message reply
    H-->>M: ordinary agent message
    H->>H: update registry and attribute usage
```

### 4. 自我迭代场景（refine.run 全程，来自会话讲解）
```mermaid
sequenceDiagram
    participant U as 用户
    participant M as 模型(回合内)
    participant K as KernelManager(TS)
    participant I as IPython内核(Python)
    participant H as AgentSession宿主
    participant R as /refine子系统
    participant F as harness_state.json

    U->>M: 发起任务
    M->>K: tool_call ipython(cell源码)
    K->>I: execute_request (shell通道)
    I-->>K: stdout/stderr/status (iopub)
    K-->>M: cell结果(工具结果)
    Note over M: 第N次重复拼check命令 / git status解析失败
    M->>I: await refine.run("每次改包后要在包目录跑 npm run check…")
    I->>K: comm_open "host.request" + comm_msg {type:"refine.run"}
    K->>H: 分发到 refine.run handler
    H-->>K: {status:"ok", scheduled:true} (control通道回复)
    K-->>I: comm_msg 回复
    I-->>M: {"scheduled": true}，回合正常结束
    H->>R: shouldStopAfterTurn 边界触发 refine 检查点
    R->>R: planRefinement: 最近8万字符轨迹+harness现状+refine历史 → LLM提案
    R-->>H: JSON: create skill "run_pkg_check" (reference+arguments)
    H->>F: 校验→apply: before/after快照, version=1, refinements追加
    H->>M: 重建system prompt(含新harness摘要) 自动继续
    M->>I: await run_pkg_check(pkg="packages/ai") 一次成功
    M->>F: record_refinement(trigger, changes, evidence, outcome="一次通过")
```

## 数据模型：转录文件 / result / appliedEdits / before-after（2026-08-15）

### 会话转录文件是什么
~/.prime/agent/sessions/<id>.jsonl 是当前会话的完整日志，追加式，一行一条记录。行有两种：
- 消息行：用户、助手、工具结果（进模型上下文）；
- custom 条目：扩展/宿主写的"记账"记录（不进模型上下文）。

appendCustomEntry 生成的行（session-manager.ts:1568）：
```json
{
  "type": "custom",
  "customType": "prime-agent.refinement",
  "data": { "...整个 RefinementResult..." },
  "id": "entry-id",
  "parentId": "...",
  "timestamp": "..."
}
```
关键：文件是容器，data 是内容物。refine 结果被装进 data 存进转录。

### result / appliedEdits / before / after / edits 的关系
一次 refine 全流程：
```
LLM 提案 edits（要改什么）
   ↓ apply（applyRefinementProposal）
result（RefinementResult）
   ├── summary / rationale / expectedOutcome
   ├── appliedEdits[]   ← 每条 = 一次编辑尝试的结果
   ├── rollbackOf / scope / harnessStatePath
   ↓ appendCustomEntry
转录文件里的 data 字段
```
- edits（提案里的）：plan 阶段 LLM 输出的"想法"，如 {action:"update", kind:"memory", id:"check_cmd", title, content:"新内容"}。此时还没有 before/after。
- appliedEdits（result 里的数组）：apply 阶段把每条提案 edit 执行后的记录，每条含 action/kind/id/title/content/before/after/applied/error。
- before / after：被改动条目的完整拷贝（id/kind/title/content/path/scope/reference/arguments/metadata/source/created_at/updated_at/version）。before=动手前，after=改完后；创建无 before，删除无 after。

appliedEdits 元素示例：
```json
{
  "action": "update",
  "kind": "memory",
  "id": "check_cmd",
  "title": "check 命令",
  "content": "改后的内容",
  "before": { "id": "check_cmd", "kind": "memory", "title": "check 命令", "content": "改前的内容", "path": "general", "scope": "local", "reference": {}, "arguments": {}, "metadata": {}, "source": "agent", "created_at": "...", "updated_at": "...", "version": 1 },
  "after":  { "id": "check_cmd", "kind": "memory", "title": "check 命令", "content": "改后的内容", "path": "general", "scope": "local", "reference": {}, "arguments": {}, "metadata": {}, "source": "agent", "created_at": "...", "updated_at": "...", "version": 2 },
  "applied": true
}
```

### 三个易混问题的直接回答
1. result.appliedEdits 和转录文件是同一个东西吗？不是。appliedEdits 是 result 的一个字段；result 整个作为 data 被写进转录文件的一行。文件是容器。
2. 恢复是从转录文件里的 before/after 生成反向 edits 吗？是。回滚时 getRefinementHistory 从转录（global 还从 refinements.jsonl）读出 result，rollbackProposal 用 before/after 生成反向 edits（update 过的改回 before 全部字段、删除过的重建、新建过的删掉），再作用到当前 harness_state.json 上。
3. 保存和恢复的分别是什么？保存 = 条目改前/改后的完整样子（before/after 在 result 里，result 在转录里）；恢复 = 把 harness 里当前那条改回 before 的样子。恢复的是 harness 状态文件，不是转录本身。

### 完整例子
1. plan 产出：edits: [{action:"update", kind:"memory", id:"check_cmd", content:"在包目录跑 npm run check"}]；
2. apply 读当前文件：该 memory version=1 内容旧；执行更新 → version=2 内容新；生成 appliedEdits[0] = {action, kind, id, before:{...v1 全字段...}, after:{...v2 全字段...}, applied:true}；
3. result 组装好，harnessStatePath = ".../harness/harness_state.json"；
4. 写入转录：{type:"custom", customType:"prime-agent.refinement", data: result}（global 再追加 refinements.jsonl）；
5. 回滚（/refine --rollback <id>）：读出 data → rollbackProposal 生成 {action:"update", id:"check_cmd", content:"旧内容"...} → 应用到当前 harness_state.json → 新 result（rollbackOf: <id>）又写进转录。

### 名词速查
| 名词 | 是什么 | 存在哪 |
|---|---|---|
| 会话转录 JSONL | 会话完整日志，一行一条 | ~/.prime/agent/sessions/<id>.jsonl |
| custom 条目 | 转录里 type:"custom" 的记账行 | 同上 |
| result | 一次 refine 的完整结果对象 | 转录 data 字段（global 还写 refinements.jsonl） |
| edits | plan 输出的修改提案 | 只有 LLM 回复，apply 后不再单独存 |
| appliedEdits | result 里每条编辑的落地记录（含 before/after/applied/error） | 在 result 里，随 result 存 |
| before / after | 条目改前/改后的完整拷贝 | 在 appliedEdits 里 |
| harnessStatePath | 这次写入的 harness_state.json 路径（指针，不是备份） | result 里 |

一句话链路：文件是容器、result 是内容、appliedEdits 是 result 里的数组、before/after 是数组元素里的完整拷贝。

## 缓存与 system prompt 重建（2026-08-15，含更正）

### 更正之前的一句
之前写"每次 prompt 构建都重新 loadHarnessState + 重新格式化，所以 harness 修改下一回合即生效"——不准确。

事实：_rebuildSystemPrompt 只在特定事件触发：会话启动、工具列表变化、配置变化、refine apply（agent-session.ts:4272）。回合开始用的是缓存的 _baseSystemPrompt（agent-session.ts:5767），不会每回合重读 harness。

- harness 没变 → 摘要跨回合字节一致（条目按 path/title/id 确定性排序）→ 缓存命中，不失配；
- /refine 修改 → apply 时显式重建 base → 下一回合 system 变化（这一轮 miss 是有意的，harness 变化是低频事件）；
- rlm.harness 直写 → 立即写文件和内核视角，但不会立刻进 system prompt，要等下一次重建；模型靠对话历史知道这次直写，影响有限。

### OpenAI vs Anthropic 缓存策略不一样
- OpenAI：自动前缀缓存。前缀字节完全一致（且≥1024 tokens）才命中。system 变了 → 从 system 开始全部 miss（消息在 system 之后同样失效）。这不是报错，只是 cache miss：重新 prefill，慢一点、贵一点，功能不受影响。消息历史每回合变长，尾部本来就永远 miss——前缀缓存只承诺"从头到某个前缀"的复用。
- Anthropic（本项目默认 provider）：显式 cache_control 断点，打在 system 块和最后一个 tool 上（anthropic.ts:996）。system 变了只失效 system 段，消息历史段仍可能命中——比 OpenAI 更抗动态 system。

### 位置结论
决定缓存命中的是"内容变没变"，不是"位置"。放 system 尾部的真实收益：固定前缀最大化（缓存复用主体）+ 动态摘要离消息最近（注意力）。"尾部避免 prefill 失败"不成立——prefill 不会失败，内容变化只是重算。这套设计的缓存保障是"base 不重建则字节不变"，而不是靠摆放位置。

### 自我迭代的层面（prime-agent 到底能改什么）
| 层面 | 能改吗 | 机制 |
|---|---|---|
| 消息历史 | 平时 append-only；compaction 会把早期历史收敛为摘要（compactionSummary），近期保留 | 不能逐字改写已有消息 |
| 基础 system prompt | 不可改 | /refine 明确禁止 base_system_prompt |
| harness（补充 prompt/memory/skill/subagent） | 可改 | refine.run / /refine（审核+留痕+回滚）、rlm.harness 直写（即时无审核） |
| IPython 内核命名空间 | 可改 | 模型写代码定义/覆盖函数、类、变量，跨回合持久（dill 快照/恢复）；每次启动 bootstrap 重新盖 rlm/skills |
| Python skill 包 | 可增 | skill-creator 建新 skill 包，bootstrap 按 pyproject 哈希在下一次内核启动时装进 venv |
| 运行时控制面 | 可控制 | host_request：rlm.run/list_subagents/delete_subagent、goal.*、agent_observe.*、agent_message.*（steer）、rlm_heartbeat.*、compact、refine.*、MCP |
| 宿主 TS 代码 | 不能在线改 | 改代码要更新 + daemon 重启上线 |

"IPython 内核特有的自我迭代" = 内核是可变的工作台：模型在 cell 里定义函数/类/变量，状态跨回合保留，可现场定义自己的工具函数、monkeypatch、装包；harness 沉淀的是"可复用描述"，内核沉淀的是"可执行状态"。这就是 RLM 的 context as variables。

## 命令 / skill / harness skill 三层身份与位置（2026-08-15）

### refine 的双重身份
- /refine 斜杠命令：TUI/宿主侧入口，走宿主 refine() 管线（plan→apply）。
- refine Python skill 包：内核侧入口，refine.run() = host_request("refine.run") 薄包装，同一个管线。
- 所以"宿主命令跟 skill 是一回事"基本对：殊途同归，都进宿主 refine 管线。
- harness skill 条目是另一回事：/refine 生成的"描述+契约"，存 harness_state.json。

### 位置为什么不随意
- system prompt 里没有命令段：模型看不到 /refine（不能敲斜杠命令），只看到 await refine.run()。
- 技能段（第2段）= 模块清单 + 怎么 inspect（help/dir/inspect.signature）；
- refine 行为段 = 何时调用 + 怎么用，条件 hasIpython && installedSkills.includes("refine")，放在 IPYTHON_CONTROL_PROMPT 之后、harness 摘要之前：因为调用路径是内核代码、管理对象是紧随的 harness 块。
- refine 也在技能清单里（Installed Python skill modules 会列出），所以是"清单一份、行为指导一份"，不是没跟 skill 放一起。

### "上下文当变量"的两种机制
- harness 摘要注入 system prompt = "prompt-as-variable"的一种：同一模板每次填充不同值，可被 refine/CRUD 修改（可编辑的上下文）。
- 内核 user_ns = 真正意义的变量环境：模型写代码定义的变量/函数/类跨回合保留、可读写、可组合（可执行的变量）。
- 区别：harness 修改要走 refine/CRUD（慢、有审核、留痕）；内核修改就是写代码（即时、自由）。

### tool vs skill 分层（"skill"的三个含义）
- tool（API 语义）= 请求 tools 数组里的东西，模型可直接调：这里只有 ipython（+可选 bash/edit）。goal/refine/rlm/agent_message 都不在 tools 里。
- skill 在这套架构里有三个含义（混乱的根源）：
  1. 通用 skill 目录（SKILL.md + 可选 Python 包）——发现/路由层；
  2. 安装的 Python skill——真实包，预导入内核，模型在内核里调用（代码层）；
  3. harness skill 条目——/refine 沉淀的描述+契约（持久层）。
- 不是"工具变成 skill"，是能力从"模型直接按的按钮"改造成"内核里可调用的函数/API"：要么 import 的 skill 包，要么 host_request 的宿主 API。工具面缩成一个 ipython，能力面展开成"内核代码 + 宿主 API"。

### 直接按钮 vs 收敛成 ipython
| | 直接按钮（每个能力一个 tool） | 收敛成 ipython（唯一 tool） |
|---|---|---|
| 组合性 | 每次调用是独立"事件"，结果无法编程化 | 返回值是程序值，可循环、判断、组合 |
| 状态 | 中间结果要么写文件要么回传，占上下文 | 存在内核变量里，跨回合/压缩保留 |
| 上下文 | 每次工具调用都产生 tool_use/tool_result 消息 | 模型只写要点，中间数据留内核 |
| 扩展 | 加能力=加工具定义，tool schema 每次变 | 加能力=加 skill 包或 host handler，工具定义不变 |
| 审计/策略 | 每个工具各自一套校验 | 所有动作经过同一通道，策略点集中 |
| 恢复 | 工具状态要宿主额外管 | 句柄/变量是普通对象，随 dill 快照恢复 |
| 代价 | — | 单次调用多两跳（模型→cell→内核→comm→宿主）、模型必须会编程、简单任务过度设计 |

### 谁发起 goal / refine.run
| 入口 | 发起者 | 走不走 ipython |
|---|---|---|
| /goal、/refine 命令 | 用户 | 不走，宿主直接执行 |
| await goal.complete() / refine.run() | 模型 | 必须走（模型唯一按钮是 ipython） |
| auto-refine 门 / 阈值压缩 | 宿主自动 | 不走 |

方向：模型是发起者，只是发起必须表现为写代码；宿主裁决执行、记账、留痕；内核只是通道，不是裁决者。

## 进化 harness 的内容 vs 结构（2026-08-15）

### 一句话结论
prime-agent 能进化 harness 的**内容**，不能进化 harness 的**结构**。内容本来就是 harness 的组成部分，所以"进化内容"也是"进化 harness"的一种；但"进化 harness 本身"特指结构层：改 schema、加字段、加条目类型、加工具/处理器。

### 结构层为什么被封死（代码证据）
| 限制 | 代码位置 | 说明 |
|---|---|---|
| 条目类型白名单 | refinement.ts `RefinementKind = "prompt" \| "memory" \| "skill" \| "subagent"` | validateEdit 里不在四类直接报 `unsupported kind` |
| 条目字段固定 | `HarnessEntry` 接口 | id/kind/title/content/path/scope/reference/arguments/metadata/source/created_at/updated_at/version |
| metadata 自由但不渲染 | formatHarnessStateForPrompt | 渲染进 prompt 只用 id/title/content/path/scope/version，skill 额外用 reference/arguments；metadata 完全不出现在上下文 |
| 未知 kind 读不回 | loadHarnessState | 只遍历空状态里预设的 4 个 kind 键，文件里多出的第 5 类直接不读 |
| 未知 kind 被清掉 | saveHarnessState | 按内存 HarnessState 结构重写文件，未知类不写回 |
| 内核侧接口同步受限 | bootstrap.ts REQUIRED_HARNESS_METHODS | rlm.harness 只暴露 memory/skill/subagent/prompt_note 各 create/update/delete + record_refinement，共 13 个方法 |
| base system prompt 不可编辑 | validateEdit | 明确拒绝 `base_system_prompt`；prompt 条目只是附加说明 |

### 直接回答"它还能自己添加新字段进上下文吗"
正规通道不能，两层双重阻挡：
1. 校验层：新 kind 被白名单拒绝。
2. 渲染层：即使绕过校验把数据写进文件（内核有任意写权限），宿主读取时忽略未知 kind，渲染时不用 metadata——新字段既读不回来、也渲染不出去，对模型自己都不可见。

模型唯一能"绕"的路径是在内核里写代码文件（往项目目录写 .py 再让 skill 引用它），但那属于改项目代码，不属于 harness 进化，且跨会话不可靠。

### 内容层 vs 结构层
| 层 | 改什么 | prime-agent | DeepSeek Harness |
|---|---|---|---|
| 内容层 | 4 类条目里的值（增/改/删） | 已落地（refine 审核+留痕+回滚） | 支持 |
| 结构层 | schema、字段、条目类型、工具清单、comm 处理器、内核 shim | 白名单封死 | 插件化设计（闭环未验证） |

比喻：模型能往身体里写新的记忆和技能手册（内容），但不能长出新的器官（结构）。

## 换 Agent Loop：工具化 vs 插件化（2026-08-15）

### 概念修正：工具 ≠ 插件
- 工具（tool）= 在循环**里**被调用的一步：loop 叫模型 → 模型决定调哪个工具 → 结果回灌 → 再叫模型。输入输出被 loop 契约定死。
- Agent Loop = 编排者，是工具的外围框架，不是工具本身。
- 把 Loop 做成插件 = 元层开放：换的是"调度者"，不是"被调度的一步"。
- 类比：CPU 指令是工具，操作系统内核是插件——内核决定指令怎么调度，它不是工具，是工具的调度者。

### DeepSeek Harness 的做法
模型适配器、工具注册、技能、会话、沙箱、存储、Agent Loop、调度、UI 全是插件；Cordis 元框架只保留一件事：插件加载/卸载/依赖关系管理，通过服务与事件协作。

### "换 loop 牵动全身"怎么解决
靠依赖图，不靠手工拼：每个插件声明依赖哪些服务（loop 插件依赖模型适配器、工具注册、会话存储），换 loop 时宿主按依赖自动拉起配套，缺了报依赖错误。Harness 的命名含义：马具把所有马件固定在一起，你要换的只是某一匹马。

### "由 Codex 变成 Claude Code" 类比的修正
- Codex → Claude Code = 连宿主外壳一起换（会话模型、权限、记忆、UI 全换）。
- DeepSeek 插件化 = 同一个 Cordis 底盘上换循环策略，接近"同一台电脑换操作系统"：文件系统、通道、事件总线不变，但跑的是另一套 agent 人格。

### 自指困境：两个架构殊途同归
换 loop 是最深的"自指"：agent 不能在自己运行的循环里替换掉自己运行的循环（鸡生蛋）。执行替换的人必须站在 loop 外面：
- prime-agent：内核只"预约" refine，宿主在回合边界（shouldStopAfterTurn）执行。
- DeepSeek：宿主侧命令/重启/引导加载器执行插件试装。

差别：prime-agent 把外部执行者固定死（宿主代码）；DeepSeek 把外部执行者也开放成插件。

```mermaid
flowchart TB
    subgraph HOST["宿主外壳（两架构都保留）"]
        FS[文件系统/通道/会话记账]
    end
    subgraph DSH["DeepSeek Harness：全插件"]
        LOOP1["Agent Loop（可换）"]
        MODEL1["模型适配器（可换）"]
        TOOL1["工具注册（可换）"]
        SKILL1["技能（可换）"]
        STORE1["存储/会话日志（可换）"]
        LOOP1 --> MODEL1 --> TOOL1 --> SKILL1
    end
    subgraph PA["prime-agent：半开放"]
        LOOP2["Agent Loop（固定，宿主代码）"]
        MODEL2["模型（可配）"]
        TOOL2["工具（可配）"]
        SKILL2["harness 技能（内容级可进化）"]
        STORE2["存储（固定）"]
        LOOP2 --> MODEL2 --> TOOL2 --> SKILL2
    end
    HOST --- DSH
    HOST --- PA
```

一句话总结：工具化是"把能力变成循环里的一步"，插件化是"把循环本身变成可替换的组件"。前者是加器官，后者是允许换大脑——而换大脑这件事，两个框架都承认必须由体外的人动手。
