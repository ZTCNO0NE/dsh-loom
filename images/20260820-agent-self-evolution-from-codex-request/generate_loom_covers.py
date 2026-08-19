from pathlib import Path
import torch
from diffusers import DiffusionPipeline
ROOT=Path(__file__).parent; MODEL='/data2/chenzute/t2i/models/sdxl-base-1.0'
NEG='blurry, low quality, text, letters, words, numbers, watermark, logo, signature, crowded, noisy, tangled wires, dashboard, robot, circuit board, deformed'
ITEMS=[('00-cover-loom-wood-sdxl.md','loom-cover-loom-wood-sdxl-v1.png',20260830),('00-cover-loom-fiber-sdxl.md','loom-cover-loom-fiber-sdxl-v1.png',20260831),('00-cover-loom-river-sdxl.md','loom-cover-loom-river-sdxl-v1.png',20260832),('00-cover-loom-archive-sdxl.md','loom-cover-loom-archive-sdxl-v1.png',20260833)]
pipe=DiffusionPipeline.from_pretrained(MODEL,torch_dtype=torch.float16,variant='fp16',use_safetensors=True); pipe.enable_sequential_cpu_offload(); pipe.enable_attention_slicing()
for p,n,s in ITEMS:
 im=pipe(prompt=(ROOT/'prompts'/p).read_text(encoding='utf-8'),negative_prompt=NEG,num_inference_steps=28,guidance_scale=7.0,width=1024,height=576,generator=torch.Generator('cuda').manual_seed(s)).images[0]; out=ROOT/n; im.save(out); print(out,flush=True)
