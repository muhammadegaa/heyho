# Aider and mini-swe-agent

Source study, 2026-11-05. Code read, not run. Token figures are chars/4.

- Aider `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` (2026-05-22)
- mini-swe-agent `04d809ceab9df28f9adaed044884180159172930` (2026-09-03)

## Aider

### Loop
Not a tool-calling agent. One user turn, then up to 3 automatic follow-ups ("reflections"): `max_reflections = 3` (`aider/coders/base_coder.py:101`), reset each turn (`:866-867`).

Prompt order (`coders/chat_chunks.py:16-26`): system, few-shot examples, read-only files, repo map, summarized history, full contents of files in chat, current messages, final reminder. Most stable content first, which suits prefix caching.

After the reply: (1) offer to add mentioned files, reflect "I added these files…"; (2) `apply_updates` (`:2296-2335`) parses and applies edits, a malformed edit's `ValueError` becomes the reflection; (3) auto-commit; (4) auto-lint (on by default) → lint output reflected after confirmation; (5) auto-test (off by default) → `"I ran this command:\n\n{command}\n\nAnd got this output:\n\n{output}"` (`prompts.py:36-43`), sent untruncated (`commands.py:1036-1046`).

### Edit formats
`whole`, `diff` (SEARCH/REPLACE), `diff-fenced`, `udiff`, `udiff-simple`, `patch` (OpenAI V4A), `editor-diff`/`editor-whole`/`editor-diff-fenced` (short prompts), `architect`, `ask`, `context`, `help`, legacy `func`.

`diff` prompt size: `main_system` 2,212 chars, two few-shot examples 1,274, `system_reminder` 3,039. The reminder is sent twice (`base_coder.py:1261-1262` and `:1285-1330`). Fixed overhead ≈ 9.6k chars ≈ 2.4k tokens.

Core rules (`editblock_prompts.py:120-144`):
```
Every *SEARCH/REPLACE block* must use this format:
1. The *FULL* file path alone on a line, verbatim. ...
2. The opening fence and code language, eg: ```python
3. The start of search block: <<<<<<< SEARCH
4. A contiguous chunk of lines to search for in the existing source code
5. The dividing line: =======
6. The lines to replace into the source code
7. The end of the replace block: >>>>>>> REPLACE
8. The closing fence: ```
Every *SEARCH* section must *EXACTLY MATCH* the existing file content, character for character ...
*SEARCH/REPLACE* blocks will *only* replace the first match occurrence.
Keep *SEARCH/REPLACE* blocks concise. ...
```

Parsing is lenient (`editblock_coder.py:386-599`): markers 5–9 chars; filename found in the 3 lines before the block (exact → basename → difflib 0.8); missing filename inherits the previous block's.

Matching (`replace_most_similar_chunk`, `:157-187`): exact lines → leading-whitespace-insensitive with uniform indent offset (`:243-293`) → drop spurious leading blank line → `...` elision. The fuzzy SequenceMatcher path is dead code after a bare `return` (`:183-187`). A failed block is retried against other files in chat (`:58-65`).

Failure text (`:84-123`):
```
# 1 SEARCH/REPLACE block failed to match!

## SearchReplaceNoExactMatch: This SEARCH block failed to exactly match lines in {path}
<<<<<<< SEARCH
{original}=======
{updated}>>>>>>> REPLACE

Did you mean to match some of these actual lines from {path}?
{closest chunk, ratio ≥0.6, ±5 lines}

Are you sure you need this SEARCH/REPLACE block?
The REPLACE lines are already in {path}!

The SEARCH section must exactly match an existing block of lines including all white space, comments, indentation, docstrings, etc

# The other {n} SEARCH/REPLACE blocks were applied successfully.
Don't re-send them.
Just reply with fixed versions of the blocks above that failed to match.
```

### Per-model defaults
`model-settings.yml`: 357 entries, 289 `diff`. No entries for Devstral, gpt-oss, Qwen3-Coder or Qwen3-30B; an unknown local model gets `edit_format: "whole"` (`models.py:131`).

Leaderboard evidence (`website/_data/polyglot_leaderboard.yml`, `qwen3_leaderboard.yml`):

| Model | Format | Pass | Well-formed |
|---|---|---|---|
| Qwen2.5-Coder-32B | diff | 8.0% | 71.6% |
| Qwen2.5-Coder-32B | whole | 16.4% | 99.6% |
| Qwen3-32B (vLLM) | diff | 41.3% | 94.2% |
| Qwen3-32B (vLLM) | whole | 45.8% | 100% |

~30B models break SEARCH/REPLACE syntax more often; whole-file output scores higher for them, at a high output-token cost.

### Repo map (`aider/repomap.py`)
tree-sitter `.scm` queries for definitions and references; diskcache SQLite keyed by path+mtime (`:233-264`). `networkx.MultiDiGraph`, edge referencer→definer (`:463-513`); weights ×10 for identifiers mentioned in chat, ×10 for long (≥8 char) structured identifiers, ×0.1 for `_private`, ×0.1 for identifiers defined in >5 files, ×50 if the referencer is in chat, × sqrt(#refs). Personalized PageRank (`:374-445`, `:519-525`), rank spread over definitions (`:533-546`). Budget `max_input/8` clamped 1,024–4,096 (`models.py:782-789`); ×2 when no files are in chat (`args.py:263-267`). Binary search over tag count to within 15% of budget (`:676-704`). Output:
```
aider/coders/base_coder.py:
⋮...
│class Coder:
│    abs_fnames = None
⋮...
│    def run(self, with_message=None):
⋮...
```

### Context management
History summarized when it exceeds `max_input/16` clamped 1k–8k (`models.py:356-358`), in a background thread (`base_coder.py:1002-1046`), keeping a recent tail under half the budget (`history.py:33-96`). Prompt (`prompts.py:46-59`): "*Briefly* summarize… MUST include the function names… filenames… MUST NOT include fenced code… Start with 'I asked you…'". Files added to chat are re-sent in full every turn (`:637-657`).

### Architect/editor
Architect is an ask-coder; its reply goes to a fresh editor coder with no map and no history (`architect_coder.py:11-48`). Gains come mainly from pairing a reasoning model with a separate editor (QwQ-32B 20.9% → 26.2% with Qwen2.5-Coder editor; R1 56.9% → 64.0% with Sonnet). Same-model pairing: gpt-4o-mini +4.6 pts only. On one local machine it means two prefills per edit.

### Error recovery
Malformed edit / failed match → reflection. Lint: tree-sitter syntax + `compile()` + fatal-only flake8, formatted with `█` markers (`linter.py:82-254`). Context exceeded → no retry, advise /drop (`base_coder.py:1628-1679`). Transient API errors → exponential backoff to 60 s (`:1468-1490`).

### Local notes
Ollama: Aider sets `num_ctx = tokens*1.25 + 8192` per request (`models.py:1012-1014`). Measured (`_data/quant.yml`, Qwen2.5-Coder-32B): 71.4% at ≥8k context vs 51.9% at Ollama's old 2k default; Q4_K_M 66.9% vs fp16 71.4%.

## mini-swe-agent

### Loop (~100 lines, `src/minisweagent/agents/default.py`)
`run()` renders system+instance templates, calls `step()` until a message has role `exit` (`:88-124`). `step()` = `query()` (checks step/cost/time limits, `:130-152`) + `execute_actions()`. Each action runs in a fresh `subprocess` (`shell=True`, stderr merged), process group killed on timeout (`environments/local.py:24-92`); default timeout 30 s. History is linear, never trimmed; context overflow aborts (`models/litellm_model.py:50-57`). Model retries: 10 with backoff (`models/utils/retry.py:19-25`).

Stops: first output line `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` with exit 0 (`local.py:45-56`); limits; 3 consecutive format errors (`default.py:32`, `:100-112`). `mini.yaml` has no step limit, `cost_limit: 3` — never fires for a $0 local model.

v2 defaults to native tool calls with one `bash` tool (`models/utils/actions_toolcall.py:11-27`). Text mode remains (`mini_textbased.yaml`, regex ```` ```mswea_bash_command\s*\n(.*?)\n``` ````, exactly one block required).

### Prompt sizes (chars)
| Config | System | Instance | Observation | Format error |
|---|---|---|---|---|
| `mini.yaml` (tool calls) | 63 | 3,007 | 599 | 841 |
| `mini_textbased.yaml` | 545 | 2,438 | 961 | 966 |

Core instructions (`mini_textbased.yaml:2-40`):
```
Your response must contain exactly ONE bash code block with ONE command (or commands connected with && or ||).
Include a THOUGHT section before your command where you explain your reasoning process.
1. Analyze the codebase by finding and reading relevant files
2. Create a script to reproduce the issue
3. Edit the source code to resolve the issue
4. Verify your fix works by running your script again
5. Test edge cases to ensure your fix is robust
6. Submit your changes and finish your work by issuing: `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`.
3. Directory or environment variable changes are not persistent. Every action is executed in a new subshell.
```

### Truncation / errors
Output ≥10,000 chars → head 5,000 + tail 5,000 + elided count + "The output of your last command was too long. Please try a different command that produces less output…" (`mini_textbased.yaml:120-142`). Timeout → partial output, `returncode -1`. Separate message when `finish_reason=length`. Tool-mode errors: "No tool calls found in the response. Every response MUST include at least one tool call.", "Unknown tool '…'", "Missing 'command' argument in bash tool call." (`actions_toolcall.py:40-74`).

### Why bash-only; results
Shell can do anything; works with any model; linear history = trajectory; independent subprocesses avoid persistent-shell failure modes (`README.md:36-50`, `docs/faq.md:102-115`).

SWE-bench Verified, mini-tagged rows from swebench.com `data/leaderboards.json` (outside the repo):

| Model | Verified | mini version |
|---|---|---|
| Claude 4.5 Opus high | 76.8% | v2 |
| MiniMax M2.5 | 75.8% | v2 |
| GLM 5 | 72.8% | v2 |
| DeepSeek V3.2 | 70.0% | v2 |
| Devstral Small 2512 (24B) | 56.4% | v1.17.2, text format |
| Qwen3-Coder-480B | 55.4% | v1.0 |
| gpt-oss-120b | 26.0% | v1.7 |
| Qwen2.5-Coder-32B | 9.0% | v1.0 |

No row for Qwen3-Coder-30B-A3B.

## Takeaways for heyho
1. Code inside JSON tool-call strings scores lower even for strong models (`_data/code-in-json.yml`: Sonnet 3.5 60.5% markdown vs 54.1% JSON; DeepSeek Coder V2 60.6% vs 51.1%).
2. Aider's SEARCH/REPLACE parser and matcher are worth copying: lenient markers, filename recovery, exact then indent-tolerant match, "did you mean" lines, re-request only failed blocks. No automatic fuzzy apply.
3. Whole-file output as fallback for small files.
4. Don't keep whole files in context; repo map + line ranges.
5. Repo map with fixed 2–4k budget, frozen for the session so the prompt prefix stays cacheable.
6. Don't repeat the reminder; mini works with a 63-char system prompt.
7. mini's output handling: 5k head + 5k tail, kill process group on timeout, distinct `finish_reason=length` message, cap reflections and format errors at 3.
8. Cheap lint after every edit; feed back only marked context lines.
9. Set context size explicitly; never rely on server defaults.
10. Step limit, not cost limit.
