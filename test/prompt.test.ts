import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderInstructions, instructions, systemPrompt } from "../src/prompt.ts";

let top: string;
let root: string;
beforeEach(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), "heyho-test-")));
  root = join(top, "work", "repo");
  mkdirSync(join(root, "pkg", "api"), { recursive: true });
  process.env.HEYHO_HOME = join(top, "home");
  mkdirSync(process.env.HEYHO_HOME);
});
afterEach(() => delete process.env.HEYHO_HOME);

test("instruction files load most general first: yours, folders above, the project, your private one, notes", () => {
  writeFileSync(join(top, "home", "AGENTS.md"), "user rule");
  writeFileSync(join(top, "work", "CLAUDE.md"), "parent rule");
  writeFileSync(join(root, "AGENTS.md"), "project rule");
  writeFileSync(join(root, "CLAUDE.md"), "ignored: AGENTS.md wins in the same folder");
  writeFileSync(join(root, "AGENTS.local.md"), "private rule");
  const notes = join(top, "home", "NOTES.md");
  writeFileSync(notes, "a note");
  const { text, files } = instructions(root, notes);
  expect(files.map((f) => f.scope)).toEqual(["user", "parent", "project", "local", "notes"]);
  const order = ["user rule", "parent rule", "project rule", "private rule", "a note"].map((t) => text.indexOf(t));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect(text).not.toContain("ignored:");
  expect(systemPrompt(root, new Date("2026-01-01"), notes)).toContain(`Notes file: ${notes}`);
});

test("a line that is only @file is replaced by the file; a loop stops", () => {
  writeFileSync(join(root, "AGENTS.md"), "top\n@docs/style.md\nmention @docs/style.md inline stays\n");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "style.md"), "use tabs\n@../AGENTS.md\n@missing.md\n");
  const { text } = instructions(root);
  expect(text).toContain("top\nuse tabs\n");
  expect(text).toContain("mention @docs/style.md inline stays");
  expect(text).toContain("@missing.md");
  expect(text.match(/use tabs/g)?.length).toBe(1);
});

test("long files are cut, and the total is capped", () => {
  writeFileSync(join(top, "home", "AGENTS.md"), "u".repeat(5000));
  writeFileSync(join(top, "work", "AGENTS.md"), "p".repeat(5000));
  writeFileSync(join(root, "AGENTS.md"), "r".repeat(5000));
  const { text, files } = instructions(root);
  expect(files.every((f) => f.cut)).toBe(true);
  expect(text.match(/u{100,}/)![0].length).toBe(4000);
  expect(text.match(/r{100,}/)![0].length).toBe(2000); // what was left of the total
});

test("a subfolder's instructions come with the first file read under it, once", () => {
  writeFileSync(join(root, "AGENTS.md"), "root rule");
  writeFileSync(join(root, "pkg", "AGENTS.md"), "pkg rule");
  writeFileSync(join(root, "pkg", "api", "CLAUDE.md"), "api rule");
  const given = new Set<string>();
  const first = folderInstructions(root, join(root, "pkg", "api", "handler.ts"), given);
  expect(first).toMatch(/pkg rule[\s\S]*api rule/);
  expect(first).not.toContain("root rule");
  expect(folderInstructions(root, join(root, "pkg", "api", "other.ts"), given)).toBe("");
  expect(folderInstructions(root, join(root, "main.ts"), given)).toBe("");
});
