import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals, prefixOf } from "../src/approve.ts";
import { Changes } from "../src/changes.ts";
import { listSessions, loadMessages, newSession } from "../src/session.ts";
import { Markdown, outputTail, paint, renderDiff } from "../src/ui.ts";

const plain = paint(false);

test("markdown is rendered a whole line at a time", () => {
  const md = new Markdown(plain);
  expect(md.push("## Ti")).toBe("");
  expect(md.pending).toBe(true);
  expect(md.push("tle\n- one\n```js\nconst a = `x`;\n```\nlast")).toBe("Title\n• one\n```js\n│ const a = `x`;\n```\n");
  expect(md.flush()).toBe("last\n");
  expect(md.pending).toBe(false);
});

test("a diff is shown with line numbers, and a long one is cut with a count", () => {
  const d = renderDiff({ path: "a.ts", before: "one\ntwo\nthree\n", after: "one\n2\nthree\n" }, plain);
  expect(d.lines).toEqual(["1   one", "2 - two", "2 + 2", "3   three"]);
  expect([d.added, d.removed]).toEqual([1, 1]);
  const long = renderDiff({ path: "b.ts", before: null, after: Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n" }, plain, 5);
  expect(long.lines.length).toBe(6);
  expect(long.lines[5]).toBe("   … 25 more lines");
});

test("a command's output is shown from the end, counting what is hidden", () => {
  expect(outputTail("a\n\nb\nc\n", 2)).toEqual({ shown: ["b", "c"], hidden: 1 });
  expect(outputTail("", 4)).toEqual({ shown: [], hidden: 0 });
});

test("ask mode asks for edits and commands; read-only commands inside the workspace don't ask", () => {
  const a = new Approvals("ask");
  expect(a.allowed("edit", "x")).toBe(false);
  expect(a.allowed("bash", "git status")).toBe(true);
  expect(a.allowed("bash", "cat src/a.ts")).toBe(true);
  expect(a.allowed("bash", "cat ~/.ssh/id_rsa")).toBe(false);
  expect(a.allowed("bash", "cat ../other/secret")).toBe(false);
  expect(a.allowed("bash", "git status; rm -rf .")).toBe(false);
  expect(a.allowed("bash", "npm test")).toBe(false);
  expect(a.allowed("bash", "find . -name '*.js'")).toBe(true);
  expect(a.allowed("bash", "find . -name '*.js' -delete")).toBe(false);
  const rooted = new Approvals("ask", undefined, "/work/repo");
  expect(rooted.allowed("bash", "find /work/repo/src -type f")).toBe(true);
  expect(rooted.allowed("bash", "cat /work/repository/secret")).toBe(false);
  expect(rooted.allowed("bash", "cat /etc/passwd")).toBe(false);
});

test("a prefix rule covers the command with other arguments but never a chained command", () => {
  const a = new Approvals("ask");
  expect(prefixOf("npm test -- --watch")).toBe("npm test");
  expect(prefixOf("ls -la")).toBe("ls");
  expect(prefixOf("npm test && rm x")).toBeNull();
  a.allowPrefix("npm test");
  expect(a.allowed("bash", "npm test -- one")).toBe(true);
  expect(a.allowed("bash", "npm testx")).toBe(false);
  expect(a.allowed("bash", "npm test && rm -rf .")).toBe(false);
  a.allowExact("npm test && echo ok");
  expect(a.allowed("bash", "npm test && echo ok")).toBe(true);
});

test("auto mode stops asking for edits but still asks for commands", () => {
  const a = new Approvals("auto");
  expect(a.allowed("edit", "x")).toBe(true);
  expect(a.allowed("write", "x")).toBe(true);
  expect(a.allowed("bash", "npm test")).toBe(false);
});

test("plan mode lets read-only commands run and nothing else", () => {
  const a = new Approvals("plan");
  a.allowPrefix("npm test");
  expect(a.allowed("bash", "git diff")).toBe(true);
  expect(a.allowed("bash", "npm test")).toBe(false);
  expect(a.allowed("edit", "x")).toBe(false);
  expect(a.allowed("write", "x")).toBe(false);
});

test("command rules are kept for the project; allowing all edits is not", () => {
  const file = join(mkdtempSync(join(tmpdir(), "heyho-state-")), "allowed.json");
  const a = new Approvals("ask", file);
  a.allowPrefix("npm test");
  a.allowExact("make && make install");
  a.allowKind("edit");
  const b = new Approvals("ask", file);
  expect(b.allowed("bash", "npm test -- x")).toBe(true);
  expect(b.allowed("bash", "make && make install")).toBe(true);
  expect(b.allowed("edit", "x")).toBe(false);
  b.forget();
  expect(new Approvals("ask", file).allowed("bash", "npm test")).toBe(false);
});

test("undo restores the last turn's files and leaves files changed since alone", () => {
  const root = mkdtempSync(join(tmpdir(), "heyho-test-"));
  const [a, b, c] = ["a.txt", "b.txt", "c.txt"].map((f) => join(root, f));
  const changes = new Changes(root);
  changes.startTurn();
  for (const [file, before, after] of [[a, "one\n", "two\n"], [b, null, "new\n"], [c, "c1\n", "c2\n"]] as const) {
    writeFileSync(file, after);
    changes.record(file, before, after);
  }
  changes.record(a, "two\n", "three\n");
  writeFileSync(a, "three\n");
  expect(changes.summary()).toEqual([
    { path: "a.txt", added: 1, removed: 1, created: false },
    { path: "b.txt", added: 1, removed: 0, created: true },
    { path: "c.txt", added: 1, removed: 1, created: false },
  ]);
  writeFileSync(c, "edited by the user\n");
  changes.startTurn(); // a later turn with no changes
  expect(changes.turnCount).toBe(2);
  expect(changes.undo()).toEqual({ restored: ["a.txt", "b.txt"], skipped: ["c.txt"] });
  expect(readFileSync(a, "utf8")).toBe("one\n");
  expect(existsSync(b)).toBe(false);
  expect(readFileSync(c, "utf8")).toBe("edited by the user\n");
  expect(changes.undo()).toBeNull();
});

test("a session reloads its messages, starting after the last reset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heyho-state-"));
  const s = newSession(dir);
  s.record({ meta: { root: "/x" } });
  s.record({ role: "system", content: "sys" });
  s.record({ role: "user", content: "first task\nmore" });
  s.record({ usage: { prompt: 1 } });
  s.record({ role: "assistant", content: "ok", reasoning_content: "why" });
  expect(loadMessages(s.file)).toEqual([
    { role: "system", content: "sys" },
    { role: "user", content: "first task\nmore" },
    { role: "assistant", content: "ok", reasoning_content: "why" },
  ]);
  expect(listSessions(dir).map((x) => [x.first, x.turns])).toEqual([["first task", 1]]);
  s.record({ reset: true });
  s.record({ role: "system", content: "sys" });
  s.record({ role: "user", content: "Earlier messages in this session were removed to free context. Your notes from before:\n\nx" });
  expect(loadMessages(s.file).length).toBe(2);
  // Still listed under what the user first typed, not under the notes heyho wrote.
  expect(listSessions(dir).map((x) => [x.first, x.turns])).toEqual([["first task", 1]]);

  const once = newSession(dir);
  once.record({ meta: { headless: true } });
  once.record({ role: "user", content: "one-off question" });
  expect(listSessions(dir).map((x) => x.first)).toEqual(["first task"]);
  expect(listSessions(dir, 10, { headless: true }).map((x) => x.first)).toContain("one-off question");
});
