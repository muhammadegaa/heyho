# OpenCode, Pi, Serena

Source study, 2026-11-05. Sparse shallow clones, code read, not run. Sizes are character counts of description strings (JSON wrapping adds ~100–200 chars per tool); tokens = chars/4.

- OpenCode: `sst/opencode` → `anomalyco/opencode`, branch `dev`, `893e8dc43f05e872d4cac603486ce8a7181170fa`, v2.2.5. Core rewritten on Effect; logic in `packages/core` and `packages/ai`. (OC = `opencode/packages/`)
- Pi: `badlogic/pi-mono` → `earendil-works/pi`, `ccff9876e7ca72fa6bcdd4820ef814831624601d`, v1.5.0. (PI = `pi-mono/packages/`)
- Serena: `ede329aaf0c824bea75455a2926f01420d7aa620`. (SE = `serena/src/serena/`)

## OpenCode

**Loop.** OC `core/src/session/runner/llm.ts:212-380`; one provider call `step.ts:71-295`. Native function calling through its own `@opencode/ai` layer; local providers via `openai-compatible` (`core/src/plugin/provider/local.ts:69`). Each tool starts in its own fiber as soon as its call event arrives (`step.ts:110-131`). Ends when `needsContinuation` is false. `steps` cap unset by default; when hit, appends "Tools are disabled… Respond with text only" and sets `toolChoice: "none"` while keeping tool definitions "to preserve the provider's cached prefix" (`llm.ts:252,267-271`). Two consecutive output-length stops fail the session (`llm.ts:40-41,339-369`). Abort: unsettled tools get "Tool execution interrupted"; every call ends with a result (`step.ts:60-61,152-154,227-236`).

**Tools.** read, edit, write, shell, grep, glob, todowrite, webfetch, websearch, question, skill, subagent, plus `execute` (JS "Code Mode" reaching secondary tools). GPT models get `patch`. `bash` aliased to `shell` (`plugin/tool-input-repair.ts:22-23`). Sizes: read ~660, edit ~1,170, write ~290, shell ~1,190, grep ~660, glob ~320; all direct tools ≈10k chars (~2.5k tokens).

**Edit** (`core/src/tool/plugin/edit.ts`): exact on LF-normalized text → typographic quotes/dashes/spaces normalized → line-by-line ignoring trailing whitespace (`:49-188`). Multiple matches fail unless `replaceAll` (`:335-339`). No read-before-edit rule. CRLF preserved per region. Per-file lock.

**Read**: default and max 2,000 lines, 50 KiB per page, long lines cut at 2,000 chars. Lines as `N: content`; ends `[Output truncated. Continue reading with offset: N]`. Missing file → "Did you mean" suggestions.

**System prompt.** Base `system.txt` 756 chars + per-tool guidance ≈1,470 chars + date/`<env>` ≈400 chars ≈ 470 tokens before AGENTS.md. Qwen gets the default. Instruction changes are appended as deltas ("Today's date is now: …").

**Compaction** (`core/src/session/compaction.ts`): trigger at window − max(15%, 16k) (≈48k on a 64k window); keeps newest 15,000 tokens verbatim. Summary template: Objective, Requirements, Decisions, Work State, Next Move, Relevant Files (≤15), Important Context; "terse single-line bullets", "fine to leave out information the next agent can recover from the code", "preserve exact paths, error strings". Overflow error → compact and retry at 85/70/50/35%. Tool output capped 2,000 lines / 50 KiB with full output to a file (`core/src/tool-output.ts`). No pruning pass for old tool results.

**Error text.**
- No match: `Could not find oldString in ${path}. It must match exactly, including whitespace and indentation.` + either `newString is already in the file, so this edit may already be applied.` or `The closest lines in the file:` with up to 12 numbered lines found by whitespace-insensitive line voting (`edit.ts:190-241`).
- Ambiguous: `Found ${n} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.`
- Malformed JSON: `The tool input could not be parsed as JSON, so the call was not executed. Reissue the call with valid JSON arguments.` + excerpt; separate message for args cut off by the output limit (`session/runner/publish-llm-event.ts:42-57`).
- Schema repair converts stringified scalars, drops nulls; then `Invalid arguments for tool "X":` + up to 5 issues + `Update the arguments and call the tool again.`
- No repeated-call detection (open issue #45442: subagent repeated identical calls ~50 minutes).
- API retries: exponential 2 s → 10 s cap, 10 retries, jitter.

**Permissions.** Rules (action, glob, allow/ask/deny), last match wins. Default `* * allow` (edits and shell run unprompted), `.env` reads ask. No OS sandbox.

**LSP.** None in v2.2.5: TODOs "Add LSP notification and diagnostics after LSP runtime exists" (`edit.ts:258`, `write.ts:38`).

**Local models.** Ollama discovery reads the trained `context_length`, not runtime `num_ctx` (`plugin/provider/ollama.ts:44-90`), so it can assume a larger window than the server runs. LM Studio uses the smallest loaded instance context. Open issues: #60202 (no `tool_choice:"auto"` → tool calls not parsed on vLLM gateways), #58019 (unanchored schema pattern → llama.cpp 400), #53202 (`/thinking high` breaks llama.cpp Qwen template), #60663 (empty compaction summary lost the objective on Ollama/Qwen), #61843 (tools sent to models without tool capability).

**Persistence/MCP.** Event-sourced SQLite (drizzle). MCP tools go through Code Mode by default.

## Pi

**Loop** (PI `agent/src/agent-loop.ts:172-330`): inner loop while tool calls or steering messages; ends with no tool calls and nothing queued. No step cap, no loop detection. Native calls; tools run after the message completes, parallel by default. Output-length stop: every call fails with `Tool call "X" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.` On replay, orphaned calls get a synthetic "No result provided" (`ai/src/api/transform-messages.ts:179-232`).

**Tools.** Default: read, bash, edit, write (`coding-agent/src/core/settings-manager.ts:85`). grep, find, ls opt-in. Sizes: read ~470, bash ~380, edit ~790, write ~200 → ≈1.85k chars (~460 tokens).

**Edit**: `edits[]` array, each matched against the original file, unique, non-overlapping. One fuzzy tier: NFKC, trailing whitespace, quotes/dashes/spaces normalized; unchanged lines keep original bytes. Argument repair for `edits` sent as a string, single object, or legacy top-level fields (`edit.ts:100-131`).

**Read**: 2,000 lines or 50 KB; raw content, no line numbers; ends `[Showing lines a-b of N. Use offset=M to continue.]`. bash keeps the last 2,000 lines / 50 KB, full output to temp file, no default timeout. grep: 100 matches, 500 chars per line.

**System prompt** ≈2.2k chars ≈ 560 tokens: preamble, `<tools>`, `<rules>`, `<docs>` (~1,260 chars of Pi's own docs), `<project_context>`, `<skills>`, `<cwd>`. Changes appended as later system messages.

**Compaction**: at window − 16,384 (≈47.6k on 64k), keeps ~20,000 recent tokens; chars/4 estimate. Template: Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context.

**Errors.** `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`; `Found ${n} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.` No closest-lines hint. Retries: 3, 2 s doubling, 60 s max.

**Permissions.** None; absolute paths accepted. No sandbox. **LSP**: none.

**Local models.** Built-in llama.cpp extension reads llama-server `/props` for runtime `n_ctx` (fallback `n_ctx_train`); requests constrained JSON-schema sampling. Open issues: #10885 (llama.cpp "Context size has been exceeded" not detected → compaction never triggers), #9216 (Ollama Qwen streams terminate), #9566 (defaults to 128k context).

**Persistence/MCP.** JSONL with id/parentId tree entries. MCP via codemode by default.

## Serena

Tools: get_symbols_overview, find_symbol (name-path patterns like `Class/method`, depth, include_body, kinds, max_matches), find_referencing_symbols, find_implementations, find_declaration, get_diagnostics_for_file, replace_symbol_body, insert_after/before_symbol, rename_symbol. Results are JSON symbol dicts; bodies only on request. Over budget (`max_answer_chars` default 150,000) it steps down: symbols → file→name-path map; references → without lines → per-file counts → "Found N references."; overview → depth 0 → kind counts (`repl/api/lsp_api.py:163-280`).

Diagnostics after edits exist but are disabled (`ENABLE_DIAGNOSTICS = False`) because edits often introduce diagnostics that later edits resolve (`tools/tools_base.py:438-444`).

Cost: 28 default tools, ≈19.2k chars (~4.8k tokens) of descriptions; `system_prompt.yml` 12.4k chars. Too heavy to load whole for a 64k local window.

## Verbatim schemas

OpenCode edit (`edit.ts:24-34`):
```ts
path: "File to edit"
oldString: "Exact text to find and replace"
newString: "Text to replace oldString with (must differ from oldString)"
replaceAll?: "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false."
```
> Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. … If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. …

OpenCode read (`read.ts:20-28`):
```ts
path: "File or directory to read"
offset?: "The line or directory entry to start reading from (1-based)"
limit?: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)"
```
> Read the contents of a file or directory. … Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. … Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.

Pi edit (`edit.ts:20-40`):
```ts
path: "Path to the file to edit (relative or absolute)"
edits: [{ oldText: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
          newText: "Replacement text for this targeted edit." }]
```

Pi read (`read.ts:14-18`): `path`, `offset?` (1-indexed), `limit?`.

## Takeaways for heyho
1. Pi's budget: 4 tools ≈1.85k chars + ≈2.2k-char prompt ≈ 1k tokens. Drop the `<docs>` section.
2. OpenCode's edit-miss hint ("already applied" or up to 12 closest numbered lines) saves a re-read.
3. Two fuzzy tiers only: unicode quotes/dashes/spaces, then trailing whitespace.
4. Flat edit schema (path, oldString, newString, replaceAll) plus argument repair; a 30B model gets the flat shape right more often than nested arrays.
5. Truncate tool output to a file with a marker, but at 8–12 KB / 200–400 lines, not 50 KB (≈12k tokens = a fifth of 64k). Keep `N: ` line prefixes on read.
6. Size compaction to the window; read the runtime context from llama-server `/props`, never Ollama's trained length; detect llama.cpp's overflow error string.
7. Append-only prefix; at max steps keep tools and set `tool_choice: none`; send instruction changes as appended deltas.
8. Add what neither has: identical-call guard and a step cap with a text-only wrap-up.
9. Never execute malformed calls; separate message for args cut off by the output limit; convert stringified scalars; alias `bash`→`shell`.
10. No LSP diagnostics in every edit result; offer on-demand symbol/diagnostic tools with Serena-style step-down output.
