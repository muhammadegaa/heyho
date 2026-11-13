import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { call, open, reply, rules } from "./harness.ts";

type Session = Awaited<ReturnType<typeof open>>;
let s: Session | undefined;
afterEach(() => (s?.close(), (s = undefined)));

const EDIT = call("edit", { path: "greet.js", old_string: '"hello"', new_string: '"good morning"' });
const BASH = call("bash", { command: "node greet.js" });
const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long answer that keeps going for a while so it has to wrap on a narrow screen.`).join("\n") + "\n";

// ---- start, layout, resize ----

test("start: header, input box between two rules, footer with mode and model", async () => {
  s = await open();
  const screen = s.screen();
  expect(screen).toMatch(/heyho v\d/);
  expect(rules(screen)).toBe(2);
  expect(screen).toMatch(/⏸ ask.*shift\+tab changes/);
  expect(screen).toMatch(/qwen3-coder · 0% context/);
});

test("resize: narrower then wider leaves one header, two rules and a one-line footer", async () => {
  s = await open({ cols: 120 });
  for (const cols of [100, 80, 60, 90, 120]) await s.resize(cols, 30);
  const screen = s.screen();
  expect(rules(screen)).toBe(2);
  expect(screen.match(/heyho v\d/g)?.length).toBe(1);
  expect(screen.split("\n").filter((l) => l.includes("⏸ ask")).length).toBe(1);
  expect(screen).toMatch(/describe a task/);
});

test("resize with a transcript: earlier output is still there, once, at the new width", async () => {
  s = await open({ cols: 110, steps: [reply("The answer is forty-two.\n")] });
  await s.send("what is the answer");
  await s.wait(/worked for/);
  for (const cols of [70, 110]) await s.resize(cols, 30);
  const all = s.scrollback();
  expect(all.match(/The answer is forty-two\./g)?.length).toBe(1);
  expect(all.match(/what is the answer/g)?.length).toBe(1);
  expect(rules(s.screen())).toBe(2);
});

test("narrow terminal: the footer stays on one line and nothing overflows", async () => {
  s = await open({ cols: 50 });
  const screen = s.screen();
  expect(screen.split("\n").every((l) => l.length <= 50)).toBe(true);
  expect(screen.split("\n").filter((l) => l.includes("⏸ ask")).length).toBe(1);
  expect(rules(screen)).toBe(2);
});

test("short terminal: a long diff in an approval still shows the question and choices", async () => {
  const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n";
  s = await open({ rows: 16, steps: [call("write", { path: "big.txt", content: big })] });
  await s.send("make a big file");
  const screen = await s.wait(/Create this file\?/);
  expect(screen).toMatch(/1\. Yes/);
  expect(screen).toMatch(/more lines/);
});

test("a long answer scrolls: the input box is still at the bottom and the start is in scrollback", async () => {
  s = await open({ steps: [reply(LONG)] });
  await s.send("write a lot");
  await s.wait(/worked for/);
  expect(s.screen()).toMatch(/describe a task/);
  expect(rules(s.screen())).toBe(2);
  const all = s.scrollback();
  expect(all).toMatch(/Line 1 of a long answer/);
  expect(all.match(/Line 40 of a long answer/g)?.length).toBe(1);
});

// ---- working, approvals ----

test("working: a status line while waiting, then the reply and a summary", async () => {
  s = await open({ steps: [{ think: "thinking about it ".repeat(40), text: "Done.\n" }] });
  await s.send("do it");
  await s.wait(/thinking · .* esc to stop/);
  const screen = await s.wait(/worked for .* 1 step/);
  expect(screen).toMatch(/⏺ Done\./);
});

test("edit approval: numbered diff and menu; 1 applies it and the diff stays in the transcript", async () => {
  s = await open({ steps: [EDIT, reply("Changed.\n")] });
  await s.send("change it");
  const panel = await s.wait(/Make this edit\?/);
  expect(panel).toMatch(/Edit greet\.js/);
  expect(panel).toMatch(/2 - const greeting = "hello";/);
  expect(panel).toMatch(/2 \+ const greeting = "good morning";/);
  expect(panel).toMatch(/❯ 1\. Yes/);
  await s.key("1");
  const after = await s.wait(/worked for/);
  expect(after).toMatch(/⏺ edit greet\.js\s+\+1 −1/);
  expect(after).not.toMatch(/Make this edit\?/);
  expect(readFileSync(join(s.root, "greet.js"), "utf8")).toContain("good morning");
});

test("edit approval: arrow keys and Enter choose; Esc declines and the file is untouched", async () => {
  s = await open({ steps: [EDIT, reply("Okay, leaving it.\n")] });
  await s.send("change it");
  await s.wait(/Make this edit\?/);
  await s.key("Down");
  await s.wait(/❯ 2\. Yes, and don't ask again/);
  await s.key("Escape");
  await s.wait(/declined/);
  await s.wait(/worked for/);
  expect(readFileSync(join(s.root, "greet.js"), "utf8")).toContain('"hello"');
});

test("edit approval: Tab takes a typed correction and the model is told", async () => {
  s = await open({ steps: [EDIT, reply("Understood.\n")] });
  await s.send("change it");
  await s.wait(/Make this edit\?/);
  await s.key("Tab");
  await s.wait(/What should it do instead\?/);
  await s.send("say good evening");
  const screen = await s.wait(/worked for/);
  expect(screen).toMatch(/you said: say good evening/);
});

test("'don't ask again for edits' holds for the rest of the session", async () => {
  s = await open({ steps: [EDIT, call("edit", { path: "README.md", old_string: "# demo", new_string: "# Demo" }), reply("Both done.\n")] });
  await s.send("change both");
  await s.wait(/Make this edit\?/);
  await s.key("2");
  const screen = await s.wait(/worked for/);
  expect(screen).toMatch(/⏺ edit README\.md/);
  expect(readFileSync(join(s.root, "README.md"), "utf8")).toBe("# Demo\n");
});

test("command approval, collapsed output, and Ctrl+O to see it", async () => {
  s = await open({ steps: [call("bash", { command: "for i in 1 2 3 4 5 6; do echo row $i; done" }), reply("Ran it.\n")] });
  await s.send("run it");
  const panel = await s.wait(/Run this command\?/);
  expect(panel).toMatch(/Run a command/);
  await s.key("1");
  const after = await s.wait(/worked for/);
  expect(after).toMatch(/exit code 0/);
  expect(after).toMatch(/6 lines of output \(ctrl\+o shows them\)/);
  expect(after).not.toMatch(/row 4/);
  await s.key("C-o");
  await s.wait(/row 4/);
});

test("a prefix rule: the second command of the same kind does not ask", async () => {
  s = await open({ steps: [call("bash", { command: "node greet.js" }), call("bash", { command: "node greet.js again" }), reply("Twice.\n")] });
  await s.send("run twice");
  const panel = await s.wait(/Run this command\?/);
  expect(panel).toMatch(/2\. Yes, and don't ask again in this project for: node …/);
  await s.key("2");
  const screen = await s.wait(/worked for/);
  expect(screen.match(/⏺ bash node greet\.js/g)?.length).toBe(2);
});

test("a failing command shows its output and exit code", async () => {
  s = await open({ steps: [call("bash", { command: "echo boom; exit 3" }), reply("It failed.\n")] });
  await s.send("run it");
  await s.wait(/Run this command\?/);
  await s.key("1");
  const screen = await s.wait(/worked for/);
  expect(screen).toMatch(/exit code 3/);
  expect(screen).toMatch(/boom/);
});

// ---- modes ----

test("Shift+Tab cycles ask, auto, plan and back", async () => {
  s = await open();
  await s.key("BTab");
  await s.wait(/⏵⏵ auto/);
  await s.key("BTab");
  await s.wait(/⏸ plan/);
  await s.key("BTab");
  await s.wait(/⏸ ask/);
});

test("auto mode: an edit is applied without asking", async () => {
  s = await open({ args: ["--mode", "auto"], steps: [EDIT, reply("Done.\n")] });
  await s.send("change it");
  const screen = await s.wait(/worked for/);
  expect(screen).toMatch(/⏺ edit greet\.js/);
  expect(readFileSync(join(s.root, "greet.js"), "utf8")).toContain("good morning");
});

test("plan mode: edits are refused, then the plan can be approved and carried out", async () => {
  s = await open({ args: ["--mode", "plan"], steps: [EDIT, reply("Plan: change the greeting.\n"), EDIT, reply("Carried out.\n")] });
  await s.send("change it");
  const asked = await s.wait(/Carry out this plan\?/);
  expect(asked).toMatch(/not run: plan mode/);
  expect(readFileSync(join(s.root, "greet.js"), "utf8")).toContain('"hello"');
  await s.key("1");
  await s.wait(/Carried out\./);
  await s.wait(/⏵⏵ auto/);
  expect(readFileSync(join(s.root, "greet.js"), "utf8")).toContain("good morning");
});

// ---- input ----

test("slash menu filters as you type, and Enter runs the selected command", async () => {
  s = await open();
  await s.type("/");
  const menu = await s.wait(/❯ \/help/);
  expect(menu).toMatch(/\/context/);
  await s.type("co");
  const narrowed = await s.wait(/❯ \/context/);
  expect(narrowed).toMatch(/\/compact/);
  expect(narrowed).not.toMatch(/\/help/);
  await s.key("Enter");
  await s.wait(/of 65536 tokens/);
});

test("@ menu lists files and Tab inserts the path", async () => {
  s = await open();
  await s.type("look at @car");
  await s.wait(/❯ src\/cart\.js/);
  await s.key("Tab");
  await s.wait(/› look at @src\/cart\.js/);
});

test("a message can span lines: backslash-Enter, Ctrl+J, and a multi-line paste", async () => {
  s = await open({ steps: [reply("Got it.\n")] });
  await s.type("first\\");
  await s.key("Enter");
  await s.type("second");
  await s.key("C-j");
  await s.type("third");
  await s.wait(/› first\n\s+second\n\s+third/);
  await s.key("C-u", "C-u", "C-u", "C-u", "C-u");
  await s.key("C-c");
  await s.paste("alpha\nbeta\ngamma");
  await s.wait(/› alpha\n\s+beta\n\s+gamma/);
  await s.key("Enter");
  const screen = await s.wait(/worked for/);
  expect(screen.match(/Got it\./g)?.length).toBe(1);
});

test("Up recalls the previous message; editing keys work", async () => {
  s = await open({ steps: [reply("One.\n")] });
  await s.send("first message");
  await s.wait(/worked for/);
  await s.key("Up");
  await s.wait(/› first message/);
  await s.key("C-w");
  await s.wait(/› first\s*$/m);
  await s.key("C-u");
  await s.wait(/describe a task/);
});

test("! runs a shell command and shows its output", async () => {
  s = await open();
  await s.send("!echo from-the-shell");
  const screen = await s.wait(/exit code 0/);
  expect(screen).toMatch(/from-the-shell/);
});

// ---- while it works ----

test("a message typed during a run is queued, shown, then sent", async () => {
  s = await open({ steps: [{ text: "Working on the first thing now.\n", slow: true }, reply("Second done.\n")] });
  await s.send("first");
  await s.wait(/esc to stop|Working/);
  await s.send("second");
  await s.wait(/queued: second/);
  const screen = await s.wait(/Second done\./, 15000);
  expect(screen).not.toMatch(/queued:/);
});

test("Esc stops a reply in progress and keeps what was written", async () => {
  s = await open({ steps: [{ text: "This is a slow reply that will be cut off before it finishes.\nMore.\n", slow: true }] });
  await s.send("go");
  await s.wait(/This is a slow/);
  await s.key("Escape");
  const screen = await s.wait(/\[interrupted\]/);
  expect(screen).toMatch(/This is a slow/);
  expect(screen).toMatch(/describe a task/);
});

// ---- undo, rewind, sessions ----

test("rewind restores the file and the conversation, and puts the message back in the box", async () => {
  s = await open({ steps: [EDIT, reply("Changed.\n")] });
  await s.send("change the greeting");
  await s.wait(/Make this edit\?/);
  await s.key("1");
  await s.wait(/worked for/);
  await s.key("Escape", "Escape");
  await s.wait(/Go back to before which message\?/);
  await s.key("Enter");
  await s.wait(/What should be restored\?/);
  await s.key("1");
  await s.wait(/› change the greeting/);
  expect(readFileSync(join(s.root, "greet.js"), "utf8")).toContain('"hello"');
});

test("/undo takes back the last turn's files", async () => {
  s = await open({ steps: [call("write", { path: "new.txt", content: "x\n" }), reply("Made it.\n")] });
  await s.send("make a file");
  await s.wait(/Create this file\?/);
  await s.key("1");
  await s.wait(/worked for/);
  expect(existsSync(join(s.root, "new.txt"))).toBe(true);
  await s.send("/undo");
  await s.wait(/Restored: new\.txt/);
  expect(existsSync(join(s.root, "new.txt"))).toBe(false);
});

test("/clear then /resume reopens the earlier session by its first message", async () => {
  s = await open({ steps: [reply("Hello.\n")] });
  await s.send("say hello");
  await s.wait(/worked for/);
  await s.send("/clear");
  await s.wait(/New conversation/);
  await s.send("/resume");
  await s.wait(/Reopen a session[\s\S]*❯ say hello/);
  await s.key("Enter");
  await s.wait(/Reopened "say hello"/);
});

test("/help lists commands and keys", async () => {
  s = await open();
  await s.send("/help");
  const screen = await s.wait(/\/rewind/);
  expect(screen).toMatch(/Shift\+Tab changes mode/);
});

// ---- leaving ----

test("Ctrl+C clears typed text; twice on an empty box quits", async () => {
  s = await open();
  await s.type("half a thought");
  await s.key("C-c");
  await s.wait(/describe a task/);
  await s.key("C-c");
  await s.wait(/press ctrl\+c again to quit/);
  await s.key("C-c");
  await s.wait(/heyho has exited/);
});

test("no server: a plain message says how to start one", async () => {
  const r = Bun.spawnSync(["bun", join(import.meta.dirname, "../src/cli.ts"), "--base-url", "http://127.0.0.1:9/v1", "--plain"], { stdin: "ignore", env: { ...process.env, HEYHO_CTX: "" } });
  expect(r.stderr.toString()).toMatch(/No model server answered[\s\S]*llama-server -m/);
});

// ---- rough handling ----

test("Ctrl+C during an approval stops the run, and the next message works", async () => {
  s = await open({ steps: [EDIT, reply("Second run fine.\n")] });
  await s.send("change it");
  await s.wait(/Make this edit\?/);
  await s.key("C-c");
  await s.wait(/\[interrupted\]/);
  expect(s.screen()).not.toMatch(/Make this edit\?/);
  await s.send("try again");
  await s.wait(/Second run fine\./);
  expect(readFileSync(join(s.root, "greet.js"), "utf8")).toContain('"hello"');
});

test("resizing while an approval is open keeps one panel and it still answers", async () => {
  s = await open({ cols: 110, steps: [EDIT, reply("Changed.\n")] });
  await s.send("change it");
  await s.wait(/Make this edit\?/);
  for (const cols of [70, 100]) await s.resize(cols, 30);
  const screen = s.screen();
  expect(screen.match(/Make this edit\?/g)?.length).toBe(1);
  expect(s.scrollback().match(/change it/g)?.length).toBe(1);
  await s.key("1");
  await s.wait(/worked for/);
});

test("resizing while a reply streams leaves each line once", async () => {
  s = await open({ cols: 110, steps: [{ text: "alpha line\nbravo line\ncharlie line\ndelta line\n", slow: true }] });
  await s.send("go");
  await s.wait(/alpha line/);
  await s.resize(80, 30);
  await s.wait(/worked for/, 15000);
  const all = s.scrollback();
  for (const word of ["alpha", "bravo", "charlie", "delta"]) expect(all.match(new RegExp(`${word} line`, "g"))?.length).toBe(1);
});

test("a very small window still shows the input box", async () => {
  s = await open({ cols: 44, rows: 9, steps: [reply("Short answer.\n")] });
  await s.send("hi");
  await s.wait(/worked for/);
  const screen = s.screen();
  expect(rules(screen)).toBe(2);
  expect(screen.split("\n").every((l) => l.length <= 44)).toBe(true);
});

test("input longer than the window wraps inside the box and is sent whole", async () => {
  const long = "word ".repeat(40).trim();
  s = await open({ cols: 60, steps: [reply("Got it.\n")] });
  await s.type(long);
  expect(rules(s.screen())).toBe(2);
  await s.key("Enter");
  await s.wait(/Got it\./);
  expect(s.scrollback().replace(/\s+/g, " ")).toContain(long);
});

test("wide characters in the input keep the cursor and the text intact", async () => {
  s = await open({ steps: [reply("ok\n")] });
  await s.type("日本語 and émoji 🙂 done");
  await s.wait(/› 日本語 and émoji 🙂 done/);
  await s.key("C-a");
  await s.type("x");
  await s.wait(/› x日本語 and émoji 🙂 done/);
});

test("an unknown command says so and the box keeps working", async () => {
  s = await open({ steps: [reply("Still here.\n")] });
  await s.send("/nonsense");
  await s.wait(/Unknown command \/nonsense/);
  await s.send("hello");
  await s.wait(/Still here\./);
});

test("keys typed while an approval is open do not leak into the next message", async () => {
  s = await open({ steps: [EDIT, reply("Changed.\n")] });
  await s.send("change it");
  await s.wait(/Make this edit\?/);
  await s.type("xyz");
  await s.key("1");
  await s.wait(/worked for/);
  expect(s.screen()).toMatch(/describe a task/);
});

test("a reply with a table, a code block and a long line reads cleanly", async () => {
  const text = "| name | value |\n|---|---|\n| a | 1 |\n\n```js\nconst x = 1;\n```\n\n" + "A sentence that is long enough to need wrapping on this terminal, with several more words after the edge of the screen has passed.\n";
  s = await open({ cols: 70, steps: [reply(text)] });
  await s.send("show me");
  const screen = await s.wait(/worked for/);
  expect(screen).toMatch(/const x = 1;/);
  expect(screen.split("\n").every((l) => l.length <= 70)).toBe(true);
  // No word is cut in two at the right edge.
  expect(screen).not.toMatch(/\bedg\n\s*e\b/);
});

test("the footer is one line at every width from 44 to 130", async () => {
  s = await open({ cols: 130 });
  for (const cols of [130, 110, 95, 90, 84, 72, 60, 50, 44]) {
    await s.resize(cols, 24);
    const screen = s.screen();
    const below = screen.split("\n").slice(screen.split("\n").findLastIndex((l) => /^─{20,}$/.test(l.trim())) + 1).filter((l) => l.trim());
    expect([cols, below.length]).toEqual([cols, 1]);
    expect(below[0]).toMatch(/⏸ ask/);
  }
});

test("a table is drawn with aligned columns and no pipes", async () => {
  s = await open({ steps: [reply("| File | Lines |\n|---|---|\n| src/cart.js | 15 |\n| b.js | 3 |\n\nDone.\n")] });
  await s.send("table please");
  const screen = await s.wait(/worked for/);
  expect(screen).toMatch(/File\s+Lines\n\s+─+\s+─+\n\s+src\/cart\.js\s+15\n\s+b\.js\s+3/);
  expect(screen).not.toMatch(/\|/);
});

// ---- sessions that outlive the process ----

test("rewind still restores a file after heyho is closed and reopened with --continue", async () => {
  s = await open({ steps: [EDIT, reply("Changed.\n")] });
  await s.send("change the greeting");
  await s.wait(/Make this edit\?/);
  await s.key("1");
  await s.wait(/worked for/);
  const root = s.root;
  await s.send("/exit");
  await s.wait(/heyho has exited/);
  s.close();
  expect(readFileSync(join(root, "greet.js"), "utf8")).toContain("good morning");

  s = await open({ root, args: ["--continue"] });
  await s.wait(/Continuing the session/);
  await s.key("Escape", "Escape");
  await s.wait(/Go back to before which message\?[\s\S]*❯ change the greeting/);
  await s.key("Enter");
  await s.wait(/What should be restored\?/);
  await s.key("1");
  await s.wait(/› change the greeting/);
  expect(readFileSync(join(root, "greet.js"), "utf8")).toContain('"hello"');
});

test("a session can be named, is listed under that name, and --resume opens it by name", async () => {
  s = await open({ steps: [reply("Hello.\n")] });
  await s.send("say hello");
  await s.wait(/worked for/);
  await s.send("/rename greeting work");
  await s.wait(/Session named "greeting work"/);
  await s.wait(/greeting work · qwen3-coder/);
  const root = s.root;
  await s.send("/exit");
  await s.wait(/heyho has exited/);
  s.close();

  s = await open({ root, args: ["--resume", "greeting"] });
  await s.wait(/Reopened "greeting work"/);
  await s.wait(/greeting work · qwen3-coder/);
});

test("--resume with no name opens a list that narrows as you type", async () => {
  s = await open({ steps: [reply("One.\n")] });
  await s.send("alpha task");
  await s.wait(/worked for/);
  const root = s.root;
  await s.send("/clear");
  await s.wait(/New conversation/);
  await s.send("bravo task");
  await s.wait(/worked for/);
  await s.send("/exit");
  await s.wait(/heyho has exited/);
  s.close();

  s = await open({ root, args: ["--resume"] });
  const list = await s.wait(/Reopen a session/);
  expect(list).toMatch(/alpha task/);
  expect(list).toMatch(/bravo task/);
  await s.type("alp");
  const narrowed = await s.wait(/Search: alp/);
  expect(narrowed).not.toMatch(/bravo task/);
  await s.key("Enter");
  await s.wait(/Reopened "alpha task"/);
});

test("the mode a session was in comes back when it is reopened", async () => {
  s = await open({ steps: [reply("One.\n")] });
  await s.key("BTab");
  await s.wait(/⏵⏵ auto/);
  await s.send("do a thing");
  await s.wait(/worked for/);
  const root = s.root;
  await s.send("/exit");
  await s.wait(/heyho has exited/);
  s.close();
  s = await open({ root, args: ["--continue"] });
  await s.wait(/⏵⏵ auto/);
});

// ---- input: search, editor, stash ----

test("Ctrl+R searches earlier messages and puts the chosen one in the box", async () => {
  s = await open({ steps: [reply("One.\n"), reply("Two.\n")] });
  await s.send("fix the tax bug");
  await s.wait(/worked for/);
  await s.send("rename the helper");
  await s.wait(/Two\./);
  await s.key("C-r");
  await s.wait(/Earlier messages/);
  await s.type("tax");
  await s.wait(/Search: tax[\s\S]*❯ fix the tax bug/);
  await s.key("Enter");
  await s.wait(/› fix the tax bug/);
});

test("Ctrl+G opens the message in $EDITOR and takes back what was saved", async () => {
  s = await open({ env: { EDITOR: "sh -c 'printf \" plus-editor-text\" >> \"$0\"'" } });
  await s.type("from the box");
  await s.key("C-g");
  await s.wait(/› from the box plus-editor-text/);
  expect(rules(s.screen())).toBe(2);
});

test("Ctrl+S sets a draft aside and brings it back", async () => {
  s = await open();
  await s.type("half written");
  await s.key("C-s");
  await s.wait(/describe a task/);
  await s.key("C-s");
  await s.wait(/› half written/);
});

test("? on an empty box shows the help", async () => {
  s = await open();
  await s.type("?");
  await s.wait(/Ctrl\+R searches history/);
});

// ---- commands ----

test("/export writes the conversation to a file", async () => {
  s = await open({ steps: [reply("The answer is 42.\n")] });
  await s.send("what is the answer");
  await s.wait(/worked for/);
  await s.send("/export out.md");
  await s.wait(/Wrote the conversation to/);
  const text = readFileSync(join(s.root, "out.md"), "utf8");
  expect(text).toMatch(/## You\n\nwhat is the answer/);
  expect(text).toMatch(/## heyho\n\nThe answer is 42\./);
});

test("/copy puts the last reply on the clipboard", async () => {
  s = await open({ steps: [reply("Clipboard check 7781.\n")] });
  await s.send("say it");
  await s.wait(/worked for/);
  await s.send("/copy");
  await s.wait(/Copied the last reply/);
  expect(Bun.spawnSync(["pbpaste"]).stdout.toString()).toContain("Clipboard check 7781.");
});

test("/status shows version, model, folder and session", async () => {
  s = await open();
  await s.send("/status");
  const screen = await s.wait(/heyho v\d[\s\S]*folder:/);
  expect(screen).toMatch(/model: qwen3-coder/);
  expect(screen).toMatch(/mode: ask/);
});
