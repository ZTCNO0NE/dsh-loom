# M2 实施记录

更新：2026-08-16。范围：固定式完整 verifier + 回归集 + gate 应用/回滚 + builder 回炉闭环。

## 已完成

### M2.1 verifier（`src/validate/index.ts`）

- Tycho 对齐：`align()` 逐事件比对预期轨迹 vs 真实帧，产出 accuracy/strictAccuracy/first_divergence（精确到 index + 字段）/coverage；
- 完整判定：approved 仅当 accuracy=1、strict=1、无 first_divergence、coverage ≥ 阈值（默认 0.75）、回归集全过、配置不变性成立；
- 回归集运行器：`regressionDir/<scenario>/`（task.md + run.sh + expected.json），keyless 确定性执行；
- 输出 ValidationReport（I10，含 alignment/regressionResults/beforeAfterHashes）+ persistReport 落盘。

### M2.2 gate（`src/gate/index.ts`）

- `applyWithRollback(patch, ops)`：读 before → baseline 冲突检测（plan→apply 期间被改即拒）→ write → smoke → 失败回滚到 before；
- history.jsonl append-only（apply/rollback/rollback-error/reject-conflict/apply-error）；status.json 状态机；
- ops 注入（readConfig/writeConfig/smoke/baseline），可离线测试。

### M2.3 builder 回炉闭环（`src/meta/loop.ts`）

- `IterationLoop`：builder → verifier → 拒绝则强制回炉（propose 带 previousReport 的 first_divergence 证据）→ approved 后人工确认应用；
- `maxIterations` 超限升级（escalated=true），不允许放行。

### M2.4 回归集

- `meta-regressions/`：smoke-hello / smoke-math / smoke-bash-timeout 三个 keyless 场景（≥3 达成）。

### M2.5 验收

- `npm run check` 全绿；`npm test` **23/23**（A3 对齐/分歧定位/覆盖率/不变性/回归失败 ×6，A4 应用/回滚/写失败/冲突 ×4，回炉闭环 ×2，其余 M1）；
- dsh headless + overlay 集成 boot 正常（meta.validate 工具已注册）。

## 遗留（M2 后续 / M3 前置）

- **隔离执行未接**：`meta.validate` 目前用 `patches/<id>/run/events.jsonl`（无则视为空帧）；临时 profile 应用候选并采集真实帧的执行器是下一步（M2.6）。

### M2.6 隔离执行器定位（2026-08-16 用户确认，防 scope 膨胀）

- **目的 = 验证候选自身的基础错误**：① 组合树可解析/可加载（`--dump-config` 校验同 profile 同 patch 层）；② 候选行为面与预期轨迹对齐（probe 任务真实帧）；③ 未涉及行不变（配置不变性）。**不是**为了更深入感知 actor。
- **不感知 actor**：隔离环境不复制 actor 的会话/上下文/提示词历史；只挂候选 patch + probe 任务 + 回归集。
- **验收归属**（2026-08-16 决策）：M2.6 执行器归 **verifier**；builder 只保留提交前自检（advisory，不构成验收）；**默认不信任 builder 生成的代码**——代码级错误由 verifier 隔离加载即校验（fresh process import），失败即 rejected。
- **与全量轨迹的关系**：actor 进 builder 时提供的全量轨迹是"改之前的世界"；隔离运行只回答"把这个候选应用后，世界是否按预期转"——两者不重复，也不互相替代。
- 若某个候选不需要行为探测（如纯配置数值修正），M2.6 最小形态 = 只做 `--dump-config` 校验 + 配置不变性 + 回归集，probe 可选。

### M2.6 完成（2026-08-16）

- `src/isolation/runner.ts`：`runIsolation(patch, opts)`——baseline/patched 两次 `--dump-config` 解析（`parseDump`/`findChangedRows`/`buildCandidateOverlay`），校验候选行存在、无关行不变；可选 probe（在候选 profile 下跑一条任务）。
- 测试：`isolation.test.ts` 5 例（解析/差异检测/overlay 生成/composed 判定/失败路径），全套 `npm test` 29/29。
- 真机 demo（`npm run demo:isolation -- --probe "reply with ok"`）：候选行 agent-default-model 改模型 → `composed: true, changedRows: []`，probe exit 0 输出 ok。
- 归属（2026-08-16 确认）：**M2.6 归 verifier**——`Validator.runIsolationCheck()` 已在 `run()` 中作为前置步骤（组合/加载不过直接 rejected，probe 失败也 rejected）；隔离执行器不是 builder 的验收权。测试增至 31/31（新增 verifier×isolation 2 例）。
- 状态：执行器已并入 Validator；`meta.validate` 工具接入配置化 isolation（dshCommand/cwd/profile）留到 M3 与 host 硬触发一起做。
- dsh 原生事件接线待确认（tools/post-execute payload）；
- host 硬触发（回合边界确定性规则）归 M3；
- 真实模型回炉演示（builder 第一次 rejected → 按 first_divergence 修 → approved）待隔离执行就绪后补。
