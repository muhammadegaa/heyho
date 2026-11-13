import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals } from "../src/approve.ts";
import { ask } from "../src/tools/ask.ts";
import { bash } from "../src/tools/bash.ts";
import { htmlToText } from "../src/tools/fetch.ts";
import { todo } from "../src/tools/todo.ts";
import type { Todo, ToolContext } from "../src/tools/types.ts";

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  root: realpathSync(mkdtempSync(join(tmpdir(), "heyho-test-"))),
  stateDir: mkdtempSync(join(tmpdir(), "heyho-state-")),
  seen: new Map(),
  approve: async () => true,
  sandbox: { enabled: false, noNet: false },
  outCount: { n: 0 },
  jobs: [],
  ...over,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a background command returns at once, logs to a file, and can be stopped by its process group", async () => {
  const c = ctx();
  const t0 = Date.now();
  const r = await bash.run({ command: "echo started; sleep 30; echo never", background: true }, c);
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(r.ok).toBe(true);
  expect(r.text).toMatch(/Started in the background as job 1/);
  const job = c.jobs[0];
  await wait(400);
  expect(readFileSync(job.log, "utf8")).toBe("started\n");
  expect(job.exit).toBeUndefined();
  process.kill(-job.pid, "SIGKILL");
  await wait(300);
  expect(job.exit).not.toBeUndefined();
});

test("a background command that ends records its exit code", async () => {
  const c = ctx();
  await bash.run({ command: "exit 4", background: true }, c);
  await wait(500);
  expect(c.jobs[0].exit).toBe(4);
});

test("the checklist is passed on whole, with unknown statuses treated as pending", async () => {
  let seen: Todo[] = [];
  const c = ctx({ onTodos: (items) => (seen = items) });
  const r = await todo.run({ items: [{ text: "read the code", status: "done" }, { text: "fix it", status: "doing" }, { text: "run tests", status: "later" }, { text: "  " }] }, c);
  expect(seen).toEqual([{ text: "read the code", status: "done" }, { text: "fix it", status: "doing" }, { text: "run tests", status: "pending" }]);
  expect(r.text).toBe("Checklist saved: 1 of 3 done.");
  await todo.run({ items: ["[x] read the code", "[~] fix it", "[ ] run tests", "no mark"] }, c);
  expect(seen.map((i) => i.status)).toEqual(["done", "doing", "pending", "pending"]);
  expect(seen[3].text).toBe("no mark");
  expect((await todo.run({ items: "no" }, c)).ok).toBe(false);
});

test("a question gets the user's answer, or tells the model to decide when nobody is there", async () => {
  const asked: [string, string[]][] = [];
  const there = ctx({ question: async (q, o) => (asked.push([q, o]), "tabs") });
  expect((await ask.run({ question: "Tabs or spaces?", options: ["tabs", "spaces"] }, there)).text).toBe("The user answered: tabs");
  expect(asked).toEqual([["Tabs or spaces?", ["tabs", "spaces"]]]);
  const alone = await ask.run({ question: "Tabs or spaces?" }, ctx());
  expect(alone.ok).toBe(false);
  expect(alone.text).toMatch(/Nobody is here to answer/);
});

test("a web page is reduced to its text", () => {
  expect(htmlToText("<html><head><title>x</title><style>p{color:red}</style></head><body><h1>Docs</h1><p>Use <code>a &amp; b</code>.</p><script>bad()</script><ul><li>one</li><li>two</li></ul></body></html>")).toBe("Docs\nUse a & b .\none\ntwo");
});

test("fetching asks by default; rules name hosts; a deny holds even in yolo", () => {
  const layers = [{ source: "user" as const, file: "u", settings: { permissions: { allow: ["fetch(docs.example.com)", "WebFetch(domain:*.rust-lang.org)"], deny: ["fetch(evil.example.com)"] } } }];
  const a = new Approvals("ask", undefined, "", layers);
  expect(a.decide("fetch", "https://docs.example.com/a/b").action).toBe("allow");
  expect(a.decide("fetch", "https://doc.rust-lang.org/std/").action).toBe("allow");
  expect(a.decide("fetch", "https://example.com/").action).toBe("ask");
  expect(a.decide("fetch", "https://evil.example.com/x").action).toBe("deny");
  const yolo = new Approvals("yolo", undefined, "", layers);
  expect(yolo.decide("fetch", "https://evil.example.com/x").action).toBe("deny");
  expect(yolo.decide("fetch", "https://example.com/").action).toBe("allow");
  a.allowHost("https://example.com/page");
  expect(a.decide("fetch", "https://example.com/other").action).toBe("allow");
});
