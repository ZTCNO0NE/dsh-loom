# M3 实施记录

更新：2026-08-16。范围：host 硬触发 + 应用后冒烟 + 自动应用（autoConfirm）+ isolation 配置接入 meta 工具 + 效果对照协议。

## 已完成

### M3.1 host 硬触发（L2，确定性规则）

- `Observer.evaluateHardTriggers(thresholds)`：回合边界确定性判定——repeated_failure 达阈值、user_correction、regression_failure、**turn_end_error ≥ 2**（无进展卡死）；全部不经模型判断，actor 无法抑制；触发即写 `triggers.jsonl`。

### M3.2 应用后冒烟（I15）

- `Validator.runSmoke(patch, cases)`：keyless 回归子集 + expectedOutcome 存在性检查；gate 在应用后执行，失败自动回滚（A4 既有路径）。

### M3.3 自动应用 + isolation 配置 + meta.iterate

- `IterationLoop` 增加 `autoConfirm`：`mode: apply` 时 approved 直接应用，不再等人工；`mode: propose` 保持人工确认。
- Config 增加 `isolation`（enabled/dshCommand/cwd/profile/baseOverlays/probe/probeTimeoutMs），开启后 Validator 前置隔离校验（M2.6 归属 verifier）。
- 新工具 `meta.iterate`：信号 -> builder -> verifier（含可选隔离）-> approved 后按 mode 自动/人工确认应用；应用走 `ctx.loader`（best-effort）+ `runSmoke`。

### M3.4 验收

- `npm run check` 全绿；`npm test` **36/36**（新增：硬触发 ×1、runSmoke ×2、autoConfirm/人工拒绝 ×2）；
- dsh headless + overlay 集成 boot 正常（新 schema 与 meta.iterate 注册无碍）。

### M3.5 评审门 + 自动频率控制器（2026-08-16）

- `src/meta/review.ts`：独立 LLM 评审门——确定性硬触发命中后才调用；输出 `{shouldRefine, rationale, focus}`；决策写 `gate-decisions.jsonl` + triggers 追加 `review_gate`；**只能否决启动，不能批准 patch**。
- `src/meta/autopilot.ts`：两级频率控制——阶段0 免费硬触发 → 阶段1 评审门 → 阶段2 builder+verifier 闭环；`minIntervalTurns`（冷却）、`maxIterationsPerEpoch`（每 epoch 预算）、apply 后 epoch+1 重置预算（epoch 锁）；状态持久化 `autopilot-state.json`。
- Config 新增 `reviewGate`（enabled/minIntervalTurns/maxIterationsPerEpoch/prompt）；observe 模式强制关。
- 新工具 `meta.auto`：回合边界入口（turn 参数），跑完整 AutoPilot 流程。
- 测试 **44/44**（新增 review ×3、autopilot ×5：硬触发放行/冷却/评审门否决/epoch 预算/无触发不动作）。
- 遗留：`meta.auto` 手动可调；自动挂到 dsh 回合边界事件仍需真机确认（M3.6）。

### M3.6 回合边界自动挂接（2026-08-16）

- 事件源确认：`turn/end` 是 session 日志事件（非 ctx emit）；插件可订阅的是 **`agent/turn-stopping`（serial，回合即将关闭，payload {agent, turn, signal}）** 与 **`agent/status`（emit，idle/running 转移）**（docs/subsystems/core.md 行 971-1017）。
- `src/meta/turnboundary.ts`：`TurnBoundaryHook`——turn-stopping 时做**廉价确定性硬触发检查**（不阻塞边界），命中则置 pending；`agent/status -> idle` 时（无 driver 活跃的安全窗口）异步跑 AutoPilot 闭环，busy 标志防重入。
- index 接线：`mode !== 'observe'` 时 attach；observe 只采集不动作。
- 测试 **48/48**（新增 turnboundary ×4：监听注册/触发在 idle 才执行/无触发不动/重入保护）。
- 真机：propose 模式 overlay boot 正常，workspace 落盘。
- 说明：事件 payload 的运行时确认基于官方文档契约；`agent/error`/`tools/post-execute` 的 observer 接线仍是 best-effort（M1 遗留），硬触发判定的数据源在真实 dsh 会话里还需一次带真实事件的观测验证（列入 B1 实验前置）。

## 效果对照协议（B1/B2，09 落地）

- B2 回归保护：meta-regressions 三个 keyless 场景已在 verifier/smoke 路径全绿；
- B1 可修复任务集：任务清单待选（TB easy + 自建），**对照协议** = 同任务集 × 同模型/预算 × {插件开 vs 关}，指标 Δsuccess、收敛 epoch、成本；基线锚点已备（TB 切片 1/2、自建冒烟 5/5，run-log）；
- 说明：B1 实跑需要"真实可修复失败场景 + 自动应用闭环"同时就绪，随 M3 集成验证一起做（下一条）。

### B1 首轮实测（2026-08-16）

- B1a 真实事件观测：fs 权限拒绝 ×3 → observer 经 `tools/result` emit 捕获 3 条 tool-error（映射已验证），硬触发命中；
- B1b 真实数据回环：真实 27b 出候选（tool-fs sandbox → sandbox_permissions）→ verifier 用真实帧对齐 → rejected（first_divergence@0）→ 回炉；完整闭环可运行；
- 下一步：对齐预期轨迹格式（turn/start 等）后跑多轮回炉至 approved，再做插件开/关 Δsuccess 对照（off 基线：自建冒烟 5/5、TB 切片 1/2）。

## 遗留

- host 硬触发接入回合边界回调（`meta.iterate` 已可手动触发；自动挂到 dsh turn 边界需确认事件接线）；
- B1 真实对照实验（选 1 个可修复失败任务，跑插件开/关）；
- 工具/技能层（tool/skill patch）的隔离加载即校验（M4）。
