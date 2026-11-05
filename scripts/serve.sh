#!/usr/bin/env bash
# Start llama-server with the settings heyho expects: explicit context, flash attention,
# chat template from the GGUF (--jinja, needed for tool calls), host-memory prompt cache, and
# one slot so a single conversation owns the whole KV cache (the default runs 4 slots sharing it).
# Usage: scripts/serve.sh <path-to-gguf> [port]
set -euo pipefail
gguf="${1:?usage: scripts/serve.sh <path-to-gguf> [port]}"
port="${2:-8080}"
bin="$(command -v llama-server || echo "$(brew --prefix llama.cpp 2>/dev/null)/bin/llama-server")"
exec "$bin" -m "$gguf" -c "${HEYHO_CTX:-65536}" -fa on --jinja -cram 2048 -np 1 --port "$port" --host 127.0.0.1
