// Shows the terminal UI without a model: a fake server streams scripted replies, with
// pauses, into a throwaway project. Run `bun scripts/ui-demo.ts` and type anything.
// Add --plain for the line mode. Three messages walk through: thinking, an edit with a diff, a command, a new file,
// a failing command, and a reply in markdown. Extra arguments go to heyho (e.g. --mode auto).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Step = { think?: string; text?: string; calls?: [string, object][]; slow?: boolean };
const script: Step[] = [
  { think: "The user wants the greeting changed. I should read the file first, then make a small edit and run it to check. ".repeat(6), text: "Plan:\n- read `greet.js`\n- change the greeting\n- run it\n", calls: [["read", { path: "greet.js" }]] },
  { calls: [["edit", { path: "greet.js", old_string: 'const greeting = "hello";\nconsole.log(greeting + ", " + name);', new_string: 'const greeting = "good morning";\nconsole.log(`${greeting}, ${name}`);' }]] },
  { calls: [["bash", { command: "for i in 1 2 3; do echo \"check $i\"; sleep 1; done; node greet.js" }]] },
  { text: "## Done\n\nChanged the greeting in `greet.js` and ran it:\n\n```\ngood morning, world\n```\n\n- **Edited:** one line\n- **Checked:** `node greet.js`\n" },
  { think: "A test file is missing. ".repeat(8), calls: [["write", { path: "greet.test.js", content: 'import { execFileSync } from "node:child_process";\nimport assert from "node:assert";\n\nconst out = execFileSync("node", ["greet.js"], { encoding: "utf8" });\nassert.equal(out.trim(), "good evening, world");\n' }]] },
  { calls: [["bash", { command: "node greet.test.js" }]] },
  { text: "The test fails: it expects `good evening` and the file prints `good morning`. Tell me which one you want.\n" },
  { text: "That was the last scripted reply. `/undo` takes back the last change, `/help` lists the commands, `/exit` quits.\n" },
];

// The UI tests supply their own replies and timing: DEMO_STEPS is a JSON file of steps,
// DEMO_ROOT the project folder to use, DEMO_FAST=1 drops the pauses.
if (process.env.DEMO_STEPS) script.splice(0, script.length, ...JSON.parse(readFileSync(process.env.DEMO_STEPS, "utf8")));
const speed = process.env.DEMO_FAST ? 0.05 : 1;

const seen: unknown[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms * speed));
const server = createServer((req, res) => {
  if (req.method !== "POST") return res.writeHead(404).end();
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    // The tests read back what heyho sent.
    if (process.env.DEMO_ROOT) {
      seen.push(JSON.parse(body));
      writeFileSync(`${process.env.DEMO_ROOT}-requests.json`, JSON.stringify(seen));
    }
    const s = script.shift() ?? { text: "Nothing more is scripted.\n" };
    res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
    const send = (delta: object, finish?: string) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    await pause(1500);
    for (const part of s.think?.match(/.{1,12}/gs) ?? []) (send({ reasoning_content: part }), await pause(40));
    for (const part of s.text?.match(/.{1,6}/gs) ?? []) (send({ content: part }), await pause(s.slow ? 2000 : 25));
    for (const [i, [name, args]] of (s.calls ?? []).entries()) {
      send({ tool_calls: [{ index: i, id: `c${i}`, type: "function", function: { name, arguments: "" } }] });
      for (const part of JSON.stringify(args).match(/.{1,20}/gs) ?? []) (send({ tool_calls: [{ index: i, function: { arguments: part } }] }), await pause(20));
    }
    send({}, s.calls ? "tool_calls" : "stop");
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9000 + 2500 * (8 - script.length), completion_tokens: 180 }, timings: { cache_n: 8800, prompt_ms: 400, predicted_per_second: 41 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});

server.listen(0, "127.0.0.1", () => {
  const root = process.env.DEMO_ROOT ?? mkdtempSync(join(tmpdir(), "heyho-demo-"));
  if (!process.env.DEMO_ROOT) writeFileSync(join(root, "greet.js"), 'const name = "world";\nconst greeting = "hello";\nconsole.log(greeting + ", " + name);\n');
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), "--base-url", `http://127.0.0.1:${port}/v1`, "--cwd", root, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, HEYHO_CTX: "65536" },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
});
