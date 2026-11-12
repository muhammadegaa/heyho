import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals, prefixOf } from "../src/approve.ts";
import { Changes } from "../src/changes.ts";
import { listSessions, loadMessages, newSession } from "../src/session.ts";
import { lineDelta, Markdown, paint, renderChange } from "../src/ui.ts";

const plain = paint(false);

test("markdown is rendered a whole line at a time", () => {
  const md = new Markdown(plain);
  expect(md.push("## Ti")).toBe("");
  expect(md.pending).toBe(true);
  expect(md.push("tle\n- one\n```js\nconst a = `x`;\n```\nlast")).toBe("Title\n• one\n```js\n│ const a = `x`;\n```\n");
  expect(md.flush()).toBe("last\n");
  expect(md.pending).toBe(false);
});

test("an edit's diff shows unchanged first and last lines as context", () => {
  const out = renderChange("edit", "a.ts\n@@ line 4\n- keep\n- old\n- end\n+ keep\n+ new\n+ end", plain);
  expect(out.split("\n")).toEqual(["a.ts", "@@ line 4", "  keep", "- old", "+ new", "  end"]);
});

test("a new file's preview says how many lines are not shown", () => {
  expect(renderChange("write", "b.ts (new file, 5 lines)\none\ntwo", plain)).toBe("b.ts (new file, 5 lines)\n+ one\n+ two\n  … 3 more lines");
});

test("line counts ignore the unchanged start and end of a file", () => {
  expect(lineDelta("a\nb\nc\n", "a\nx\ny\nc\n")).toEqual([2, 1]);
  expect(lineDelta(null, "a\nb")).toEqual([2, 0]);
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
    { path: "b.txt", added: 2, removed: 0, created: true },
    { path: "c.txt", added: 1, removed: 1, created: false },
  ]);
  writeFileSync(c, "edited by the user\n");
  changes.startTurn(); // a later turn with no changes
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
  expect(loadMessages(s.file)).toEqual([{ role: "system", content: "sys" }]);
});
