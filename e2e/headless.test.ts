// Headless runs against the scripted server: what a script or CI job would see.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { call, FILES, reply, type Step } from "./harness.ts";

const demo = join(import.meta.dirname, "../scripts/ui-demo.ts");

function run(args: string[], opts: { steps?: Step[]; files?: Record<string, string>; stdin?: string; root?: string } = {}) {
  const root = opts.root ?? realpathSync(mkdtempSync(join(tmpdir(), "heyho-e2e-")));
  for (const [path, content] of Object.entries(opts.root ? {} : { ...FILES, ...opts.files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const stepsFile = `${root}-steps.json`;
  writeFileSync(stepsFile, JSON.stringify(opts.steps ?? []));
  const r = Bun.spawnSync(["bun", demo, ...args], {
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
    env: { ...process.env, DEMO_STEPS: stepsFile, DEMO_ROOT: root, DEMO_FAST: "1", HEYHO_HOME: `${root}-home` },
  });
  return { root, out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode, requests: () => JSON.parse(readFileSync(`${root}-requests.json`, "utf8")) as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] }[] };
}

const EDIT = call("edit", { path: "greet.js", old_string: '"hello"', new_string: '"good morning"' });

test("-p reads the task from stdin, and adds stdin to a task given as an argument", () => {
  const a = run(["-p"], { stdin: "what is in greet.js\n", steps: [reply("A greeting.\n")] });
  expect(a.out).toBe("A greeting.\n");
  expect(a.requests()[0].messages.at(-1)!.content).toBe("what is in greet.js");
  const b = run(["-p", "explain this error"], { stdin: "TypeError: x is not a function\n", steps: [reply("ok\n")] });
  expect(b.requests()[0].messages.at(-1)!.content).toBe("explain this error\n\nTypeError: x is not a function");
});

test("--output-format json prints one result object; text prints only the reply", () => {
  const j = run(["--output-format", "json", "say hi"], { steps: [reply("Hi.\n")] });
  expect(JSON.parse(j.out)).toMatchObject({ status: "done", reply: "Hi.\n", steps: 1 });
  expect(run(["--output-format", "text", "say hi"], { steps: [reply("Hi.\n")] }).out).toBe("Hi.\n");
});

test("--output-format stream-json prints one JSON event per line: start, text, tools, result", () => {
  const r = run(["--yolo", "--output-format", "stream-json", "change it"], { steps: [{ ...EDIT, text: "Changing it.\n" }, reply("Done.\n")] });
  const events = r.out.trim().split("\n").map((l) => JSON.parse(l));
  expect(events.map((e) => e.type)).toEqual(["start", "text", "tool_call", "tool_result", "text", "result"]);
  expect(events[0]).toMatchObject({ model: "qwen3-coder" });
  expect(events[1].text).toBe("Changing it.\n");
  expect(events[2]).toMatchObject({ name: "edit", args: { path: "greet.js" } });
  expect(events[3]).toMatchObject({ name: "edit", ok: true });
  expect(events[5]).toMatchObject({ status: "done", reply: "Done.\n", changes: [{ path: "greet.js" }] });
});

test("--allowed-tools lets a rule through without a terminal; without it the same call is declined", () => {
  const declined = run(["change it"], { steps: [EDIT, reply("Could not.\n")] });
  expect(readFileSync(join(declined.root, "greet.js"), "utf8")).toContain('"hello"');
  const allowed = run(["--allowed-tools", "edit(greet.js),bash(node *)", "change it"], { steps: [EDIT, call("bash", { command: "node greet.js" }), reply("Done.\n")] });
  expect(readFileSync(join(allowed.root, "greet.js"), "utf8")).toContain("good morning");
  expect(allowed.err).toMatch(/→ bash node greet\.js\s+exit code 0/);
});

test("--disallowed-tools refuses even with --yolo", () => {
  const r = run(["--yolo", "--disallowed-tools", "edit(greet.js)", "change it"], { steps: [EDIT, reply("Not allowed.\n")] });
  expect(readFileSync(join(r.root, "greet.js"), "utf8")).toContain('"hello"');
  expect(r.err).toMatch(/Blocked: a rule set by the user/);
});

test("--tools limits which tools the model is offered", () => {
  const r = run(["--tools", "read,search", "look around"], { steps: [reply("Looked.\n")] });
  expect(r.requests()[0].tools.map((t) => t.function.name)).toEqual(["read", "search"]);
});

test("--system-prompt replaces the instructions; --append-system-prompt adds to them", () => {
  const a = run(["--system-prompt", "You are a pirate.", "hi"], { steps: [reply("Arr.\n")] });
  const sysA = a.requests()[0].messages[0].content;
  expect(sysA.startsWith("You are a pirate.")).toBe(true);
  expect(sysA).not.toContain("You are heyho");
  expect(sysA).toContain("Working directory:");
  const b = run(["--append-system-prompt", "Answer in one word.", "hi"], { steps: [reply("Yes.\n")] });
  const sysB = b.requests()[0].messages[0].content;
  expect(sysB).toContain("You are heyho");
  expect(sysB.trimEnd().endsWith("Answer in one word.")).toBe(true);
});

test("--continue and --resume <name> carry a headless conversation on", () => {
  const first = run(["--session-name", "tax work", "remember the number 7781"], { steps: [reply("Remembered.\n")] });
  const second = run(["--continue", "what was the number"], { root: first.root, steps: [reply("7781.\n")] });
  expect(second.requests()[0].messages.map((m) => m.content).join("\n")).toContain("remember the number 7781");
  const third = run(["--resume", "tax", "-p", "and again"], { root: first.root, steps: [reply("7781.\n")] });
  const said = third.requests()[0].messages.filter((m) => m.role === "user").map((m) => m.content);
  expect(said).toEqual(["remember the number 7781", "what was the number", "and again"]);
});

test("--max-turns stops the run like --max-steps", () => {
  const loop = Array.from({ length: 6 }, (_, i) => call("read", { path: i % 2 ? "greet.js" : "README.md" }));
  const r = run(["--max-turns", "2", "--output-format", "json", "keep reading"], { steps: [...loop, reply("Stopped.\n")] });
  expect(JSON.parse(r.out).status).toBe("step_limit");
  expect(r.code).toBe(2);
});

test("a long task is shortened more than once in one run and still finishes", () => {
  // On the real model a second fill of the context ended the turn and told the user to type /compact.
  const READ = { calls: [["read", { path: "greet.js" }]] as [string, object][], full: true };
  const r = run(["--yolo", "go"], { steps: [READ, reply("Notes one: read greet.js once."), READ, reply("Notes two: read greet.js twice."), reply("Finished.\n")] });
  expect(r.out).toContain("Finished.");
  expect(r.err).not.toMatch(/context is full/i);
});
