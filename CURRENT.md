# CURRENT.md — 当前状态与交接

更新：2026-08-17 22:17（Asia/Shanghai）

## 一句话状态

**`v1.1.0` 已完成双重正式发布**：GitHub source release 为 <https://github.com/ZTCNO0NE/dsh-loom/releases/tag/v1.1.0>，npm registry 已核验 `dsh-loom@1.1.0` 且 `latest=1.1.0`。控制候选已完成 **Builder Kernel → commit-pinned Git acquisition → 无网络 build → C0/C1–C8/C6 → gate cold install → actor 重跑 → rollback/restore**；生产与用户 profile 均未触及。builder-generated 通道已提交到 GitHub `main`（远端 `ef4b7ef`），但真实 acquisition 首次尝试被 GitHub codeload HTTP 429 阻断，尚未进入 verifier/gate。当前 `npm run check`、`npm test`（122/122）、`npm run build`、`git diff --check` 全部通过。

## 当前进行中（loop 层放开，按序）

### Builder 基础重定（2026-08-18，优先于继续扩展候选网关）

用户确认：Builder 应是一个具有自身持久化极简 loop 的独立 agent，而非受限 JSON candidate generator；`loop-evolution` 应降为第一个 Builder capability skill/tool。Builder 对部署范围内状态具备全局读取、可在自身 workspace 自由探索/写入/构建/测试，并以真实工具反馈驱动多步修正；actor、builder 或 loop 的 live 变更一律以 proposal 交给独立 verifier/gate。JSON 保留为工具协议、journal 与交付格式，不作为认知或单文件写入边界。规格：`docs/builder-foundation-spec.md`。

`loopBaseline`、固定 fallback 文案与扩大的 acquisition attempts 临时修补已从当前工作树撤出。基础 Kernel 已补齐：全局文件/目录读取、持久 workspace 多文件读写、命令 stdout/stderr/exit-code 反馈及通用 proposal freeze；`npm run check`、`npm test`（124/124）、`npm run build` 全绿。下一实现步骤：建立 Builder 基础 profile 与 capability 注册协议，再把现有 Git/generated gateway 收编为 `loop-evolution` capability。

插件拼装基线（2026-08-18）：Capability 可自由新增并声明它要求的 verifier set；Verifier 以可插拔、固定版本/hash 的治理插件形式存在；Gate 对 immutable proposal + 完整同 hash 的 required reports 执行 fail-closed 授权，缺报告、超时、错误、not_run、stale evidence 或 before-snapshot 冲突一律不放行。`loop-evolution` 的首个 verifier set 及实现顺序见 `docs/plugin-composition-spec.md`。

1. **A 收编（已完成）**：可运行构建产物已进入 `vendored/serial-tool-calls/`；`loop-candidates/serial-tool-calls.manifest.json` 固定上游 commit、候选 delta（并行 10→1）、目录 SHA-256 与入口。
2. **候选状态/边界（已完成代码，122/122）**：`src/candidates/` 实现 `staging → pending → verified → approved → installed`（及 rejected）、契约证据要求、before/after 安装记录、失败 rollback；builder Git acquisition 只能写 staging，需 HTTPS allowlist、固定 ref/commit/hash，不能直接写正式 vendored。builder-generated 另受固定 baseline、精确 hash 替换、路径/大小/无 symlink 限制。
3. **完整报告（已完成）**：正式 profile 下 C0/C1-C4/C7/C8 与 C6(L1-L5) 都通过，报告见 `eval/meta-workspace-loop-adapter-20260817/reports/profile-candidate-full-contract.json`。
4. **真实替换/gate（已完成，隔离 runtime）**：`src/candidates/profile.ts` + `profile-gate.ts` 在组合前替换 entry，严格校验 artifact hash，记录 before/after；`meta-workspace-loop-gate-final-20260817` 中 installed candidate 的 actor 重跑全绿，fault-injected C0 mismatch 自动 rollback。
5. **候选网关/自主获取/E2E（Git 通道完成；generated 通道待补真实链路）**：`allowLoopCandidates` 默认关闭；开启后仅 `meta_auto(discoverLoopCandidate=true)` 可调用独立 BuilderKernel。loop draft/工具反馈/journal 与 config/tool/skill builder 复用同一 bounded driver；提交后 core importer 才能 HTTPS 拉取。source 缺 entry 时，只允许固定的 `sandboxed-dsh-workspace` 无网络 build，build recipe/hash 写 manifest。builder-generated 只接受固定 DSH baseline commit、`agent-loop/src/**/*.ts`、exact beforeHash/after 替换、文件数/字节数/无 symlink 限制，并仍只进入 staging。控制候选完整证据见 `eval/run-records/2026-08-17-loop-autonomous-final-lifecycle-proof.json`；generated 首次真实拉取因 codeload 429 清理 staging，registry 无残留，未获验收。
6. **BuilderKernel（完成）**：`docs/builder-kernel-spec.md` 将 Tycho 的 bounded tool loop、workspace、verify feedback 与 Loom 权限/状态一一映射。`BuilderDriver` 以严格 JSON `tool | continue | submit | abort` 运行有上限的真实 LLM 微循环；Kernel 自动写 decision/tool/error journal 与 snapshots，allowlist 为 `read_input/read_journal/write_world_model/write_plan/write_candidate_draft/inspect_staging/preflight_staging_entry`，无 shell/任意文件/裁决能力。`submit` 无 payload，只冻结已预检 draft；verifier、probe 失败、gate/install rollback 全会 `reopenFromFeedback()` 建立新的 immutable run 并在 `previous-attempt.json` 回注。官方 V4 Flash 成功实证见 `eval/run-records/2026-08-17-builder-kernel-real-feedback-proof.json`：项目真实 `Validator` 产生 rejection，第三个官方 builder run 读取该 report 后以 4-turn/3-tool 提交（无 install）。
7. **并行归因与真实对照（完成，低成本）**：直接 27b（thinking disabled）真实生成两个 native tool calls；DSH 也在同一 turn/step 保留两调用。随后用两个 1000ms、显式 `isConcurrencySafe` 的隔离工具验证 cap：原版 loop overlap、tool span **1017ms**；已安装 serial candidate 串行、**2024ms**（**1.99×**），两侧 C0/C1-C4/C7/C8 全绿、0 error frame。因此该候选是安全/顺序策略，**不构成吞吐提升**；完整 record 为 `eval/run-records/2026-08-17-loop-parallel-safe-real-behavior-comparison.json`。官方/候选 scheduler 的 parallel-safe 与 cap=1 语义另有零模型 42/42 测试复核。

## 环境（2026-08-17 05:40 实测）

- Node v22.20.0 / npm 10.9.3 / pnpm 11.21.0（`/chenzute/dsh-src/tools/bin/pnpm`）；`dsh` 不在 PATH。
- dsh checkout `/chenzute/dsh-src/deepseek-harness` 存在；插件类型链 devDependencies `file:` 正常。
- `dist/index.js` 已构建；`npm run check` ✓；`npm test` 122/122 ✓；`npm run build` ✓；`git diff --check` ✓。
- 候选 fork 已构建 `lib/index.js`，`DEFAULT_MAX_PARALLEL_TOOL_CALLS = 1` ✓。
- env 文件在位（600）：`.env-27b`（本地 actor）、`.env-deepseek`（官方 V4 Flash builder/评审门）；禁止打印/提交。
- 契约跑法模板：

```bash
set -a; . /chenzute/dsh-src/eval/.env-27b; set +a
export DSH_CMD='/chenzute/dsh-src/tools/bin/pnpm dsh' DSH_CWD=/chenzute/dsh-src/deepseek-harness
export DSH_META_VALIDATE_ROOT=/chenzute/dsh-src/eval/meta-workspace-<name>
node scripts/contract-runner.mjs check /chenzute/dsh-src/eval/overlay-contract-candidate-fork.yml '<task>' loop-contract/golden-current.json
```

- golden 快照：`loop-contract/golden-current.json`（71 事件）；候选 overlays 在 `/chenzute/dsh-src/eval/overlay-contract-*.yml`。**任何候选运行必须带** `--expected-entry <candidate entry>`，C0 不通过即不允许花模型费用。
- run 快照：`/chenzute/dsh-src/eval/run-records/`（含 2026-08-17-loop-contract-bh3-*.json）。

## 已完成的里程碑（v1 实证；详见 docs/project-status.md + run-log）

- 发布：dsh-loom@1.0.4（npm latest），tags v1.0.2/v1.0.3/v1.0.4；便携 CLI `dsh-loom try` 已发布（真机留档待做）。
- 从零成长：off 0/3 → L1-L5 全过；严格同任务集 off 0/3 → on 3/3。
- 宿主闭环：host-demo pass=true；meta_auto/meta_iterate 真实链路（评审门 → builder → 隔离探测 → verifier → gate）。
- 演示留档：model-swap、supervisor-swap、scheduled-notify、preferences、refine-skill、actor-progress-qa。
- loop 契约 runner：record/check/rollback/--regression/--report/--profile + C0 entry-resolution 已实现；正式 profile adapter、完整三件套、cold gate 安装与回滚均已有隔离实证。旧单纯 overlay 差分证据仍仅是“官方 loop 上的环境/runner 验证”。

## 决策记录（保持简短；细节见 docs/research/08 等）

- 角色：builder（迭代者）+ verifier（固定式核验）完全分离；verifier 不通过强制回炉，无 force-apply。
- 文件优先：上下文不可信，状态落盘 `$DSH_HOME/meta-validate/`。
- 模型分工：actor = 本地 27b；builder/评审门 = 官方 V4 Flash。
- loop 放开门槛：完整契约报告三件套（C1-C8 + C6 回归 + 实装 before/after）；builder 必须自主选候选。
- dsh 约束（2026-08-17 新发现）：`PatchOptions.name` 不是更新字段；`--patch` 无法把 `agent-loop` 从官方包换成候选路径。gate 必须在完整 entry tree/宿主 Loader 级别做替换，并以 C0 验证实际解析入口。
- v1 锁定：`agent`/`agent-loop`/`meta-validate` 行禁止修改。

## 待用户决策/待办

- 下一步顺序：先在 codeload 限流解除后重跑 generated baseline→edit→sandbox build；成功后用独立 verifier 跑 C0/C1–C8/C6，再做 gate before/after、actor 重跑和 rollback；全部通过后，才跑 12 个 parallel-safe 延迟工具的 cap=10 对 cap=20 性能对照。任一供应链/契约/回滚失败都只记 rejected，不宣称性能提升。
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
| loop 契约 runner + golden + C0 entry-resolution | 完成（正式 Loader adapter + 自主候选实装均有 C0） |
| 完整契约报告三件套 + 候选 loop 网关 | 完成（正式 profile、C0–C8/C6、冷 gate、staging 网关均有隔离实证） |
| builder 自主选择候选 loop + 端到端案例 | 完成（受限 Git acquisition → staging；外部 candidate 未获验收） |
| Tycho 型 BuilderKernel 微循环 + 拒绝回注 | 完成（官方 V4 Flash patch/loop-candidate run + verifier feedback 证据） |
| 自主 loop 最后一公里 | 完成（staging → C0–C8/C6 → installed → actor 重跑 → rollback/restore） |
| loom-bench / Web 成长面板 / `dsh-loom try` 真机留档 | 后续 |
