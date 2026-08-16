# prime-agent 冷替换/回滚（契约级笔记）

更新：2026-08-16。来源：PrimeIntellect-ai/prime-agent `97b994c`；核心文件 `packages/coding-agent/src/core/refinement/refinement.ts`；README 行 12/34/40/83。本地学习笔记 `references/background-prime-agent-learn.py` 作为补充背景。

## 1. 定位

- "self-improving RLM agent"：Continual Harness 存 prompt/memory/skill/subagent 为持久状态，`/refine` 读取轨迹做小步、有证据的更新；**永不改写不可变的 base system prompt**；记录快照支持回滚（README 行 34/40/83）。
- 心智模型（learn.py Q6）：refiner 不是常驻代理，是宿主在回合边界发起的一次性 LLM 调用；actor 与 validate 分离，validate = 独立 LLM 提案 + 宿主确定性校验。

## 2. 管线

1. **review gate**（`reviewAutoRefine`）：自动触发 refine 前，独立 LLM 先回答"这段轨迹值不值得沉淀"（输入 trigger + harness 现状 + 历史 + 最近 ~40k 字符轨迹），`shouldRefine=false` 直接跳过；显式 `/refine` 跳过此门（refinement.ts 行 974 附近；learn.py Q9）。
2. **planRefinement**：独立 LLM 调用（轨迹 ~80k + overview + 历史 + scope 政策），输出严格 JSON 方案 `{summary, rationale, expectedOutcome, edits:[{action: create|update|delete, kind, id, ...}]}`；`_planRefine` 先记录 baselineState（learn.py）。
3. **applyRefinementProposal**：宿主确定性执行（refinement.ts 行 707），逐 edit：
   - `validateEdit`（行 664）：action 白名单 `create/update/delete`；kind 白名单 `prompt/memory/skill/subagent`；`base_system_prompt` 不可编辑；update/delete 必须带 id；create/update 必须 title+content；skill 必须有 python reference（import + callable/call_pattern）。
   - **baseline 冲突检测**（行 726-735）：若 `baselineState` 存在且当前 `before` 与 baseline 不一致 → `applied:false, error:"entry changed during refinement planning"`（防止 plan→apply 期间文件被并发修改而静默覆盖）。
   - create 已存在 / update 不存在 / delete 不存在 → 编辑级失败留痕，不中断其他 edit。
   - 成功：version+1，保留 before/after 快照，`source:"refine"`，追加 `RefinementResult` 到历史。
4. **落盘**：`saveHarnessState`（行 340-360）= 写 `${statePath}.${pid}.${uuid}.tmp` → `renameSync` 原子替换 → finally 清理残留 tmp；目录自动创建，保留原文件 mode。
5. **历史**：`refinements` 数组 / 全局 `refinements.jsonl` 追加式；跨会话回滚依据（learn.py 行 64-70）。

## 3. 回滚（确定性，不走 LLM）

- `rollbackProposal(target)`（行 804）：对 `target.appliedEdits` **逆序**重放——有 `before` 的用 update/create 恢复 before 全字段；无 `before` 但有 `after` 的（原 create）用 delete 删除。输出与普通提案同构，宿主同样走 apply + validate。
- 结论：改什么就还原什么；不依赖模型"猜"回滚内容。

## 4. scope 政策（行 850-895）

- local（默认）：会话私有，global 条目只读；global：只允许稳定跨会话教训/偏好/可复用 skill。
- 政策文本直接进 refiner 的 user prompt，约束提案范围。

## 5. 可借鉴 vs 不借鉴

可借鉴：
- 回合边界执行（apply 时断开 agent）；
- `validateEdit` 白名单思想（我们的 gate 对 targetKind/字段做确定性校验）；
- baseline 冲突检测（plan 到 apply 之间目标被改 → 拒绝而非覆盖）；
- tmp+rename 原子写 + before/after 快照 + 确定性回滚（逆序重放）。

不借鉴：
- validate 用 LLM 主观判定（我们有 Tycho 对齐式 validator）；
- 只改内容层条目（我们的对象是 dsh 插件行 config/tool/skill，patch 语义不同——整行替换不深合并）。

## 6. 映射到 dsh-meta-validate

- gate.applyWithRollback 的骨架（`src/gate/index.ts`）应补上：apply 前重读目标行 config 与 `before` 比对（baseline 冲突）、tmp+rename 原子写（或 dsh patch 语义的整行替换）、失败回滚到 before 快照、版本递增 + 历史留痕。
- `MetaPatch.expectedOutcome` 对应 prime-agent 的 expectedOutcome——回滚/后续决策的输入。
