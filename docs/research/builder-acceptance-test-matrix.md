# Builder 演进验收测试矩阵

本矩阵把“Builder 修出了候选”“候选被独立裁决”“真实安装后 Actor 获益”分开计分。任何一层失败都不能向上冒充成功。

## 组 A：确定性修复与交付

| 用例 | 故障 | Builder 必须完成 | 通过条件 |
| --- | --- | --- | --- |
| A1 导出接口 | `candidate.run is not a function` | 定位入口、修复 `run(tools)`、运行 oracle、提交 | 5 个 fresh run 全部 `oracle pass + proposal + submit` |
| A2 路径迁移 | prior-run 绝对路径不可写 | 将旧路径映射到当前 workspace | 无 path-escape；候选 hash 新且 oracle 通过 |
| A3 回执修复 | submit 缺 draft | 根据 Kernel feedback 写 proposal 再提交 | 不重复 submit；proposal manifest 完整 |

## 组 B：独立 Verifier / Gate

| 用例 | 故障/目标 | 必须观察 |
| --- | --- | --- |
| B1 契约全量 | C0–C8、C6 回归 | verifier 独立读取 immutable candidate；全部报告绑定同一 hash |
| B2 冷安装 | approved candidate → profile loader | before/after snapshot、实际入口 hash、Actor replay |
| B3 恶意/越界候选 | 改 verifier/gate 或错误 entry | fail-closed，不能安装；拒绝报告回注 Builder |
| B4 回滚 | 安装后注入 C0 mismatch | 原子回滚，旧 hash 恢复，rollback evidence 完整 |

## 组 C：性能提升（只针对可归因变量）

性能候选入口契约必须先作为 oracle 事实固定：模块导出 `run(tools)`；`tools[i]` 是可直接调用的 async 函数（不是 `{run()}` 对象），其函数属性 `isConcurrencySafe === true` 才可并发；返回值保持输入顺序；异常必须原样可观察。任何 `runActorLoop` 等别名都视为接口不匹配并先拒绝。

| 用例 | 基线/候选 | 指标 | 宣称门槛 |
| --- | --- | --- | --- |
| C1 并发安全工具 | serial vs candidate，两个 `isConcurrencySafe` 延迟工具 | overlap、总时延、错误率 | 候选总时延下降 ≥20%，错误率不升，C0–C8/C6 全绿 |
| C2 负载扩展 | 2/4/8/16 个独立延迟工具 | 吞吐曲线、p50/p95 | 至少 3 个负载点保持优势；无串行语义回归 |
| C3 真实任务 | 同一 Actor workload before/after | admissible、claimLevel、任务结果 | installed 版本真实 workload 改善，不能只凭 synthetic oracle |

## 证据包

每个用例必须保存：Builder journal、prompt-visible、proposal、manifest、candidate hash、verifier reports、gate before/after、rollback（若要求）、Actor replay、comparison.json。性能报告同时保存原始时长和错误帧，禁止只保存单一分数。

## 最终判定

只有 A、B 全部通过且 C1–C3 满足门槛，才能称为“Builder 自主完成并带来真实性能提升”。A 通过只能称为“自主修复交付稳定”；B 通过只能称为“可安全安装”；C 未通过时必须如实记录为无性能提升。
