import json, glob, random, sys, time, urllib.request

MODEL = sys.argv[1]
SRC = sys.argv[2]
corpus = "".join(f"\n// FILE {f}\n" + open(f, errors="ignore").read() for f in sorted(glob.glob(SRC + "/**/*.ts", recursive=True)))

def post(body):
    req = urllib.request.Request("http://localhost:11434/api/chat", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=1800) as r:
        return json.loads(r.read())

opts = {"num_ctx": 65536, "temperature": 0}
post({"model": MODEL, "messages": [{"role": "user", "content": "hi"}], "stream": False, "think": False, "options": {**opts, "num_predict": 1}})
for chars in [c for c in [7000, 56000, 112000] if c < len(corpus)]:
    start = random.randint(0, len(corpus) - chars)
    msgs = [{"role": "system", "content": f"session {random.random()}"}, {"role": "user", "content": corpus[start:start + chars] + "\n\nSummarize this code in 3 sentences."}]
    o = post({"model": MODEL, "messages": msgs, "stream": False, "think": False, "options": {**opts, "num_predict": 128}})
    pn, pd, en, ed = o["prompt_eval_count"], o["prompt_eval_duration"] / 1e9, o["eval_count"], o["eval_duration"] / 1e9
    print(f"{MODEL}: prompt={pn:6d} tok  prefill avg={pn/pd:5.0f} tok/s ({pd:5.1f}s)  decode={en/ed:5.1f} tok/s")
