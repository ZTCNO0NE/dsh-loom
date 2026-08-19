import sys
import time
from pathlib import Path
import torch

sys.path.insert(0, '/data2/chenzute/t2i')
from gen_qwen_one import _load_pipe

prompt = Path(__file__).parent / 'prompts/00-cover-agent-request-loop.md'
text = prompt.read_text(encoding='utf-8')
out = Path('/chenzute/dsh-meta-validate-handoff/images/20260820-agent-self-evolution-from-codex-request/loom-agent-request-loop-cover-v1.png')
pipe = _load_pipe()
start = time.time()
image = pipe(
    prompt=text,
    num_inference_steps=28,
    guidance_scale=4.5,
    true_cfg_scale=8.0,
    negative_prompt='text, letters, numbers, labels, logo, watermark, signature, tangled arrows, chaotic wires, crowded dashboard, giant brain, humanoid robot, mystical AGI imagery, visual noise',
    width=1024,
    height=576,
    generator=torch.Generator('cuda').manual_seed(20260820),
).images[0]
image.save(out)
print(f'{out} ({time.time()-start:.1f}s)')
