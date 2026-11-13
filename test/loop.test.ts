import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compact } from "../src/compact.ts";
import { newStats, runAgent, type AgentEvent } from "../src/loop.ts";
import type { Message, Profile } from "../src/model.ts";
import { TOOLS, toolSchemas } from "../src/tools/index.ts";
import type { ToolContext } from "../src/tools/types.ts";

// A fake OpenAI-compatible server that streams scripted replies and records requests.
type Scripted = { reasoning?: string; text?: string; calls?: [string, string][]; finish?: string; drop?: boolean; status?: number };
let script: Scripted[] = [];
const requests: { messages: Message[]; tool_choice: string; tools: unknown }[] = [];
let server: Server;
let profile: Profile;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const s = script.shift() ?? { text: "done" };
      if (s.status) return res.writeHead(s.status).end(s.text);
      // On a reused keep-alive connection, Bun's fetch resent the dropped request by itself
      // and joined both bodies into one stream, so the drop never reached heyho.
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (s.drop) {
        send({ choices: [{ index: 0, delta: { content: "partial" } }] });
        return setTimeout(() => res.destroy(), 20);
      }
      for (const part of s.reasoning?.match(/.{1,5}/gs) ?? []) send({ choices: [{ index: 0, delta: { reasoning_content: part } }] });
      if (s.text) for (const part of s.text.match(/.{1,5}/gs) ?? []) send({ choices: [{ index: 0, delta: { content: part } }] });
      (s.calls ?? []).forEach(([name, args], i) => {
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `c${i}`, type: "function", function: { name, arguments: "" } }] } }] });
        for (const part of args.match(/.{1,7}/gs) ?? []) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: part } }] } }] });
      });
      send({ choices: [{ index: 0, delta: {}, finish_reason: s.finish ?? (s.calls ? "tool_calls" : "stop") }] });
      send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 }, timings: { cache_n: 90, prompt_ms: 5, predicted_per_second: 50 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  profile = { baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake", maxTokens: 100 };
});
afterAll(() => server.close());

function setup() {
  requests.length = 0;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "heyho-loop-")));
  writeFileSync(join(root, "a.txt"), "hello\n");
  const ctx: ToolContext = { root, stateDir: mkdtempSync(join(tmpdir(), "heyho-st-")), seen: new Map(), approve: async () => true, sandbox: { enabled: false, noNet: false }, outCount: { n: 0 }, jobs: [] };
  const messages: Message[] = [{ role: "system", content: "sys" }, { role: "user", content: "task" }];
  const stats = newStats();
  const events: AgentEvent[] = [];
  const run = (maxSteps = 10) => runAgent({ profile, messages, tools: TOOLS, ctx, maxSteps, contextSize: 65536, stats, onEvent: (e) => events.push(e), record: () => {} });
  return { root, messages, stats, run, ctx, events };
}

test("each request extends the previous one unchanged (append-only prefix)", async () => {
  const { run, messages, stats } = setup();
  script = [
    { text: "Plan: read it.", calls: [["read", '{"path":"a.txt"}']] },
    { calls: [["edit", '{"path":"a.txt","old_string":"hello","new_string":"bye"}'], ["bash", '{"command":"cat a.txt"}']] },
    { text: "Changed hello to bye." },
  ];
  expect((await run()).status).toBe("done");
  expect(requests.length).toBe(3);
  // Compared as serialized text, not deep equality: a reordered key changes the bytes the
  // server tokenizes and invalidates its cache from that point.
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1];
    expect(JSON.stringify(requests[i].messages.slice(0, prev.messages.length))).toBe(JSON.stringify(prev.messages));
    expect(JSON.stringify(requests[i].tools)).toBe(JSON.stringify(prev.tools));
  }
  expect(messages.filter((m) => m.role === "tool").length).toBe(3);
  expect(stats.toolCalls).toEqual({ read: 1, edit: 1, bash: 1 });
  expect((messages.at(-2) as { content: string }).content).toContain("bye");
});

test("thinking is sent back with the turn it came from", async () => {
  const { run } = setup();
  script = [{ reasoning: "Read a.txt first.", calls: [["read", '{"path":"a.txt"}']] }, { text: "It says hello." }];
  expect((await run()).status).toBe("done");
  const replayed = requests[1].messages[2] as { content: string | null; reasoning_content?: string };
  expect(replayed.reasoning_content).toBe("Read a.txt first.");
  expect(replayed.content).toBeNull();
});

test("the screen is told about each stage of a step, in order", async () => {
  const { run, events } = setup();
  script = [{ reasoning: "Read it.", calls: [["read", '{"path":"a.txt"}']] }, { text: "ok" }];
  await run();
  const stages = events.map((e) => e.type).filter((t, i, all) => t !== all[i - 1]);
  expect(stages).toEqual(["request", "thinking", "calling", "turn", "tool_start", "tool", "request", "text", "turn"]);
});

test("what the user types instead of approving reaches the model", async () => {
  const { run, ctx, messages, root } = setup();
  ctx.approve = async () => "keep it, change b.txt instead";
  script = [{ calls: [["edit", '{"path":"a.txt","old_string":"hello","new_string":"bye"}']] }, { text: "ok" }];
  await run();
  expect((messages[3] as { content: string }).content).toBe("The user declined this action and said: keep it, change b.txt instead");
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello\n");
});

test("edits and new files report the content before and after", async () => {
  const { run, ctx } = setup();
  const seen: [string, string | null, string][] = [];
  ctx.onChange = (abs, before, after) => seen.push([abs.split("/").pop()!, before, after]);
  script = [{ calls: [["edit", '{"path":"a.txt","old_string":"hello","new_string":"bye"}'], ["write", '{"path":"n.txt","content":"new"}']] }, { text: "ok" }];
  await run();
  expect(seen).toEqual([["a.txt", "hello\n", "bye\n"], ["n.txt", null, "new"]]);
});

test("shortening keeps the system prompt and the model's notes", async () => {
  requests.length = 0;
  script = [{ text: "Notes: changed a.txt." }];
  const before: Message[] = [{ role: "system", content: "sys" }, { role: "user", content: "task" }, { role: "assistant", content: "did it" }];
  const after = await compact(profile, before, toolSchemas(TOOLS));
  expect(after.length).toBe(2);
  expect(after[0]).toEqual(before[0]);
  expect((after[1] as { content: string }).content).toContain("Notes: changed a.txt.");
  expect(requests[0].tool_choice).toBe("none");
  expect(JSON.stringify(requests[0].messages.slice(0, 3))).toBe(JSON.stringify(before));
});

test("calls cut off by the output limit are not executed", async () => {
  const { run, messages, root } = setup();
  script = [{ calls: [["write", '{"path":"b.txt","content":"partial']], finish: "length" }, { text: "ok" }];
  expect((await run()).status).toBe("done");
  const toolMsg = messages.find((m) => m.role === "tool") as { content: string };
  expect(toolMsg.content).toContain("Not executed");
  expect(Bun.file(join(root, "b.txt")).size).toBe(0);
  // Stored arguments are always valid JSON so the server can re-render the turn.
  const asst = messages.find((m) => m.role === "assistant") as { tool_calls: { function: { arguments: string } }[] };
  expect(() => JSON.parse(asst.tool_calls[0].function.arguments)).not.toThrow();
});

test("repaired arguments are counted; unrepairable ones get the parse error", async () => {
  const { run, messages, stats } = setup();
  script = [{ calls: [["read", '{"path":"a.txt"'], ["read", "{{{"]] }, { text: "done" }];
  await run();
  const results = messages.filter((m) => m.role === "tool") as { content: string }[];
  expect(results[0].content).toContain("1: hello");
  expect(results[1].content).toContain("not valid JSON");
  expect(stats.repairedArgs).toBe(1);
});

test("a reply that was all thinking and hit the output limit is not replayed, and the model is told to answer", async () => {
  // Qwen3.6 reviewing a 70-line file thought for 7 minutes to the limit; the 16k tokens of thinking then went back in the prompt.
  const { run } = setup();
  script = [{ reasoning: "x".repeat(400), finish: "length" }, { text: "Two bugs." }];
  expect((await run()).status).toBe("done");
  const sent = requests[1].messages as { role: string; content: string | null; reasoning_content?: string }[];
  expect(JSON.stringify(sent)).not.toContain("xxxx");
  expect(sent.at(-1)!.content).toMatch(/whole reply thinking/);
});

test("a second cutoff in a row stops the run with every call answered", async () => {
  const { run, messages } = setup();
  const cut = { calls: [["write", '{"path":"b.txt","content":"x']] as [string, string][], finish: "length" };
  script = [cut, cut];
  expect((await run()).status).toBe("stopped");
  const ids = messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : []));
  const answered = messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
  expect(answered).toEqual(ids);
});

test("a stream that drops partway is retried", async () => {
  const { run, messages } = setup();
  script = [{ drop: true }, { text: "done after retry" }];
  expect((await run()).status).toBe("done");
  expect(requests.length).toBe(2);
  expect((messages.at(-1) as { content: string }).content).toBe("done after retry");
}, 10_000);

test("a context overflow from the server ends the run as context_full", async () => {
  const { run } = setup();
  script = [{ status: 400, text: '{"error":{"message":"the request exceeds the available context size"}}' }];
  expect((await run()).status).toBe("context_full");
});

test("a tool call written as text is run, and the reply stored as a real tool call", async () => {
  const { run, messages, stats } = setup();
  script = [{ text: "Reading it.\n<function=read>\n<parameter=path>\na.txt\n</parameter>\n</function>\n</tool_call>" }, { text: "done" }];
  expect((await run()).status).toBe("done");
  expect(stats.textToolCalls).toBe(1);
  const asst = messages[2] as { content: string; tool_calls: { function: { name: string; arguments: string } }[] };
  expect(asst.content).toBe("Reading it.");
  expect(asst.tool_calls[0].function).toEqual({ name: "read", arguments: '{"path":"a.txt"}' });
  expect((messages[3] as { content: string }).content).toContain("1: hello");
});

test("repeated identical calls stop the run", async () => {
  const { run } = setup();
  script = Array.from({ length: 6 }, () => ({ calls: [["read", '{"path":"a.txt"}']] as [string, string][] }));
  const res = await run();
  expect(res.status).toBe("stopped");
  expect(res.reason).toContain("repeated 5 times");
});

test("step limit ends with a text-only wrap-up turn", async () => {
  const { run, messages } = setup();
  script = [{ calls: [["read", '{"path":"a.txt"}']] }, { calls: [["bash", '{"command":"true"}']] }, { text: "Summary: read a.txt." }];
  expect((await run(2)).status).toBe("step_limit");
  expect(requests.at(-1)!.tool_choice).toBe("none");
  expect((messages.at(-1) as { content: string }).content).toBe("Summary: read a.txt.");
});

test("a wrap-up that is another tool call written as text is replaced by a plain note", async () => {
  const { run, messages } = setup();
  script = [{ calls: [["read", '{"path":"a.txt"}']] }, { text: "<tool_call>\n<function=bash>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>" }];
  expect((await run(1)).status).toBe("step_limit");
  const last = (messages.at(-1) as { content: string }).content;
  expect(last).not.toContain("<function");
  expect(last).toMatch(/tried to call another tool/);
});

test("aliased tool names and keys are accepted; unknown tools get an error", async () => {
  const { run, messages } = setup();
  script = [{ calls: [["read_file", '{"file_path":"a.txt"}'], ["teleport", "{}"]] }, { text: "done" }];
  await run();
  const results = messages.filter((m) => m.role === "tool") as { content: string }[];
  expect(results[0].content).toContain("1: hello");
  expect(results[1].content).toContain('Unknown tool "teleport"');
});
