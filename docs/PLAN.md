# heyho — architecture and build plan

Status: **approved 2026-11-05; M1 in progress.** Evidence for each decision is in [RESEARCH.md](RESEARCH.md).

## Goal

A terminal coding agent that reads a codebase, edits files, runs commands and tests, observes results and loops until done, using an open-weight model served on this Mac through any OpenAI-compatible endpoint. No cloud dependency in the core loop.

It is meant to be used daily on real work and published: public MIT repo from day one, eval results published after M2.

## Decisions

### Language: TypeScript, Node-compatible, developed on Bun
- The two harnesses closest to the goal are TypeScript: Pi (4 tools, ~1k-token budget, top group on Terminal-Bench 2.0) and OpenCode. Their source is our reference.
- MCP's reference SDK is TypeScript.
- Source uses only Node APIs (`node:child_process`, `node:fs`, `fetch`), no `Bun.*`, so the published package runs with `npx heyho` on Node ≥ 22.18. Bun is used for development, tests (`bun test`) and single-file binaries (`bun build --compile`).
- Runner-up: Python (Aider, mini-swe-agent and Mini Harness are Python; tree-sitter bindings are mature). Go and Rust would be slower to iterate on at 10–15 hours a week.

### Dependencies
Model client written on `fetch` + an SSE parser (~120 lines), not an SDK, so we control the exact bytes sent (prefix stability) and can read llama-server's `timings` and cached-token fields. Planned runtime deps: `jsonrepair` (M1), `web-tree-sitter` + grammars (M2), `@modelcontextprotocol/sdk` (M3), a TUI library (M3).

### Serving
- Primary: llama-server. It loads any GGUF file by path, including the blobs Ollama already stored, so no model is kept twice on disk. Launched by a script in the repo:
  `llama-server -m <gguf> -c 65536 -fa on --jinja -cram 2048 -np 1 --port 8080`
- Supported: Ollama (requires `OLLAMA_CONTEXT_LENGTH=65536`; heyho reads the context Ollama loaded and warns above 131k), LM Studio, mlx_lm.server, vLLM. heyho always sends `max_tokens`.
- At startup heyho reads the real context size (llama-server `/props`, Ollama `/api/ps`) and uses that number, never a default. For other servers it refuses to start until `HEYHO_CTX` is set.

### Models
- Development baseline (installed now): `qwen3-coder:30b`, served by llama-server from Ollama's blob file.
- Target: Qwen3.6-35B-A3B Q4_K_M (22.3 GB download). A/B: KAT-Coder-V2.5-Dev (fine-tune of the same base). Slow option for hard tasks: Qwen3.8-27B (17.4 GB), not downloaded.
- Config is a model profile: base URL, model name, sampling parameters from the model card, thinking level, whether to send prior reasoning back, context soft limit.
- Qwen3.6 thinking level (off / low / default) is chosen by the eval in M2, scored on pass rate and wall time together.

## Architecture

```
src/
  cli.ts          heyho "task" (headless) · heyho (interactive line mode in M1, TUI in M3)
  model.ts        OpenAI-compatible client: streaming, tool-call assembly, usage/timings,
                  backend probe, retries, long first-token timeout
  loop.ts         the agent loop
  prompt.ts       system prompt (≤600 tokens)
  context.ts      fixed prefix, token accounting, compaction
  tools/          read · edit · write · bash · search  (+ symbols in M2)
  recover.ts      argument repair, text tool-call parser, loop guard, mistake counter
  permissions.ts  modes, path confinement, command rules
  sandbox.ts      macOS Seatbelt profile for bash
  session.ts      JSONL transcript (M1), resume (M3)
eval/
  run.ts          eval runner
  tasks/<id>/     task.md · repo/ · hidden/ · verify.sh · meta.json
  private/        tasks 7–8, mined from private repos; gitignored, never sent to a hosted model
```

heyho's own files (transcripts, full tool output logs) live in `~/.heyho/projects/<hash of workspace path>/`, never in the user's repo. The `read` tool may read that directory so the model can page through saved output.

### Agent loop

```
messages = [system(fixed prefix), user(task)]
for step in 1..maxSteps:
  reply = model.chat(messages, tools)                 # streamed
  calls = reply.tool_calls or parse_text_calls(reply.content)
  messages.append(reply exactly as returned)
  if reply was cut off by the output limit: answer each call "not executed, take a smaller step"; continue
  if no calls:
    if goal mode and verify command fails and attempts < 3: append verify output; continue
    done
  for call in calls:                                  # sequential
    result = repair → validate → permission → run → cap output
    messages.append(result)                           # every call gets exactly one result
  loop_guard(calls); mistake_counter(results)
  if context over soft limit: compact()
at maxSteps: append "step limit reached; summarize state", tool_choice = none (tools stay defined)
```

Plan-act-observe without a separate planner model: the prompt asks for a short plan before the first action; whether a `todo` tool helps the local model is decided by the eval (M2).

### Tools (5 in M1, 6 in M2; prompt + schemas ≤1,500 tokens, enforced by a test that measures it against the server)

| Tool | Behaviour |
|---|---|
| `read(path, offset?, limit?)` | `N: line` numbering; default 250 lines, max 12 KB; footer says total lines and the next offset. M2: on a large file with no offset, prepend a tree-sitter outline (symbols with line numbers) |
| `edit(path, old_string, new_string, replace_all?)` | key names match Claude Code and Qwen Code, the scaffolds Qwen models are trained on; other common names (`file_path`, `oldString`, `old_str`…) are accepted as aliases. Exact match → unicode quote/dash/space normalization → trailing-whitespace-insensitive. Must be unique unless `replace_all`. A file read earlier in the session must be unchanged on disk since; an unread file can be edited, since `old_string` must match it exactly (the eval showed qwen3-coder ignoring a read-first refusal until the mistake counter stopped it). Failure returns the closest 12 numbered lines or "already applied". Success returns a short diff. M2: tree-sitter syntax check, reporting only parse errors the edit introduced |
| `write(path, content)` | create; overwriting an existing file requires a prior read |
| `bash(command, timeout?)` | fresh shell per call in the workspace root, `PAGER=cat`, `CI=1`; process group killed at timeout (default 120 s); output head 4 KB + tail 4 KB, full log saved to `~/.heyho/projects/<hash>/out/<n>.log`; exit code in the header |
| `search(pattern?, glob?, path?)` | ripgrep if on PATH, else `git grep --untracked`, else `grep -r`; .gitignore-aware; 50 matches, 200 chars per line; glob only → file list |
| `symbols(name? \| path?)` (M2) | path → outline; name → definitions across the repo, from the same tree-sitter index as the repo map. LSP-backed references and diagnostics are optional in M3 |

Every error message says what to do next. All file tools resolve real paths and refuse anything outside the workspace.

### Context strategy (64k allocated, compaction from 32k)
- **Fixed prefix, ~3k tokens, built once per session:** system prompt, tool schemas, one environment line (cwd, OS, date, git branch), AGENTS.md (capped at 1k tokens), repo map (M2, ≤1.5k tokens, frozen for the session).
- **Append-only.** Only `compact()` may change earlier messages. A test asserts the prefix bytes are identical across turns.
- **Per-turn numbers from the server:** prompt tokens, cached tokens, prefill time, generation speed. Shown in the status line and `/context`. Cache hit rate is a tracked metric; a drop means we broke the prefix or hit llama.cpp #30357.
- **Soft limit** (default 32k, set per model profile from measured turn latency) triggers compaction. **Hard limit** is 85% of the server's real context.
- **Compaction:** (1) replace tool results older than the last few turns with one-line stubs and drop superseded reads; (2) only if still over target, summarize the older half with an LLM using OpenCode's template (objective, decisions, work state, files, next step), keep the newest ~25% verbatim, reject empty summaries. One deliberate cache miss per compaction; its cost is reported.
- **Reasoning text:** sending prior-turn reasoning back is a per-profile setting, chosen by measuring cache hit rate on Qwen3.6.

### Error recovery
- Malformed arguments: jsonrepair, then key aliases (`file_path`→`path`, `cmd`→`command`), then an error naming the bad key with an excerpt. Never execute a malformed call.
- Tool calls found in message text (`<tool_call>`, `<function=…>`, `{"name":…,"arguments":…}`) are parsed and run, and counted as a metric.
- Output cut off at the token limit: partial calls are not executed; nudge to take a smaller step; stop after 2 in a row.
- Identical call (name + sorted args), counted only when back to back: warning at 3, stop at 5. Re-running the same test between edits is normal, so calls with others in between don't count.
- Mistake counter: a turn where every call failed; stop (or ask, when interactive) at 6.
- Step cap: 40 headless, with a text-only wrap-up turn.
- Server: retry dropped connections, streams that break or stall for 2 minutes, and empty streams 3× with backoff; 10-minute first-token timeout for cold loads and long prefills, not retried; detect llama.cpp and Ollama context-overflow errors, compact and retry once.
- Ctrl-C: pending calls get "interrupted" results so the transcript stays valid.

### Permissions and sandbox
- **Modes:**
  - `ask` (interactive default): edit, write and bash prompt for approval; reads and searches don't; "always allow" applies per command prefix for the session.
  - `auto`: edits run unprompted; bash runs inside the sandbox; commands on the confirm list still prompt.
  - `yolo`: headless and eval only, everything inside the sandbox.
- **Seatbelt profile** for bash in `auto` and `yolo`: writes allowed only to the workspace, this user's temp and cache folders (`/var/folders/…`, `/private/tmp`) and package caches (`~/.npm`, `~/.bun`, `~/.cache`, `~/Library/Caches`). Network on by default, `--no-net` to turn it off.
- **Confirm list** (prompts even in `auto`): `sudo`, `git push`, `git reset --hard`, `curl … | sh`. This is a convenience; the sandbox is the actual boundary.
- **Checkpoints (M2):** `git stash create` + a private ref before each turn that edits; `/undo` restores and refuses if HEAD moved. In a non-git directory heyho warns and offers `git init`.

## Evaluation

**Tasks** (`eval/tasks/<id>/`): the task prompt, a repo snapshot, hidden tests copied in only at verification, `verify.sh`, and metadata.

| # | Category | Task |
|---|---|---|
| 1 | bug fix, Python | wrong date parsing in a small library |
| 2 | bug fix, TypeScript | failing test points at the caller; the cause is in another file, so it needs search |
| 3 | feature, Python | add an option to a small CLI |
| 4 | feature, TypeScript | add a function with validation |
| 5 | refactor, Python | rename a function used across 6 files; tests pass and the old name is gone |
| 6 | refactor, TypeScript | extract duplicated logic into a helper without changing behaviour |
| 7–8 | real bug fix | revert the source part of a real fix commit from one of Ega's private repos; the commit's own test is the hidden test. Kept in `eval/private/`, run locally only |

**Runner:** `bun eval/run.ts --profile <model> --tasks smoke|all --runs N`
1. Copy the task to a temp directory, `git init`.
2. Run `heyho --yolo "<task>"` with a step cap and a 20-minute wall limit.
3. Copy in the hidden tests and run `verify.sh`.
4. Record per run: pass, steps, tool calls by type, tool errors, recovered text calls, failed edits, compactions, prompt / cached / generated tokens, wall time.
5. Print a table compared with the previous run.

Smoke = 3 tasks × 1 run (~15–20 min); full = 8 tasks × 3 runs (overnight).

**Telling model limits from harness limits:**
- **Baseline A:** the same local model through Pi on the same tasks. heyho should match or beat it.
- **Baseline B:** tasks 1–6 through heyho on OpenRouter with `anthropic/claude-sonnet-5.5` (upper bound) and `qwen/qwen3.6-35b-a3b` (same model at full precision and fast hardware, to separate quantization and speed from model limits). A task the frontier model passes and the local model fails is a model limit; a task both fail points at the harness or the task.
- Every eval summary assigns each failure to one of those causes, from the transcripts.
- Temperature from the model card; 3 runs; differences under one task are reported as noise.

## Milestones

| | Scope | Done when |
|---|---|---|
| **M1 — minimal loop** | model client + backend probe, loop, 5 tools, fixed append-only prefix, output caps, path confinement, `ask` mode, interactive line mode, headless mode, Seatbelt sandbox for `--yolo` (moved up from M2 because the eval runs unattended), step cap and identical-call guard, JSONL transcript, prefix-size test, eval runner with tasks 1–6, baseline A (Pi) | smoke eval runs end to end on `qwen3-coder:30b`; prefix ≤1.5k tokens measured; ≥90% of prompt tokens cached on turns after the first |
| **M2 — agentic loop** | full error-recovery set, text tool-call fallback, goal mode with auto-detected test command, compaction, `auto` mode, git checkpoints + `/undo`, repo map + `symbols` + outline on large reads, syntax check after edit, tasks 7–8, baseline B. Experiments: native edit vs SEARCH/REPLACE; todo tool on/off; Qwen3.6 thinking level; Qwen3.6-35B-A3B vs Qwen3-Coder-30B vs KAT | full eval with both baselines; each feature stays only if the score doesn't drop; results published |
| **M3 — polish** | TUI (streaming, diffs, approvals, status line with tokens, cache hits and latency), session save and resume, config file, MCP client (stdio; tool schemas loaded only when used, to protect the budget), optional LSP tool | a week of daily use on a real repo; eval doesn't regress |

**Time:** at 10–15 hours a week, with Claude writing most of the code: M1 about 1 week, M2 about 2 weeks, M3 2–3 weeks. That is 5–6 weeks in total. M1 alone is usable for single-step tasks.

**M2 gate:** the M2 results are published whatever they show. M3 starts only if heyho matches or beats Pi on the local model and was used for at least 3 real tasks in the week after M2.

**Publishing:** after M2, a free results post (r/LocalLLaMA, Hacker News, X) and a paid step-by-step build guide. Where the guide is sold is decided at M2.

**Not in v1:** subagents, web search, skills, multi-model routing, image input, Linux/Windows sandboxing.

## Decisions made by Ega (2026-11-05)
1. Purpose: daily driver and public project.
2. Language: TypeScript with Node-compatible APIs; Bun for development, tests and binaries; distributed with `npx heyho`.
3. Server: llama-server primary, reading GGUF files in place.
4. Model: Qwen3.6-35B-A3B Q4_K_M (bartowski, 22.29 GB) downloading to `~/models/gguf/`. Qwen3-Coder-30B as the development baseline. Thinking level decided by eval.
5. Tools: five (read, edit, write, bash, search); native tool calls plus a text fallback parser.
6. Context: 64k allocated, compaction from a 32k soft limit set per model.
7. Retrieval: tree-sitter in M2; LSP as an optional M3 tool, kept only if the eval shows a gain.
8. Safety: `ask` by default; Seatbelt sandbox for bash in `auto` and `yolo`; network on, `--no-net` to turn it off.
9. State: `~/.heyho/projects/<hash>/`.
10. Eval built in M1. Baseline A: Pi. Baseline B: OpenRouter, Sonnet 5.5 and hosted Qwen3.6, tasks 1–6 only; needs `OPENROUTER_API_KEY` in the shell profile before M2. Tasks 7–8 mined from private repos, run locally only.
11. M1 includes an interactive line mode; the TUI waits for M3.
12. Repo: `github.com/muhammadegaa/heyho`, public, MIT. Commits use the GitHub noreply address.
13. heyho is the one active bet until the M2 publish.
