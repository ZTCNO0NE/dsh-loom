from pathlib import Path
import torch
from diffusers import DiffusionPipeline
ROOT=Path(__file__).parent; MODEL='/data2/chenzute/t2i/models/sdxl-base-1.0'
NEG='blurry, low quality, text, letters, words, numbers, watermark, logo, signature, crowded, noisy, robot, circuit board, dashboard, arrows, deformed'
ITEMS=[('00-cover-soft-fabric-sdxl.md','loom-cover-soft-fabric-sdxl-v1.png',20260827),('00-cover-color-garden-sdxl.md','loom-cover-color-garden-sdxl-v1.png',20260828),('00-cover-archival-paper-sdxl.md','loom-cover-archival-paper-sdxl-v1.png',20260829)]
pipe=DiffusionPipeline.from_pretrained(MODEL,torch_dtype=torch.float16,variant='fp16',use_safetensors=True); pipe.enable_sequential_cpu_offload(); pipe.enable_attention_slicing()
for p,n,s in ITEMS:
 im=pipe(prompt=(ROOT/'prompts'/p).read_text(encoding='utf-8'),negative_prompt=NEG,num_inference_steps=28,guidance_scale=7.0,width=1024,height=576,generator=torch.Generator('cuda').manual_seed(s)).images[0]; out=ROOT/n; im.save(out); print(out,flush=True)
