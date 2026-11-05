# heyho

A terminal coding agent for open-weight models running on your own machine. It reads a codebase, edits files, runs commands and tests, reads the results and keeps going until the task is done. It talks to any OpenAI-compatible server (llama.cpp's `llama-server`, Ollama, LM Studio, MLX, vLLM); nothing in the loop calls a cloud service.

**Status:** pre-alpha. Milestone 1 (minimal loop + eval harness) is in progress. Not usable yet.

Built and measured on a MacBook Pro M1 Max with 64 GB, targeting Qwen3.6-35B-A3B at Q4 with a 64k context.

## Planned design

- At most 1.5k tokens of fixed prompt and tool schemas, so most of a 64k window is left for the code.
- Append-only conversation, so llama.cpp reuses its prompt cache: on this machine an unchanged 23k-token prefix costs 0.6 s per turn instead of 155 s.
- Five tools: `read`, `edit`, `write`, `bash`, `search`.
- Recovers tool calls that local models write as plain text, repairs malformed JSON arguments, and stops repeated identical calls.
- `bash` runs inside a macOS Seatbelt sandbox in unattended modes.
- An eval suite runs the same tasks through heyho, through another harness on the same model, and through a hosted frontier model, so a failure can be traced to the model or to the harness.

## Docs

- [docs/PLAN.md](docs/PLAN.md): architecture, agent loop, tools, context strategy, eval design, milestones
- [docs/RESEARCH.md](docs/RESEARCH.md): how Pi, OpenCode, Cline, Aider and mini-swe-agent work, which local models fit, and benchmarks measured on this machine

## License

MIT
