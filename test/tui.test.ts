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
