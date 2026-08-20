# 使用指南：v1.2 用户主动演进

> 旧版“装上后什么都不用做，系统会自己变强”的说明已不适用。v1.2 首发是用户主动委托：Actor 提出候选，用户确认后才进入隔离实现与独立裁决。

完整的从 DSH 启动、安装 Loom、加载 profile 到第一次任务卡对话的步骤在 [README 快速开始](../README.md#快速开始从零启动-dsh到第一次任务卡)。本文补充边界和排错原则。

## 两个可用阶段

### Builder 凭据（复用 DSH，角色仍独立）

Actor 的 provider 配置不等于 Builder 角色，但默认不需要再配置第二份 key：Loom 默认把 DeepSeek V4 Flash 的 Builder/Review Gate 凭据解析为 DSH 用户凭据 `DEEPSEEK_API_KEY`。请在 DSH Settings/Models 或 `$DSH_HOME/.credentials.yaml` 配置它。DSH credentials service 每次调用动态解析，外部更新文件后的下一次 Builder 调用自动使用新值。缺失时，状态和历史查询仍可用，但 `meta_auto` 不会进入真实 Builder proposal；`meta_status` 只显示 ref、configured 与来源（file/env），从不显示值。

凭据由已选的 `llm.provider` 决定：`deepseek-official` 只解析 `DEEPSEEK_API_KEY`；显式 `gpt-5.6-terra` 才解析 `OPENAI_API_KEY`（兼容旧的 `LOOM_TERRA_API_KEY`、`DSH_TERRA_API_KEY`）。不会因为某个 key 恰好存在就跨 provider 使用它。需要不同 key 的高级用户可将 Loom `llm.credentialRef` 设为任一个 DSH credential ref；不要把 key 放进 Loom config。

| 阶段 | 你能做什么 | 不会发生什么 |
| --- | --- | --- |
| DSH + Loom 已安装 | 启动 DSH，检查 `meta-validate` bundle 是否在 `--dump-config` 中 | 不会自动修改配置、技能或模型 |
| 宿主启用 `activeEvolution` | 对话中委托明确的 Config / Skill 演进 | 用户不接触内部 ID、路径、before snapshot；运行中的 pass 不强杀 |

`activeEvolution` 默认关闭。`dsh-loom setup` 会在用户自己的 Loom 状态目录安装固定版本 mini-SWE；mini-SWE 的 MIT 源码包已随 npm 包 vendored，不依赖你的 PyPI 镜像提供该项目本体。setup 同时创建 Gate-owned Skill root，并注册独立的 deployment-level Loom Skill provider，使通过 Gate 的 Skill 能沿 DSH 的 global→preset scope chain 被 Web Actor 发现。普通用户不需要填写 executable/config path。首次安装仍需要 **Python >= 3.10**、可访问的依赖包源和已配置的 DSH 模型 provider；CLI 会在创建 venv 前验证 Python 版本。高级部署仍可显式覆盖路径或使用 `--source`。

bootstrap 会自动适配平台：Linux/macOS 使用 `python3` 与 `bin/mini`，Windows 使用 `python` 与 `Scripts\mini.exe`。包内提供 `bin/setup-windows.ps1` 和 `bin/setup-unix.sh`；快速开始已按 Windows、macOS、Linux 分块，避免要求用户猜测 PATH、shell 或 venv 布局。失败时 CLI 会打印具体的 Python/venv/pip 错误。

从 DSH 源码 checkout 使用 `pnpm dsh` 的用户，应先单独确认 DSH 自身可以启动，再执行 README 对应平台的 profile wrapper。请显式传入 `--runtime-root` 并把 setup 输出的绝对 patch 路径原样传给 `pnpm dsh web --patch ...`。不要写成 `pnpm dsh web --profile loom ...`：`web` 是固定的 `--profile web` 别名，不能与另一个 profile 叠加；也不要把 `%USERPROFILE%\\.dsh\\meta-validate` 误写成当前工作目录的相对 `.meta-validate`，更不要把 Loom 安装问题与 DSH 的 `tsx/esm` 或构建产物问题混为一谈。

源码 checkout 还有一个宿主依赖差异：部分 DSH 运行时包位于 CLI 的开发依赖，旧版 profile fallback 不会自动链接它们。Loom setup 会在当前目录（或 `DSH_ROOT`）识别 DSH 源码，扫描完整依赖闭包并一次性建立安全的 host fallback；缺少 `lib` 时自动执行 DSH 根目录 `pnpm run build:lib:host` 与 `pnpm run build:lib:client`。已发布的 DSH CLI 不需要这一步。

## 一次对话的正确预期

1. 用户提出明确需求，例如“给我加一个复盘失败的技能”。
2. Actor 返回候选、风险、验收方式与确认问题；此时没有改动。
3. 用户确认后，mini-SWE 在隔离 workspace 实现候选。
4. Verifier/Gate 独立决定已生效、未生效或未完成；Actor 只解释真实状态。
5. queued 阶段可取消；running/verifying 不强杀；终态重做永远是新的 immutable plan。

## 常见问题

- **为什么安装后没有自动进化？** 这是 v1.2 的安全边界。默认关闭、用户确认、独立验证，避免旧版“自动自治”叙事掩盖未完成的产品验证。
- **为什么没有 `planId`？** 它是内部不可变记录；用户只通过任务卡确认、查看状态、取消或重做。
- **为什么需要 mini-SWE runtime？** Loom 负责证据、会话与裁决编排；明确实现 pass 交给成熟 coding runtime。运行一次 `dsh-loom setup` 即可安装；没有 runtime 不会回退为直接修改宿主。
- **成功是否表示 Agent 整体变强？** 不表示。已安装只表示该候选通过了本次独立验证。性能主张仅限已测 scheduler prepare-overlap workload。
- **如何关闭？** 不启用 `activeEvolution`，或从 profile 移除 Loom bundle。不要删除已产生的审计记录来伪造不存在过的任务。

## 截图发布清单

发布真实 CLI / Web 对话截图时，只保留用户原话、任务卡、确认、关键阶段和最终 verdict。遮掉 API key、绝对路径、workspace 内容、before snapshot、内部 ID、模型隐藏推理和完整工具日志。
