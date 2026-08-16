# dsh 插件平台（契约级笔记）

更新：2026-08-16。来源：deepseek-harness `47f9438`，路径均相对仓库根。结论带出处，接口以本笔记为准，后续实现优先查这里。

## 1. 插件形态与生命周期

- 插件 = TS 模块，导出 `name` + `apply(ctx, config)`；框架加载时调用，通过 `ctx` 注册的一切在插件卸载时自动清理（docs/user/develop/basic/index.md）。
- 三种形态：函数模块（默认）、对象模块（`{name, inject, apply}`）、class 服务（`extends Service`，供其他插件注入）（index.md "Three plugin forms"）。
- 依赖声明：`export const inject = ['tools']`，框架等齐所有必需服务才 apply（index.md）。
- 显式清理：`ctx.effect(() => { ...; return () => cleanup })`，卸载/HMR/依赖消失/应用关闭时执行返回函数（index.md）。
- HMR：改配置或代码 → 卸载旧实例 → 用新 config 重新 apply；注册项作为 effect 自动清理，不残留（config.md "Work with HMR"）。

## 2. 配置（Config + Schemastery）

- 导出同名 `Config` 类型 + Schemastery schema（`Schema.object(...)`），默认值写在 schema 字段上；加载时校验并填默认值（config.md）。
- **禁止导出普通对象当 Config**（不满足 Standard Schema）；非法配置让加载失败（fiber -> FAILED），不静默（config.md）。
- 原则：可调参数一律进 Config；检验标准 = `cordis.yml` 能改值而不改代码（config.md）。
- 我们项目现状：`cordis.patch.yml` 的 `mode/thresholds/regressionDir` 已按此设计，但 `src/index.ts` 的 `MetaValidateConfig` 尚无 Schemastery schema —— M1 要补。

## 3. 工具（defineTool / ToolDefinition）

- 最小工具：`defineTool({ name, description, parameters, output: { schema, render }, async execute(args) })`，`ctx.tools.register(...)`（docs/user/develop/basic/tool.md）。
- 执行管道：模型返回 tool_call → `tools/pre-execute`（waterfall，可拦截）→ `tools/execute`（waterfall）→ 你的 `execute()` → `tools/post-execute`（waterfall）→ `tool/result` session 事件（docs/plugin-development.md §3.1；docs/subsystems/tools.md）。
- `ToolDefinition` 完整契约（docs/subsystems/tools.md）：
  - `output.schema`：规范值 JSON Schema，成功返回值强制校验；
  - `output.render(args, value)`：纯投影，模型可见 ContentBlock；
  - `execute(args, exec)`：只返回规范 JSON 值；`args` 冻结；必须响应 `exec.signal` 并在取消时收敛；
  - `finalizeContent?(exec, result)`：总函数，管道失败也调用，不能抛；
  - `timeoutMs?`：协作超时（由 `dsh-tool-call-timeout-policy` 包装执行），**永不发给模型**；
  - `isConcurrencySafe?(args)`：显式 true 才允许并行；
  - `presentCall?/presentResult?`：UI 卡展示（纯函数，重放安全）。
  - `schemas()` 白名单只暴露 name/description/parameters 给模型，其余字段绝不外泄。
- schema DSL：`ValueSchemaSpec`（string/number/integer/boolean/null/array/object/json/oneOf），参数表为隐式开放对象，必填 = `required: true`（tools.md）。
- 事件载荷（docs/subsystems/session.md）：
  - `tool/call`：`{turn, step, callId, name, arguments}`（arguments 是模型原始 JSON 字符串）；
  - `tool/result`：`{turn, step, message: ToolResultMessage, error?: {name, code}, meta?: JsonValue}`——`error` 有就是工具失败；`meta` 为工具私有展示数据，必须 JSON 可序列化。

## 4. 事件系统与 Session 日志

- Cordis 事件三种模式：emit（广播）、serial（按注册顺序）、waterfall（链式可改写）；插件用 `ctx.on(...)` / `ctx.waterfall(...)`（docs/plugin-development.md §3.4）。
- Session = **append-only 事件日志**，`SessionEventMap` 可声明合并扩展；LLM 消息历史由日志派生（`deriveMessages()`），不另存（docs/subsystems/session.md, core.md）。
- 核心事件（session.md `SessionEventMap`）：
  - `turn/start {turn}`、`turn/end {turn, reason: TurnEndReason}`（reason 含 error/aborted 等）；
  - `step/start`、`step/end`；
  - `user/message`（含 injected/steering 区分）、`steering/message`；
  - `assistant/chunk`、`assistant/message {message, usage?}`（usage 随消息走）；
  - `tool/call`、`tool/result`（见上）；
  - `todo/write {todos}`（整表快照）；
  - `request/header {header, reason}`（重建请求头的唯一来源）、`request/context`（路由容量，仅变化时记录）；
  - compaction 系（`compaction/start/summary/end`，由合并声明加入）。
- agent 域事件（core.md "agent/* events"）：`agent/created`、`agent/disposed`、`agent/error {agent, turn, step, error}`（回合/步骤失败即时上报）；另有 agent-loop 域事件（如 `agent-loop/config-start-failed`）。
- LLM 域事件：`llm/stream` 是 waterfall（可拦截所有流式调用）；`agent/request`（每次对话请求的提案/替换）、`agent/request-error`（模型请求失败，重试策略挂这里）（packages/llm/llm/README.md）。
- 意义：observer 的失败/纠正/回归信号源 = `agent/error` + `tool/result.error` + `user/message`（纠正）+ 回归任务结果；事件 payload 结构已确认，M1 可直接订阅。

## 5. LLM 服务（ctx.llm，proposer/validator 的调用面）

- 服务：`LlmRuntime`，ctx key `llm`（packages/llm/llm/README.md）。
- 核心 API：
  - `ctx.llm.stream(GenerateOptions): AsyncIterable<StreamChunk>`——唯一的流式调用口；
  - `ctx.llm.prepareCall(config, signal)`——解析 provider/model/reasoning/maxTokens 并绑定适配器与重试策略（一次性句柄）；
  - `ctx.llm.resolveModelInfo(provider, model)`、`ctx.llm.listModels(provider)`、`ctx.llm.listProviders()`、`ctx.llm.registerAdapter(providers, adapter)`；
  - `ctx.llm.resolveCallConfig(config)`——校验显式 effort 并物化适配器默认值。
- `GenerateOptions` 关键字段：`provider`、`model`、`reasoningEffort`、`temperature`、`maxTokens`、`stop`、`sessionId`、`purpose`（conversation/compaction/session-title 等）。
- StreamChunk 协议：`block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish`；**所有失败收敛为终态 `finish {kind:'error'|'aborted'}`**，不抛流式异常；`BlockAssembler` 负责组块成消息。
- 请求头重建：`request/header` 事件记录每次请求的完整 `EpochHeader`（call config + system prompt + tool schemas），会话可重放。
- 适配器：`@deepseek-ai/dsh-llm-deepseek`（deepseek-official 路由，直接 fetch+SSE）；`@deepseek-ai/dsh-llm-pi-ai`（pi-ai 动态路由）。DeepSeek 适配器配置：`baseURL`（或 `DEEPSEEK_BASE_URL`）、`apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）、`maxTokens`、`reasoningEffort`、`models` 目录、`defaultContextWindow`；model 字符串透传（llm-deepseek/README.md）。
- **对 proposer/validator 的意义**：用 `ctx.llm.stream/prepareCall` 指定独立 provider/model + 独立 sessionId/purpose 即可做到"独立角色、不共享 actor 会话状态"；prompt 隔离靠我们自己的 system prompt 与不注入 actor 历史。

## 6. bundle / profile / patch

- 两个清单：bundle（`package.json` 声明 `dsh.bundle.patch`，贡献配置层）vs profile（`$DSH_HOME/profiles/<name>`，`dsh.profile.bundles` 有序列表）——一个包不能同时是两者（docs/user/develop/basic/publish.md）。
- 加载顺序（后层按行胜出）：① profile bundles（dsh-base 最先）→ ② profile 自身 `cordis.patch.yml` → ③ `$DSH_HOME/cordis.patch.yml` → ④ `--patch` overlay（argv 顺序）（publish.md）。
- patch 语法（vendor/include/src/index.ts `applyEntryPatches`）：
  - `- insert: [{id, name, config}]`：插入新行；带 `id` 时插进已存在的 group（`group: true` 行）；
  - `- id: <existing>` + 任意覆盖字段（`config/disabled/inject/group/isolate`…）：**按 id 整行覆盖**（config 整体替换，不深合并）；name 可带做校验，不匹配则跳过并告警；
  - 本地开发 overlay 的插件行 `name` 用**绝对路径**；bundle patch 里用**包名**（publish.md）。
- `dsh plugin --profile demo add ./pkg` 初始化 profile + pnpm link + 追加 bundle；`remove` 同时删依赖与层；`--dump-config` 打印组合树（含来源注释）。
- 对我们的意义：gate 的"应用补丁"= 用 `- id: <target> config: {...}` 覆盖目标行整行 config（必须重述所有键）；dump-config 是我们 proposer 的输入快照来源。

## 7. 服务隔离（plugin-group / isolate）

- 同一服务可多实例：`- id: xxx\n name: '@deepseek-ai/cordis-plugin-group'\n group: true\n isolate: { shell: true }\n config: [...]`——独立组内插件看到隔离实例，用于 tools/shell/fs/llm 等（docs/plugin-development.md §3.6）。
- 我们的 validator 隔离执行可借 plugin-group + isolate，或临时 profile + `--dump-config` 校验组合树后冒烟（§8 映射表）。

## 8. 类型链接（开发环境）

- `@deepseek-ai/cordis` 源码在 `vendor/cordis`（版本 4.0.1），`@deepseek-ai/dsh-tools` 在 `packages/core/tools`（0.1.0-rc.5）；构建产物 `lib/` + 类型 `lib/types/`。
- 本项目通过 `package.json` 的 `file:../dsh-src/deepseek-harness/...` devDependency 链到源码构建产物（L0 已验证，`npm run check` 通过）。
- 注意：不链运行实例的 staging 目录（旧构建风险）；上游构建产物变更后需在 dsh 仓库重新 `pnpm run build:lib`。

## 9. 构建与分发

- 本项目 `tsc -p tsconfig.json`（NodeNext ESM、strict、declaration）；`files` 含 `dist` + `cordis.patch.yml`；bundle patch 里 name 用包名（README/docs/plugin-development.md §4-5）。
- GitHub 分发：git 安装取源码不是产物，需要 `prepare` 脚本自包含构建 + pnpm `allowBuilds`；我们优先 npm/tarball/本地 link（CURRENT.md 决策）。

## 10. 对本插件的直接结论

- observer 订阅：`agent/error`、`tool/result`（含 error）、`user/message`、`assistant/message`（usage）、`request/header`（快照）——payload 已确认，M1 可编码。
- proposer/validator：走 `ctx.llm`（独立 provider/model/sessionId/purpose），不碰 actor 会话。
- gate：目标行 config 的读 = dump-config/配置服务；写 = patch 整行覆盖；回滚 = 恢复 before 快照行。
- 补 M1 前欠账：给 `MetaValidateConfig` 写 Schemastery schema；`src/index.ts` 注入点只允许依赖 `tools`/`llm`/`sessions` 等公开服务。
