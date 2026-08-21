# v1.3 README 视觉交接

本目录是 README v1.3 Preview 配图的可复现交接包。精确架构由仓库内可编辑 SVG 承担；Qwen2 只承担概念表达，不负责密集文字、精确连线或发布状态判断。

## 当前状态

| ID | 资产 | 后端 | 状态 | README 位置 |
| --- | --- | --- | --- | --- |
| 01 | `fig-v13-plugin-loom-hero.png` | Qwen2 | 待生成、待人工验收 | Hero 后；当前保持空位 |
| 02 | `fig-v13-multi-plugin-transaction.svg` | 手工 SVG | 已交付 | 多插件原子演进 |
| 03 | `fig-v13-context-separation.png` | Qwen2 | 待生成、待逐字验收 | 上下文分离；当前保持空位 |
| 04 | `fig-v13-capability-map.svg` | 手工 SVG | 已交付 | 真实场景之前 |
| 05 | `fig-v12-dialogue-task-card.svg` | 既有 SVG | Verified 证据 | 当前证据 |

Qwen2 候选未通过验收前，不得复制到 `docs/figures/`，也不得在根 README 中创建图片引用。README 已留下不会渲染的 HTML 注释作为插入锚点。

## Qwen2 固定参数

- 输出：1536×1024；
- 采样：35 steps；
- `true_cfg_scale=8`；
- 每张先生成 A/B 两个候选；
- 不加水印、Logo、签名或二维码；
- negative prompt：`乱码, 错字, 方框, 重复文字, 模糊字, 涂抹痕迹, 英文填充, 水印, 签名, 笔画断裂`。

生图命令由执行者按本地 Qwen-Image 2.x 环境填写。必须使用 `prompts/` 中保存的完整 prompt，禁止临时改写后直接出图而不留记录。

## 目录约定

```text
docs/visuals/v1.3-readme/
├── README.md
├── outline.md
├── prompts/
│   ├── 01-hero-plugin-loom.md
│   └── 03-context-separation.md
├── candidates/
│   └── .gitkeep
└── acceptance.md
```

候选命名为 `01-a.png`、`01-b.png`、`03-a.png`、`03-b.png`。最终通过的文件分别复制为：

- `docs/figures/fig-v13-plugin-loom-hero.png`
- `docs/figures/fig-v13-context-separation.png`

## 交付纪律

1. 先生成候选，不覆盖正式资产。
2. 03 必须先做 VLM 逐字转写，再由用户目检。
3. 将 seed、参数、转写和选择理由写入 `acceptance.md`。
4. 只有验收通过后才解除 README 中对应插入锚点。
5. 不得用 Pillow、SVG 或覆盖层修补 Qwen2 错字；文字错误必须重新生成并保留旧候选。
