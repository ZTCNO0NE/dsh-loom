#!/usr/bin/env python3
"""单卡顺序生成 Agent 关系图背景；失败即停，绝不并行占卡。

背景图不包含文字或箭头的事实含义；后续由各卡的确定性覆盖层补齐。
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import torch
from diffusers import QwenImagePipeline

ROOT = Path(__file__).resolve().parent
MODEL = Path("/data2/chenzute/t2i/models/Qwen-Image")
OUT = ROOT / "generated-backgrounds"
NEGATIVE = "文字, 字母, 数字, 标签, 水印, 签名, logo, 二维码, 乱码, 方框, 模糊字, 涂抹痕迹, 产品界面, 聊天窗口, 人脸, 机器人, 城市, 宇宙星云, 赛博朋克霓虹"

SPECS = [
    ("01-system-overview", ROOT / "01-system-overview-card.md", "loom-system-overview-bg-v1.png", 20260822),
    ("02-context-memory", ROOT / "prompts/02-context-memory.qwen-prompt.txt", "loom-context-memory-bg-v1.png", 20260823),
    ("03-input-body", ROOT / "prompts/03-input-body.qwen-prompt.txt", "loom-input-body-bg-v1.png", 20260824),
    ("04-skill-tool-mcp", ROOT / "prompts/04-skill-tool-mcp.qwen-prompt.txt", "loom-skill-tool-mcp-bg-v1.png", 20260825),
    ("05-tool-feedback", ROOT / "prompts/05-tool-feedback.qwen-prompt.txt", "loom-tool-feedback-bg-v1.png", 20260826),
    ("06-client-adapter", ROOT / "prompts/06-client-adapter.qwen-prompt.txt", "loom-client-adapter-bg-v1.png", 20260827),
    ("07-evidence-ladder", ROOT / "prompts/07-evidence-ladder.qwen-prompt.txt", "loom-evidence-ladder-bg-v1.png", 20260828),
    ("08-core-architecture", ROOT / "prompts/08-core-architecture.qwen-prompt.txt", "loom-core-architecture-bg-v1.png", 20260829),
]


def prompt_from_card(path: Path) -> str:
    source = path.read_text(encoding="utf-8")
    marker = "## Qwen 无文字背景提示词\n\n```text\n"
    if marker not in source:
        raise ValueError(f"missing Qwen prompt block: {path}")
    return source.split(marker, 1)[1].split("\n```", 1)[0].strip()


def load_prompt(path: Path) -> str:
    return prompt_from_card(path) if path.suffix == ".md" else path.read_text(encoding="utf-8").strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=1, help="从第几张卡开始，1-based")
    ap.add_argument("--limit", type=int, default=len(SPECS), help="最多生成多少张")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    selected = SPECS[args.start - 1: args.start - 1 + args.limit]
    if not selected:
        raise SystemExit("no cards selected")
    for card, prompt_path, filename, _ in selected:
        prompt = load_prompt(prompt_path)
        if len(prompt) < 350:
            raise SystemExit(f"{card}: prompt is too short ({len(prompt)} chars)")
        print(f"queued {card}: {len(prompt)} chars -> {filename}")
    if args.dry_run:
        return

    OUT.mkdir(parents=True, exist_ok=True)
    # CPU sequential offload keeps the queue to one GPU card and avoids parallel jobs.
    pipe = QwenImagePipeline.from_pretrained(MODEL, torch_dtype=torch.bfloat16)
    pipe.enable_sequential_cpu_offload()
    for card, prompt_path, filename, seed in selected:
        output = OUT / filename
        if output.exists():
            raise SystemExit(f"refuse to overwrite existing output: {output}")
        prompt = load_prompt(prompt_path)
        print(f"generating {card}", flush=True)
        result = pipe(
            prompt=prompt,
            negative_prompt=NEGATIVE,
            num_inference_steps=35,
            guidance_scale=4.5,
            true_cfg_scale=8.0,
            width=1536,
            height=1024,
            generator=torch.Generator("cuda").manual_seed(seed),
        ).images[0]
        result.save(output)
        print(f"saved {output}", flush=True)


if __name__ == "__main__":
    main()
