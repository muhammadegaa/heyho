# Measured on this machine

MacBook Pro 14" 2021, M1 Max, 32-core GPU, 64 GB. macOS Darwin 25.5. 2026-11-05.
Scripts: [`bench/bench.py`](../../bench/bench.py) and [`bench/depth.py`](../../bench/depth.py), run against Ollama on `localhost:11434`: `python3 bench/bench.py <model> <dir of .ts files>`. Prompt text: 11 TypeScript files (84 KB) from a Node CLI project.

## 1. Ollama 0.40.13, qwen3-coder:30b (Q4_K_M, 18.6 GB)

**Default context on the OpenAI endpoint is the model's full 262,144 tokens.** `ollama ps` after a `/v1/chat/completions` call: 45 GB resident, CONTEXT 262144. Server log: `vram-based default context total_vram="51.8 GiB" default_num_ctx=262144`. With `num_ctx=65536` on the native API: 25 GB resident.

**Tool calls via `/v1/chat/completions`**, 3 tools (read/edit/bash), temperature 0: 6/6 returned well-formed `tool_calls` with valid JSON arguments. Small sample, simple single-step prompts. First call took 36 s (model load).

**Prefill and decode, native `/api/chat`, num_ctx 65536, cold prompt each time:**

| Prompt tokens | Prefill avg | Prefill time | Decode | Follow-up turn (same prefix + ~120 new tokens) |
|---|---|---|---|---|
| 1,974 | 480 tok/s | 4.1 s | 42.5 tok/s | 0.3 s prefill |
| 7,478 | 262 tok/s | 28.5 s | 34.6 tok/s | 0.4 s |
| 14,867 | 191 tok/s | 77.6 s | 25.4 tok/s | 0.4 s |
| 22,848 | 147 tok/s | 155.0 s | 21.5 tok/s | 0.6 s |

Prefix reuse works on Ollama for this standard-attention model: an append-only follow-up at 23k tokens re-processed only the new tokens.

## 2. llama.cpp build 9140 (Homebrew), same GGUF file, `llama-bench -p 512 -n 32`

| Depth | pp512 FA off | pp512 FA on | tg32 FA off | tg32 FA on |
|---|---|---|---|---|
| 0 | 779 | 398 | 64.9 | 59.1 |
| 8,192 | 201 | 194 | 21.1 | 41.1 |
| 16,384 | 120 | 136 | 13.0 | 35.5 |
| 32,768 | 54 | 69 | 6.4 | 19.6 |

Flash attention triples generation speed at 32k depth. At depth, raw llama.cpp with FA generates faster than Ollama (35.5 vs 25.4 tok/s around 15–16k).

Cost of one turn at 32k depth with FA on (ESTIMATE from the table): 2,000 new prompt tokens / 69 ≈ 29 s + 300 generated / 19.6 ≈ 15 s ≈ **45 s**. All 48 layers of Qwen3-Coder-30B use full attention, so cost grows with depth.

## 3. Ollama, qwen3.5:9b (hybrid Gated DeltaNet, Q4_K_M), think off

| Prompt tokens | Prefill avg | Decode |
|---|---|---|
| 1,966 | 340 tok/s | 21.4 tok/s |
| 16,043 | 211 tok/s | 22.2 tok/s |

Decode speed did not drop with depth (hybrid attention), unlike qwen3-coder (42.5 → 25.4 over the same range). Directional only: different size, dense 9B. The 30k run failed (script bug: corpus shorter than requested). Ollama's qwen35 GGUF does not load in llama.cpp 9140 (`GGML_ASSERT(K >= 1)`).

## 4. Sandbox

`sandbox-exec` works on Darwin 25.5: a profile denying `file-write*` under `~/code` blocked `touch` ("Operation not permitted"); a profile denying `network*` blocked a localhost HTTP request.

## What this means
- Never rely on server defaults for context; set it explicitly and read it back.
- Append-only conversations are required: a prefix change at 23k tokens costs ~2.5 minutes; an appended turn costs under a second of prefill.
- On a full-attention model, keep the working context near 24–32k; at 32k each turn already takes ~45 s.
- Hybrid-attention models (Qwen3.5/3.6/3.8) keep decode speed at depth, which favours Qwen3.6-35B-A3B as the target model, subject to its prompt-cache caveats (models-serving.md).
