import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { call, FILES, open, reply, rules } from "./harness.ts";

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
  await s.wait(/Shift\+Tab changes mode/);
  expect(s.scrollback()).toMatch(/\/rewind/); // the list is longer than the window
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

// ---- rules and settings ----

const settings = (o: object) => ({ ...FILES, ".heyho/settings.json": JSON.stringify(o) });

test("a deny rule refuses an edit with no question, and the model is told why", async () => {
  s = await open({ files: settings({ permissions: { deny: ["edit(greet.js)"] } }), steps: [EDIT, reply("I can't change that file.\n")] });
  await s.send("change it");
  const screen = await s.wait(/worked for/);
  expect(screen).toMatch(/Blocked: a rule set by the user forbids this \(edit\(greet\.js\)\)/);
  expect(screen).not.toMatch(/Make this edit\?/);
  expect(readFileSync(join(s.root, "greet.js"), "utf8")).toContain('"hello"');
});

test("a deny rule stops a file being read, and hides it from search", async () => {
  s = await open({
    files: { ...settings({ permissions: { deny: ["read(.env)"] } }), ".env": "SECRET=hunter2\n" },
    steps: [call("read", { path: ".env" }), call("search", { pattern: "SECRET" }), reply("Not allowed.\n")],
  });
  await s.send("show me the env file");
  const screen = await s.wait(/worked for/);
  expect(screen).toMatch(/forbids reading this file \(read\(\.env\)\)/);
  expect(screen).toMatch(/search SECRET\s+No matches\./);
  expect(s.scrollback()).not.toMatch(/hunter2/);
});

test("an allow rule from the project's settings runs a command without asking", async () => {
  s = await open({ args: ["--trust-project"], files: settings({ permissions: { allow: ["bash(node *)"] } }), steps: [BASH, reply("Ran.\n")] });
  await s.send("run it");
  const screen = await s.wait(/worked for/);
  expect(screen).toMatch(/⏺ bash node greet\.js\s+exit code 0/);
  expect(screen).not.toMatch(/Run this command\?/);
});

test("an ask rule asks even in auto mode", async () => {
  s = await open({ args: ["--mode", "auto"], files: settings({ permissions: { ask: ["edit(greet.js)"] } }), steps: [EDIT, reply("Done.\n")] });
  await s.send("change it");
  await s.wait(/Make this edit\?/);
  await s.key("1");
  await s.wait(/worked for/);
});

test("the mode can come from settings; a flag overrides it", async () => {
  s = await open({ files: settings({ mode: "auto" }) });
  await s.wait(/⏵⏵ auto/);
  s.close();
  s = await open({ files: settings({ mode: "auto" }), args: ["--mode", "plan"] });
  await s.wait(/⏸ plan/);
});

test("dontask mode refuses what would have asked, without a question", async () => {
  s = await open({ args: ["--mode", "dontask"], steps: [EDIT, BASH, reply("Could not do either.\n")] });
  await s.wait(/⏵⏵ dontask/);
  await s.send("change it and run it");
  const screen = await s.wait(/worked for/);
  expect(screen.match(/Blocked: this session runs without asking/g)?.length).toBe(2);
  expect(readFileSync(join(s.root, "greet.js"), "utf8")).toContain('"hello"');
});

test("a chained command offers one rule per part that needs one; the next like it runs unasked", async () => {
  s = await open({ steps: [call("bash", { command: "cd . && node greet.js | head -2" }), call("bash", { command: "node greet.js && node greet.js" }), reply("Done.\n")] });
  await s.send("run them");
  const panel = await s.wait(/Run this command\?/);
  expect(panel).toMatch(/2\. Yes, and don't ask again in this project for: node …/);
  await s.key("2");
  const screen = await s.wait(/worked for/);
  expect(screen.match(/exit code 0/g)?.length).toBe(2);
  expect(JSON.parse(readFileSync(join(s.home, "projects", readdirSync(join(s.home, "projects"))[0], "allowed.json"), "utf8"))).toEqual({ allow: ["bash(node *)"] });
});

test("auto mode runs file commands inside the project without asking, but not others", async () => {
  s = await open({ args: ["--mode", "auto"], steps: [call("bash", { command: "mkdir -p out && cp greet.js out/copy.js" }), BASH, reply("Done.\n")] });
  await s.send("copy it and run it");
  await s.wait(/Run this command\?[\s\S]*|Run a command/);
  expect(existsSync(join(s.root, "out/copy.js"))).toBe(true);
  expect(s.screen()).toMatch(/node greet\.js/);
});

test("/permissions adds a deny rule for the session and lists rules with where they come from", async () => {
  s = await open({ args: ["--trust-project"], files: settings({ permissions: { allow: ["bash(node *)"] } }), steps: [BASH, reply("Blocked.\n")] });
  await s.send("/permissions deny bash(node *)");
  const listed = await s.wait(/deny\s+bash\(node \*\)\s+\(this session\)/);
  expect(listed).toMatch(/allow\s+bash\(node \*\)\s+\(project settings\)/);
  await s.send("run it");
  const screen = await s.wait(/worked for/);
  expect(screen).toMatch(/Blocked: a rule set by the user forbids this \(bash\(node \*\)\)/);
});

test("a settings file that is not valid JSON is reported, not fatal", async () => {
  s = await open({ files: { ...FILES, ".heyho/settings.json": "{ oops" } });
  expect(s.screen()).toMatch(/not valid JSON and was ignored/);
});

// ---- instruction files and notes ----

test("/memory lists the instruction files in effect, and the model receives them", async () => {
  s = await open({ files: { ...FILES, "AGENTS.md": "Always answer in French.\n", "AGENTS.local.md": "private\n" }, steps: [reply("Bonjour.\n")] });
  await s.send("/memory");
  const listed = await s.wait(/AGENTS\.md\s+this project/);
  expect(listed).toMatch(/AGENTS\.local\.md\s+yours, this project/);
  await s.send("hello");
  await s.wait(/worked for/);
  const session = readFileSync(join(s.home, "projects", readdirSync(join(s.home, "projects"))[0], "sessions", readdirSync(join(s.home, "projects", readdirSync(join(s.home, "projects"))[0], "sessions"))[0]), "utf8");
  expect(session).toContain("Always answer in French.");
});

test("the agent can write its notes file without being asked, and the next session has them", async () => {
  s = await open({ steps: [reply("ok\n")] });
  await s.send("/status");
  await s.wait(/folder:/);
  const notes = join(s.home, "projects", readdirSync(join(s.home, "projects"))[0], "memory", "NOTES.md");
  const root = s.root;
  s.close();
  s = await open({ root, steps: [call("write", { path: notes, content: "Tests run with npm test.\n" }), reply("Noted.\n")] });
  await s.send("remember how tests run");
  const screen = await s.wait(/worked for/);
  expect(screen).not.toMatch(/Create this file\?/);
  expect(readFileSync(notes, "utf8")).toBe("Tests run with npm test.\n");
  await s.send("/clear");
  await s.send("/memory");
  await s.wait(/NOTES\.md\s+kept by heyho/);
});

test("a subfolder's AGENTS.md is given to the model when a file under it is first read", async () => {
  s = await open({ files: { ...FILES, "src/AGENTS.md": "In src, never use var.\n" }, steps: [call("read", { path: "src/cart.js" }), reply("Read it.\n")] });
  await s.send("read the cart");
  await s.wait(/worked for/);
  const dir = join(s.home, "projects", readdirSync(join(s.home, "projects"))[0], "sessions");
  expect(readFileSync(join(dir, readdirSync(dir)[0]), "utf8")).toContain("In src, never use var.");
});

test("/memory edit opens the chosen file in the editor", async () => {
  s = await open({ env: { EDITOR: "sh -c 'printf \"Prefer small functions.\" >> \"$0\"'" } });
  await s.send("/memory edit project");
  await s.wait(/Saved .*AGENTS\.md/);
  expect(readFileSync(join(s.root, "AGENTS.md"), "utf8")).toBe("Prefer small functions.");
});

// ---- custom commands ----

const COMMAND_FILES = {
  ...FILES,
  ".heyho/commands/review.md": "---\ndescription: review a file for bugs\n---\nReview $ARGUMENTS for bugs and list them.\n",
  ".claude/commands/ship.md": "Run the tests, then summarise what changed.\n",
};

test("a markdown file in .heyho/commands is a slash command: listed in the menu and sent with its arguments", async () => {
  s = await open({ files: COMMAND_FILES, steps: [reply("No bugs.\n")] });
  await s.type("/rev");
  await s.wait(/❯ \/review\s+review a file for bugs/);
  await s.key("Tab");
  await s.send("src/cart.js");
  await s.wait(/worked for/);
  const dir = join(s.home, "projects", readdirSync(join(s.home, "projects"))[0], "sessions");
  expect(readFileSync(join(dir, readdirSync(dir)[0]), "utf8")).toContain("Review src/cart.js for bugs and list them.");
  expect(s.screen()).toMatch(/› \/review src\/cart\.js/);
});

test("commands in .claude/commands work too, and /help lists custom commands", async () => {
  s = await open({ files: COMMAND_FILES, steps: [reply("Shipped.\n")] });
  await s.send("/help");
  const help = await s.wait(/\/ship/);
  expect(help).toMatch(/\/review \[arguments\]\s+review a file for bugs/);
  await s.send("/ship");
  await s.wait(/Shipped\./);
});

// ---- tools beyond the core five ----

test("the model's checklist is shown as it changes, and Ctrl+T hides it", async () => {
  const list = (a: string, b: string) => call("todo", { items: [`[${a}] read the code`, `[${b}] fix the bug`] });
  s = await open({ steps: [list("~", " "), { ...list("x", "~"), slow: true, text: "Working through it now.\n" }, reply("Finished.\n")] });
  await s.send("fix it");
  await s.wait(/◐ read the code\n\s+☐ fix the bug/);
  await s.wait(/☑ read the code\n\s+◐ fix the bug/);
  await s.wait(/Finished\./);
  await s.key("C-t");
  await s.wait(/Finished\.(?![\s\S]*☑)/);
});

test("the model can ask a question: options to pick, or an answer to type", async () => {
  s = await open({ steps: [call("ask", { question: "Which test runner?", options: ["node:test", "vitest"] }), call("ask", { question: "What should the file be called?" }), reply("Using both answers.\n")] });
  await s.send("add tests");
  const asked = await s.wait(/Which test runner\?/);
  expect(asked).toMatch(/❯ 1\. node:test/);
  expect(asked).toMatch(/3\. Something else/);
  await s.key("2");
  await s.wait(/What should the file be called\?[\s\S]*Your answer:/);
  await s.send("cart.test.js");
  await s.wait(/Using both answers\./);
  const requests = JSON.parse(readFileSync(`${s.root}-requests.json`, "utf8")) as { messages: { role: string; content: string }[] }[];
  const answers = requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content);
  expect(answers).toEqual(["The user answered: vitest", "The user answered: cart.test.js"]);
});

test("fetching a page asks first, returns its text, and can be allowed for the host", async () => {
  s = await open({ steps: [call("fetch", { url: "$SERVER/docs" }), call("fetch", { url: "$SERVER/other" }), reply("Read both.\n")] });
  await s.send("read the docs");
  const panel = await s.wait(/Fetch this page\?/);
  expect(panel).toMatch(/Fetch a web page/);
  expect(panel).toMatch(/2\. Yes, and don't ask again in this project for pages on 127\.0\.0\.1/);
  await s.key("2");
  await s.wait(/Read both\./);
  const requests = JSON.parse(readFileSync(`${s.root}-requests.json`, "utf8")) as { messages: { role: string; content: string }[] }[];
  const pages = requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content);
  expect(pages.length).toBe(2);
  expect(pages[0]).toMatch(/^200 OK · http:\/\/127\.0\.0\.1:\d+\/docs\nDocs\nThe answer is 42 & nothing else\.$/);
});

test("a background command shows in the footer and /tasks, can be stopped, and does not outlive heyho", async () => {
  s = await open({ args: ["--mode", "yolo-not-a-mode"].slice(2), steps: [call("bash", { command: "sleep 300", background: true }), reply("Server is up.\n")] });
  await s.send("start the server");
  await s.wait(/Run this command\?/);
  await s.key("1");
  await s.wait(/Server is up\./);
  await s.wait(/1 in background/);
  await s.send("/tasks");
  const listed = await s.wait(/1\s+running\s+sleep 300/);
  const pid = Number(readFileSync(`${s.root}-requests.json`, "utf8").match(/process group (\d+)/)![1]);
  expect(listed).toMatch(/\.log/);
  expect(() => process.kill(pid, 0)).not.toThrow();
  await s.send("/exit");
  await s.wait(/heyho has exited/);
  await new Promise((r) => setTimeout(r, 300));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("/tasks stop ends a background command", async () => {
  s = await open({ steps: [call("bash", { command: "sleep 300", background: true }), reply("Up.\n")] });
  await s.send("start it");
  await s.wait(/Run this command\?/);
  await s.key("1");
  await s.wait(/1 in background/);
  await s.send("/tasks stop 1");
  await s.wait(/Stopped job 1/);
  await s.send("/tasks");
  await s.wait(/1\s+ended\s+sleep 300/);
});

// ---- trust and hooks ----

test("a project with hooks or allow rules asks for trust first; No leaves them off, Yes is remembered", async () => {
  const files = settings({ permissions: { allow: ["bash(node *)"] }, hooks: { PreToolUse: [{ matcher: "bash", command: "touch hook-ran.flag" }] } });
  s = await open({ files, steps: [BASH, reply("Ran.\n")] });
  expect(s.screen()).toMatch(/sets hooks, allow rules or MCP servers/);
  await s.key("2");
  await s.wait(/Left off/);
  await s.send("run it");
  await s.wait(/Run this command\?/);
  expect(existsSync(join(s.root, "hook-ran.flag"))).toBe(false);
  await s.key("Escape");
  const root = s.root;
  s.close();

  s = await open({ root, steps: [BASH, reply("Ran.\n")] });
  await s.key("1");
  await s.wait(/Trusted\./);
  await s.send("/hooks");
  await s.wait(/PreToolUse\s+bash\s+touch hook-ran\.flag/);
  await s.send("run it");
  const screen = await s.wait(/worked for/);
  expect(screen).not.toMatch(/Run this command\?/);
  expect(existsSync(join(root, "hook-ran.flag"))).toBe(true);
  s.close();

  s = await open({ root });
  expect(s.screen()).not.toMatch(/sets hooks, allow rules or MCP servers/);
});

test("a hook that blocks a call is shown in the transcript", async () => {
  s = await open({ args: ["--trust-project"], files: settings({ hooks: { PreToolUse: [{ matcher: "edit", command: "echo frozen >&2; exit 2" }] } }), steps: [EDIT, reply("Okay.\n")] });
  await s.send("change it");
  const screen = await s.wait(/worked for/);
  expect(screen).toMatch(/Blocked by a hook: frozen/);
  expect(screen).not.toMatch(/Make this edit\?/);
});

// ---- look and editing options ----

const CODE = "```ts\nconst total = 42; // the answer\n```\n";
const COLOUR = /\x1b\[(3[0-7]|9[0-7])m/;

test("code in a reply is coloured: keywords, numbers and comments differ from plain text", async () => {
  s = await open({ steps: [reply(CODE)] });
  await s.send("show code");
  await s.wait(/worked for/);
  const line = s.styled().split("\n").find((l) => l.includes("total"))!;
  expect(line).toMatch(/\x1b\[36mconst/);
  expect(line).toMatch(/\x1b\[33m42/);
  expect(line).toMatch(/\x1b\[2m\/\/ the answer/);
});

test("NO_COLOR, or \"theme\": \"none\" in settings, turns colour off", async () => {
  s = await open({ env: { NO_COLOR: "1" }, steps: [reply(CODE)] });
  await s.send("show code");
  await s.wait(/worked for/);
  expect(s.styled()).not.toMatch(COLOUR);
  s.close();
  s = await open({ home: { "settings.json": JSON.stringify({ theme: "none" }) }, steps: [reply(CODE)] });
  await s.send("show code");
  await s.wait(/worked for/);
  expect(s.styled()).not.toMatch(COLOUR);
  expect(s.screen()).toMatch(/const total = 42;/);
});

test("vim keys: Esc enters normal mode, motions and deletes work, i returns to typing", async () => {
  s = await open({ home: { "settings.json": JSON.stringify({ editorMode: "vim" }) }, steps: [reply("ok\n")] });
  await s.wait(/-- INSERT --/);
  await s.type("fix the bug");
  await s.key("Escape");
  await s.wait(/-- NORMAL --/);
  await s.type("0wdw");
  await s.wait(/› fix bug/);
  await s.type("A");
  await s.wait(/-- INSERT --/);
  await s.type(" now");
  await s.wait(/› fix bug now/);
  await s.key("Escape");
  await s.type("dd");
  await s.wait(/describe a task/);
  await s.type("ihello");
  await s.key("Enter");
  await s.wait(/› hello[\s\S]*worked for/);
});

test("without the setting, letters after Esc are just text", async () => {
  s = await open();
  await s.type("abc");
  await s.key("Escape");
  await s.type("dd");
  await s.wait(/› abcdd/);
});

test("a status line command's output replaces the right of the footer and follows the mode", async () => {
  s = await open({ home: { "settings.json": JSON.stringify({ statusLine: { command: "grep -o '\"mode\":\"[a-z]*\"' | tr -d '\"' | sed 's/^/my line · /'" } }) } });
  await s.wait(/my line · mode:ask/);
  await s.key("BTab");
  await s.wait(/my line · mode:auto/);
  expect(s.screen()).not.toMatch(/% context/);
});
