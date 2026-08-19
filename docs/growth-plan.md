# dsh-loom 增长与内容运营计划

更新时间：2026-08-19

## 目标与分工

本文件负责 dsh-loom 的公开叙事、内容资产和转化节奏；代码、发布版本、评测与产品事实仍以 `CURRENT.md`、release 和可复现实验记录为准。

- 研发 agent：实现、测试、版本和证据。
- 宣传维护：把已验证的证据转为 README、Release、知乎文章、短视频和案例；不替研发作未经证实的产品承诺。

北极星指标不是单纯浏览量，而是“读者能在十分钟内理解风险边界，并成功运行一个演示”。建议每周记录：README 访问与克隆、GitHub 星标/Watch、npm 下载、安装问题数、知乎收藏/有效评论、Demo 成功率。

## 对外定位

一句话：**dsh-loom 给运行中的 Agent 加上独立的验证与冷替换机制，让它可以在 `config | tool | skill` 范围内安全地改进，而不是自己给自己当裁判。**

主叙事始终围绕一个问题：Agent 能提出修改，但谁来验证、谁来安装、改错后如何回滚？

不要把项目泛化表述为“通用 AGI 自我进化”或“Agent 自动写好任何代码”。这会弱化 Loom 的实际差异化：外部验证器、可信执行边界、不可变证据和可验证回滚。

## 公开声明分级

### 可以直接公开

- `v1.1.0` 已通过 GitHub release 和 npm `latest` 发布。
- 已有 capability runtime registry、workspace simulation、结构化 clarification/choice/verification 请求。
- 当前工作树已有 `npm run check`、`npm test`（213/213）、`npm run build`、`git diff --check` 的通过记录；发布前需由研发重新确认。
- 受控的 prepare-overlap scheduler workload 中，Builder candidate 有明确的因果改进记录；所有任务均完整、零 error。
- 在真实 cold DSH CLI Loader 下，候选 profile 的 16 个并发调用完成且未越过 mixed-exclusive、abort-draining、failure-draining 等安全边界；安装与独立回滚都有 receipt。

### 必须带限定语

- 性能只能称为“在修改的 prepare-overlap workload 中观测到/验证到的改进”，不得称“Agent 整体提速”。
- cold Loader 结果只能称为“完成性与非回归”；不要把单次 wall-time 差异写成性能提升。
- config/tool/skill ingress 的闭环状态、真实 profile cold smoke 和 rollback 必须依照当次 release 的证据逐项确认。
- builder 的修复收敛并未普遍解决。曾有 rejection-repair 1/3 完整闭环，也有多组 0/3 观察；不能宣传为“Builder 已经自主稳定修好真实代码”。

### 不再复用的旧表述

- 旧知乎稿中的 `99/99`、`dsh-loom@1.0.2`、历史 from-zero 数字，以及第三方项目 star 数都不能原样发布。
- 不使用“自动进化”“完全不需要人”“真实性能提升”“生产级自我改写”等无边界承诺。

## 内容漏斗

| 层级 | 读者问题 | 内容形式 | 唯一行动 |
| --- | --- | --- | --- |
| 发现 | 为什么 Agent 不能审自己？ | 30–60 秒短视频、知乎想法、架构图 | 打开 README |
| 理解 | Loom 和普通 agent loop 有何不同？ | 知乎深度文、README 的 1 分钟概览 | 看一条完整证据链 |
| 信任 | 它真能拦错、回滚吗？ | 可复现 Demo、Release evidence、失败案例 | 本地运行验收命令 |
| 使用 | 我怎样在自己的 DSH profile 上试？ | Quick Start、FAQ、Issue 模板 | 安装并反馈 |
| 传播 | 我如何分享一个有效案例？ | Showcase 模板、用户案例征集 | 提交 Discussion / Issue |

## 四条固定内容支柱

1. **安全架构**：为什么修改者、验证者和安装者必须分离；冷替换与回滚解决什么。
2. **证据而非口号**：一次 candidate 从 proposal 到 verifier、cold smoke、receipt、rollback 的完整轨迹；同时展示被拒绝案例。
3. **真实工程边界**：讲清已验证 workload、未验证范围和下一步门槛。这是面对技术受众的长期信任资产。
4. **开发者上手**：用配置、工具或技能的一个小案例，给出最短可复制路径和验收命令。

## 利用图像与视频资产

- **Qwen Image**：生成每篇文章统一视觉语言的封面和章节图；配图是解释架构，不承担性能或功能事实。封面只表达“外部教练 / 验证门 / 冷替换”，避免伪造产品界面。
- **Wan T2V**：制作 15–30 秒概念短片：一个 Agent 提出改动，外部验证门放行或拒绝，失败时回滚。视频末帧放项目名、问题和 README URL。
- **Wan I2V**：把静态架构图或真实、已脱敏的 receipt/evidence 截图做轻量动效；任何概念动画要标注“概念演示”，真实运行录屏另行标注“真实记录”。
- 每一套图/视频都要回链到同一篇文章或 README 的具体 section，避免“漂亮但无转化”的孤岛内容。

## 30 天运行节奏

| 周期 | 产出 | 主题 |
| --- | --- | --- |
| 第 1 周 | README 首屏与 Quick Start 改版；知乎旧稿事实更新为草稿 | 什么是独立验证与冷替换 |
| 第 2 周 | 一篇证据链文章 + 一支 30 秒概念视频 | 候选为什么能被拒绝和回滚 |
| 第 3 周 | 一篇工程边界文章 + Release/Changelog 模板 | 什么被验证，什么尚未验证 |
| 第 4 周 | 一个可复制的 config/tool/skill 演示 + Showcase 征集 | 如何在自己的 profile 里安全试用 |

每次研发发布时，宣传维护按固定顺序产出：Release note → README 变更 → 一条知乎短内容 → 是否值得扩展为长文的判断。没有新证据时，不硬凑“版本新闻”，改写失败案例、边界、设计决策或用户问题。

## 当前内容队列

1. **README 首屏重构**：一句话定位、真实边界、15 分钟验证路径、证据链接、明确的“尚不支持”区块。
2. **知乎更新稿**：将 2026-08-16 旧稿改为当前版本的“外部验证器”文章。先建草稿，人工复核后才允许发布。
3. **证据链案例**：`cold-loader-prepare-20260819` 的 proposal → verifier → install → rollback，只写完成性与非回归，不写整体性能结论。
4. **短视频脚本**：`Agent 提议 → 验证器拒绝/放行 → 冷替换 → 回滚`；素材产生后再审查字幕是否与公开声明分级一致。
5. **Showcase 模板**：收集“任务、改动范围、验证命令、before/after、回滚证明、局限”的用户案例，而不是只收集漂亮截图。

## 发布前门禁

1. 在 `CURRENT.md`、release 和原始 evidence 中复核全部版本号、测试数、性能数字与功能状态。
2. 对每一个数字或“已完成”结论附内部证据路径；没有路径就删掉或改为问题/假设。
3. 先用 `create_zhihu_draft.py` 生成草稿，不带 `--publish`；发布必须由用户明确授权。
4. 检查链接、图片替代文本、Quick Start 命令和适用 DSH 版本。
5. 将已发布链接、发布时间、主要指标与后续修订原因记录在单独的运营日志中。

## 本轮下一步

先完成 README 信息架构审阅和知乎更新稿的选题/事实清单；没有研发确认的新 release 证据时，不修改外部公开页面。
