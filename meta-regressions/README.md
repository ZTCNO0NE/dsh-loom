# meta-regressions（回归集种子，M1.7）

验证器固定式回归集的第一版种子。M2 起由 verifier 全量执行；M1 只建骨架与首批场景清单。

## 场景格式（草案）

每个场景一个目录：

```text
<scenario>/
├── task.md         # 任务描述（agent 可见）
├── assert.*        # 外部断言（重跑命令/重读文件，byte-identical 精神）
└── expected.json   # 期望的帧/产物哈希（keyless 对比基准）
```

## 首批场景（M2 目标）

- `acp-text-turn`：dsh acp-snapshot 的 text-turn 场景（keyless replay）；
- `headless-jsonl`：headless-agent JSONL 快照（事件流面）；
- `smoke-bash-timeout`：自建冒烟——bash 工具在配置超时变化后行为不变/按预期变化（覆盖 I6/I9 对齐语义）。
