# AGENTS.md — dsh-meta-validate 交付说明

## 项目定位

为 DeepSeek Harness（`deepseek-ai/deepseek-harness`，v0.1，Cordis 插件化架构）开发一个 bundle 插件 `dsh-meta-validate`：用**第二个独立验证器**帮助 agent 完成真正的运行时自进化。核心回路：observe -> propose -> validate -> cold-apply -> rollback。

## 立即要做的事（按序）

1. 环境：Node >=22.19、pnpm；`git clone https://github.com/deepseek-ai/deepseek-harness.git`，`pnpm install`，配 `DEEPSEEK_API_KEY`，`pnpm dsh web` 验证 Web UI 可启动。
2. 类型链接：本项目的 `@deepseek-ai/cordis` 类型要链接到 dsh 源码 checkout 的构建产物（`packages/<pkg>/lib/types`），不要链运行实例的 staging 目录。
3. 让本项目通过 `npm install` + `npm run check`（tsc strict，无报错）。
4. 实现 M1（当前里程碑）：observer 事件采集 + proposer 独立模型调用，见 `CURRENT.md` 与 `src/` 内 TODO。
5. 用 scratch-plugin overlay + HMR 开发循环验证；里程碑完成后打包 bundle 并 `dsh plugin --profile demo add` 安装验证。

## 工作流

- 开发循环：dsh 源码 checkout 内建 `scratch-plugin/`，`cordis.yml` 写 `- insert`（本地插件行 name 用绝对文件路径），`pnpm dsh web --patch ./scratch-plugin/cordis.yml` 启动，改代码/配置靠 HMR 热替换。
- 打包：`package.json` 声明 `dsh.bundle.patch`；bundle 的 `cordis.patch.yml` 里 name 用**包名**；`files` 包含产物与 patch。
- 安装：`dsh plugin --profile demo add ./dsh-meta-validate`；`dsh --profile demo --dump-config` 确认组合树；`dsh --profile demo` 实测。
- 交付前：`npm run check` 全绿；`docs/plugin-development.md` 有完整命令参考。

## 架构约束（已定，不要推翻）

- **冷替换**：agent 不能在自己运行的 loop 里替换自己。所有修改走预约 -> 回合边界停机 -> 原子切换 -> 冒烟 -> 失败回滚。
- **第二个验证器必须独立**：不与 actor 共享模型实例、会话状态、提示词历史，防自我确认偏误。
- **信任根基（TCB）**：验证器、回归集、签名校验所在路径对被修改的 actor 只读；被修改的 actor 永远够不到验证链路。如果修改者能改验证者，自进化就退化成自我欺骗。
- **分层放开**：第一版只允许 `targetKind: config | tool | skill`；`loop` 留到验证链路成熟后。
- **收敛纪律**：一次只改一个变量；改完锁定观察一个 epoch；只在证据充分时出手（连续失败/用户纠正/回归失败）。
- **状态兼容**：任何应用前记录 before/after 快照，保证可回滚；换 loop 不等于换壳丢记忆。

## 代码纪律

- TypeScript strict；不用 `any`（AGENTS 原仓库规则，本项目沿用）。
- 可调参数一律进 Config + Schemastery schema，禁止硬编码；检验标准：`cordis.yml` 能改值而不改代码。
- dsh 接口变动风险：所有注入点收敛在 `src/index.ts`，内部服务不直接依赖 dsh 私有 API。
- 注释只在有歧义处写；不写废话。
- 提交只提交本项目文件；不要动任何 prime-agent 仓库内容。

## 参考文档（项目内）

- `docs/architecture.md`：设计原理（为什么这么设计）。
- `docs/plugin-development.md`：dsh 插件开发流程手册（环境/循环/打包/安装/分发）。
- `references/background-prime-agent-learn.py`：背景材料（prime-agent 架构学习笔记，最后两章是"进化 harness 的内容 vs 结构"与"换 Agent Loop"，是本项目设计的来源语境）。
- `REFERENCES.md`：外部资料链接索引。

## 完成定义

- M1 完成：observer 能采集并归类失败信号并按阈值触发；proposer 能调用独立模型生成候选 patch（config 层）；`npm run check` 通过。
- 每个里程碑结束在 Linux 上跑通：dsh profile 能加载插件、`--dump-config` 组合树包含本插件行。
