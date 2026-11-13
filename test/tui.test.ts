import { expect, test } from "bun:test";
import { at, atToken, backspace, EMPTY, insert, killToStart, killWord, rank, replaceToken, vertical } from "../src/tui/edit.ts";
import { Store } from "../src/tui/store.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("typing, deleting and killing text move the cursor with the text", () => {
  let e = insert(EMPTY, "fix the bug");
  e = insert({ ...e, cursor: 4 }, "all ");
  expect(e).toEqual({ value: "fix all the bug", cursor: 8 });
  expect(backspace(e)).toEqual({ value: "fix allthe bug", cursor: 7 });
  expect(killWord(at("run src/cart.js"))).toEqual({ value: "run src/", cursor: 8 });
  expect(killToStart({ value: "one\ntwo three", cursor: 7 })).toEqual({ value: "one\n three", cursor: 4 });
});

test("up and down move inside a multi-line message and report its edges", () => {
  const e = { value: "first line\nab\nthird", cursor: 8 };
  expect(vertical(e, -1)).toBeNull();
  expect(vertical(e, 1)).toEqual({ ...e, cursor: 13 }); // shorter line: end of it
  expect(vertical({ ...e, cursor: 13 }, 1)).toEqual({ ...e, cursor: 16 });
  expect(vertical({ ...e, cursor: 16 }, 1)).toBeNull();
});

test("an @ token at the cursor is found and replaced", () => {
  const e = at("look at @src/ca");
  expect(atToken(e)).toEqual({ start: 8, query: "src/ca" });
  expect(replaceToken(e, 8, "@src/cart.js ")).toEqual(at("look at @src/cart.js "));
  expect(atToken(at("mail a@b"))).toBeNull();
  expect(rank(["test/cart.test.js", "src/cart.js", "README.md"], "cart", 5)).toEqual(["test/cart.test.js", "src/cart.js"]);
  expect(rank(["help", "clear", "compact", "context"], "co", 5)).toEqual(["compact", "context"]);
});

test("a reply becomes transcript lines as each line completes; the rest stays live", () => {
  const s = new Store();
  s.onEvent({ type: "request", step: 1 });
  expect(s.live.activity?.label).toBe("waiting for the model");
  s.onEvent({ type: "text", text: "First **line**.\nSecond li" });
  expect(s.items.map((i) => plain(i.text))).toEqual(["First line."]);
  expect(s.items[0].mark).toBe("⏺");
  expect(s.live.partial).toBe("Second li");
  expect(s.live.activity).toBeNull();
  s.onEvent({ type: "text", text: "ne" });
  s.onEvent({ type: "turn", step: 1, usage: { prompt: 1, cached: 0, completion: 1 }, ms: 1 });
  expect(s.items.map((i) => plain(i.text))).toEqual(["First line.", "Second line"]);
  expect(s.live.partial).toBe("");
});

test("an edit is shown with its numbered diff; a passing command hides long output until asked", () => {
  const s = new Store();
  s.onEvent({ type: "tool_start", name: "edit", args: { path: "a.js" } });
  s.changed({ path: "a.js", before: "one\ntwo\n", after: "one\n2\n" });
  s.onEvent({ type: "tool", name: "edit", args: { path: "a.js" }, result: { ok: true, text: "Edited a.js" } });
  expect(plain(s.items[0].text)).toBe("edit a.js  +1 −1\n1   one\n2 - two\n2 + 2");
  s.onEvent({ type: "tool_start", name: "bash", args: { command: "npm test" } });
  s.onEvent({ type: "tool", name: "bash", args: { command: "npm test" }, result: { ok: true, text: "exit code 0\n" + Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n") } });
  expect(plain(s.items[1].text)).toMatch(/^bash npm test  exit code 0 · [\d.]+ s\n9 lines of output \(ctrl\+o shows them\)$/);
  s.expandOutput();
  expect(plain(s.items[2].text).split("\n").length).toBe(10);
});

test("an approval waits for an answer and then lets the work continue", async () => {
  const s = new Store();
  s.onEvent({ type: "tool_start", name: "bash", args: { command: "npm test" } });
  const answer = s.ask({ kind: "bash", summary: "npm test", prefix: "npm test" });
  expect(s.live.pending?.request.summary).toBe("npm test");
  expect(s.live.activity).toBeNull();
  s.live.pending!.resolve("prefix");
  expect(await answer).toBe("prefix");
  expect(s.live.pending).toBeNull();
  expect(s.live.activity?.label).toBe("running npm test");
});

test("vim normal mode: counts, the e motion, copy and paste, and undo", async () => {
  const { normalKey } = await import("../src/tui/vim.ts");
  type S = NonNullable<ReturnType<typeof normalKey>>;
  const run = (value: string, cursor: number, keys: string) => {
    let s: S = { edit: { value, cursor }, insert: false, pending: "" };
    for (const k of keys) s = normalKey(s, k)!;
    return s;
  };
  expect(run("one two three four", 0, "3w").edit.cursor).toBe(14);
  expect(run("one two three four", 0, "e").edit.cursor).toBe(2);
  expect(run("one two three four", 0, "2e").edit.cursor).toBe(6);
  expect(run("one two three four", 0, "d2w").edit.value).toBe("three four");
  expect(run("one two three four", 0, "2dw").edit.value).toBe("three four");
  expect(run("one two three four", 4, "de").edit.value).toBe("one  three four");
  expect(run("one two three four", 0, "3x").edit.value).toBe(" two three four");
  expect(run("a\nb\nc\nd", 2, "2dd").edit).toEqual({ value: "a\nd", cursor: 2 });
  expect(run("a\nb\nc", 4, "dd").edit.value).toBe("a\nb");
  expect(run("one two", 0, "c2w")).toMatchObject({ edit: { value: "", cursor: 0 }, insert: true });
  // The count 10 uses 0 as a digit; a lone 0 is still "start of line".
  expect(run("abcdefghijklmnop", 0, "10l").edit.cursor).toBe(10);
  expect(run("abc", 2, "0").edit.cursor).toBe(0);
  // Copy a word and paste it; cut a line and paste it below another.
  expect(run("one two", 0, "yw$p").edit.value).toBe("one twoone ");
  expect(run("a\nb\nc", 0, "ddp").edit.value).toBe("b\na\nc");
  expect(run("a\nb", 0, "yyP").edit.value).toBe("a\na\nb");
  expect(run("abc", 0, "xp").edit.value).toBe("bac");
  // u takes back changes one at a time, and does nothing when there are none.
  expect(run("one two three", 0, "dwdwu").edit.value).toBe("two three");
  expect(run("one two three", 0, "dwdwuu").edit.value).toBe("one two three");
  expect(run("one", 0, "u").edit.value).toBe("one");
});

test("vim normal mode: moving, entering insert, deleting and changing", async () => {
  const { normalKey } = await import("../src/tui/vim.ts");
  const run = (value: string, cursor: number, keys: string) => {
    let s = { edit: { value, cursor }, insert: false, pending: "" };
    for (const k of keys) s = normalKey(s, k)!;
    return s;
  };
  expect(run("fix the bug", 0, "w").edit.cursor).toBe(4);
  expect(run("fix the bug", 0, "ww").edit.cursor).toBe(8);
  expect(run("fix the bug", 8, "b").edit.cursor).toBe(4);
  expect(run("fix the bug", 5, "0").edit.cursor).toBe(0);
  expect(run("fix the bug", 0, "$").edit.cursor).toBe(11);
  expect(run("fix the bug", 4, "dw").edit).toEqual({ value: "fix bug", cursor: 4 });
  expect(run("fix the bug", 4, "cw")).toMatchObject({ edit: { value: "fix  bug", cursor: 4 }, insert: true, pending: "" });
  expect(run("fix the bug", 4, "x").edit.value).toBe("fix he bug");
  expect(run("fix the bug", 4, "D").edit.value).toBe("fix ");
  expect(run("one\ntwo\nthree", 5, "dd").edit).toEqual({ value: "one\nthree", cursor: 4 });
  expect(run("one", 1, "A")).toMatchObject({ edit: { cursor: 3 }, insert: true });
  expect(run("one", 1, "o")).toMatchObject({ edit: { value: "one\n", cursor: 4 }, insert: true });
  expect(run("one", 1, "d").pending).toBe("d");
  expect(normalKey({ edit: { value: "one", cursor: 1 }, insert: false, pending: "" }, "k")).toBeNull();
});

test("code is coloured by rough rules: comments, strings, numbers, keywords", async () => {
  const { highlight } = await import("../src/highlight.ts");
  const tag: Record<string, (s: string) => string> = { dim: (s) => `<c>${s}</c>`, green: (s) => `<s>${s}</s>`, yellow: (s) => `<n>${s}</n>`, cyan: (s) => `<k>${s}</k>`, red: (s) => s, bold: (s) => s };
  const paint = tag as unknown as Parameters<typeof highlight>[2];
  expect(highlight('const x = "a // b"; // note 1', "ts", paint)).toBe('<k>const</k> x = <s>"a // b"</s>; <c>// note 1</c>');
  expect(highlight("def f(n): return n + 42  # add", "python", paint)).toBe("<k>def</k> f(n): <k>return</k> n + <n>42</n>  <c># add</c>");
  expect(highlight("return the 3 files", "text", paint)).toBe("return the <n>3</n> files");
  expect(highlight("#include <x>", "c", paint)).toBe("#include <x>");
});
