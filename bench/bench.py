import json, os, glob, time, random, subprocess, sys, urllib.request

BASE = "http://localhost:11434"
MODEL = sys.argv[1] if len(sys.argv) > 1 else "qwen3-coder:30b"
SRC = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("BENCH_SRC", ".")

def post(path, body, timeout=900):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())
    return out, time.time() - t

corpus = ""
for f in sorted(glob.glob(SRC + "/**/*.ts", recursive=True)):
    corpus += f"\n// FILE {f}\n" + open(f, errors="ignore").read()
print(f"corpus chars={len(corpus)}")

def chunk(chars):
    start = random.randint(0, max(0, len(corpus) - chars))
    return corpus[start:start + chars]

def ps():
    return subprocess.run(["ollama", "ps"], capture_output=True, text=True).stdout.strip().splitlines()[-1]

# 1. OpenAI-compatible endpoint: default context + tool calls
TOOLS = [
    {"type": "function", "function": {"name": "read", "description": "Read a file. Returns numbered lines.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}}, "required": ["path"]}}},
    {"type": "function", "function": {"name": "edit", "description": "Replace exact text in a file. old must appear exactly once.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "old": {"type": "string"}, "new": {"type": "string"}}, "required": ["path", "old", "new"]}}},
    {"type": "function", "function": {"name": "bash", "description": "Run a shell command in the project root.",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
]
tasks = [
    "Open src/main.ts and show me the first 40 lines.",
    "Run the test suite with npm test.",
    "In src/util.ts, change `const MAX = 10` to `const MAX = 20`.",
    "Find every file that imports lodash.",
    "Read package.json, then tell me the test command.",
    "In app.py replace the line `    return a+b` with `    return a + b  # fixed`.",
]
print("\n== /v1 tool calls (default context) ==")
ok = 0
for t in tasks:
    body = {"model": MODEL, "messages": [{"role": "system", "content": "You are a coding agent. Use tools."}, {"role": "user", "content": t}], "tools": TOOLS, "temperature": 0}
    out, dt = post("/v1/chat/completions", body)
    msg = out["choices"][0]["message"]
    calls = msg.get("tool_calls") or []
    parsed = []
    for c in calls:
        try:
            parsed.append((c["function"]["name"], json.loads(c["function"]["arguments"])))
        except Exception as e:
            parsed.append(("BADJSON", c["function"].get("arguments")))
    good = bool(parsed) and all(p[0] != "BADJSON" for p in parsed)
    ok += good
    print(f"{dt:5.1f}s calls={parsed} text={(msg.get('content') or '')[:80]!r}")
print(f"well-formed tool calls: {ok}/{len(tasks)}")

big = chunk(40000)
out, dt = post("/v1/chat/completions", {"model": MODEL, "messages": [{"role": "user", "content": big + "\n\nSay OK."}], "max_tokens": 5})
print(f"\n/v1 with ~40k-char prompt: usage={out.get('usage')} ({dt:.1f}s)")
print("ollama ps after /v1:", ps())

# 2. Native API with explicit num_ctx=65536: prefill/decode speed + prefix reuse
print("\n== /api/chat num_ctx=65536 ==")
NUM_CTX = 65536
post("/api/chat", {"model": MODEL, "messages": [{"role": "user", "content": "hi"}], "stream": False, "options": {"num_ctx": NUM_CTX, "num_predict": 1}})
print("ollama ps:", ps())
rows = []
for chars in [7000, 28000, 56000, 112000]:
    nonce = f"session {random.random()}\n"
    msgs = [{"role": "system", "content": nonce + "You are a coding agent."}, {"role": "user", "content": chunk(chars) + "\n\nSummarize what this code does in 3 sentences."}]
    out, dt = post("/api/chat", {"model": MODEL, "messages": msgs, "stream": False, "options": {"num_ctx": NUM_CTX, "num_predict": 128, "temperature": 0}})
    pn, pd = out["prompt_eval_count"], out["prompt_eval_duration"] / 1e9
    en, ed = out["eval_count"], out["eval_duration"] / 1e9
    print(f"prompt={pn:6d} tok  prefill={pn/pd:6.0f} tok/s ({pd:5.1f}s)  decode={en/ed:5.1f} tok/s  wall={dt:5.1f}s")
    # follow-up turn: append-only, same prefix
    msgs2 = msgs + [{"role": "assistant", "content": out["message"]["content"]}, {"role": "user", "content": "Now name one function in it."}]
    out2, dt2 = post("/api/chat", {"model": MODEL, "messages": msgs2, "stream": False, "options": {"num_ctx": NUM_CTX, "num_predict": 32, "temperature": 0}})
    print(f"   follow-up: prompt_eval_count={out2['prompt_eval_count']} in {out2['prompt_eval_duration']/1e9:.1f}s  wall={dt2:.1f}s")
print("ollama ps end:", ps())
