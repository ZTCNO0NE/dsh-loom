# 本地大模型推理加速手册：从算子、MoE 到服务链路

更新时间：2026-08-21。

这是一份持续维护的工程手册。它回答三个问题：一次请求慢在哪里，为什么 GPU 满载时 decode 会降速，以及每种优化应该用什么实验验证。

文中的结论分为三类：

- **本机事实**：来自原始响应、llama.cpp timing、GPU 快照或服务日志；
- **通用机理**：来自硬件/运行时原理和官方文档；
- **待验证假设**：机制上合理，但还没有完成本机受控 A/B。

不要把三类结论混在一起。尤其是性能数字，只能在硬件、模型、量化、上下文、请求、并发和热态都固定后比较。

## 1. 先把“一次请求有多慢”拆开

### 1.1 四个最重要的时间

| 指标 | 从哪里开始，到哪里结束 | 主要受什么影响 |
| --- | --- | --- |
| 排队与冷启动 | 请求进入服务到 backend 可接受请求 | scheduler、模型装载、显存抢占、进程切换 |
| TTFT | backend 接受请求到第一个模型 token | prompt prefill、未命中 KV、首个 decode、首包传播 |
| TPOT | 相邻输出 token 的平均时间 | 权重/KV 带宽、算子效率、GPU 竞争、多卡通信 |
| E2E | 客户端发请求到收到最终完成事件 | 以上全部，再加 adapter、工具、重试、judge、网络 |

常用公式：

```text
decode_tokens_per_second = decoded_tokens / decode_seconds
TPOT_ms = 1000 / decode_tokens_per_second

E2E ≈ queue_and_load
    + prompt_prefill
    + decode
    + protocol_and_transport
    + optional_helper_or_tool_rounds
```

**TTFT 低不代表整轮快。** 一个服务可以 5ms 就发出 `response.created`，随后让用户等 20 秒才看到最终正文。测 SSE 时必须区分“第一个 HTTP/SSE 字节”和“第一个模型 token”。

### 1.2 Prefill 和 decode 是两种工作负载

Prefill 一次处理许多 prompt token，矩阵通常更大，更容易喂满 GPU 的计算单元。它常表现为较高的 token/s，但未缓存 token 数量一大，TTFT 仍会变长。

Decode 每轮通常只新增一个 token。batch=1 时，很多矩阵退化为小批量 GEMM/GEMV。GPU 反复读取权重和 KV，计算单元未必吃得饱，因此常受显存带宽、kernel launch 和同步影响。

这解释了一个常见现象：`GPU-Util=100%` 只能说明采样窗口内 GPU 一直有工作，不能证明 Tensor Core、HBM 或每个算子都达到了高效率。

## 2. 四层加速地图

### 2.1 算子与硬件层

这层关注一个算子如何在 AI Core/GPU 上执行。

| 问题 | GPU/CUDA 视角 | 昇腾算子视角 | 应记录的证据 |
| --- | --- | --- | --- |
| 算力是否吃满 | Tensor Core、occupancy、warp stall | Cube/Vector 利用率、流水并行 | kernel 时间、利用率、算子 trace |
| HBM 是否成为瓶颈 | DRAM throughput、L2 hit、读写字节 | GM/HBM 搬运、片上缓存复用 | 带宽、cache hit、搬运/计算比 |
| 小算子是否过碎 | launch 数量、CPU launch gap | task 下发间隔、算子切换 | kernel timeline、空洞时间 |
| 能否融合 | RMSNorm、RoPE、activation、dequant fusion | TBE/Ascend C 融合、tiling 合并 | 融合前后 kernel 数与 wall time |
| 量化是否真省时 | 权重字节减少 vs dequant 开销 | 低比特搬运 vs 转换开销 | 同模型同请求的 TPOT、功耗、误差 |

Decode batch=1 经常更接近带宽问题。权重从 Q8 降到 Q6/Q4 会减少搬运字节，但低比特解码、量化 block 布局和 kernel 实现会决定最终收益。文件更小并不自动等于 token/s 按比例提高。

### 2.2 模型与 MoE 架构层

MoE 的“总参数”和“每 token 激活参数”要分开看。

```text
总参数：决定模型文件、常驻权重和可选专家集合的规模
激活参数：决定一个 token 实际经过多少专家和多少计算
```

Qwen3.6-35B-A3B 的本地 GGUF metadata 报告约 34.66B 参数。文件约 27.30GiB；A3B 表示每个 token 只激活其中一部分计算路径，但不表示整个 35B 权重能从显存中消失。

MoE decode 还会受这些因素影响：

- router 和 top-k 选择的额外开销；
- 被选专家权重的读取与缓存局部性；
- 多 token/batch 下的专家负载是否均衡；
- expert parallel 时的 all-to-all 通信；
- 专家跨设备放置是否让每 token 都等待较慢设备。

**MoE 省的是激活计算，不一定同比例节省权重带宽和通信。** 要判断收益来自哪里，至少同时记录总权重大小、激活专家数、TPOT、HBM 带宽和多卡通信。

### 2.3 推理 runtime 层

runtime 把模型图变成真实 kernel 和内存操作。当前本机使用 llama.cpp backend `version 1 (5190c2e)`。

关键旋钮如下：

| 旋钮 | 主要收益 | 主要代价或风险 |
| --- | --- | --- |
| `--gpu-layers all` | 避免逐 token CPU/GPU 往返 | 需要足够显存 |
| `--flash-attn on` | 降低 attention 中间张量和显存访问 | 依赖模型与 backend kernel 支持 |
| `--batch-size` | 提高 prefill 吞吐 | 增加显存峰值，未必改善 batch=1 decode |
| `--ubatch-size` | 控制 prefill 的物理分块 | 太小增加调度，太大可能 OOM |
| KV Q8/Q4 | 减少长上下文 KV 容量和带宽 | 可能有精度影响与 dequant 开销 |
| prompt/KV cache | 命中时减少重复 prefill | cache key、前缀变化和恢复有效性必须核验 |
| continuous batching | 多请求共享 GPU，提高总吞吐 | 单请求 TPOT 可能因竞争上升 |
| speculative decoding | 主模型一次接受多个草稿 token | draft 命中率低时收益消失 |

128K context 不等于每轮都计算 128K prompt，但它会扩大 KV 的最大容量。对 full-attention 层，每生成一个 token 都要读取已有 K/V；上下文越长，单 token attention 的工作量越大。混合注意力架构可能降低其中一部分成本，不能直接套用纯 Transformer 的固定比例。

### 2.4 服务链路层

本机原生产链为：

```text
client → LiteLLM :4000 → Responses adapter :4010
       → scheduler :12341 → llama.cpp backend
```

当前 canary 把它缩成：

```text
Chat/Benchmark → llama.cpp :12424
Codex          → minimal Responses adapter :4021 → llama.cpp :12424
```

链路层会增加：

- JSON/SSE 编解码和缓冲；
- 连接建立、代理转发和首包传播；
- scheduler 排队、冷加载和模型切换；
- narrator、terminal judge、retry 等额外模型调用；
- tool call 后的多轮往返；
- KV 保存、恢复和磁盘 I/O。

本次 canary 中，adapter 首 SSE 约 7ms，模型流尾处理 1ms。此前生产记录里，terminal judge/narrator 会把部分请求从主模型的数秒扩大到 25–55 秒。这个差值属于控制链路，不应归因给 decode kernel。

## 3. 为什么 GPU 满载会让 decode 降速

### 3.1 “显存占用”和“GPU 忙”不是同一件事

显存占用表示数据驻留了多少。GPU utilization 表示采样窗口内是否有 kernel 执行。真正影响 decode 的还包括：

- HBM 带宽是否被另一任务读取训练参数、梯度或 optimizer state；
- SM/Tensor Core 是否被另一任务的 GEMM 占用；
- L2 cache 是否被互相冲刷；
- power limit 下，两个负载是否争夺功耗和频率；
- runtime 是否在两个进程之间切换 context；
- 温度升高后时钟是否降低。

所以“还有 3GiB 空闲显存”不能推出“decode 不受影响”。模型已经装得下，只说明容量门槛过了。

### 3.2 当前双卡为什么会被 GPU1 拖慢

本机两张 RTX 3090 之间没有 NVLink；`nvidia-smi topo -m` 显示 GPU0↔GPU1 为 `NODE` 路径。canary 使用 layer split `0.70,0.30`，一部分层固定在 GPU1。

生成单个 token 时，层之间有严格依赖：前一层输出完成，后一层才能继续。只要 GPU1 上的训练任务抢占它负责的层，整个 token 都要等待。GPU0 即使有空闲，也不能跳过 GPU1 上的层。

可以用一个简化式理解：

```text
TPOT ≈ GPU0_layers_time
     + inter_gpu_transfer_time
     + GPU1_layers_time
     + synchronization_and_launch_time
```

这里是串行关键路径，不能拿两张卡的平均利用率解释。

### 3.3 本次观测能证明什么

| 观测 | 环境 | decode |
| --- | --- | --- |
| 直连稳定短请求 | 热模型、41 prompt、256 decode | 85.27 token/s |
| Codex 流式请求 | GPU1 外部训练 99–100%、475 prompt、274 decode | 45.14 token/s |

两者相差约 47%。这个数字说明 GPU 竞争与 decode 下降同时发生，符合算力/HBM/同步竞争机制。

它还不是严格因果实验。两次请求的 prompt、输出内容、图热态和 adapter 注入都不同。后续必须在训练停止前后使用相同请求、相同 seed、相同服务热态，各重复至少 5 次，再报告中位数和分位数。

## 4. 本机 35B Q6 canary 基线

### 4.1 硬件与拓扑

| 项目 | 当前事实 |
| --- | --- |
| GPU | 2× RTX 3090，单卡 24GiB |
| GPU 互联 | `NODE`，未检测到 NVLink |
| Driver | 580.173.02 |
| 模型 | Qwen3.6-35B-A3B UD-Q6_K |
| GGUF | 29,308,320,736 bytes |
| llama.cpp | version 1, build 5190c2e |

### 4.2 冻结参数

```text
ctx-size       131072
parallel       1
batch-size     2048
ubatch-size    512
split-mode     layer
tensor-split   0.70,0.30
cache-type-k   q8_0
cache-type-v   q8_0
flash-attn     on
gpu-layers     all
cache-ram      0
slot-save      disabled
reasoning      on
```

### 4.3 已完成的功能与性能 smoke

| 测试 | 结果 | 边界 |
| --- | --- | --- |
| 128K + Q8 KV 加载 | 一次成功 | 只证明当前双卡容量可用 |
| llama `/health` | 约 0.65ms | 不经过模型推理 |
| 直连 decode | 67.39 / 85.27 token/s | 前者含冷态影响；请求不同 |
| Responses 流式 | TTFT 426ms，总时长 7.31s | TTFT 是模型 token，不是首 SSE |
| adapter 尾处理 | 1ms | helper/judge 已关闭 |
| function call | 3.18s，参数结构正确 | 只测一个简单 schema |

新增的固定 prompt contention 5× 记录进一步得到：

| 指标 | 结果 |
| --- | ---: |
| decode token/s（5 次） | 44.55 / 44.58 / 52.22 / 54.70 / 74.69 |
| decode 中位数 | 52.22 token/s |
| decode 范围 | 44.55–74.69 token/s |
| HTTP total 中位数 | 4.9567s |
| GPU1 utilization | 163 个 200ms 时间点，平均约 97.27% |
| GPU0 / GPU1 平均功耗 | 153.92W / 294.76W |
| GPU0 / GPU1 平均 SM clock | 1729.97 / 1863.50MHz |

该请求在 warm-up 后命中 48/52 prompt tokens，每轮只 prefill 4 个 token，正式轮均 decode 256 tokens。这比此前不同 prompt 的 85→45 对照更适合描述“当前 contention 分布”，仍需空闲 GPU 的同命令数据才能计算净损失。

原始记录：`/chenzute/dsh-src/eval/run-records/2026-08-21-qwen36-35b-a3b-q6-runtime-canary/`。

固定 prompt 5× 记录：`/chenzute/dsh-src/eval/run-records/2026-08-21-qwen35-q6-decode-gpu1-contention-v1/`。

## 5. 每层该怎么做受控实验

### 5.1 算子层实验

一次只改变一个变量：

1. 固定模型、prompt、输出上限、seed、context、GPU 空闲状态；
2. warm-up 2 次；
3. 正式重复 5 次；
4. 报告 TTFT、prefill token/s、decode token/s、TPOT、功耗和能耗/token；
5. 再比较 Flash Attention、batch/ubatch、KV dtype 或量化 kernel。

如果要研究昇腾算子，同样保留这套上层输入，替换 backend 后采集算子 trace。这样能区分“算子本身更快”和“prompt/调度刚好不同”。

### 5.2 MoE 层实验

建议至少对比：

- 35B-A3B Q6 与 27B dense 的同量化或近似显存档；
- 短 prompt/长 decode，用来观察权重与 expert 路径；
- 长 prompt/短 decode，用来观察 attention/KV；
- batch=1 与多请求，用来观察专家聚合和总吞吐；
- 单卡可运行模型与双卡模型，用来观察通信代价。

不能只看模型卡上的激活参数，也不能只看单次 token/s。最终选择仍应以任务成功率、工具格式错误、收敛调用数和能耗/成功任务为主。

### 5.3 runtime 层实验

推荐矩阵：

| 变量 | 候选值 | 主要观察 |
| --- | --- | --- |
| Context | 16K / 32K / 64K / 128K | 显存、长上下文 TPOT |
| KV | F16 / Q8 / Q4 | 容量、速度、任务质量 |
| batch | 1024 / 2048 / 4096 | prefill、显存峰值 |
| ubatch | 256 / 512 / 1024 | prefill、OOM、kernel 数 |
| split | layer 不同比例 / row | 负载均衡与 PCIe 通信 |
| backend | 当前 llama.cpp / 新 build | kernel 与模型支持差异 |

### 5.4 链路层实验

同一个模型请求按三条路径跑：

```text
A. direct llama.cpp
B. minimal adapter → llama.cpp
C. LiteLLM → full adapter → scheduler → llama.cpp
```

每条路径记录：

- 客户端首 HTTP 字节；
- adapter 内部 TTFT；
- backend prompt/decode timing；
- scheduler submit→dispatch；
- 是否发生冷加载、helper、retry、KV save/restore；
- 最终 E2E。

只有这样才能回答“慢在模型还是慢在链路”。

## 6. 数据落地规范

每次测试目录至少包含：

```text
run-records/YYYY-MM-DD-<model>-<experiment>/
├── report.md
├── config.json
├── request.json
├── response-001.json
├── response-002.json
├── timings.jsonl
├── gpu-samples.csv
└── backend.log
```

`timings.jsonl` 每行建议包含：

```json
{
  "model": "qwen/qwen3.6-35b-a3b-q6",
  "request_index": 1,
  "prompt_tokens_total": 512,
  "prompt_tokens_evaluated": 64,
  "cached_tokens": 448,
  "decoded_tokens": 256,
  "prompt_tps": 1000.0,
  "decode_tps": 85.0,
  "http_first_byte_s": 0.01,
  "http_total_s": 3.2,
  "finish_reason": "stop"
}
```

不要只保存汇总表。没有原请求、原响应、backend timing 和 GPU 时间序列，后续很难判断一次“加速”是不是缓存、输出变短或外部负载变化造成的。

## 7. 当前测试工具

固定请求的 canonical 采集脚本和 prompt：

```text
/chenzute/dsh-meta-validate-handoff/docs/research/tools/measure-llamacpp-decode.sh
/chenzute/dsh-meta-validate-handoff/docs/research/tools/llamacpp-decode-fixed-v1.txt
```

eval 目录 `/chenzute/dsh-src/eval/scripts/measure-llamacpp-decode.sh` 保留当前可执行副本；版本化事实源以上述 Loom 文件为准。脚本会保存请求、每轮响应、curl 时间、llama.cpp timing 字段和 200ms GPU 样本，并拒绝覆盖已有非空 run 目录。默认 warm-up 2 次、正式 5 次。调用示例：

```bash
PROMPT_FILE=/chenzute/dsh-meta-validate-handoff/docs/research/tools/llamacpp-decode-fixed-v1.txt \
REPEATS=5 WARMUPS=2 MAX_TOKENS=512 \
/chenzute/dsh-meta-validate-handoff/docs/research/tools/measure-llamacpp-decode.sh \
  http://127.0.0.1:12424/v1 \
  qwen/qwen3.6-35b-a3b-q6 \
  /chenzute/dsh-src/eval/run-records/2026-08-21-qwen35-decode-idle
```

## 8. 下一轮必须补的数据

1. 等 GPU1 外部训练停止后，用同一 prompt 做 2 warm-up + 5 repeat；
2. 在训练运行时重复同一组，形成真正的 contention A/B；
3. 分别测 16K、32K、64K、128K context 的显存与长上下文 TPOT；
4. 比较 KV Q8 与 Q4，不改其他参数；
5. 用同请求比较 direct 与 minimal adapter；
6. 最后才恢复 full scheduler 链路做端到端对照。

## 9. 参考资料

- NVIDIA, CUDA C++ Best Practices Guide：<https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html>
- NVIDIA, `nvidia-smi` documentation：<https://docs.nvidia.com/deploy/nvidia-smi/index.html>
- NVIDIA TensorRT-LLM, Performance Tuning Guide：<https://nvidia.github.io/TensorRT-LLM/performance/performance-tuning-guide/useful-build-time-flags.html>
- ggml-org/llama.cpp server documentation：<https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md>
- 本机模型来源与哈希：`/data2/chenzute/models/Qwen3.6-35B-A3B-GGUF/model-provenance.json`

这些链接用于解释稳定机理。所有本机性能数字仍以同目录 raw record 为唯一事实源。
