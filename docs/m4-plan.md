# M4 实施记录（最小集：insert 新行 + skill/tool patch + 模块写入 + 隔离加载校验）

更新：2026-08-16。范围由"从零成长实验"（10 §9.5）直接逼出。

## 已完成

### M4.1 类型与协议

- `MetaPatch` 增加 `action: 'update' | 'insert'`、`targetName`、`module { files, entry }`；
- `ModuleFile` / `MetaModule` 类型；protocol 增加 `paths.staging`（builder 草稿目录）。

### M4.2 builder 产出 insert patch + 模块草稿

- prompt schema 增加 action/targetName/module；
- `normalizeModule`：insert 必须 files 非空且 entry 命中一个文件，否则报错；
- `writeStagingFiles`：草稿写入 `builder/staging/<patchId>/`（**不写 live 树**）。

### M4.3 verifier 隔离加载即校验

- `runModuleLoadCheck`：insert patch 的 .js/.mjs 模块在 staging 路径跑 `node --check`（fresh process），失败即 rejected（evidence 带文件名与错误摘要）；
- ValidatorOptions 增加 workspaceRoot/sessionId 定位 staging；
- isolation overlay 支持 insert（`- insert: [{id, name, config}]`）。

### M4.4 gate insert 应用/回滚

- `ApplyOps` 增加 `rowExists / insertRow / removeRow`；
- `applyInsert`：row 已存在 → 拒绝；插入 → 冒烟 → 失败 removeRow 回滚；history 记 `insert / insert-rollback / insert-conflict / insert-error`；
- index 的 loader 接线：模块安装到 `installed/<session>/<patchId>/`，`loader.create` 插入行，`loader.remove` 回滚并删安装目录。

### M4.5 验收

- `npm run check` 全绿；`npm test` **56/56**（新增：proposer insert+staging、verifier 语法错拒绝/合法通过、gate insert 成功/回滚/冲突、isolation insert overlay）；
- dsh headless + overlay 集成 boot 正常。

### M4.6 skill patch 接入 gate（2026-08-16）

- `ApplyOps` 增加 `skillExists / installSkill / removeSkill`；`applyInsert` 按 `targetKind === 'skill'` 分流到 `applyInsertSkill`——技能已存在拒绝、安装 SKILL.md 文件、冒烟失败回滚（删除技能目录）；history 记 `skill-insert / skill-insert-rollback / skill-conflict / skill-insert-error`；
- Config 增加 `skillRoot`（默认空，配了才允许真实安装）；index 的 loader 接线实现技能文件安装/回滚；
- 测试增至 **59/59**（新增 skill insert 成功/回滚/冲突 ×3）；集成 boot 正常。
- 遗留：skill 的隔离验证（staging 技能根 + catalog probe）仍是实验脚本路径（fromzero-l4/l5）。

### M4.7 skill 隔离验证接入 verifier 通用路径（2026-08-16）

- `ValidatorOptions.skillIsolation`（dshCommand/cwd/profile/baseOverlays/stagingRoot + 可注入 dumpRunner/probeRunner）；
- `runSkillIsolationCheck`：把候选 SKILL.md 复制进 staging 技能根 → 生成 skill-filesystem probe overlay → dump 差异（只允许 skill-filesystem 行变化）→ 真实 boot 调 skill 工具加载 → 通过条件 = 无无关变化 + exit0 + 输出含技能名且不含"不存在"；
- `run()` 前置：skill patch 未配置 skillIsolation 或探测失败 → 直接 rejected；
- Config 增加 `skillStagingRoot`，isolation 开启时自动接线；
- 测试 **62/62**（新增 skill 隔离通过/缺失拒绝/未配置拒绝 ×3）。至此 M4 工程项全部闭合；fromzero-l4/l5 实验脚本可后续迁移到通用路径。

### M4.8 通用循环驱动从零成长（2026-08-16）

- `npm run fromzero:loop-demo`：用 **IterationLoop + gate ops（stub LLM）** 直接跑工具 insert（L1）与技能 insert（L4）——各 1 次迭代 approved+applied，history 记 `insert` / `skill-insert`；
- 测试增至 **64/64**（新增 loop×tool-insert / ×skill-insert）；
- 结论：实验脚本（fromzero-l1/l4）的逻辑已可由插件通用路径替代；真实模型版本由 fromzero-l1..l5 脚本保留为端到端证据。

### M4.9 真实模型走插件完整通用路径（2026-08-16）

- `IterationLoop` 新增 `collectFrames`（builder 后隔离探测取真实帧再喂 verifier）与 builder 调用 3 次重试；
- `npm run fromzero:generic-real`：AutoPilot 全链路（硬触发→评审门→builder→collectFrames→verifier→gate insert）真实 V4 Flash 跑 L3a——**2 轮迭代（真实回炉）后 approved+applied**，升级 actor 重试通过；cost-log 带 runId；
- 测试 **65/65**（新增 collectFrames 喂帧 ×1）。

### M4.10 collectFrames 接入宿主触发路径（2026-08-16）

- `src/meta/collectFrames.ts`：`collectFramesForPatch`（可注入 isolationRunner）——builder 后对工具/config 候选跑真实隔离探测并映射为 verifier 帧；skill 直通（由 verifier 的 skillIsolation 负责）；disabled 直通；
- `createLoop`（meta.iterate / meta.auto / TurnBoundaryHook 共用）接入 collectFrames——宿主回合边界触发路径从此具备真实隔离验证；
- 测试 **69/69**（新增 collectFrames ×4）；集成 boot 正常。

### M4.11 TypeScript 工具模块加载校验（2026-08-16）

- `runModuleLoadCheck` 支持 `.ts`：staging 目录自动补 `{"type":"module"}` package.json，用 `node --import tsx/esm <file>` 加载校验（语法 + 顶层 import 解析）；`.js/.mjs/.cjs` 仍用 `node --check`；非代码文件（SKILL.md）跳过；
- 新增 tsx devDependency；测试 **71/71**（新增 .ts 合法通过 / 语法错拒绝 ×2）。

## 遗留

- `.ts` 模块的加载校验（目前只校验 .js/.mjs；TS 需要 tsx/tsc 检查）——工具模块建议先写 .mjs；
- skill patch 的内容/引用/参数白名单校验（prime-agent validateEdit 风格）——类型已通，规则细化随从零实验 L3 技能层落地；
- 从零端到端 L1-L5（步骤 2 完成后的步骤 3）：先跑 L1（builder 新增 fs 工具行 → 验证 → actor 重试成功）。
