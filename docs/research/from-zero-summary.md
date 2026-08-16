# 从零成长实验总结（B1 开/关对照）

更新：2026-08-16。证据：run-log（from-zero-off / L1-L5）、`eval/run-records/from-zero-verify.json`、`baseline/results-bare-off/summary.json`。

## 对照

| | off（bare actor 单独） | on（builder 全程迭代后） |
|---|---|---|
| 起点 | bare loop（无工具无技能） | 同起点 |
| 任务阶梯 | 0/3（L1 写文件/L2 列目录/L3 编辑验证全失败） | **L1-L5 全过**（verify 2026-08-16，L4 第 2 次尝试通过） |
| 能力获得 | 无（永远停在原地） | 4 个工具 + 2 个技能（全部 builder 生成、verifier 验收、gate 安装） |
| 回归 | — | L1/L2/L3 在 L4/L5 后仍绿 |
| builder 迭代数 | 0 | 6（L1×1、L2×1、L3×2、L4×1、L5×1） |

## 关键证据

- off：`baseline/results-bare-off/summary.json`（3 项全 false）
- on：`eval/run-records/from-zero-verify.json`（artifactsMissing=[]，allPass=true，含每级输出尾）
- 产物：`eval/fromzero-l1/l2/l3a/l3b-tool.yml` + `deepseek-harness/.dsh/skills/{edit-verify,json-verify}/SKILL.md`

## 严格同任务集 Δsuccess（2026-08-16）

- `npm run fromzero:compare`（`eval/run-records/fromzero-strict-comparison.json`）：
  - 任务集 = off 基线的 L1/L2/L3（与 on 完全相同的 prompt）；
  - **off 0/3 → on 3/3，Δsuccess = +3**（L1/L2/L3 均一次通过）；
  - 消除任务集口径差异，与从零 L4/L5（行为级/泛化）分开计量。

## 一键验收链（2026-08-16）

- `npm run fromzero:all`：默认快速模式 = `fromzero:verify`（L1-L5 全任务，含 2 次尝试兜底）+ `fromzero:compare`（严格 Δsuccess）；
- `npm run fromzero:all -- --fresh`：先全量重跑 builder 各层（L1-L5），再 verify+compare（长，真实模型）；
- 2026-08-16 默认模式实跑：**verify allPass=true（L1-L5 全部第 1 次尝试通过）+ compare off 0/3 → on 3/3（Δsuccess +3）**，记录 `eval/run-records/fromzero-all.json`。

## 结论与诚实声明

1. **机制成立**：bare actor 在 builder（V4 Flash）+ 固定 verifier + gate 的迭代下，从 0 能力长到能完成"写文件/列目录/编辑验证/行为级技能/新领域泛化"五级任务；
2. **模型随机性真实存在**：行为级 L4 在验收复跑中第 2 次才通过——技能能显著提高行为概率，但不是确定性保证；正式验收建议"每级允许 2 次尝试 + 记录 attempt"（本 verify 已实现）；
3. **口径差异**：off 是 3 级阶梯，on 验收是 5 级（含新增 L4/L5），两者任务集不完全相同；严格 Δsuccess 用同任务集复跑（off 3 级 vs on 同 3 级均过）更严谨，可作为后续补充；
4. **成本**：builder 共 6 轮（含 gate/review），token 精确统计未接入，后续用 token-meter 补。

## 成本记账（2026-08-16 接入）

- 官方适配器捕获 `stream_options.include_usage` 的 usage（每次流只记一次，去重）；
- `Proposer` / `ReviewGate` 增加 `onUsage` 回调，写入 `workspace/<session>/cost-log.jsonl`（role/model/prompt/completion）；
- L1 实测样例：gate 约 182 in / 101-118 out tokens；builder 约 974 in / 2644-4681 out tokens（builder 产出模块代码，输出明显更大）；
- 说明：cost-log 按 session 追加式留档，多次运行会累积；`runId` 已加入 fromzero-l1 的每条记录，可按 runId 过滤单次实验成本（其余 level 沿用同一模式）。
