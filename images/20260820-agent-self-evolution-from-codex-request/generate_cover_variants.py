from pathlib import Path
import sys
import torch
from diffusers import DiffusionPipeline

ROOT = Path(__file__).parent
MODEL = '/data2/chenzute/t2i/models/sdxl-base-1.0'
NEGATIVE = 'blurry, low quality, text, letters, words, numbers, watermark, logo, signature, arrows, crowded, noisy, robot, humanoid, giant brain, dashboard, deformed'
ITEMS = [
    ('00-cover-minimal-editorial-sdxl.md', 'loom-cover-minimal-editorial-sdxl-v1.png', 20260821),
    ('00-cover-loom-metaphor-sdxl.md', 'loom-cover-loom-metaphor-sdxl-v1.png', 20260822),
    ('00-cover-blueprint-sdxl.md', 'loom-cover-blueprint-sdxl-v1.png', 20260823),
    ('00-cover-ink-loom-sdxl.md', 'loom-cover-ink-loom-sdxl-v1.png', 20260824),
    ('00-cover-night-bridge-sdxl.md', 'loom-cover-night-bridge-sdxl-v1.png', 20260825),
    ('00-cover-paper-fiber-sdxl.md', 'loom-cover-paper-fiber-sdxl-v1.png', 20260826),
]

pipe = DiffusionPipeline.from_pretrained(MODEL, torch_dtype=torch.float16, variant='fp16', use_safetensors=True)
pipe.enable_sequential_cpu_offload()
pipe.enable_attention_slicing()
for prompt_name, image_name, seed in ITEMS:
    image = pipe(
        prompt=(ROOT / 'prompts' / prompt_name).read_text(encoding='utf-8'),
        negative_prompt=NEGATIVE,
        num_inference_steps=28,
        guidance_scale=7.0,
        width=1024,
        height=576,
        generator=torch.Generator('cuda').manual_seed(seed),
    ).images[0]
    target = ROOT / image_name
    image.save(target)
    print(target, flush=True)
