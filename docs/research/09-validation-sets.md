# 验证集与指标（测试先行落地）

更新：2026-08-16。回答"插件做好了怎么验证效果"。配套：`01-eval-and-acceptance.md`（指标/阈值）、`run-log.md`（每次运行留档）、`/chenzute/dsh-src/eval/`（基准资产）。

## 0. 结论

- **现在就能验证的**：评测管线（Harbor + 本地 27b + keyless replay）、基线锚点（TB 2.1 切片 1/2）、指标草案（01 §3/§6）、合成验证集设计（本文档）；
- **要等实现才能验证的**：插件本体功能（M1/M2 合成集）、插件效果对照（M3 任务集）；
- **当前缺口**：自建冒烟集基线未跑；合成验证集用例未固化成测试文件（本文档先固化成清单，M1 编码时转成测试）。

## A. 合成验证集（功能验收，M1/M2，离线确定性）

| 集 | 用例 | 预期 | 指标 | 阈值 |
|---|---|---|---|---|
| A1 observer 信号 | ≥10 条合成事件流：重复失败×3、用户纠正、回归失败、正常事件、阈值边界 | 归类正确、阈值边界不误触发 | precision/recall/阈值触发正确率 | M1：1.0/1.0/100% |
| A2 proposer 补丁 | 5-10 组（信号 + 配置快照 + 用户需求），mock LLM 确定性输出 | schema 合法、单变量、targetKind 白名单、带预期轨迹、含 selfConfidence/completeness | 合法性/单变量率 | M1：100% |
| A3 verifier 对齐 | 已知正确 patch ×3（全指标应过）；已知错误 patch ×3（应拒且 first_divergence 定位正确）；边界：coverage 不足、no-op 假变化 | approved/rejected 与定位均正确 | 对齐判定准确率、first_divergence 定位准确率 | M2：100% |
| A4 gate 回滚 | 故障注入：冒烟失败、apply 后断言失败、plan→apply 期间目标被改（baseline 冲突） | 回滚后 before 哈希一致；冲突拒绝且不覆盖 | 回滚成功率、冲突拒单率 | M2：100% |

工具：A1-A4 全部可写成 vitest 单测 + 固定 fixture；A3 用 `dsh-llm-replay`/keyless snapshot 跑，**0 token**。

## B. 任务对照集（效果验收，M3 后，需真实模型/容器）

| 集 | 内容 | 对比 | 指标 | 阈值草案 |
|---|---|---|---|---|
| B1 可修复任务集 | 5-10 个"持续失败但通过 config/tool/skill 调整可修复"的任务（TB easy + 自建） | 插件开 vs 关（同模型同预算同 seed） | Δsuccess、收敛 epoch 数、成本 | M3：Δsuccess>0，连续 2 epoch 收敛 |
| B2 回归保护集 | acp-snapshot text-turn + headless JSONL + 自建冒烟（keyless） | 插件应用前后 | 通过率、配置不变性 | 始终 100% |
| B3 效率集 | 同任务 token/动作对比 | 插件开 vs 关 | 效率比（参考 RHAE 形状） | 记录，不作硬门槛 |
| B4 进阶真实基准 | Terminal-Bench 2.1 / DeepSWE 小切片（本地已就绪） | 插件开 vs 关 + 官方参考分 | 完成率/RHAE 口径 | M4 评估 |

## C. 基线（对照锚点）

| 基线 | 状态 |
|---|---|
| 原生 dsh + 27b × TB 2.1 切片（fix-git/overfull） | **已跑**：1/2（run-log 2026-08-16） |
| 原生 dsh + 27b × 自建冒烟集（5-10 任务） | **待跑**（L5 前后补，作为插件效果的最直接对照） |
| 原生 dsh + 27b × B1 可修复任务集 | 待 M1 后定义并跑 |

## D. 指标 → 验证集 → 归属（汇总）

| 指标 | 验证集 | 归属 | 阈值 |
|---|---|---|---|
| 信号准确率/召回率 | A1 | observer | 1.0/1.0（M1） |
| 补丁合法/单变量 | A2 | proposer | 100%（M1） |
| 对齐/分歧定位 | A3 | verifier | 100%（M2） |
| 回滚/冲突 | A4 | gate | 100%（M2） |
| 回归通过率/配置不变性 | B2 | validator/gate | 100% |
| 改进率/回归率/收敛 | B1 | 系统级 | Δsuccess>0、无回归、2 epoch（M3） |
| 效率/成本 | B3 + token-meter | 系统级 | 记录 |
| 完成率/效率 | B4 | 系统级 | M4 评估 |

### D2. 评审门指标（08 §15，M3.5 起）

| 指标 | 定义 | 用途 |
|---|---|---|
| gate 精度 | gate=yes 且最终 approved / 应用后无回归 的比例 | 评审门是否值得信任 |
| gate 召回 | builder 最终成功案例中 gate=yes 的占比 | 有没有误杀该迭代的时机 |
| 成本节省 | gate=no 省掉的 builder+verifier 轮次 | 频率控制收益 |
| 触发频率 | 每 epoch 迭代次数、触发间隔分布 | 调确定性阈值/冷却参数 |

## E. 执行规则

- 每次验证集运行必须走 `run-log.md`（含配置、结果、tokens、补丁/偏差）；
- A 集合集离线确定性，B 集真实模型/容器时标注成本与本地补丁偏差（当前 TB 切片含 pip 替代 uv 偏差，非官方口径）；
- 合成集在 M1 编码时固化为 `tests/` 下的 vitest 用例与 fixture，验收脚本随代码入库。
