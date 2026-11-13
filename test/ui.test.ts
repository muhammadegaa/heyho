import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals, splitCommand } from "../src/approve.ts";
import { loadSettings } from "../src/settings.ts";
import { Changes } from "../src/changes.ts";
import { listSessions, loadMessages, newSession } from "../src/session.ts";
import { Markdown, outputTail, paint, renderDiff } from "../src/ui.ts";

const plain = paint(false);

test("markdown is rendered a whole line at a time", () => {
  const md = new Markdown(plain);
  expect(md.push("## Ti")).toBe("");
  expect(md.pending).toBe(true);
  expect(md.push("tle\n- one\n```js\nconst a = `x`;\n```\nlast")).toBe("Title\n• one\njs\n│ const a = `x`;\n");
  expect(md.flush()).toBe("last\n");
  expect(md.pending).toBe(false);
});

test("a table is held until it ends, then printed with its columns lined up", () => {
  const md = new Markdown(plain);
  expect(md.push("| File | Lines |\n|---|---|\n| `src/cart.js` | 15 |\n")).toBe("");
  expect(md.pending).toBe(true);
  expect(md.push("| b.js | 3 |\n\nAfter.\n")).toBe("File          Lines\n───────────   ─────\nsrc/cart.js   15\nb.js          3\n\nAfter.\n");
  expect(md.push("| a | b |\n| 1 | 2 |")).toBe("");
  expect(md.flush()).toBe("a   b\n─   ─\n1   2\n");
});

test("quotes, links and italics lose their markup", () => {
  const md = new Markdown(plain);
  expect(md.push("> a note\nSee [docs](https://x.io) now.\n")).toBe("│ a note\nSee docs (https://x.io) now.\n");
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

test("a compound command is judged part by part, and anything that can't be taken apart asks", () => {
  expect(splitCommand("cd src && npm test | tail -5; echo 'a; b'")).toEqual(["cd src", "npm test", "tail -5", "echo 'a; b'"]);
  expect(splitCommand("npm test > out.txt")).toBeNull();
  expect(splitCommand("echo $(whoami)")).toBeNull();
  expect(splitCommand("sleep 5 &")).toBeNull();
  // Inside single quotes nothing is special, so a regex with backslashes is still a plain grep.
  expect(splitCommand("grep -rn '\\bsecs\\b' src/")).toEqual(["grep -rn '\\bsecs\\b' src/"]);
  expect(splitCommand("grep '<div>' a.html | head -3")?.length).toBe(2);
  expect(splitCommand("grep 'x' > out.txt")).toBeNull();
  // Sending errors to the output or to nowhere writes no file, so it does not make a command opaque.
  expect(splitCommand("ls test/ 2>/dev/null | head -3")).toEqual(["ls test/", "head -3"]);
  expect(splitCommand("npm test 2>&1")).toEqual(["npm test"]);
  expect(splitCommand("ls 2>/tmp/x")).toBeNull();
  expect(splitCommand("ls 2>/dev/nullx")).toBeNull();
  expect(splitCommand("ls >/dev/null; rm 2>&1 > f")).toBeNull();
  expect(splitCommand(`echo "it's $(whoami)'s"`)).toBeNull();
  expect(splitCommand(`echo "a\\'" 'b'`)).toBeNull();
  const a = new Approvals("ask", undefined, "/work/repo");
  expect(a.allowed("bash", "cd /work/repo && git status | head -3")).toBe(true);
  expect(a.allowed("bash", "cd /work/repo && npm test")).toBe(false);
  expect(a.suggest("cd /work/repo && npm test -- x && node build.js")).toEqual(["npm test", "node"]);
  a.allowSuggested("cd /work/repo && npm test -- x && node build.js");
  expect(a.allowed("bash", "npm test && node other.js")).toBe(true);
  expect(a.allowed("bash", "npm test && rm -rf .")).toBe(false);
  expect(a.allowed("bash", "npm test > log")).toBe(false);
  expect(a.suggest("npm test > log")).toBeNull();
  // A rule for every use of a shell or a wrapper would allow any command at all.
  expect(a.suggest('sh -c "echo hi"')).toBeNull();
  expect(a.suggest("npm test && sudo make install")).toBeNull();
});

test("auto mode stops asking for edits and for file commands inside the workspace", () => {
  const a = new Approvals("auto", undefined, "/work/repo");
  expect(a.allowed("edit", "x")).toBe(true);
  expect(a.allowed("write", "x")).toBe(true);
  expect(a.allowed("bash", "mkdir -p src/new && mv a.js src/new/a.js")).toBe(true);
  expect(a.allowed("bash", "rm -rf /etc")).toBe(false);
  expect(a.allowed("bash", "npm test")).toBe(false);
  expect(new Approvals("ask", undefined, "/work/repo").allowed("bash", "mkdir x")).toBe(false);
});

test("plan mode lets read-only commands run and nothing else", () => {
  const a = new Approvals("plan");
  a.allowPrefix("npm test");
  expect(a.allowed("bash", "git diff")).toBe(true);
  expect(a.allowed("bash", "npm test")).toBe(false);
  expect(a.allowed("edit", "x")).toBe(false);
  expect(a.allowed("write", "x")).toBe(false);
});

test("rules: deny beats ask beats allow, in every mode", () => {
  const layers = [
    { source: "user" as const, file: "u", settings: { permissions: { allow: ["bash(npm run *)", "edit(docs/**)"], deny: ["read(.env)", "bash(git push *)"] } } },
    { source: "project" as const, file: "p", settings: { permissions: { ask: ["bash(npm run deploy *)"], deny: ["Edit(secrets/**)"], allow: ["nonsense rule"] } } },
  ];
  const a = new Approvals("ask", undefined, "/work/repo", layers);
  expect(a.problems.length).toBe(1);
  expect(a.decide("bash", "npm run build").action).toBe("allow");
  expect(a.decide("bash", "npm run deploy prod").action).toBe("ask");
  expect(a.decide("bash", "git status && git push origin main")).toMatchObject({ action: "deny", rule: { text: "bash(git push *)" } });
  expect(a.decide("edit", "docs/guide.md\n@@ line 1").action).toBe("allow");
  expect(a.decide("edit", "src/a.ts\n@@ line 1").action).toBe("ask");
  expect(a.decide("write", "secrets/key.txt (new file, 1 lines)\nx").action).toBe("deny");
  expect(a.readDenied("/work/repo/config/.env")?.text).toBe("read(.env)");
  expect(a.readDenied("/work/repo/src/env.ts")).toBeUndefined();
  const yolo = new Approvals("yolo", undefined, "/work/repo", layers);
  expect(yolo.decide("bash", "git push origin main").action).toBe("deny");
  expect(yolo.decide("bash", "rm -rf build").action).toBe("allow");
});

test("saved answers are kept for the project; allowing all edits is not; rules can be added and removed", () => {
  const file = join(mkdtempSync(join(tmpdir(), "heyho-state-")), "allowed.json");
  const a = new Approvals("ask", file);
  a.allowPrefix("npm test");
  a.allowExact("make > log");
  a.allowKind("edit");
  const b = new Approvals("ask", file);
  expect(b.allowed("bash", "npm test -- x")).toBe(true);
  expect(b.allowed("bash", "make > log")).toBe(true);
  expect(b.allowed("edit", "x")).toBe(false);
  expect(b.addRule("deny", "bash(npm test *)")).toBe(true);
  expect(b.addRule("deny", "what")).toBe(false);
  expect(b.decide("bash", "npm test").action).toBe("deny");
  expect(b.removeRule("bash(npm test *)")).toBe(true);
  expect(b.decide("bash", "npm test").action).toBe("ask");
  b.forget();
  expect(new Approvals("ask", file).allowed("bash", "make > log")).toBe(false);
});

test("settings files merge with the project's own winning", () => {
  const home = mkdtempSync(join(tmpdir(), "heyho-home-"));
  const root = mkdtempSync(join(tmpdir(), "heyho-test-"));
  process.env.HEYHO_HOME = home;
  writeFileSync(join(home, "settings.json"), JSON.stringify({ mode: "auto", profile: "qwen3.6", permissions: { deny: ["read(.env)"] } }));
  mkdirSync(join(root, ".heyho"));
  writeFileSync(join(root, ".heyho", "settings.json"), JSON.stringify({ mode: "plan" }));
  writeFileSync(join(root, ".heyho", "settings.local.json"), "{ not json");
  const s = loadSettings(root);
  delete process.env.HEYHO_HOME;
  expect(s.merged).toEqual({ mode: "plan", profile: "qwen3.6" });
  expect(s.layers.map((l) => l.source)).toEqual(["user", "project"]);
  expect(s.problems.length).toBe(1);
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

test("the light theme swaps yellow and cyan for colours that show on a light background", async () => {
  const { paint } = await import("../src/ui.ts");
  expect(paint(true).yellow("x")).toBe("\x1b[33mx\x1b[0m");
  process.env.HEYHO_THEME = "light";
  try {
    expect(paint(true).yellow("x")).toBe("\x1b[38;5;130mx\x1b[0m");
    expect(paint(true).cyan("x")).toBe("\x1b[34mx\x1b[0m");
    expect(paint(true).green("x")).toBe("\x1b[32mx\x1b[0m");
  } finally {
    delete process.env.HEYHO_THEME;
  }
});

test("ages are given in the largest unit that fits", async () => {
  const { ago } = await import("../src/session.ts");
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);
  const back = (ms: number) => ago(new Date(now - ms), now);
  expect([back(20_000), back(5 * 60_000), back(3 * 3_600_000), back(26 * 3_600_000), back(9 * 86_400_000)]).toEqual(["just now", "5 min ago", "3 h ago", "yesterday", "9 days ago"]);
});

test("sessions opened in the same millisecond get separate files", () => {
  const dir = mkdtempSync(join(tmpdir(), "heyho-state-"));
  const files = new Set(Array.from({ length: 20 }, () => newSession(dir).file));
  expect(files.size).toBe(20);
});

test("paths are shown relative to the project, and with ~ under the home folder", async () => {
  const { tidyPaths } = await import("../src/ui.ts");
  const { homedir } = await import("node:os");
  expect(tidyPaths("cd /work/repo && cat /work/repo/src/a.ts", "/work/repo")).toBe("cd . && cat src/a.ts");
  expect(tidyPaths(`read ${homedir()}/.heyho/projects/x/memory/NOTES.md`, "/work/repo")).toBe("read ~/.heyho/projects/x/memory/NOTES.md");
});

test("a session reopened after shortening keeps its title and replaces the one it came from", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heyho-state-"));
  const old = newSession(dir);
  old.record({ role: "user", content: "first task" });
  old.record({ reset: true });
  old.record({ role: "user", content: "Earlier messages in this session were removed to free context. Your notes from before:\n\nx" });
  await new Promise((r) => setTimeout(r, 5));
  const fork = newSession(dir);
  fork.record({ from: old.file.split("/").pop() });
  fork.record({ role: "user", content: "Earlier messages in this session were removed to free context. Your notes from before:\n\nx" });
  fork.record({ checkpoints: [{ text: "first task", messages: 1, turn: 0 }] });
  // Reopened and closed without a message: still one entry, under the original title.
  expect(listSessions(dir).map((x) => [x.first, x.file])).toEqual([["first task", fork.file]]);
  fork.record({ role: "user", content: "next thing" });
  expect(listSessions(dir).map((x) => [x.first, x.file])).toEqual([["first task", fork.file]]);
});
