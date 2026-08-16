# AGENTS.md — dsh-loom（Loom · 织机）项目恢复入口

> 本文件是 `/chenzute/dsh-meta-validate-handoff` 的恢复与交付入口。
> 易变状态一律在 `CURRENT.md`；本文件只放稳定路由、环境事实与不可推翻的架构约束。

## Compact 恢复协议（最高优先级）

每次会话开始、出现压缩摘要或上下文恢复提示时，按顺序执行：

1. 重读本文件；
2. 读 `CURRENT.md`（当前状态/下一步）；若缺失或明显过期，先向用户指出，并基于只读核查（git log、docs、run-log）补全，不凭记忆；
3. 按任务读相关文档（见「文档地图」）；
4. 需要运行结论时读 `docs/research/run-log.md` 尾部与 `/chenzute/dsh-src/eval/run-records/`；
5. 禁止整卷复读历史会话 JSONL（`~/.codex/sessions/**`）。

## 项目定位

DeepSeek Harness 的 bundle 插件 **dsh-loom（Loom · 织机）**：为 actor 提供"第二个验证器/外部教练"，把判断权放到被修改者之上，完成安全自进化：

observe（观察/监督员）→ judge（评审门）→ design（builder 改进模型）→ verify（verifier 确定性核验）→ install（gate 冷替换）→ rollback（失败回滚）。

- actor：只干活、只产出真实帧，不自己迭代、不改自己；
- supervisor/评审门：监视触发与频率控制；
- builder：看用户需求 + 帧 + 遥测，迭代产出候选 patch（`config | tool | skill`；loop 待放开）；
- verifier：固定式、确定性核验（预期 vs 真实帧 + 回归 + 契约报告），唯一验收者，无 force-apply；
- gate：snapshot → 冲突检查 → 原子写 → 冒烟 → 回滚；`agent-loop` 行 v1 锁定。

## 环境事实（稳定路径；变动项见 CURRENT.md）

- 工作区：`/chenzute/dsh-meta-validate-handoff`（git remote: `github.com/ZTCNO0NE/dsh-loom`）。
- Node v22.20.0 / npm 10.9.3；pnpm 11.21.0 在 `/chenzute/dsh-src/tools/bin/pnpm`；`dsh` 不在 PATH。
- dsh 源码 checkout：`/chenzute/dsh-src/deepseek-harness`；类型链接走 devDependencies `file:` 指向其构建产物。
- 本插件构建产物：`dist/index.js`（改代码后 `npm run build`）；overlay 引用其绝对路径。
- 模型/env 文件（禁止打印、禁止提交）：
  - `/chenzute/dsh-src/eval/.env-27b` — 本地 27b（actor），`http://124.221.77.140:4000/v1`；
  - `/chenzute/dsh-src/eval/.env-deepseek` — 官方 V4 Flash（builder/评审门），`https://api.deepseek.com`。
- 契约验证环境：`DSH_CMD='/chenzute/dsh-src/tools/bin/pnpm dsh'`、`DSH_CWD=/chenzute/dsh-src/deepseek-harness`、`DSH_META_VALIDATE_ROOT=<eval/meta-workspace-*>`。
- loop 契约：`loop-contract/golden-current.json`（71 事件）；runner `scripts/contract-runner.mjs record|check|rollback <overlay> <task> <golden.json> [--regression]`。
- 候选 loop fork：`/chenzute/dsh-src/deepseek-harness/packages/core/dsh-agent-loop-candidate`（并行 10→1；**未收编**，见 CURRENT.md）。
- 基准/评测：`/chenzute/dsh-src/eval/`（Terminal-Bench 2.1、DeepSWE、verifiers、baseline、overlays、run-records）。
- 验收命令：`npm run check`、`npm test`（101/101）、`npm run fromzero:verify`、`npm run fromzero:all`、`npm run host-demo`。

## 工作流

- 开发/验证循环：headless profile + overlay；改代码 `npm run build` 后重跑；本地 demo 用 `scripts/*.mjs`。
- 契约/loop 工作：contract-runner 先 record golden，再 check 候选，坏改必须能拦截，最后 `--regression`。
- 运行留档纪律：每次基准/评测/契约运行必须追加 `docs/research/run-log.md` + 存 `/chenzute/dsh-src/eval/run-records/` 快照；未留档不算完成。
- 实质性会话结束：更新 `CURRENT.md`（最近改动/下一步/待用户决策）。
- 发布：`npm run check` → `npm test` → `npm run build` → `npm publish` → git tag vX.Y.Z；README/文章同步。

## 架构约束（已定，不要推翻）

- 冷替换：agent 不能在自己运行的 loop 里替换自己；预约 → 回合边界停机 → 原子切换 → 冒烟 → 失败回滚。
- 第二验证器独立：builder/verifier 与 actor 不共享模型实例、会话状态、提示词历史，防自我确认偏误。
- TCB：verifier/回归集/签名路径对被修改的 actor 只读；被修改者永远够不到验证链路。
- 分层放开：v1 只允许 `config | tool | skill`；`loop` 必须满足「完整契约报告三件套」+ 实验开关才放开；`verifier/gate/meta-validate` 行永远锁定。
- 收敛纪律：一次只改一个变量；改完锁定观察一个 epoch；只在证据充分时出手（连续失败/用户纠正/回归失败）。
- 状态兼容：任何应用前记录 before/after 快照，保证可回滚；换 loop 不等于换壳丢记忆。
- 文件优先：上下文不可完全信任；关键状态落盘 `$DSH_HOME/meta-validate/`，恢复只读文件不依赖 LLM 摘要。
- 防泄露：loop 自进化必须由 builder 自主选候选 + 提交 + 真实安装；开发者手工造候选只算验证闸门，不算自进化证据。

## 代码纪律

- TypeScript strict，不用 `any`；`npm run check` 全绿。
- 可调参数进 Config + Schemastery schema，禁止硬编码。
- dsh 接口注入点收敛 `src/index.ts`；内部服务不直接依赖 dsh 私有 API。
- 不提交：`.env-*`、`dist/`、`eval/`、`lint/`、`scripts/`（除 `contract-runner.mjs` 等明确放行项）；不改 dsh checkout（本地候选 fork 除外）。
- 提交只提交本项目文件；不动 prime-agent 仓库内容。

## 文档地图

- `CURRENT.md` — 当前状态/下一步（恢复必读）
- `docs/architecture.md` — 设计原理与风险
- `docs/loop-layer-contracts.md` — C1-C8 + 完整契约报告定义 + 放开条件
- `docs/research/08-actor-validator-protocol.md` — 角色/协议/信息目录
- `docs/research/10-builder-capability-experiment.md` — 从零成长实验设计
- `docs/research/run-log.md` — 全部运行记录（按时间追加）
- `docs/project-status.md` — v1 验收证据与命令
- `docs/plugin-development.md` — dsh 插件开发/打包/安装手册
- `REFERENCES.md` — 外部参考索引

## 完成定义

- v1（已完成）：config/tool/skill 进化闭环 + 监督员 + 预约后台 + 通知/台账 + 偏好沉淀；101/101；npm `dsh-loom@1.0.4`。
- loop 层放开（进行中）：contract-runner 报告持久化 → meta.auto 候选 loop 网关 + `allowLoopCandidates` 开关 → 真实完整三件套跑通 → 候选目录 + builder 自主选择 → 端到端案例。
