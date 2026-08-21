# Loom Benchmark 本地化与模型筛选计划

更新时间：2026-08-21。

## 目标

先建立轻量、本地可复现的 Benchmark 基座，再对候选模型执行相同预算的
Baseline bake-off。模型冻结后，才运行
`Baseline → Loom → Loom + verifier → Loom + evolution → optimized inference`
五级系统实验。

首轮主表固定为：

- Terminal-Bench 2.1；
- SWE-bench Verified；
- SkillsBench v1.1。

ARC-AGI-3 只作为 `0 → non-zero` 高难探针。AHE 仅作为 harness evolution
竞品与实验协议参考。τ³-bench 首轮不下载、不运行。

## 本地来源与锁定

所有 benchmark 统一落到 `/chenzute/dsh-src/eval/`。每个来源必须在
`bench-source-lock.json` 中记录 URL、commit/tag、许可证、任务数、磁盘大小、
本地路径及任务 manifest 的 SHA-256。

- 保留现有 `terminal-bench-2-1@7131e4375048a0e408a8fb404b5f499d726b695b`；
- 拉取 `benchflow-ai/skillsbench@v1.1`，只使用默认、无外部凭据、支持 Docker 的任务；
- 拉取 `SWE-bench/SWE-bench` 固定 commit 与 Hugging Face
  `SWE-bench_Verified` metadata，首轮不批量拉镜像；
- 拉取 `china-qijizhifeng/agentic-harness-engineering` 固定 commit，仅用于协议对照；
- 不重复拉取已有 ARC-AGI-3、DeepSWE、CyberGym 与 verifiers。

## Pilot manifests

### Terminal-Bench 12 题

`fix-git`、`cancel-async-tasks`、`filter-js-from-html`、
`log-summary-date-ranges`、`regex-log`、`sanitize-git-repo`、
`sqlite-db-truncate`、`polyglot-rust-c`、`build-cython-ext`、
`query-optimize`、`headless-terminal`、`llm-inference-batching-scheduler`。

先做 oracle/image preflight。不可复现的任务保留失败记录，不静默替换；替换必须
更新 manifest 版本。

### SkillsBench 6 组迁移对

每组前者为 adaptation，后者为 held-out：

- PDDL：`pddl-airport-planning → pddl-tpp-planning`；
- Three.js：`threejs-structure-parser → threejs-to-obj`；
- React：`fix-visual-stability → react-performance-debugging`；
- Power flow：`energy-market-pricing → grid-dispatch-operator`；
- Seismic：`earthquake-phase-association → seismic-phase-picking`；
- Spreadsheet：`shock-analysis-demand → shock-analysis-supply`。

每题运行 `without-skill`、`official-skill` 和
`Loom-generated/evolved skill`。Loom 生成条件不得读取 official skill 正文。

### SWE-bench Verified 12 题

下载 metadata 后，以 seed `loom-v1` 对 instance ID 做稳定 hash 排序；每个 repo
最多一题，并覆盖测试修复、接口行为、数据处理和跨文件修改。Pilot 因镜像尺寸排除
实例时必须公开 excluded 清单；正式 50 题不得根据模型结果事后替换。

## 模型 bake-off

候选为 Qwen3.6-27B、Qwen3-Coder-Next、GLM-4.7-Flash、
Qwen3.6-35B-A3B。固定量化等级、上下文、采样、工具 schema 与总预算，只运行
Baseline Agent。

选择优先级：任务成功率 → completed trajectory / submit 收敛率 → 工具调用格式
错误率 → tokens/LLM calls → wall time → GPU energy/success。只有成功率区间相近时，
才以速度或能耗选择模型；厂商模型卡分数不作为本地结论。

## 存储与证据边界

- 先下载 Git、metadata 和轻量依赖；镜像必须先生成预计空间报告；
- 不自动执行 Docker prune；回收前解析精确目标并单独确认；
- Pilot 只按需拉取任务镜像；当前空间不足以保存完整 SWE-bench 镜像集；
- 所有失败、镜像缺失、本地补丁和 verifier 偏离均进入 immutable raw record；
- 模型选定后冻结模型文件 hash、量化、推理参数，再进入五级实验。

## 当前优先模型资产

优先下载 `unsloth/Qwen3.6-35B-A3B-GGUF` 的
`Qwen3.6-35B-A3B-UD-Q6_K.gguf`。纯文本 Coding/Agent 实验不下载视觉
projector。目标目录为 `/data2/chenzute/models/Qwen3.6-35B-A3B-GGUF/`，下载后
保存 SHA-256、字节数与 Hugging Face source URL。
