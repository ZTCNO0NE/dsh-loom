# Builder 通用溯因导航底座

更新：2026-08-19。状态：最小实现已接入 `BuilderKernel`；它只提供事实导航，不决定 Builder 的认知路线或修复方案。

## 为什么需要它

拒绝报告里的 `TypeError: run is not a function` 是一个**现象**，不是修复方案。若只把这段文本重新塞回 prompt，Builder 仍需要自己猜：哪个 oracle 消费了哪个 candidate、candidate 由哪个 prior run 产生、接口的实际 export 在哪里定义。猜错时就会回到 broad read 循环。

本底座把这些关系落为小型、可审计的 artifact graph，使 Builder 可自行选择：追踪、检查接口、全局检索、编辑、仿真、提问、提交或放弃。它不把其中任一动作设为必经节点。

## 上游参考与采用边界

- Prime Agent，commit `97b994c3d7c45ca1ae635190e91e9e58ddf2577c`，MIT：成品 coding agent 的持久 kernel、host-owned state 与 programmatic tools。Loom 不把它的完整 CLI/30+ 运行时依赖嵌进 plugin process；后续以可选 `BuilderRuntime` adapter 接入，保持 verifier/gate 在外部。
- Tycho，commit `f68912a`，Apache-2.0：采用它的 schema-first tool surface、pass 起点 verifier state、编辑后返回验证事实的原则；不复制 ARC/Python world-model runtime。

这不是“复制一大段 prompt”，也不是对上游成品 agent 的 fork。Loom 负责自身不可替代的 immutable evidence、proposal freeze、独立 verifier/gate/cold install；外部 runtime 只可以成为 Builder 的认知/工具执行器。

## 持久数据合同

每个 run 有 `state/provenance.json`：

```json
{
  "schemaVersion": 1,
  "runId": "builder-...",
  "artifacts": [
    {"id": "artifact-...", "role": "failure_report", "path": ".../previous-attempt.json", "hash": "..."},
    {"id": "artifact-...", "role": "candidate", "path": "/workspace/candidate.mjs", "hash": "..."}
  ],
  "edges": [
    {"from": "failure-report-id", "relation": "consumes", "to": "candidate-id", "evidence": ".../previous-attempt.json"}
  ]
}
```

artifact 的 ID 由 role/path/hash 确定，因而可在之后的 turn 或 immutable child run 中引用。当前事实角色包括 actor handoff、target-before、failure report、prior run/assets、workspace、source、candidate、submission、verification report 和 tool result。关系只描述 `consumes | produces | tests | reports_on | derived_from`。

Kernel 在 run 创建时确定性写入 actor/target/previous-attempt/previous-run/submission 关系；读取或检查源码时再追加 source artifact。它不从错误文本推断“应该导出什么函数”。

## 开放只读导航工具

| 工具 | 输入 | 返回 | 权限 |
| --- | --- | --- | --- |
| `trace_artifact` | `{artifact: id \| absolutePath}` | 节点、相邻 producer/consumer/test/report 边与关联 artifact | 只读 |
| `inspect_file` | `{path}` | hash、语言、imports、exports、functions、16KB preview | 只读 |
| `search_text` | `{query, roots?, maxResults?}` | 显式 roots 内的 `rg` 匹配；argv 调用，不解释 shell | 只读 |
| `read_input(provenance)` | 无额外字段 | 完整图 | 只读 |

它们不取代已有的 `read_file`/`list_directory`/workspace/command 工具。Builder 保持全局读取和 workspace 写入自由；live change 仍只能经过 proposal → independent verifier → gate。

## Prompt 与上下文

compact prompt 只放 graph 入口、artifact 数量与当前 failure/candidate ID；完整图按需通过 `read_input(provenance)` 读取。这避免把全量路径/日志再次稀释进每一轮上下文。

系统纪律是：出现 error/rejection 时，将其当作 artifact 指针，按需追 `report → consumer input → producer/prior run → interface/implementation`，每个因果主张必须引用文件或工具反馈。它是探索建议，不是一个 phase 白名单，Builder 可基于证据选择任何其他开放动作。

## 验收边界

确定性测试覆盖：拒绝报告能定位 candidate、candidate 的 exports 可检查、全局文本检索可定位源码、完整 provenance 可恢复。它只证明导航底座正确；尚未证明 V4 Flash 在 oracle-repair 案例上必然收敛。下一次官方对照必须只给 rejection + graph，不提供 `export run` 结论，并统计 `trace → inspect → edit → oracle → submit` 是否真实发生。
