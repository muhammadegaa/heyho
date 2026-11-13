// Hooks: the user's own commands run at fixed points, set in settings.json. A hook gets the
// event as JSON on stdin. Exit 0 lets things go on; exit 2 blocks, and its stderr is passed on.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { call, FILES, reply, type Step } from "./harness.ts";

const demo = join(import.meta.dirname, "../scripts/ui-demo.ts");

function run(args: string[], hooks: object, steps: Step[], extra: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "heyho-e2e-")));
  const files = { ...FILES, ".heyho/settings.json": JSON.stringify({ hooks }), ...extra };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  writeFileSync(`${root}-steps.json`, JSON.stringify(steps));
  const r = Bun.spawnSync(["bun", demo, "--yolo", "--trust-project", ...args], { stdin: "ignore", env: { ...process.env, DEMO_STEPS: `${root}-steps.json`, DEMO_ROOT: root, DEMO_FAST: "1", HEYHO_HOME: `${root}-home` } });
  const requests = () => JSON.parse(readFileSync(`${root}-requests.json`, "utf8")) as { messages: { role: string; content: string }[] }[];
  return { root, out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode, requests, last: () => requests().at(-1)!.messages };
}

const EDIT = call("edit", { path: "greet.js", old_string: '"hello"', new_string: '"good morning"' });

test("a PreToolUse hook that exits 2 blocks the call, and its message reaches the model", () => {
  const r = run(["change it"], { PreToolUse: [{ matcher: "edit", command: "echo 'greet.js is frozen this week' >&2; exit 2" }] }, [EDIT, reply("Understood.\n")]);
  expect(readFileSync(join(r.root, "greet.js"), "utf8")).toContain('"hello"');
  expect(r.last().find((m) => m.role === "tool")!.content).toBe("Not run: a hook the user set up blocked it: greet.js is frozen this week");
});

test("a hook gets the event as JSON on stdin, and exit 0 lets the call run", () => {
  const r = run(["change it"], { PreToolUse: [{ matcher: "edit|write", command: "cat > hook-input.json" }] }, [EDIT, reply("Done.\n")]);
  expect(readFileSync(join(r.root, "greet.js"), "utf8")).toContain("good morning");
  const input = JSON.parse(readFileSync(join(r.root, "hook-input.json"), "utf8"));
  expect(input).toMatchObject({ event: "PreToolUse", tool: "edit", args: { path: "greet.js" }, cwd: r.root });
});

test("a matcher limits a hook to the tools it names; no matcher means every tool", () => {
  const r = run(["do both"], { PreToolUse: [{ matcher: "bash", command: "echo bash >> seen.txt" }, { command: "echo any >> seen.txt" }] }, [call("read", { path: "greet.js" }), call("bash", { command: "true" }), reply("Done.\n")]);
  expect(readFileSync(join(r.root, "seen.txt"), "utf8")).toBe("any\nbash\nany\n");
});

test("a PostToolUse hook runs after the call; exit 2 adds its message to the result", () => {
  const r = run(["change it"], { PostToolUse: [{ matcher: "edit", command: "grep -q morning greet.js && echo 'lint: greeting must be lowercase hello' >&2 && exit 2" }] }, [EDIT, reply("Fixing.\n")]);
  const result = r.last().find((m) => m.role === "tool")!.content;
  expect(result).toMatch(/^Edited greet\.js/);
  expect(result).toMatch(/A hook reported: lint: greeting must be lowercase hello$/);
});

test("a UserPromptSubmit hook can add context to the message, or refuse it", () => {
  const added = run(["what branch"], { UserPromptSubmit: [{ command: "echo 'Ticket: HEY-42'" }] }, [reply("ok\n")]);
  expect(added.last().findLast((m) => m.role === "user")!.content).toBe("what branch\n\n[Added by a hook: Ticket: HEY-42]");
  const refused = run(["deploy to prod"], { UserPromptSubmit: [{ command: "grep -q prod && echo 'no prod from here' >&2 && exit 2 || exit 0" }] }, [reply("should not run\n")]);
  expect(refused.err).toMatch(/A hook refused this message: no prod from here/);
  expect(existsSync(`${refused.root}-requests.json`)).toBe(false);
  expect(refused.code).toBe(1);
});

test("a Stop hook that exits 2 sends the model back to work, at most three times", () => {
  const once = run(["finish up"], { Stop: [{ command: "test -f done.flag || { touch done.flag; echo 'run the tests before you stop' >&2; exit 2; }" }] }, [reply("All done.\n"), reply("Tests run. Done.\n")]);
  expect(once.out).toContain("Tests run. Done.");
  expect(once.last().findLast((m) => m.role === "user")!.content).toBe("[A hook did not accept stopping: run the tests before you stop]");
  const always = run(["finish up"], { Stop: [{ command: "echo never >&2; exit 2" }] }, Array.from({ length: 8 }, (_, i) => reply(`Try ${i}.\n`)));
  expect(always.requests().length).toBe(4);
});

test("a SessionStart hook's output is given to the model with the first message", () => {
  const r = run(["hello"], { SessionStart: [{ command: "echo 'Node 24, pnpm workspace'" }] }, [reply("hi\n")]);
  expect(r.last().find((m) => m.role === "user")!.content).toBe("[Added by a hook at the start: Node 24, pnpm workspace]\n\nhello");
});

test("Claude Code's nested hook format is read as well", () => {
  const r = run(["change it"], { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo nested >&2; exit 2" }] }] }, [EDIT, reply("ok\n")]);
  expect(r.last().find((m) => m.role === "tool")!.content).toBe("Not run: a hook the user set up blocked it: nested");
});

test("a hook that fails for its own reasons does not block: the run goes on and the failure is shown", () => {
  const r = run(["change it"], { PreToolUse: [{ command: "exit 7" }] }, [EDIT, reply("Done.\n")]);
  expect(readFileSync(join(r.root, "greet.js"), "utf8")).toContain("good morning");
  expect(r.err).toMatch(/hook exited with code 7/i);
});

test("without trust, a project's hooks do not run in a headless run, and it says so", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "heyho-e2e-")));
  mkdirSync(join(root, ".heyho"));
  writeFileSync(join(root, ".heyho/settings.json"), JSON.stringify({ hooks: { SessionStart: [{ command: "touch ran.flag" }] } }));
  writeFileSync(`${root}-steps.json`, JSON.stringify([reply("hi\n")]));
  const r = Bun.spawnSync(["bun", demo, "hello"], { stdin: "ignore", env: { ...process.env, DEMO_STEPS: `${root}-steps.json`, DEMO_ROOT: root, DEMO_FAST: "1", HEYHO_HOME: `${root}-home` } });
  expect(existsSync(join(root, "ran.flag"))).toBe(false);
  expect(r.stderr.toString()).toMatch(/off because the project has not been trusted/);
});

test("hooks in the user's own settings need no trust", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "heyho-e2e-")));
  mkdirSync(`${root}-home`);
  writeFileSync(`${root}-home/settings.json`, JSON.stringify({ hooks: { SessionStart: [{ command: "touch ran.flag" }] } }));
  writeFileSync(`${root}-steps.json`, JSON.stringify([reply("hi\n")]));
  Bun.spawnSync(["bun", demo, "hello"], { stdin: "ignore", env: { ...process.env, DEMO_STEPS: `${root}-steps.json`, DEMO_ROOT: root, DEMO_FAST: "1", HEYHO_HOME: `${root}-home` } });
  expect(existsSync(join(root, "ran.flag"))).toBe(true);
});
