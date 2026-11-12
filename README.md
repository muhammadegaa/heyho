# heyho

A terminal coding agent for open-weight models running on your own machine. It reads a codebase, edits files, runs commands and tests, reads the results and keeps going until the task is done. It talks to any OpenAI-compatible server (llama.cpp's `llama-server`, Ollama, LM Studio, MLX, vLLM); nothing in the loop calls a cloud service.

**Status:** pre-alpha. Milestone 1 (minimal loop + eval harness) is in progress. It completes small single-repo tasks; it is not ready for daily use.

## Try it (macOS, Bun)

```sh
git clone https://github.com/muhammadegaa/heyho && cd heyho && bun install
scripts/serve.sh path/to/model.gguf          # llama-server on :8080 with 64k context
bun src/cli.ts --cwd path/to/repo            # interactive; edits and commands ask first
bun src/cli.ts --cwd path/to/repo "fix the failing test"           # one task, then exit
bun src/cli.ts --cwd path/to/repo --yolo "fix the failing test"    # no prompts, bash sandboxed
```

`--profile` picks the model settings (`qwen3-coder`, `qwen3.6`, or hosted `or-sonnet` / `or-qwen3.6` via OpenRouter). `--base-url` points at any other OpenAI-compatible server. heyho reads the context size from llama-server and Ollama; for other servers, set `HEYHO_CTX` to the context size the server runs with.

In a session there is an input box at the bottom and the work scrolls above it. heyho shows what the model is doing while you wait, a numbered diff before every edit, and a menu to answer with one key: yes, yes and don't ask again, or say what to do instead. Shift+Tab switches between `ask`, `auto` (edits don't ask) and `plan` (read-only; it proposes a plan and asks before carrying it out). `/` opens the command menu, `@` completes file paths, `!` runs a shell command yourself. `/rewind` goes back to an earlier message and restores files, the conversation or both; `/resume` and `--continue` reopen earlier sessions. `--plain` gives a line-at-a-time session with no input box. `bun scripts/ui-demo.ts` plays a scripted session with no model, to see the screen.

The eval: `bun eval/run.ts --profile qwen3-coder --tasks smoke` (or `all`, or task ids; `--harness pi` runs the same tasks through Pi).

Built and measured on a MacBook Pro M1 Max with 64 GB, targeting Qwen3.6-35B-A3B at Q4 with a 64k context.

## Planned design

- At most 1.5k tokens of fixed prompt and tool schemas, so most of a 64k window is left for the code.
- Append-only conversation, so llama.cpp reuses its prompt cache: on this machine an unchanged 23k-token prefix costs 0.6 s per turn instead of 155 s.
- Five tools: `read`, `edit`, `write`, `bash`, `search`.
- Repairs malformed JSON arguments, runs tool calls that local models write as plain text, and stops repeated identical calls.
- `bash` runs inside a macOS Seatbelt sandbox in unattended modes.
- An eval suite runs the same tasks through heyho, through another harness on the same model, and through a hosted frontier model, so a failure can be traced to the model or to the harness.

## Docs

- [docs/PLAN.md](docs/PLAN.md): architecture, agent loop, tools, context strategy, eval design, milestones
- [docs/RESEARCH.md](docs/RESEARCH.md): how Pi, OpenCode, Cline, Aider and mini-swe-agent work, which local models fit, benchmarks measured on this machine, and eval results

## License

MIT
