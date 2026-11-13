import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { bash } from "../src/tools/bash.ts";
import { edit, locate } from "../src/tools/edit.ts";
import { read } from "../src/tools/read.ts";
import { search } from "../src/tools/search.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { write } from "../src/tools/write.ts";

let ctx: ToolContext;
const w = (p: string, s: string) => writeFileSync(join(ctx.root, p), s);
const r = (p: string) => readFileSync(join(ctx.root, p), "utf8");

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "heyho-test-")));
  const stateDir = mkdtempSync(join(tmpdir(), "heyho-state-"));
  ctx = { root, stateDir, seen: new Map(), approve: async () => true, sandbox: { enabled: false, noNet: false }, outCount: { n: 0 }, jobs: [] };
});

describe("read", () => {
  test("a notes file that is not there yet says to create it, not to go looking for it", async () => {
    // Qwen3.6, asked to remember something, read the missing file and then ran find, mkdir and ls.
    ctx.notesFile = join(ctx.stateDir, "memory", "NOTES.md");
    const res = await read.run({ path: ctx.notesFile }, ctx);
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/no notes yet/i);
    expect(res.text).toMatch(/write/);
    expect(res.text).not.toMatch(/glob/);
  });

  test("numbers lines and pages", async () => {
    w("a.txt", Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const first = await read.run({ path: "a.txt" }, ctx);
    expect(first.text).toContain("1: line 1\n");
    expect(first.text).toContain("[lines 1-250 of 300; continue with offset=251]");
    const next = await read.run({ path: "a.txt", offset: 251 }, ctx);
    expect(next.text).toContain("300: line 300");
    expect(next.text).toContain("[end of file, 300 lines]");
  });
  test("refuses paths outside the workspace, including through symlinks", async () => {
    await expect(read.run({ path: "../../etc/passwd" }, ctx)).rejects.toThrow("outside the working directory");
    symlinkSync("/etc", join(ctx.root, "link"));
    await expect(read.run({ path: "link/hosts" }, ctx)).rejects.toThrow("outside the working directory");
  });
  test("refuses to write through a symlink to a missing file", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "heyho-outside-")), "target.txt");
    symlinkSync(target, join(ctx.root, "dangling.txt"));
    await expect(write.run({ path: "dangling.txt", content: "x" }, ctx)).rejects.toThrow("symlink to a missing file");
    expect(existsSync(target)).toBe(false);
  });
  test("accepts names that start with two dots", async () => {
    w("..env", "A=1\n");
    expect((await read.run({ path: "..env" }, ctx)).text).toContain("1: A=1");
  });
  test("may read heyho's state dir", async () => {
    writeFileSync(join(ctx.stateDir, "1.log"), "saved output");
    expect((await read.run({ path: join(ctx.stateDir, "1.log") }, ctx)).text).toContain("1: saved output");
  });
});

describe("edit", () => {
  test("edits an unread file; refuses one that changed since it was read", async () => {
    w("f.py", "x = 1\n");
    expect((await edit.run({ path: "f.py", old_string: "x = 1", new_string: "x = 2" }, ctx)).ok).toBe(true);
    expect(r("f.py")).toBe("x = 2\n");
    await read.run({ path: "f.py" }, ctx);
    w("f.py", "x = 2\ny = 2\n");
    utimesSync(join(ctx.root, "f.py"), new Date(), new Date(Date.now() + 5000));
    expect((await edit.run({ path: "f.py", old_string: "x = 2", new_string: "x = 3" }, ctx)).text).toContain("changed on disk");
  });
  test("exact replace and diff", async () => {
    w("f.py", "def f():\n    return 1\n");
    await read.run({ path: "f.py" }, ctx);
    const res = await edit.run({ path: "f.py", old_string: "return 1", new_string: "return 2" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.text).toContain("@@ line 2");
    expect(r("f.py")).toBe("def f():\n    return 2\n");
  });
  test("ambiguous match lists lines; replace_all replaces all", async () => {
    w("f.py", "a = 0\nb = 0\na = 0\n");
    await read.run({ path: "f.py" }, ctx);
    const amb = await edit.run({ path: "f.py", old_string: "a = 0", new_string: "a = 1" }, ctx);
    expect(amb.text).toContain("Found 2 matches");
    expect(amb.text).toContain("lines 1, 3");
    expect((await edit.run({ path: "f.py", old_string: "a = 0", new_string: "a = 1", replace_all: true }, ctx)).ok).toBe(true);
    expect(r("f.py")).toBe("a = 1\nb = 0\na = 1\n");
  });
  test("typographic quotes normalized", () => {
    const { ranges, tier } = locate("say('hi') — ok", "say(‘hi’) - ok");
    expect(ranges).toEqual([[0, 14]]);
    expect(tier).toContain("quotes");
  });
  test("trailing whitespace ignored, line-based", async () => {
    w("f.py", "if x:   \n    y()  \nz()\n");
    await read.run({ path: "f.py" }, ctx);
    const res = await edit.run({ path: "f.py", old_string: "if x:\n    y()\n", new_string: "if x:\n    w()\n" }, ctx);
    expect(res.text).toContain("trailing whitespace");
    expect(r("f.py")).toBe("if x:\n    w()\nz()\n");
  });
  test("miss shows closest lines, or says already applied", async () => {
    w("f.py", "import os\n\ndef load(path):\n    with open(path) as f:\n        return f.read()\n");
    await read.run({ path: "f.py" }, ctx);
    const miss = await edit.run({ path: "f.py", old_string: "def load(path):\n    with open(path, 'r') as f:", new_string: "x" }, ctx);
    expect(miss.ok).toBe(false);
    expect(miss.text).toContain("3: def load(path):");
    const applied = await edit.run({ path: "f.py", old_string: "nope", new_string: "import os" }, ctx);
    expect(applied.text).toContain("may already be applied");
    const deletion = await edit.run({ path: "f.py", old_string: "def load(path):\n    with open(path, 'r') as f:", new_string: "" }, ctx);
    expect(deletion.text).toContain("3: def load(path):");
  });
  test("keeps CRLF line endings", async () => {
    w("f.txt", "a\r\nb\r\n");
    await read.run({ path: "f.txt" }, ctx);
    await edit.run({ path: "f.txt", old_string: "a\nb", new_string: "a\nc" }, ctx);
    expect(r("f.txt")).toBe("a\r\nc\r\n");
  });
  test("denied approval leaves the file alone", async () => {
    w("f.py", "x = 1\n");
    await read.run({ path: "f.py" }, ctx);
    ctx.approve = async () => false;
    expect((await edit.run({ path: "f.py", old_string: "x = 1", new_string: "x = 2" }, ctx)).text).toContain("declined");
    expect(r("f.py")).toBe("x = 1\n");
  });
});

describe("write", () => {
  test("creates files and parent dirs; overwrite needs a read", async () => {
    expect((await write.run({ path: "src/new.ts", content: "export {}\n" }, ctx)).text).toContain("Created src/new.ts");
    w("old.txt", "x");
    expect((await write.run({ path: "old.txt", content: "y" }, ctx)).text).toContain("Read old.txt before");
  });
});

describe("bash", () => {
  test("exit code and output", async () => {
    const res = await bash.run({ command: "echo hi; echo err >&2; exit 3" }, ctx);
    expect(res.text).toStartWith("exit code 3\n");
    expect(res.text).toContain("hi");
    expect(res.text).toContain("err");
  });
  test("timeout kills the process group", async () => {
    const t0 = Date.now();
    const res = await bash.run({ command: "sleep 30", timeout: 1 }, ctx);
    expect(res.text).toContain("timed out after 1 s");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  test("does not hang on a backgrounded process", async () => {
    const t0 = Date.now();
    const res = await bash.run({ command: "sleep 30 & echo started" }, ctx);
    expect(res.text).toContain("started");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  test("long output is cut and saved", async () => {
    const res = await bash.run({ command: "seq 1 20000" }, ctx);
    expect(res.text).toContain("characters omitted. Full output:");
    expect(res.text).toContain("\n20000");
    expect(res.text.length).toBeLessThan(9000);
  });
  test("sandbox blocks writes outside the workspace and allows inside", async () => {
    ctx.sandbox.enabled = true;
    const outside = join(homedir(), `.heyho-sandbox-test-${Date.now()}`);
    mkdirSync(outside);
    try {
      const res = await bash.run({ command: `touch inside.txt && touch ${outside}/x` }, ctx);
      expect(res.text).toContain("Operation not permitted");
      expect(r("inside.txt")).toBe("");
      expect(existsSync(join(outside, "x"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true });
    }
  });
  test("sandbox --no-net blocks network", async () => {
    const server = createServer((_, res) => res.end("pong"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const command = `curl -sS -m 3 http://127.0.0.1:${(server.address() as { port: number }).port}/ || true`;
    try {
      ctx.sandbox = { enabled: true, noNet: false };
      expect((await bash.run({ command }, ctx)).text).toContain("pong");
      ctx.sandbox = { enabled: true, noNet: true };
      expect((await bash.run({ command }, ctx)).text).not.toContain("pong");
    } finally {
      server.close();
    }
  });
});

describe("search", () => {
  test("content search and glob listing, gitignore-aware", async () => {
    w("a.ts", "export function parseDate() {}\n");
    w("b.py", "def parse_date(): pass\n");
    w(".gitignore", "ignored/\n");
    mkdirSync(join(ctx.root, "ignored"));
    w("ignored/c.ts", "parseDate\n");
    spawnSync("git", ["init", "-q"], { cwd: ctx.root });
    const res = await search.run({ pattern: "parse_?[dD]ate" }, ctx);
    expect(res.text).toContain("a.ts:1:");
    expect(res.text).toContain("b.py:1:");
    expect(res.text).not.toContain("ignored");
    const files = await search.run({ glob: "*.ts" }, ctx);
    expect(files.text.trim()).toBe("a.ts");
  });
});
