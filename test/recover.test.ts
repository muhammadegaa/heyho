import { expect, test } from "bun:test";
import { LoopGuard, normalizeArgs, parseArgs, textToolCalls, toolName } from "../src/recover.ts";
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
  expect(parseArgs("read the file a.ts")).toContain("must be a JSON object");
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

test("parses Qwen XML tool calls written as text, with or without the opening tag", () => {
  // Verbatim from eval run 05-py-rename-2 (qwen3-coder on llama-server b9140).
  const content =
    "I need to rename the function `parse_qty` to `parse_quantity` throughout the project. Let me start by finding all occurrences of this function.\n\n<function=search>\n<parameter=pattern>\ndef parse_qty\n</parameter>\n</function>\n</tool_call>";
  expect(textToolCalls(content)).toEqual({
    calls: [{ name: "search", args: { pattern: "def parse_qty" } }],
    rest: "I need to rename the function `parse_qty` to `parse_quantity` throughout the project. Let me start by finding all occurrences of this function.",
  });
  const two = "<tool_call>\n<function=read>\n<parameter=path>\na.ts\n</parameter>\n<parameter=offset>\n10\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=bash>\n<parameter=command>\nbun test\n</parameter>\n</function>\n</tool_call>";
  expect(textToolCalls(two)?.calls).toEqual([
    { name: "read", args: { path: "a.ts", offset: "10" } },
    { name: "bash", args: { command: "bun test" } },
  ]);
});

test("parses JSON tool calls in tool_call tags or as the whole reply", () => {
  expect(textToolCalls('Checking.\n<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>')).toEqual({
    calls: [{ name: "read", args: { path: "a.ts" } }],
    rest: "Checking.",
  });
  expect(textToolCalls('```json\n{"name": "bash", "arguments": {"command": "ls"}}\n```')?.calls).toEqual([{ name: "bash", args: { command: "ls" } }]);
  expect(textToolCalls('Use {"name": "x"} in config files.')).toBeNull();
  expect(textToolCalls("All done, tests pass.")).toBeNull();
});

test("loop guard counts consecutive identical calls only", () => {
  const g = new LoopGuard();
  expect(g.see("bash", { command: "make test" })).toBe(1);
  expect(g.see("bash", { command: "make test" })).toBe(2);
  expect(g.see("read", { path: "a" })).toBe(1);
  expect(g.see("bash", { command: "make test" })).toBe(1);
});
