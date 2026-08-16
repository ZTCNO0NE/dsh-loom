# 参考源地图（Source Map）

更新：2026-08-16

全部从公开源重新拉取（浅克隆，`--depth 1`）。阅读状态以 L2 结束时的进度为准。

| 源 | 本地路径 | commit | 关键文件 | 状态 |
|---|---|---|---|---|
| deepseek-harness | `/chenzute/dsh-src/deepseek-harness` | `47f9438` | `BENCHMARK.md`、`docs/testing.md`、`docs/user/develop/basic/*`、`docs/subsystems/{tools,events,session,goal,token-meter}.md`、`vendor/cordis`、`packages/core/tools`（dsh-tools）、`packages/test-support/{acp-snapshot,llm-replay}`、`examples/{acp-agent,headless-agent,jsonrpc-agent}`、`apps/cli/config/agent-presets/` | L0 安装构建完成；L1 评测面已读；插件开发面待 L3 |
| Tycho | `/chenzute/dsh-src/tycho` | `f68912a` | `docs/ARCHITECTURE.md`、`docs/PAPER_RESULTS.md`、`tycho/workspace/wmlib_template.py`（verify 行 567 / verify_outcome 行 1071）、`tycho/workspace/workspace.py`（validated_plan_hint）、`tycho/agent/{modes,dispatcher}.py`、`tycho/prompts/`、`artifacts/scorecards/` | 首轮浅读完成；论文细节待补 |
| prime-agent | `/chenzute/dsh-src/prime-agent` | `97b994c` | `README.md`（行 12/34/40/83）、`packages/coding-agent/src/core/refinement/{index,refinement}.ts`、`packages/coding-agent/test/refinement.test.ts` | README 已核对；refinement 源码待 L3 |
| ARC-AGI-3 官方 | `/chenzute/dsh-src/arc-agi3` | `4743e7d` | `README.md`、`agents/{agent,recorder,swarm}.py`、`main.py`、`llms.txt`；配套 docs.arcprize.org（methodology） | 结构已列；内容待 L3 |
| 社区插件 onebot | `/chenzute/dsh-src/community/dsh-plugin-onebot` | `ef160ed` | 插件结构/package.json/README | 待读 |
| 插件注册表 | `/chenzute/dsh-src/community/plugin-registry` | `6dab4de` | 注册表结构、make-dsh-plugin | 待读 |
| 评测素材（dsh 基准） | `/chenzute/dsh-src/eval/terminal-bench-2-1` | `7131e43` | 91 个 Harbor 任务 + leaderboard 配置 | 已拉取，运行需 Harbor+沙箱 |
| 评测素材（dsh 基准） | `/chenzute/dsh-src/eval/deep-swe` | `435ee89` | ~116 个任务（task.toml/instruction/tests/solution），程序化 verifier | 已拉取，运行需 datacurve-pier |
| 评测素材（dsh 基准） | `/chenzute/dsh-src/eval/cybergym` | `7656b71` | 评测框架代码；数据 ~240GB 独立 HF 数据集未拉取 | 框架已拉取，数据按需 |
| 评测素材（自迭代参考） | `/chenzute/dsh-src/eval/verifiers` | `be6faf6` | prime-agent 生态 envs+evals 库（数据集+rollout+reward rubric） | 已拉取 |

## 论文与网页

| 资料 | 标识 | 状态 |
|---|---|---|
| Tycho 论文 | arXiv:2607.28287 | 摘要已读，细节待补 |
| Continual Harness（prime-agent 引用） | arXiv:2605.09998 | 暂不必须 |
| Self-Harness | arXiv:2606.09498 | 暂不必须 |
| DarwinX | arXiv:2608.07545 | 暂不必须 |
| SIA | arXiv:2605.27276 | 暂不必须 |
| ARC-AGI-3 评分方法 | docs.arcprize.org/methodology | 已读（RHAE 公式） |

## 环境与工具（L0 产出）

- pnpm 11.21.0：`/chenzute/dsh-src/tools/bin/pnpm`（npm 全局前缀不可写，装到用户前缀）
- dsh 源码依赖已 `pnpm install`；`build:lib` 与 `build:web` 已完成
- 本项目类型链到源码构建产物：`vendor/cordis/lib/types`、`packages/core/tools/lib/types`；`npm run check` 通过
- dsh web 验证：`DEEPSEEK_BASE_URL=http://127.0.0.1:8001/v1 DEEPSEEK_API_KEY=mock-key pnpm dsh web --port 3081` 启动，HTTP 200
