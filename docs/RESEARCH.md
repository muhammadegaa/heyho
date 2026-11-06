# heyho — survey findings

2026-11-05. Step 1 of the brief: how existing harnesses work, which local models fit, and what this machine actually does. Details and citations:

- [research/opencode-pi-serena.md](research/opencode-pi-serena.md)
- [research/aider-mini-swe-agent.md](research/aider-mini-swe-agent.md)
- [research/cline.md](research/cline.md)
- [research/models-serving.md](research/models-serving.md)
- [research/local-bench.md](research/local-bench.md) — measured on this M1 Max

Also used: Paweł Huryn, "Agent Harness: How I Built My Own Claude Code" (free half of the post; the paywall cuts off before sessions, permissions, subagents and MCP).

## 1. Harnesses compared

All read from source at the listed commit. Token figures are chars/4 of the source strings.

| Harness | Version / commit | Lang | Default tools | Fixed prompt + tool schemas | Tool calling | Edit matching | Loop guard | Compaction |
|---|---|---|---|---|---|---|---|---|
| Pi | 1.5.0 `ccff987` | TS | 4: read, bash, edit, write | ~1k tokens | native | exact + one fuzzy tier | none | at window−16k, keep 20k |
| OpenCode | 2.2.5 `893e8dc` | TS (Effect) | 13 + "Code Mode" | ~3k tokens | native | exact + two fuzzy tiers, closest-lines hint | none (issue #45442: 50-minute loop) | at window−max(15%,16k), keep 15k |
| Cline 4.x (SDK rewrite) | `d3ecc48` | TS | 7 (act mode) | ~3k tokens | native only, jsonrepair on args | exact, unique | identical call warn 3 / stop 5; mistakes 6 | 90% → 70%, LLM summary |
| Cline 3.89 (legacy) | `e1bdeef` | TS | 15+ | **~14.3k tokens** | XML in text | exact → line-trimmed → anchor | mistakes 3 | drop half, keep first exchange |
| Aider | `5dc9490` | Python | none (edit formats in text) | ~2.4k + repo map 1–4k + full files in chat | text SEARCH/REPLACE | exact → uniform-indent → elision | 3 reflections | summarize at max_input/16 |
| mini-swe-agent v2 | `04d809c` | Python | 1: bash | ~0.8k | native (text mode kept) | none (sed / heredoc) | 3 format errors | none; aborts on overflow |
| Mini Harness (PDF) | 1.0.0 | Python | 5 + web search | 525 + 2,068 tokens measured (+5,588 web search) | native | exact, read-before-edit | (paywalled) | yes |

## 2. Findings that shape the design

1. **Lean harnesses perform as well as large ones.** In the PDF's Terminal-Bench 2.0 run on Claude Haiku 5.5 (10 tasks × 5 runs), Mini Harness scored 9.2, Pi 8.8, mini-swe-agent 8.8, Claude Code 8.4, OpenCode 8.2. The gaps are small, but a ~1k-token harness gives up nothing measurable.
2. **The fixed budget can be about 1k tokens.** Pi spends ~1k on prompt plus tools. Legacy Cline spent 14.3k, 22% of a 64k window, before reading a file.
3. **On this Mac, an unchanged prompt prefix matters more than anything else in the harness.** Measured: a cold 23k-token prompt takes 155 s to process; the next turn with the same prefix takes 0.6 s. Anything that edits earlier messages (re-rendered system prompt, pruned tool results, changed repo map) costs minutes. Hybrid-attention models make this more fragile: llama.cpp can only roll back to checkpoints, and llama.cpp #30357 forces a full re-prefill if the client echoes reasoning text differently from what was cached.
4. **Server defaults cause failures.** Ollama 0.40.13 on this Mac loads at 262,144 tokens of context (45 GB resident) because it detects 51.8 GiB of VRAM. Pi, OpenCode and Cline all have open bugs from assuming the wrong window. The harness must set the context size and read it back from the server.
5. **Local tool calls fail by leaking into plain text.** The most common local-model complaint in Cline's tracker (#14453, #10843, #15255) and an open llama.cpp bug for the Qwen parser (#30118). Cline 4.x removed its text fallback and broke working setups (#13008). A fallback parser for tool calls found in message text is required. My own test: 6/6 well-formed calls from Qwen3-Coder-30B on simple prompts.
6. **Edit tools have converged:** exact text, must be unique (or replace-all), a narrow normalization fallback (unicode quotes/dashes/spaces, trailing whitespace), and a failure message that shows the closest lines (OpenCode) or says "already applied". Avoid echoing the whole file on failure (legacy Cline) and automatic fuzzy apply (Aider wrote it, then disabled it).
7. **Native tool calls vs text edit blocks.** Aider's 2024 data shows code inside JSON tool arguments scoring 3–10 points lower, and ~30B models breaking SEARCH/REPLACE syntax often (Qwen2.5-Coder-32B: 71.6% well-formed). Current Qwen models are trained and scored on bash + edit tool scaffolds (Qwen3.6 card), and Kwaipilot attributes score gaps to mismatches with the model's trained tool preferences. Default: native edit tool. Test SEARCH/REPLACE as an eval experiment.
8. **Tool output caps are too large elsewhere.** OpenCode and Pi cap at 2,000 lines / 50 KB ≈ 12k tokens, a fifth of 64k. Use ~8 KB, with full output written to a file the model can page through.
9. **Loop protection is mostly missing.** Only Cline 4.x detects repeated identical calls; OpenCode and Pi have none. A step cap is also missing by default in Pi, OpenCode and mini (whose only limit is cost, which is $0 locally).
10. **LSP is not where the others are.** OpenCode 2.x has TODOs for it; Pi has none; Serena disabled diagnostics-after-edit because edits introduce diagnostics that later edits fix. tree-sitter outlines and a symbol index (Aider's repo-map approach) need no language server and fit a token budget. LSP queries can come later as an on-demand tool.
11. **Compaction thresholds are fixed elsewhere.** OpenCode and Pi compact at window−16k, about 48k on a 64k window. On this Mac with a full-attention model, a turn at 32k already takes ~45 s. Trigger compaction from measured latency, not from the window size alone.
12. **No OS sandbox in OpenCode or Pi; Cline's CLI auto-approves everything by default.** macOS `sandbox-exec` works on this machine (write and network denial both verified).

## 3. Models

Ranked for this machine (64 GB, M1 Max 32-core):

1. **Qwen3.6-35B-A3B** (MoE, 3B active, hybrid attention). Best third-party-reproduced score in its size class: 70.1 SWE-bench Verified on NVIDIA's harness, 64.4 on Kwaipilot's. Q4_K_M is 22.3 GB; KV cache is 1.25 GiB at 64k. Community M1 Max numbers: ~600 tok/s prefill at 16k, 40–50 tok/s generation. Risks: prompt-cache reuse on hybrid models (finding 3) and the open Qwen tool-call leak (#30118).
2. **Qwen3.8-27B** exists (Apache-2.0, Aug 2026). Strongest on Qwen's own benchmarks, but dense: estimated 4–5 minutes to prefill 30k tokens and 10–20 tok/s generation here, with thinking on at `xhigh` effort by default. Use it for hard tasks where waiting is acceptable.
3. **North-Mini-Code-1.0** (Cohere, 3B active, sliding-window attention, so prefix caching behaves normally). 67.6 on the public SWE-agent harness. No M1 Max numbers found.

Already installed: **Qwen3-Coder-30B-A3B** (Ollama, Q4_K_M). Weak on third-party harnesses (31.8 on Kwaipilot's), but it doesn't use thinking, has standard attention (reliable prefix cache) and gave 6/6 clean tool calls. Good as a development baseline while building; not the target.

Not recommended here: Devstral Small 2 (dense, 10 GiB KV at 64k, 56.4 on a neutral harness), gpt-oss-20b (fast, weak on third-party harnesses), Laguna-XS-2.1 (broken on Metal in llama.cpp, #30896).

## 4. Serving

| | Use | Why |
|---|---|---|
| **llama-server** (Homebrew build 9140, already installed) | primary | explicit `-c`, `/props` reports the real context, per-response timings and cached-token counts, JSON-schema output, flash attention (3× faster generation at 32k, measured) |
| Ollama | supported | wraps llama-server since 0.40, but needs `OLLAMA_CONTEXT_LENGTH` set; slower than raw llama-server at depth (25 vs 36 tok/s at ~16k, measured) |
| MLX / LM Studio | supported as plain OpenAI endpoints | faster on the hybrid Qwen models, but no structured output in `mlx_lm.server`, `max_tokens` defaults to 512, Qwen3.5 prompt-cache bug (#903) |
| vLLM on a rented GPU | later | same client, `--tool-call-parser qwen3_coder` |

Build 9140 can't load current Qwen3.6 GGUFs. They include the multi-token-prediction layer, which llama.cpp supports from b9180, and loading fails with `missing tensor 'blk.40.ssm_conv1d.weight'`. Qwen3.6 runs here on the official b11850 release; 9140 stays in place for the Qwen3-Coder baselines.

## 5. What to expect from local quality

- On a neutral harness (mini-SWE-agent, SWE-bench Verified), the 24B class scores 56.4 against 71–77 for Claude Sonnet/Opus 4.5. Qwen3.6-35B-A3B's 64–70 comes from other people's harnesses, not a neutral one.
- Vendor scores use BF16 weights, 200k+ context, temperature 1.0 and multi-hour timeouts. Here we run Q4, 32–64k, minutes per task. Qwen recommends ≥128k context to keep thinking quality. Expect our numbers to land below theirs.
- Realistic target: scoped single-repo tasks (find, edit, run tests, iterate) succeed often; long multi-file refactors fail more. On Qwen3.6-35B-A3B a turn should take ~30–45 s, so a 20-step task takes 10–15 minutes.
- The eval in the plan separates "the model can't" from "the harness didn't" by running the same tasks with a frontier model through the same harness.

## 6. Eval results: Qwen3-Coder-30B-A3B

2026-11-06. Tasks 1–6 (`eval/tasks/`), three runs each, Qwen3-Coder-30B-A3B Q4_K_M on llama-server b9140 with a 64k context and a 20-minute limit per run. heyho stops at 40 steps; Pi has no step limit. Pi ran without this machine's skills (`--no-skills`). No run overlapped a system sleep.

| Task | heyho 9cb13b9 | heyho d00c370 | Pi |
|---|---|---|---|
| 01 date bug | 1/3 | 0/3 | 2/3 |
| 02 cross-file bug | 2/3 | 1/3 | 1/3 |
| 03 CLI option | 2/3 | 3/3 | 0/3 |
| 04 validation feature | 0/3 | 0/3 | 0/3 |
| 05 rename | 0/3 | 0/3 | 1/3 |
| 06 extract helper | 3/3 | 2/3 | 3/3 |
| **Total** | **8/18** | **6/18** | **7/18** |

- The harnesses are level on pass rate. At this pass rate the standard deviation of an 18-run total is about 2. Pooled, heyho passes 14/36 and Pi 7/18 (39% each).
- heyho d00c370 and Pi ran back to back on the same server: 71.6 against 117.2 minutes in total, median run 153 against 319 s. Step counts and the mix of tool calls were similar; Pi's runs generated about twice as many tokens (median 8.2k against 4.4k).
- Every failure traced is a model mistake that also occurs under the other harness. 04 misses the same spec rules each time (0/12 across four eval sets, including the first Pi baseline). 05 also renames `parse_qty_range`, though the task says only one function changes. 01 applies the offset's sign to the hours only. 02 misallocates a fixed discount. 03 fails the rule that the `--since` cutoff comes from the newest entry of any level (all three Pi runs, one of six heyho runs).
- The 40-step limit stopped 3 heyho runs, all failing. The 4 Pi runs that went past 40 steps also failed.
- A first Pi baseline loaded 105 skills from this machine, about 19k extra tokens per request, and ran much slower. Two of its runs on 05 ended when the model wrote a tool call as plain text. Without the skills that didn't happen. heyho has run such calls since cb59b6c; the recovery fired 0 times in the d00c370 runs.
- On this model the pass rate is limited by the model, so three runs per task can't show the effect of harness changes. The next comparison is across models.

## 7. Eval results: Qwen3.6-35B-A3B

2026-11-06. The same six tasks, three runs each, through heyho 6500b41 (the same `src/` as d00c370). The `qwen3.6` profile: Q4_K_M, sampling from the model card, thinking on (the model's default), earlier thinking not sent back. llama-server b11850 with a 64k context. The Mac ran on battery throughout and went to sleep at 1% charge during the last run, which is invalid.

| Task | Qwen3-Coder (both heyho evals) | Qwen3.6 |
|---|---|---|
| 01 date bug | 1/6 | 3/3 |
| 02 cross-file bug | 3/6 | 0/3 |
| 03 CLI option | 5/6 | 3/3 |
| 04 validation feature | 0/6 | 2/3 |
| 05 rename | 0/6 | 2/2 |
| 06 extract helper | 5/6 | 3/3 |
| **Total** | **14/36 (39%)** | **13/17 (76%)** |

- Through the same harness, Qwen3.6 about doubles the pass rate. It passed 04 and 05, which Qwen3-Coder never did, and fixed 01 in 7–9 steps each time.
- It took fewer steps (median 11 against 32) and generated about as many tokens, thinking included (median 4.4k). The median run took 161 s.
- 02 failed all three runs the same way. The model changed `Math.round` to `Math.floor` in `allocate` and kept the loop that gives spare cents to the first shares. That passes the reported test but breaks the contract in the doc comment directly above the function: spare cents go to the largest fractional parts, and a zero weight gets zero. Each run stopped after 8–11 steps.
- 04 run 2 missed spec rules 5, 7 and 8.
- Cache reuse after the first turn was lower than with Qwen3-Coder (median 0.87 against 0.97). The cause hasn't been measured.
- The step and time limits stopped no valid run.
