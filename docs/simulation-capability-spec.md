# Workspace Simulation Capability

更新：2026-08-18。状态：第一版 runtime 已落地；真实 DSH profile 高保真仍需单独验收。

## 边界

`BuilderKernel` 只持有生命周期、持久状态、journal、workspace、消息和提交冻结。仿真是 capability，不是 Builder 核心状态机。共享 `SimulationRunner` 负责在 Builder-owned workspace 中执行实验；它永远不能修改 live actor、verifier 或 gate。

```text
BuilderKernel
  └─ workspace-simulation capability
       └─ SimulationRunner
            ├─ fixture / synthetic actor
            ├─ command or script execution
            ├─ output + artifact hashes
            └─ simulation report
```

## 证据等级

- `L0 model`: 从已知事实推导，不执行实验；
- `L1 simulation`: 固定 workspace、fixture、依赖和可重放命令；
- `L2 isolated-replay`: 真实 profile/runtime，但不写 live target；
- `L3 cold-install`: verifier → gate → 安装 → actor 重跑 → rollback。

`SimulationRunner` 只能输出 `passed`、`failed` 或 `inconclusive`。`passed` 代表当前 fixture 下命令满足预期，不代表 verifier `approved`，更不代表性能提升。仿真与真实对照必须记录 input、fixture、output、report hash，并明确 claim level。

## Builder 使用原则

Builder 应先使用 L0/L1 区分假设；当仿真无法判断真实 Loader、模型、资源、时序或部署行为时，才发出 `request_input(kind=verification)`。请求必须包含 claim、已尝试的仿真证据和 `whyNow`，由 Actor/用户协调，verifier/gate 最终裁决。

第一版执行器允许 workspace-local command/script；后续可增加持久 IPython backend，但仍复用同一 SimulationRunner 的快照、报告和权限边界，不能让 backend 自己形成第二套治理链路。
