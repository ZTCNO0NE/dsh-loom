# 使用指南（3 分钟上手）

你只需要做三件事：**装插件 → 开一个开关 → 正常用你的 agent**。其他全自动。

## 第 1 步：安装（一条命令）

```bash
cd dsh-meta-validate
npm install && npm run build
dsh plugin --profile demo add ./dsh-meta-validate
```

## 第 2 步：开"后台优化"（一个开关）

在插件配置里加一行 `scheduled: true`，其余用默认：

```yaml
- insert:
    - id: meta-validate
      name: '/你的路径/dsh-meta-validate/dist/index.js'
      config:
        mode: apply
        scheduled: true
        notify:
          start: true
          progress: true
          completion: true
```

开了这个开关后，优化在后台静默进行，**不会卡住你和 agent 的对话**。

## 第 3 步：正常用，然后问它

- **什么都不用做**：agent 连续失败、卡住、或你纠正过它，它就会自己变强；
- **想知道进度**：直接问它——“优化进度怎么样？”；
- **想知道学了什么**：问它——“你最近学到了什么？”；
- **优化完成时**：它告诉你“reload 后生效”——重启/刷新会话即可用上新能力。

你不需要认识任何工具名、配置文件或内部术语。

想 3 分钟亲历一遍"失败 → 看着它长 → 重试成功 → 成长报告"？跑 `npm run try`（仓库内体验脚本），跑完自动生成一份可分享的 HTML 成长报告。

装了 npm 包后在任何机器上：`dsh-loom try`（同样流程，自动生成报告）。

## 你能看到什么

| 时机 | 你会看到 |
| --- | --- |
| 优化开始时 | 一条轻提示：“正在后台优化…完成会通知你，不影响当前对话。” |
| 优化超过 1 分钟 | “优化仍在进行…你可以继续。” |
| 优化完成时 | “优化完成：改了什么。reload 后生效。” |
| 任何时候 | 直接问 agent，它实时查状态回答你 |

## 可选微调（不调也能用）

```yaml
notify:
  start: true        # 开始优化时提示
  progress: true     # 超时未完成时提示
  progressAfterMs: 60000   # 超过 60 秒算"还在优化"
  completion: true   # 完成时提示
```

不想被任何通知打扰？把三个都设 `false`，需要时问 agent 就行。

## 常见问题

- **优化会卡住我的对话吗？** 不会，后台跑。
- **改坏了怎么办？** 自动回滚，每次改动都有 before/after 记录。
- **换模型、改配置要我自己动手吗？** 不用，它自己设计并安装，你 reload 生效。
- **我想关掉它？** 把插件从 profile 里移除即可。
- **它会不会乱改？** 所有改动先经过独立核验器在隔离环境验证，不通过不会安装。

> 想看它到底怎么工作的？跑 `npm run fromzero:all`、`npm run supervisor-swap-demo`、`npm run scheduled-notify-demo`，每个都是真实模型跑通并留档。
