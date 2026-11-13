// MCP: servers from .mcp.json (or "mcpServers" in settings) are started over stdio, and
// their tools are reached through one `mcp` tool so the fixed prompt stays small.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { call, FILES, open, reply, type Step } from "./harness.ts";

const demo = join(import.meta.dirname, "../scripts/ui-demo.ts");
const server = join(import.meta.dirname, "fixtures/mcp-server.ts");
const MCP = (extra: object = {}) => JSON.stringify({ mcpServers: { calc: { command: "bun", args: [server] }, ...extra } });

function run(args: string[], steps: Step[], files: Record<string, string> = { ".mcp.json": MCP() }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "heyho-e2e-")));
  for (const [path, content] of Object.entries({ ...FILES, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  writeFileSync(`${root}-steps.json`, JSON.stringify(steps));
  const r = Bun.spawnSync(["bun", demo, ...args], { stdin: "ignore", env: { ...process.env, DEMO_STEPS: `${root}-steps.json`, DEMO_ROOT: root, DEMO_FAST: "1", HEYHO_HOME: `${root}-home` } });
  const requests = () => JSON.parse(readFileSync(`${root}-requests.json`, "utf8")) as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] }[];
  return { root, out: r.stdout.toString(), err: r.stderr.toString(), requests, results: () => requests().at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content) };
}

const ADD = call("mcp", { tool: "calc.add", args: { a: 2, b: 40 } });

test("a server's tools are named in the system prompt and reached through one mcp tool", () => {
  const r = run(["--trust-project", "--allowed-tools", "mcp(calc)", "add them"], [ADD, reply("42.\n")]);
  const first = r.requests()[0];
  expect(first.tools.map((t) => t.function.name)).toContain("mcp");
  expect(first.messages[0].content).toMatch(/calc\.add: Add two numbers\./);
  expect(first.messages[0].content).toMatch(/calc\.echo: Return the text it was given\.$/);
  expect(first.messages[0].content).not.toMatch(/Second line of the description/);
  expect(r.results()).toEqual(["42"]);
});

test("with no servers configured there is no mcp tool and nothing about it in the prompt", () => {
  const r = run(["hello"], [reply("hi\n")], {});
  expect(r.requests()[0].tools.map((t) => t.function.name)).not.toContain("mcp");
  expect(r.requests()[0].messages[0].content).not.toMatch(/MCP/);
});

test("a wrong tool name lists the real ones; a failing call returns the server's message and the schema", () => {
  const r = run(["--trust-project", "--allowed-tools", "mcp(calc)", "try"], [call("mcp", { tool: "calc.subtract", args: {} }), call("mcp", { tool: "calc.add", args: { a: "two", b: 1 } }), reply("ok\n")]);
  const [unknown, bad] = r.results();
  expect(unknown).toMatch(/No MCP tool "calc\.subtract"\. Tools: calc\.add, calc\.echo/);
  expect(bad).toMatch(/a and b must be numbers/);
  expect(bad).toMatch(/"required":\["a","b"\]/);
});

test("a call that leaves out required arguments gets the schema back without asking the user", () => {
  // Qwen3.6 was seen calling a tool with no arguments first, which cost the user an approval for nothing.
  const r = run(["--trust-project", "add them"], [call("mcp", { tool: "calc.add" }), reply("ok\n")]);
  expect(r.results()[0]).toMatch(/calc\.add needs: a, b/);
  expect(r.results()[0]).toMatch(/"required":\["a","b"\]/);
  expect(r.results()[0]).not.toMatch(/declined/);
});

test("non-text content in a result is noted, not passed on", () => {
  const r = run(["--trust-project", "--allowed-tools", "mcp(calc.echo)", "echo"], [call("mcp", { tool: "calc.echo", args: { text: "hi" } }), reply("ok\n")]);
  expect(r.results()).toEqual(["echo: hi\n[1 image item left out]"]);
});

test("an MCP call asks like any other: unanswered it is declined, and a deny rule blocks it", () => {
  const unanswered = run(["--trust-project", "add them"], [ADD, reply("could not\n")]);
  expect(unanswered.results()[0]).toMatch(/The user declined this action/);
  const denied = run(["--trust-project", "--yolo", "--disallowed-tools", "mcp(calc.add)", "add them"], [ADD, reply("blocked\n")]);
  expect(denied.results()[0]).toMatch(/Blocked: a rule set by the user forbids this \(mcp\(calc\.add\)\)/);
});

test("Claude Code's rule spelling for MCP tools is read", () => {
  const r = run(["--trust-project", "--allowed-tools", "mcp__calc__add", "add them"], [ADD, reply("42.\n")]);
  expect(r.results()).toEqual(["42"]);
});

test("a server that will not start is reported and the session goes on without it", () => {
  const r = run(["--trust-project", "--allowed-tools", "mcp(calc)", "add them"], [ADD, reply("42.\n")], { ".mcp.json": MCP({ dead: { command: "bun", args: [server, "broken"] } }) });
  expect(r.err).toMatch(/MCP server "dead" did not start/);
  expect(r.results()).toEqual(["42"]);
  expect(r.requests()[0].messages[0].content).not.toMatch(/dead\./);
});

test("a project's .mcp.json is not started until the project is trusted", () => {
  const r = run(["hello"], [reply("hi\n")]);
  expect(r.requests()[0].tools.map((t) => t.function.name)).not.toContain("mcp");
  expect(r.err).toMatch(/has not been trusted/);
});

test("servers in the user's own settings need no trust", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "heyho-e2e-")));
  mkdirSync(`${root}-home`);
  writeFileSync(`${root}-home/settings.json`, MCP());
  writeFileSync(`${root}-steps.json`, JSON.stringify([reply("hi\n")]));
  Bun.spawnSync(["bun", demo, "hello"], { stdin: "ignore", env: { ...process.env, DEMO_STEPS: `${root}-steps.json`, DEMO_ROOT: root, DEMO_FAST: "1", HEYHO_HOME: `${root}-home` } });
  expect((JSON.parse(readFileSync(`${root}-requests.json`, "utf8"))[0].tools as { function: { name: string } }[]).map((t) => t.function.name)).toContain("mcp");
});

let s: Awaited<ReturnType<typeof open>> | undefined;
afterEach(() => (s?.close(), (s = undefined)));

test("in a session: /mcp lists servers and tools, and a call shows an approval that can be allowed for the server", async () => {
  s = await open({ args: ["--trust-project"], files: { ...FILES, ".mcp.json": MCP() }, steps: [ADD, call("mcp", { tool: "calc.echo", args: { text: "again" } }), reply("Both done.\n")] });
  await s.send("/mcp");
  const listed = await s.wait(/calc\s+running\s+2 tools/);
  expect(listed).toMatch(/calc\.add\s+Add two numbers\./);
  await s.send("use the calculator");
  const panel = await s.wait(/Use this tool\?/);
  expect(panel).toMatch(/calc\.add/);
  expect(panel).toMatch(/"a": 2/);
  expect(panel).toMatch(/2\. Yes, and don't ask again in this project for the calc server/);
  await s.key("2");
  const screen = await s.wait(/Both done\./);
  expect(screen).toMatch(/⏺ mcp calc\.add/);
  expect(screen).not.toMatch(/Use this tool\?/);
});
