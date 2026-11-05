# Cline

Source study, 2026-11-05. Code read, not run.

- HEAD `cline/cline@d3ecc4890e8f9bcb77182b96c77fa90575e8e145` (2026-11-04): SDK monorepo `sdk/packages/{shared,llms,agents,core}`, CLI `apps/cli` v3.0.74, VS Code `apps/vscode` v4.1.26.
- Legacy tag `v3.89.2` (`e1bdeeff`), the last classic release. Legacy paths are relative to `apps/vscode/src/`.

## Cline was rewritten
4.x replaced the classic loop with a shared TypeScript SDK (CHANGELOG.md:604-641). Gone at HEAD: `recursivelyMakeClineRequests`, XML tool parsing, `replace_in_file`, `attempt_completion`, and the compact-prompt setting (`apps/vscode/proto/cline/state.proto:115`). Old→new names (`runtime-builder.ts:105-117`): `replace_in_file→editor`, `execute_command→run_commands`, `attempt_completion→submit_and_exit`, `read_file→read_files`.

## Loop (HEAD)
`sdk/packages/agents/src/agent-runtime.ts:849-1040`: `while` loop with optional `maxIterations`. Model call → extract tool calls → none = run completed (`:962-981`) → else execute, append, loop. A tool with `lifecycle.completesRun` (`submit_and_exit`) ends the run. Multiple tool calls per message; sequential by default (`:629`), adjacent `parallel` tools via `Promise.all` (`:2380-2406`).

Mistake tracker (`core/src/runtime/safety/mistake-tracker.ts`): limit 6; a turn is a mistake only if ≥1 tool failed and none succeeded; any success resets (`session-runtime-orchestrator.ts:1415-1436`). At the limit: "Stopped after N/M consecutive mistakes… Session state was preserved. Send a new prompt to resume…".

Loop detection (`core/src/runtime/safety/loop-detection.ts:113-156`): identical consecutive calls (name + key-sorted JSON). At 3: "...consider trying a different approach." At 5: forces the mistake limit.

Legacy: one tool per message; after the first tool the stream is cut and "[Response interrupted by a tool use result. Only one tool may be used at a time...]" is appended (`core/task/index.ts:2985-2989`). Text-only reply → `noToolsUsed` nudge, mistake count +1; limit 3.

## Tool calling
HEAD: native function calling only, via Vercel AI SDK `streamText` (`llms/src/providers/ai-sdk.ts:2421-2432`); no text fallback. Malformed JSON args repaired with jsonrepair through `experimental_repairToolCall` (`ai-sdk.ts:925-959`; comment: "truncated payloads, single quotes, unescaped newlines — common with weaker models"). Lenient input schemas: `read_files` accepts `files`, `file_paths`, `paths`, a string or an array (`core/src/extensions/tools/definitions.ts:287-318`).

Legacy: XML tags in text, parsed from the stream (`core/assistant-message/parse-assistant-message.ts`); unclosed blocks marked `partial` and not executed; native tools only for model variants labelled for it.

## Tools (HEAD, `core/src/extensions/tools/presets.ts:25-110`)
act: `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `editor`, `skills`, `ask_question`. plan: same without `editor`. yolo: `read_files`, `run_commands`, `editor`, `submit_and_exit`. GPT/Codex models get `apply_patch` instead of `editor`. The CLI (non-yolo) adds `spawn_agent`, `ux_verifier` and ~18 `team_*` tools.

`read_files`: 2,000 lines / ~48k chars per read; long files report total line count; page with start_line/end_line.

`editor` (`executors/editor.ts:162-192`): exact substring after EOL normalization, must occur once. Errors: `No replacement performed: text not found in <path>.` / `...multiple occurrences of text found in <path>.` Success returns a line diff capped at 200 lines. Optional `insert_line`.

`run_commands`: output beyond ~48k chars middle-truncated; advises piping through grep/head/tail; long-running commands → background + tmp file.

Legacy `replace_in_file` matching (`core/assistant-message/diff.ts:350-378`): exact from last position → line-trimmed fallback (`:51`) → block-anchor (first/last line, ≥3 lines, `:132`) → whole-file exact. On failure `diffError` (`core/prompts/responses.ts:300-305`) **echoed the entire file back** and suggested `write_to_file` after 3 failures.

## System prompt size
| Prompt | Chars | ~Tokens |
|---|---|---|
| HEAD act | 4,257 | 1.06k |
| HEAD plan | 6,018 | 1.5k |
| HEAD act tool schemas (7 tools, estimate from string literals) | ~7–9k | ~2k |
| Legacy generic XML (default for Qwen on Ollama/LM Studio) | 57,245 | 14.3k |
| Legacy "xs" compact (LM Studio qwen3_coder) | 5,851 | 1.46k |
| Legacy native next-gen (Claude 4.5) | 12,658 + 28,614 tool JSON | ~10k |

Legacy generic breakdown: tool definitions + examples 30,080; RULES 9,999; CAPABILITIES 4,806; EDITING FILES 4,673. Legacy also injected `<environment_details>` every turn (file list up to 200 files on turn 1, context usage, mode). HEAD does not.

## Context management
HEAD:
- Auto-compaction at 90% of max input, target 70% (`core/src/extensions/context/compaction-shared.ts:15-29`). Default `agentic` (LLM summary, ≤8,192 output tokens), fallback `basic` (truncate tool results/file contents to 2,000 chars). Skipped entirely if the context limit is unknown (`compaction.ts:330-335`). If the provider's real token count exceeds the estimate, the budget is scaled down (`:337-361`).
- Message builder (`core/src/session/services/message-builder.ts`): tool results capped at 8,000 chars (middle-truncated), full result saved to a temp URI with "Use read_files with specific line ranges" (`:281-295`). Older reads of the same file replaced by `[outdated - see the latest file content]`, only in batches once ≥64KB is reclaimable, to keep the provider prefix cache valid.

Legacy: truncation threshold = window − 27k for 64k models; first tried de-duplicating file reads; truncation kept the first user/assistant pair and dropped half (or three quarters) of the rest (`ContextManager.ts:248-340`).

## Plan vs act (HEAD)
Plan = same tools minus `editor`, plus ~1.8k chars of plan rules appended to the system prompt (`cline.ts:188-198`) — which changes the prefix on a mode switch. `run_commands` stays, guarded by a blacklist (`rm`, `mv`, `sed -i`, redirection…) (`core/src/extensions/tools/command-guard.ts`).

## Error recovery (HEAD)
- Transient provider errors: 3 retries, 1 s → 15 s backoff (`agent-runtime.ts:87-91`).
- Empty/dropped streams retried before any output (`llms/src/providers/middleware/retry-empty-response.ts`, "first observed on local backends (Ollama especially)").
- Output-token cut-off: up to 3 retries with "Your previous response was cut off because it reached the model's output-token limit before finishing. Keep responses concise: take one small step at a time..." (`agent-runtime.ts:72-75`).
- Text-only reply in act mode ends the run (no nudge turn).

## Safety
HEAD: CLI auto-approves all tools by default (`apps/cli/src/main.ts:885-894`); VS Code prompts. No command allow list at HEAD. Checkpoints: `git stash create` per user turn under `refs/cline/checkpoints/<session>/<n>`; restore = `git reset --hard` + apply stash, refused if HEAD moved (`core/src/session/checkpoint-restore.ts:376-420`). None outside git repos. Legacy used a separate shadow git repo per workspace.

## Local models
HEAD Ollama provider uses native `/api/chat` because "/v1/chat/completions ... ignores Ollama's proprietary `options.num_ctx` field" (`llms/src/providers/vendors/ollama.ts:1-10`); default `num_ctx` 32768; first-token timeout 5 minutes for cold loads. No context-length detection from the server.

Recurring issues:
- Tool-call JSON returned as plain text instead of `tool_calls`: #14453 (Ollama + Qwen2.5-Coder), #15255, #10843 (Qwen loops emitting raw JSON), #12979 (`<|tool_…|>` markers).
- Removing compact/XML modes broke working local setups: #13008 (Qwen3.6-35B-A3B on Ollama).
- Malformed/fragmentary args: #14827 (llama.cpp + Qwen3.6-35B-A3B sends `{"commands":[]}`, loop detector aborts), #15483 (bare "Invalid input" hides which key was wrong).
- Wrong context size: #13457, #14812.
- Timeouts during long prefill: #13843 (30 s cut-off), #9328, #15275, #15512.

## Takeaways for heyho
1. A ~1k-token system prompt with usage rules inside tool descriptions is enough (HEAD). Legacy spent 22% of a 64k window before any work.
2. Native tool calls plus a text fallback that detects `{"name":…,"arguments":…}`, `<tool_call>` and XML-shaped calls in content — the top local complaint is tool calls arriving as text.
3. jsonrepair on arguments, alias keys, and validation errors that name the bad key.
4. Edit: exact unique match with EOL normalization + line-trimmed fallback. Never echo the whole file on failure; return the closest lines.
5. Recovery counters: mistake = all tools in a turn failed; identical-call warn at 3, stop at 5; 3 retries with a "be concise" nudge on output cut-off; retry empty streams.
6. Set the context size yourself and read it back; don't skip compaction when it's unknown.
7. Cap tool results (4–8k chars at 64k) and write full output to a temp file the model can page through. Replace stale reads in batches to keep the KV prefix.
8. Deterministic compaction first (dedupe reads, drop old turns keeping the first exchange); an LLM summary costs a full extra prefill locally. Keep the system prompt identical across modes; carry the mode in the user message.
9. Long first-token timeout (minutes) for cold loads and big prefills.
10. Read-only auto-approve + command blacklist in plan mode; git-stash checkpoints that refuse to restore when HEAD moved.
