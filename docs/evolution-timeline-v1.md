# 持久化优化轨迹可视化 v1（设计稿）

> 目标：把 agent 的每次进化沉淀成一条**可回看、可分享、可验证**的时间线——用户打开一个文件就能看到"我的 agent 一路怎么长的"。

## 一、数据源（全部已有，不新增埋点）

| 数据 | 位置 | 用途 |
| --- | --- | --- |
| 进化台账 | `growth/<session>/ledger.jsonl` | 每次应用：触发场景、问题、改动、verdict、时间 |
| 偏好沉淀 | `growth/<session>/preferences.json` | 用户偏好清单（紫色节点） |
| 人话记录 | `growth/<session>/report.md` | 每行一条进化摘要 |
| 原始证据 | `workspace/<session>/history.jsonl`、`patches/<id>/`、`cost-log.jsonl` | before/after、验证报告、成本 |
| 查询工具 | `meta_growth`（已实现） | CLI/agent 侧摘要查询 |

## 二、v1 交付形态（不做 web 面板，先给"能打开、能分享"）

### 1. 静态时间线 HTML（核心交付）

一条命令生成自包含 `timeline.html`（单文件、无外链、可发群里）：

```bash
npm run timeline          # 读取 growth/ 生成 timeline.html
```

页面内容：

- **顶部汇总卡**：进化总次数、新增工具/技能数、记住偏好数、累计成本（有 cost-log 时）、最近一次进化时间；
- **时间轴**：按时间排列每个进化节点，节点卡片含：
  - 触发场景徽章（S1 重复失败 / S3 用户纠正 / S9 显式请求…）；
  - 问题摘要（一句话）；
  - 改动 before/after（config/工具/技能）；
  - 核验结果（approved ✅ / 回炉 ⏳ / 回滚 🔄）；
  - 偏好节点（紫色：scope: value）；
- **分组**：按天/epoch 分组，跨会话用 sessionId 标注。

### 2. CLI 摘要

```bash
npm run growth            # 最近 10 条 + 汇总（复用 meta_growth 逻辑）
```

## 三、设计要点

- **数据契约**：以 `ledger.jsonl` 为唯一事实源，HTML 只做渲染；缺字段不阻塞（显示"暂无"）。
- **颜色语义**：绿=成功安装、黄=回炉后通过、红=回滚、紫=偏好沉淀。
- **补 metrics**：现在 `metricsBefore/After` 为空；后续在 `onApplied` 里用 actor-profile 快照填充（错误率/时延/成本），时间线就能画"成长曲线"。
- **可分享**：HTML 内嵌全部数据（base64 图片可后续加），单文件分享。
- **性能**：默认最近 200 个节点，超限折叠。

## 四、验收标准

1. `npm run timeline` 在有 fromzero/preferences 数据的机器上生成 `timeline.html`；
2. 页面能看到 ≥3 个真实进化节点（含工具、技能或偏好）；
3. 浏览器打开无外链请求；文件可单独分享；
4. `npm run growth` 输出最近记录与汇总。

## 五、后续路线（不在 v1）

- dsh web 插件面板：实时时间线 + 成长曲线（错误率/时延/成本随 epoch）；
- 多 agent：共享技能库视图、团队成长汇总；
- 视频/动效：进化瞬间回放（失败→方案→验证→安装）。
