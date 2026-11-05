# Local models and serving on M1 Max 64 GB

Web survey, 2026-11-05. "ESTIMATE" = derived, method shown. "UNVERIFIED" = no primary source found. Source keys at the end. Measurements taken on this machine are in [local-bench.md](local-bench.md).

## Models

`Qwen/Qwen3.8-27B` exists (Apache-2.0, HF repo 2026-08-05). Same architecture as Qwen3.6-27B and Qwen3.5-27B: 64-layer dense, 3 of 4 layers Gated DeltaNet, 1 gated attention. No open-weight Qwen3.7.

Excluded: Qwen3-Coder-Next 80B (Q4_K_M 48.5 GB, over the Metal budget); Qwen3.8-Flash-Next, GLM-5.3-Flash, Laguna-S-2.1, Mistral-Small-4 (all >100B); Qwen-AgentWorld-35B-A3B (world model, not a coder).

### Specs (sizes in decimal GB from HF file listings; GGUF bartowski unless (u) unsloth)

| Model | Total / active | Type | Native ctx | License | Q4_K_M / Q5_K_M | MLX 4b / 5b |
|---|---|---|---|---|---|---|
| Qwen3.6-35B-A3B | 36.0B / 3B | MoE, hybrid DeltaNet (10/40 attn) | 262k | Apache-2.0 | 22.29 / 25.91 | 20.40 / 24.73 |
| Qwen3.8-27B | 27.8B | dense, hybrid DeltaNet (16/64 attn) | 262k | Apache-2.0 | 17.44 / 20.92 | 16.05 / 19.42 |
| North-Mini-Code-1.0 | 30.5B / 3B | MoE, 13 full + 36 SWA(4096) | 256k | Apache-2.0 | 18.74 / 21.85 | 18.50 / 22.19 |
| KAT-Coder-V2.5-Dev | 34.7B / 3B | fine-tune of Qwen3.6-35B-A3B | 262k | Apache-2.0 | 21.39 / 25.02 | — |
| Laguna-XS-2.1 | 33.4B / 3B | MoE, 10 full + 30 SWA(512) | 262k | OpenMDW-1.1 | 20.55 / 24.01 | 18.82 / 23.00 |
| Devstral-Small-2-24B | 24.0B | dense GQA | 256k | Apache-2.0 | 14.33 / 16.76 | 15.10 / 17.97 |
| Qwen3-Coder-30B-A3B | 30.5B / 3.3B | MoE, standard GQA | 262k | Apache-2.0 | 18.56 / 21.73 (u) | 17.18 / 20.99 |
| gpt-oss-20b | 20.9B / 3.6B | MoE, alternating 128-token SWA / full | 131k | Apache-2.0 | 11.67 (MXFP4 experts) | 11.18 |
| Gemma-4-31B | 31.3B | dense, 50 SWA + 10 global | 256k | Apache-2.0 | 19.60 / 22.61 | 18.41 / 22.25 |
| GLM-4.7-Flash | 31.2B / A3B | MoE, MLA | 202k | MIT | 18.47 / 21.57 | 16.85 / 20.59 |
| Nemotron-3.5-Lightning | 31.6B / A3B | Mamba-2 hybrid | 262k | OpenMDW-1.1 | 25.48 / 26.96 | 17.78 |
| Granite-4.2-30B | 29.3B | dense GQA | 131k | Apache-2.0 | 18.03 / 21.03 | 16.47 |
| Seed-OSS-36B | 36.2B | dense GQA | 512k | Apache-2.0 | 21.76 / 25.59 | 20.34 / 24.86 |

### KV cache (from config.json; bytes/token = full-attention layers × kv_heads × head_dim × 2 × 2)

| Model | KiB/token f16 | 64k f16 / q8_0 (GiB) | Fixed extra |
|---|---|---|---|
| Qwen3.6-35B-A3B / KAT | 20 | 1.25 / 0.66 | 0.06 GiB DeltaNet state |
| Qwen3.8 / 3.6-27B | 64 | 4.00 / 2.12 | 0.15 GiB |
| North-Mini-Code | 26 | 1.62 / 0.86 | 0.28 GiB SWA cache |
| Qwen3-Coder-30B-A3B | 96 | 6.00 / 3.19 | — |
| Devstral-Small-2 | 160 | 10.0 / 5.31 | — |
| gpt-oss-20b | 24 | 1.50 / 0.80 | ~3 MB |
| Seed-OSS-36B, Granite-4.2-30B | 256 | 16.0 / 8.5 | — |

### Coding-agent benchmarks (mostly vendor-reported on the vendor's own harness; not comparable across rows)

| Model | SWE-bench Verified (harness) | Terminal-Bench | Third-party, same harness |
|---|---|---|---|
| Qwen3.8-27B | not reported | TB2.1 73.0 (Terminus) | none |
| Qwen3.6-27B | 77.2 (Qwen internal bash+edit, 200k ctx) | TB2.0 59.3 | Kwaipilot (Qwen3.5-27B): 68.6 |
| Qwen3.6-35B-A3B | 73.4 (Qwen internal) | TB2.0 51.5 | NVIDIA NeMo: 70.12, TB2.1 44.38; Kwaipilot: 64.4, TB2.1 32.0 |
| North-Mini-Code | 67.6 (SWE-agent v1.1.0) | TB2 36.0 | none |
| KAT-Coder-V2.5-Dev | 69.4 (own harness) | TB2.1 41.0 | none |
| Laguna-XS-2.1 | 70.9 (poolside on Harbor) | TB2.0 37.5 | none |
| Devstral-Small-2 | 68.0 (harness not stated) | TB2 22.5 | mini-SWE-agent: **56.4** |
| Qwen3-Coder-30B-A3B | 51.6 (OpenHands) | — | Kwaipilot: 31.8, TB2.1 13.5 |
| gpt-oss-20b (high) | 60.7 (OpenAI, 477-task subset) | — | NVIDIA: 52.44, TB2.1 15.17 |
| GLM-4.7-Flash | 59.2 | — | none |
| Granite-4.2-30B | 57 | TB2.1 29.24 | none |
| Seed-OSS-36B | 56 (OpenHands) | — | none |

Harness variance is large: Gemma-4-26B-A4B scores 17.4 (Qwen's run), 57.4 (NVIDIA), 35.8 (Kwaipilot) on the same benchmark.

### Tool-call formats and known problems
- Qwen family (Coder, 3.5/3.6/3.8, KAT): XML `<tool_call><function=…><parameter=…>`. llama.cpp dedicated parser (`common/parsers/qwen3-coder.cpp`, PR #18675, 2026-03-06). Open: model drops the opening `<tool_call>` and the call leaks into content (llama.cpp #30118); calls inside thinking (#20837); Ollama Qwen3.5-27B tool calling broken (#14493); `qwen3.8:27b-mlx` returns no `tool_calls` when prose precedes the call (#19353).
- Devstral Small 2: `[TOOL_CALLS]`; `[THINK]`/`[TOOL_CALL]` confusion (#19647, closed). Recommended temperature 0.15.
- gpt-oss: Harmony, native llama.cpp parser.
- North-Mini-Code: Cohere format (`cohere2moe` parser); thinking must be sent back every turn.
- Laguna-XS-2.1: broken on Metal in llama.cpp when batch ≥32 tokens (#30896, open).

### Ranked shortlist
1. **Qwen3.6-35B-A3B** — best third-party-reproduced score in class (70.1 NVIDIA harness), 3B active, 1.25 GiB KV at 64k. Risks: hybrid-arch prompt-cache reuse is fragile; tool-call leak #30118 open. KAT-Coder-V2.5-Dev is a drop-in fine-tune worth A/B testing.
2. **Qwen3.8-27B** — best on paper, but dense: ~100–140 tok/s prefill, 10–20 tok/s generation on M1 Max; thinking on by default with `reasoning_effort` defaulting to `xhigh`. For hard tasks where waiting is acceptable.
3. **North-Mini-Code-1.0** — 3B active, standard + sliding-window attention (normal prefix caching), 67.6 on public SWE-agent. Least verified locally.

Fallbacks: Qwen3-Coder-30B-A3B (mature, no thinking, short turns, weak on third-party harnesses); gpt-oss-20b (fastest, weak on third-party harnesses); Devstral Small 2 (dense prefill, 10 GiB KV at 64k).

## Serving on Apple Silicon

### Speed on M1 Max (pp = prefill tok/s, tg = generation tok/s)

| Model | Engine | pp (depth) | tg | Cold 30k prefill | Source |
|---|---|---|---|---|---|
| Qwen3.6-35B-A3B | MLX 4-bit, 32c | 608 at 16k | 51 | ≥49 s | [P5] community, ±50% |
| Qwen3.6-35B-A3B | llama.cpp Q4_K_XL | 117 (length not stated) | 40.5 | ESTIMATE 43–57 s | [P3] |
| Qwen3.8 / 3.6-27B | llama.cpp Q8_0 / Q4_0 | 140 at 9k | 10.3 / 14.3 | ESTIMATE 240–260 s | [P4], [P3] |
| Qwen3.6-27B | MLX 4-bit, 32c | 100 at 16k | 18.1 | ≥300 s | [P5] |
| Qwen3-Coder-30B-A3B | MLX 4-bit, 32c | 250 at 32k | 24.0 at 32k | ~120 s | [P5] |
| gpt-oss-20b | llama.cpp MXFP4 | 995 at 2k, 498 at 32k | 75.2 | ~57–60 s | [P2] |
| Devstral-Small-2 | MLX 4-bit, 24c | 65 at 32k | 9.2 at 32k | ~463 s | [P5] |

llama.cpp got its first Metal kernel for Gated DeltaNet on 2026-03-11 [P7]; generation is still slower than MLX. MLX open bugs: Qwen3.5 prompt caching broken (mlx-lm #903), long-prefill OOM on the hybrid MoE (#1480).

### Features

| | llama-server | mlx_lm.server | LM Studio (MLX) | Ollama 0.40.13 |
|---|---|---|---|---|
| Prefix reuse | `cache_prompt` on by default; `--cache-reuse N` off; slots save/restore; RAM prompt cache cap 8 GiB (`--cache-ram`) | LRU cache, 10 entries, reports `cached_tokens` | Qwen3.5 caching broken (#903) | Runs upstream llama-server for GGUF since 0.40 |
| Hybrid / SWA models | Roll back only to context checkpoints (32/slot, ≥8,192 tokens apart); restored slots give no reuse (#28194) | — | — | MLX runner cache loss (#19359) |
| Tool calling | `--jinja` default; `parallel_tool_calls` per request | parsers incl. qwen3_coder, mistral, gemma4 | yes | yes |
| Structured output | `json_schema`, grammars | **none** | GGUF grammar / MLX Outlines | `format`, `response_format` |
| KV quant / FA | `-ctk/-ctv q8_0`, `-fa auto` | `--kv-bits` (disables batching) | — | `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_FLASH_ATTENTION` |
| Pitfall | — | **`max_tokens` defaults to 512** | — | see below |

Prompt-cache invalidation: standard-attention models reuse up to the first differing token. Hybrid and SWA models only roll back to a checkpoint, so a mismatch between re-rendered and cached prompt often forces a full re-prefill. llama.cpp #30357 (open, reproduced on Qwen3.8-27B and Qwen3.6-35B on Metal): the server trims whitespace around `<think>`/`<tool_call>` in what it returns but caches raw tokens, so echoing `reasoning_content` back verbatim can force a full re-prefill.

Ollama 0.40.13 (source at tag): default context by detected VRAM — ≥47 GiB → 262,144; ≥23 GiB → 32,768; else 4,096. This Mac logs `total_vram="51.8 GiB" default_num_ctx=262144` (`~/.ollama/logs/server.log`, 2026-11-02). Silent truncation drops oldest messages, logged only at debug level. The OpenAI endpoint cannot set context size; use `OLLAMA_CONTEXT_LENGTH` (Mac app: `launchctl setenv`) or a Modelfile `PARAMETER num_ctx`.

macOS Metal budget: `recommendedMaxWorkingSetSize` ≈ 48 GiB (75%) on M1 Max 64 GB (llama.cpp #14697); one 2026 report shows ~53 GiB. Raise with `sudo sysctl iogpu.wired_limit_mb=N`. None of the top 3 needs it.

## Memory budget (GiB, f16 KV + 2 GiB runtime, vs ~48 GiB Metal budget)

| Model | Weights Q4 / Q5 | 32k (Q4) | 64k (Q4) | 64k (Q5) |
|---|---|---|---|---|
| Qwen3.6-35B-A3B | 20.8 / 24.1 | 23.5 | 24.1 | 27.4 |
| Qwen3.8-27B | 16.2 / 19.5 | 20.4 | 22.4 | 25.6 |
| North-Mini-Code | 17.5 / 20.3 | 20.6 | 21.4 | 24.2 |

Set llama-server `-cram 2048` to keep its RAM prompt cache small.

## Local vs frontier

Same harness (mini-SWE-agent, SWE-bench Verified): Devstral-Small-2 56.4 vs Claude 4.5 Opus 76.8, Claude 4.5 Sonnet 71.4, GPT-5 mini 56.2. On a neutral harness the 24B class sits 15–20 points behind frontier, level with GPT-5 mini. Qwen3.6/3.8 have no neutral-harness entry; the claim they close the gap rests on Qwen's own runs (BF16, 200–256k context, temperature 1.0, multi-hour timeouts). Qwen advises ≥128k context to preserve thinking capability. Q4 loss for these models is UNVERIFIED.

Typical failures: tool-call format drift (#30118, #20837, #19647, #14493); repetition loops (Qwen card: raise `presence_penalty`); full re-prefill on cache miss (#30357); harness mismatch with the model's trained tool preferences (Kwaipilot).

## Sources (fetched 2026-11-05)
- Model cards: [M1] huggingface.co/Qwen/Qwen3.8-27B · [M2] Qwen/Qwen3.6-27B · [M3] Qwen/Qwen3.6-35B-A3B · [M5] mistralai/Devstral-Small-2-24B-Instruct-2512 · [M6] OpenAI gpt-oss model card PDF · [M7] CohereLabs/North-Mini-Code-1.0 · [M8] poolside/Laguna-XS-2.1 · [M9] Kwaipilot/KAT-Coder-V2.5-Dev · [M10] nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16 · [M11] google/gemma-4-31B-it · [M12] zai-org/GLM-4.7-Flash · [M13] ibm-granite/granite-4.2-30b · [M14] ByteDance-Seed/Seed-OSS-36B-Instruct
- Configs/files: each repo's config.json; huggingface.co/api/models/<repo>/tree/main
- Leaderboards: [L1] github.com/SWE-bench/swe-bench.github.io data/leaderboards.json · [L2] Aider polyglot_leaderboard.yml (last entry 2025-10-03)
- Performance: [P1] llama.cpp discussion #4167 · [P2] #15396 · [P3] PR #22673 comments · [P4] PR #27529 · [P5] omlx.ai/benchmarks (community) · [P7] PR #20361 · [P8] r/LocalLLaMA 1rdx2c7
- llama.cpp: server README; PR #15293; issues #30357, #28194, #30118, #20837, #30896, #19647; PR #18675; #14697
- Ollama: tag v0.40.13 source; docs context-length, openai-compatibility, faq; PR #16031; issues #14493, #19353, #19359, #19459, #18567
- MLX/LM Studio: mlx-lm SERVER.md, server.py, tool_parsers (v0.32.2); lmstudio.ai openai-compat docs; mlx-lm #903, #1480, #1425
