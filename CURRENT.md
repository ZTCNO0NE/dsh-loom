# CURRENT.md — 当前状态与交接

更新：2026-08-17 05:45（Asia/Shanghai）

## 一句话状态

**dsh-loom v1.0.4 已发布**（npm latest + GitHub `ZTCNO0NE/dsh-loom`，tag v1.0.4，HEAD `c9504be`）；`npm test` **101/101**、`npm run check` 全绿（2026-08-17 实测）。v1 自进化闭环（从零成长 L1-L5、config/tool/skill、自主换模型、监督员、预约后台、偏好沉淀）全部实证。**当前主线：loop 层契约与放开**——行为差异实证已完成，正在向「builder 自主选候选 loop + 完整契约报告 + 真实安装」推进。

## 当前进行中（loop 层放开，按序）

1. **行为差异实证（已完成，bh3）**：候选 fork `@deepseek-ai/dsh-agent-loop-candidate`（并行 10→1）与原版 C1-C4/C7/C8 全绿；27b 不并发发工具 → 模型层差异不可观测；证据 = 代码 diff + 契约全绿（run-log「loop-contract-bh3」）。
2. **候选源码收编（待用户定）**：fork 在 `/chenzute/dsh-src/deepseek-harness/packages/core/dsh-agent-loop-candidate`，未进本项目 git；选项 A vendored 进本项目（推荐）/ B 独立包 / C 留 checkout 只记录路径。
3. **完整契约报告三件套（设计已定，未实现）**：`contract-runner --report <path>` 落盘 + C6 回归 + 真实安装 before/after 快照；verifier 只认三件套，不做 LLM 主观判断（定义见 `docs/loop-layer-contracts.md`）。
4. **builder 自主选择（设计缺口，用户已确认是问题）**：候选目录/注册表 + builder 依据需求/遥测选候选 + 产出 loop patch + gate 真实安装；否则"开发者手工造候选"只是验证闸门，不算自进化证据。
5. **实现顺序**：① contract-runner `--report` → ② meta.auto 候选 loop 网关 + `allowLoopCandidates` 开关 → ③ 真跑完整三件套（用户已允许烧钱）→ ④ 候选目录 + builder 选择 → ⑤ 端到端案例（用户需求 → builder 选 loop → 真实安装 → actor 重跑观测差异）。

## 环境（2026-08-17 05:40 实测）

- Node v22.20.0 / npm 10.9.3 / pnpm 11.21.0（`/chenzute/dsh-src/tools/bin/pnpm`）；`dsh` 不在 PATH。
- dsh checkout `/chenzute/dsh-src/deepseek-harness` 存在；插件类型链 devDependencies `file:` 正常。
- `dist/index.js` 已构建（无 src 未编译改动）；`npm run check` ✓；`npm test` 101/101 ✓。
- 候选 fork 已构建 `lib/index.js`，`DEFAULT_MAX_PARALLEL_TOOL_CALLS = 1` ✓。
- env 文件在位（600）：`.env-27b`（本地 actor）、`.env-deepseek`（官方 V4 Flash builder/评审门）；禁止打印/提交。
- 契约跑法模板：

```bash
set -a; . /chenzute/dsh-src/eval/.env-27b; set +a
export DSH_CMD='/chenzute/dsh-src/tools/bin/pnpm dsh' DSH_CWD=/chenzute/dsh-src/deepseek-harness
export DSH_META_VALIDATE_ROOT=/chenzute/dsh-src/eval/meta-workspace-<name>
node scripts/contract-runner.mjs check /chenzute/dsh-src/eval/overlay-contract-candidate-fork.yml '<task>' loop-contract/golden-current.json
```

- golden 快照：`loop-contract/golden-current.json`（71 事件）；候选 overlays 在 `/chenzute/dsh-src/eval/overlay-contract-*.yml`。
- run 快照：`/chenzute/dsh-src/eval/run-records/`（含 2026-08-17-loop-contract-bh3-*.json）。

## 已完成的里程碑（v1 实证；详见 docs/project-status.md + run-log）

- 发布：dsh-loom@1.0.4（npm latest），tags v1.0.2/v1.0.3/v1.0.4；便携 CLI `dsh-loom try` 已发布（真机留档待做）。
- 从零成长：off 0/3 → L1-L5 全过；严格同任务集 off 0/3 → on 3/3。
- 宿主闭环：host-demo pass=true；meta_auto/meta_iterate 真实链路（评审门 → builder → 隔离探测 → verifier → gate）。
- 演示留档：model-swap、supervisor-swap、scheduled-notify、preferences、refine-skill、actor-progress-qa。
- loop 契约 v0：contract-runner（record/check/rollback/--regression）+ golden + C1-C8；良改/坏改/整包替换差分已验。

## 决策记录（保持简短；细节见 docs/research/08 等）

- 角色：builder（迭代者）+ verifier（固定式核验）完全分离；verifier 不通过强制回炉，无 force-apply。
- 文件优先：上下文不可信，状态落盘 `$DSH_HOME/meta-validate/`。
- 模型分工：actor = 本地 27b；builder/评审门 = 官方 V4 Flash。
- loop 放开门槛：完整契约报告三件套（C1-C8 + C6 回归 + 实装 before/after）；builder 必须自主选候选。
- v1 锁定：`agent`/`agent-loop`/`meta-validate` 行禁止修改。

## 待用户决策/待办

- 候选 loop 收编方式（A/B/C，推荐 A）。
- 是否开工实现「完整契约报告 + 候选 loop 网关」：用户已口头同意烧钱真跑，说"做"即开工。
- awesome-dsh-plugin PR：fork 分支 `ZTCNO0NE:add-dsh-loom` 已推；仓库满 1 天后（北京时间 08-17 20:35 后）`gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --base main --head ZTCNO0NE:add-dsh-loom --title "Add ZTCNO0NE/dsh-loom to the plugin list"`。
- README 竞品定位段（prime-agent 合并 + 偏好沉淀证据）已入库（commit `386269a`），如需调整再改。
- 曝光待办：GitHub Discussions 自荐 → 其他 awesome 列表 PR → Discord/公众号/掘金/知乎。
- 官方 DeepSeek key 曾短暂泄漏进 git 历史（已 force push），建议用户撤销换新（未确认）。

## 风险与注意

- 烧钱敏感：优先本地 27b / 零成本验证；官方调用（builder/评审门/基准）跑前确认。
- dsh v0.1 developer preview，接口会变；注入点收敛 `src/index.ts`。
- 候选 fork 在 dsh checkout 内，上游更新会冲突 → 尽快定收编。
- 每次运行必须留档（run-log + run-records）；未留档不算完成。

## 里程碑

| 里程碑 | 状态 |
| --- | --- |
| M0-M4（config/tool/skill 进化 + gate + 回滚） | 完成 |
| v1.0.0-v1.0.4（监督员/后台/通知/偏好/便携 CLI） | 完成 |
| loop 契约 runner + golden + C1-C8 差分 | 完成 |
| 完整契约报告三件套 + 候选 loop 网关 | 未开始 |
| builder 自主选择候选 loop + 端到端案例 | 未开始 |
| loom-bench / Web 成长面板 / `dsh-loom try` 真机留档 | 后续 |
