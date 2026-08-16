# M1 实施计划（L5 产出，待用户确认默认值）

更新：2026-08-16。前置：L0-L4 完成，设计定稿见 `docs/architecture.md` 与 `docs/research/08`；验证集见 `docs/research/09`。

## 1. 三个待确认默认值

### I6：世界模型 v1 最小 schema（`builder/world-model.json`）

```json
{
  "schemaVersion": 1,
  "target": { "id": "<plugin row id>", "kind": "config", "targetId": "<目标行>" },
  "behavior": {
    "invariants": ["未涉及配置行逐字节不变", "<目标行相关不变量>"],
    "expectedEventPatterns": [
      { "event": "tool/result", "name": "<tool>", "ok": true, "note": "……" }
    ],
    "configDependencies": ["<目标行依赖的其他配置键>"]
  },
  "version": 1,
  "updatedAt": "ISO8601",
  "hash": "sha256:……"
}
```

### I9：预期轨迹 v1 格式（`patches/<id>/expected-trajectory.json`）

```json
{
  "schemaVersion": 1,
  "patchId": "<id>",
  "events": [
    { "type": "turn/start", "turn": 1 },
    { "type": "tool/call", "turn": 1, "step": 1, "name": "bash", "argsHash": "sha256:……" },
    { "type": "tool/result", "turn": 1, "step": 1, "name": "bash", "error": null, "resultHash": "sha256:……" },
    { "type": "turn/end", "turn": 1, "reason": "success" }
  ],
  "configBeforeHash": "sha256:……",
  "configAfterHash": "sha256:……",
  "coverage": { "claimedBehaviors": ["bash", "fs-write"], "note": "builder 自评覆盖的行为面" }
}
```

### I15：应用后冒烟范围（`patches/<id>/smoke.json`）

- keyless 回归子集：B2 中 1-2 个场景（acp-snapshot text-turn 或 headless JSONL）；
- 配置不变性：未涉及行 dump-config 哈希一致；
- expectedOutcome 外部断言：目标行行为按 MetaPatch.expectedOutcome 检查；
- 任一失败 → gate 回滚到 before 快照；冒烟全程走 run-log。

## 2. M1 任务拆分

| 任务 | 内容 | 验收 |
|---|---|---|
| M1.1 配置与类型 | `MetaValidateConfig` 写 Schemastery schema（mode/thresholds/regressionDir/maxPendingPatches/maxSignalsPerCycle/maxIterations）；`MetaPatch` 增 `selfConfidence/completeness`；新增文件协议类型（requirements/triggers/trajectory/report 的 TS 类型） | `npm run check` 全绿 |
| M1.2 文件协议骨架 | `meta-validate/` 目录创建、`protocol.json`、原子写工具（tmp+rename）、schemaVersion 校验、只读/只写权限边界 | 单测覆盖原子写与损坏文件容错 |
| M1.3 observer | 订阅 `agent/error`、`tool/result`、`user/message`、`turn/end`；归类 repeated_failure / user_correction(启发式) / regression_failure；阈值过滤；写 signals.jsonl/requirements.json/triggers.jsonl/trajectory 投影 | 合成验证集 A1：precision/recall 1.0、阈值边界正确 |
| M1.4 builder | `ctx.llm` 独立调用（独立 sessionId/purpose，不注入 actor 历史）；读 requirements/signals/trajectory/config-tree；维护 world-model.json；self-check（自评字段 + 确定性自检副本）；输出 candidate.json + expected-trajectory.json | 合成验证集 A2：schema 合法、单变量、targetKind 白名单、带预期轨迹与自评字段 |
| M1.5 工具注册 | `meta.request-validate`（actor 主动 L1）、`meta.status`（只读查询，不暴露验证器内部）；注册表 schema 化 | `--dump-config` 组合树含本插件行；工具 schema 校验 |
| M1.6 验收演示 | 假信号 → observer 采集 → builder（mock LLM）→ 候选 patch + 预期轨迹落盘 → status 流转到 submitted | 端到端 trace 留档（run-log） |
| M1.7 回归集种子 | regressionDir 下首批 keyless 场景（acp-snapshot text-turn + headless JSONL + 1 自建冒烟） | B2 场景可运行 |

## 4. M1 完成记录（2026-08-16）

- M1.1-M1.6 已完成：Config Schemastery schema、协议类型、文件协议骨架（原子写/schemaVersion）、observer（事件归类/阈值/持久化）、builder（独立 LLM 调用/世界模型/self-check/候选+预期轨迹）、工具注册（meta.request-validate / meta.status）。
- 验收：`npm run check` 全绿；`npm test` 11/11（A1/A2 + 协议）；集成 boot 验证——dsh headless + overlay 加载插件成功、回答正常、`$DSH_META_VALIDATE_ROOT/workspace/<session>/protocol.json` 落盘。
- 真实模型端到端 trace（`npm run demo`，2026-08-16）：3 条 bash 超时信号 + 用户需求 → 真实 27b 产出单变量 patch（timeoutMs 5000→30000）、selfCheck 0.95/0.9、4 帧预期轨迹 → candidate/expected-trajectory/status 全部落盘。**说明：这是功能验证，不是效果基准。**
- M1.7 为骨架：`meta-regressions/` 已建场景格式与首批清单，场景实体在 M2 随 verifier 落地。
- 遗留说明：dsh 原生事件到 observer 的接线是 best-effort（agent/error 已接，tools/post-execute payload 待 M2 确认）；A1/A2 以 ingest 注入为准。

## 3. 依赖与工具

- mock LLM（`packages/test-support/llm-mock-server`）保证 A1/A2 确定性；真实 27b 端点用于演示 trace；
- dsh 源码 checkout `/chenzute/dsh-src/deepseek-harness`（`47f9438`）+ 本项目类型链接；
- 基线（原生 dsh + 27b 自建冒烟集）后台运行中，结果记 run-log，作为 M3 效果对照锚点。
