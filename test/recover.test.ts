import { expect, test } from "bun:test";
import { looksLikeTextToolCall, LoopGuard, normalizeArgs, parseArgs, toolName } from "../src/recover.ts";
import { edit } from "../src/tools/edit.ts";
import { read } from "../src/tools/read.ts";

test("tool name aliases", () => {
  expect(toolName("shell")).toBe("bash");
  expect(toolName("str_replace")).toBe("edit");
  expect(toolName("Read_File")).toBe("read");
});

test("parseArgs repairs JSON and refuses garbage", () => {
  expect(parseArgs('{"path": "a.ts",}')).toEqual({ args: { path: "a.ts" }, repaired: true });
  expect(parseArgs('"{\\"path\\": \\"a.ts\\"}"')).toEqual({ args: { path: "a.ts" }, repaired: false });
  expect(parseArgs("")).toEqual({ args: {}, repaired: false });
  expect(typeof parseArgs("[1,2]")).toBe("string");
});

test("normalizeArgs maps aliases, converts scalars, reports missing keys", () => {
  expect(normalizeArgs(read, { file_path: "a.ts", offset: "10" })).toEqual({ path: "a.ts", offset: 10 });
  expect(normalizeArgs(edit, { filePath: "a", oldString: "x", newString: "y", replaceAll: "true" })).toEqual({
    path: "a",
    old_string: "x",
    new_string: "y",
    replace_all: true,
  });
  expect(normalizeArgs(edit, { path: "a", old_string: "x" })).toContain('Missing required argument "new_string"');
});

test("text tool call detection", () => {
  expect(looksLikeTextToolCall('<tool_call>\n<function=read>\n<parameter=path>a</parameter>')).toBe(true);
  expect(looksLikeTextToolCall("All done, tests pass.")).toBe(false);
});

test("loop guard counts consecutive identical calls only", () => {
  const g = new LoopGuard();
  expect(g.see("bash", { command: "make test" })).toBe(1);
  expect(g.see("bash", { command: "make test" })).toBe(2);
  expect(g.see("read", { path: "a" })).toBe(1);
  expect(g.see("bash", { command: "make test" })).toBe(1);
});
