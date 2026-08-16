# 参考资料索引

## DeepSeek Harness 官方

- 仓库：https://github.com/deepseek-ai/deepseek-harness
- 插件入门：`docs/user/develop/basic/index.md`（插件本质、三种形态、依赖注入）
- 插件配置：`docs/user/develop/basic/config.md`（Config + Schemastery schema、HMR）
- 工具开发：`docs/user/develop/basic/tool.md`（defineTool DSL）
- 打包安装：`docs/user/develop/basic/publish.md`（bundle/profile/层顺序/分发）
- 工具权威示例：`docs/cookbook/adding-a-tool.md`
- 扩展手册：`docs/cookbook/extension-cookbook.md`
- 工具子系统：`docs/subsystems/tools.md`（ctx.tools API）

## 社区参考

- 最小插件模板：https://github.com/kun2-5code/dsh-plugin-onebot
- 插件注册表/开发引导：https://github.com/vlln/plugin-registry（含 make-dsh-plugin skill）

## 背景与研究

- prime-agent（冷替换/回滚机制的参照实现）：本工作区 `E:\prime-agent-main`；学习笔记副本见 `references/background-prime-agent-learn.py`（validate 部分不参考它）
- Tycho（validator 的主参考）：ARC-AGI-3 求解 agent，actor/validate 分离，verifier 把世界模型仿真预测与真实帧逐格/哈希完全对齐。仓库 https://github.com/NIMI-research/Tycho；论文 https://arxiv.org/abs/2607.28287
- DeepSeek Harness 设计背景（Cordis，时空可组合性论文）：仓库 README 引用
- 相关论文/基准（背景，暂不必须）：Continual Harness（arXiv 2605.09998）、Self-Harness（arXiv 2606.09498）、DarwinX（arXiv 2608.07545）、SIA（arXiv 2605.27276）

## 本项目文档

- `docs/architecture.md`：设计原理
- `docs/plugin-development.md`：开发流程手册
- `README.md`：项目总览与快速开始
