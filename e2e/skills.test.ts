// Skills (instructions the model reads when a task calls for them) and subagents (a
// separate conversation for part of the work).
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { call, FILES, open, reply, type Step } from "./harness.ts";

const demo = join(import.meta.dirname, "../scripts/ui-demo.ts");
type Request = { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };

function run(args: string[], steps: Step[] | ((root: string) => Step[]), files: Record<string, string> = {}, home: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "heyho-e2e-")));
  for (const [base, set] of [[root, { ...FILES, ...files }], [`${root}-home`, home]] as const)
    for (const [path, content] of Object.entries(set)) {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), content);
    }
  writeFileSync(`${root}-steps.json`, JSON.stringify(typeof steps === "function" ? steps(root) : steps));
  const r = Bun.spawnSync(["bun", demo, "--yolo", ...args], { stdin: "ignore", env: { ...process.env, DEMO_STEPS: `${root}-steps.json`, DEMO_ROOT: root, DEMO_FAST: "1", HEYHO_HOME: `${root}-home` } });
  const requests = () => JSON.parse(readFileSync(`${root}-requests.json`, "utf8")) as Request[];
  return { root, out: r.stdout.toString(), err: r.stderr.toString(), requests };
}

const SKILL = "---\nname: release-notes\ndescription: write release notes from git history\n---\nList commits since the last tag, group them by type, and write CHANGES.md.\n";
const REVIEWER = "---\nname: reviewer\ndescription: reviews a diff for bugs\ntools: read, search\n---\nYou review code. Report bugs only, one per line.\n";

test("skills are listed in the system prompt by name, description and file; with none there is nothing", () => {
  const r = run(["hello"], [reply("hi\n")], { ".heyho/skills/release-notes/SKILL.md": SKILL, ".claude/skills/tidy.md": "Sort imports and remove unused ones.\n" });
  const system = r.requests()[0].messages[0].content;
  expect(system).toMatch(/- release-notes: write release notes from git history \(.*\.heyho\/skills\/release-notes\/SKILL\.md\)/);
  expect(system).toMatch(/- tidy: Sort imports and remove unused ones\./);
  expect(system).not.toContain("List commits since the last tag"); // the body is read only when needed
  expect(run(["hello"], [reply("hi\n")]).requests()[0].messages[0].content).not.toMatch(/Skills:/);
});

test("the model can read a skill file that lives in the user's folder, but nothing else outside the project", () => {
  const home = { "skills/release-notes/SKILL.md": SKILL, "settings.json": "{}" };
  const r = run(["write the notes"], (root) => [call("read", { path: `${root}-home/skills/release-notes/SKILL.md` }), call("read", { path: `${root}-home/settings.json` }), reply("Following it.\n")], {}, home);
  const [skill, other] = r.requests().at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content);
  expect(skill).toContain("List commits since the last tag");
  expect(other).toMatch(/outside the working directory/);
});

test("without subagents defined there is no agent tool", () => {
  const r = run(["hello"], [reply("hi\n")]);
  expect(r.requests()[0].tools.map((t) => t.function.name)).not.toContain("agent");
  expect(r.requests()[0].messages[0].content).not.toMatch(/Subagents:/);
});

test("a subagent runs in its own conversation, with its own instructions and tools, and returns its final reply", () => {
  const r = run(["review my change"], [call("agent", { agent: "reviewer", task: "Review src/cart.js for bugs." }), call("read", { path: "src/cart.js" }), reply("No bugs found in src/cart.js.\n"), reply("The reviewer found nothing.\n")], { ".heyho/agents/reviewer.md": REVIEWER });
  const [parent1, sub1, sub2, parent2] = r.requests();
  expect(parent1.tools.map((t) => t.function.name)).toContain("agent");
  expect(parent1.messages[0].content).toMatch(/- reviewer: reviews a diff for bugs/);
  // The subagent starts from its own instructions and the task, not the parent's conversation.
  expect(sub1.messages.map((m) => m.role)).toEqual(["system", "user"]);
  expect(sub1.messages[0].content).toContain("You review code. Report bugs only, one per line.");
  expect(sub1.messages[1].content).toBe("Review src/cart.js for bugs.");
  expect(sub1.tools.map((t) => t.function.name)).toEqual(["read", "search"]);
  expect(sub2.messages.length).toBe(4);
  // The parent gets only the report.
  expect(parent2.messages.at(-1)).toMatchObject({ role: "tool", content: "No bugs found in src/cart.js.\n" });
  expect(parent2.messages.some((m) => m.content?.includes("export const total"))).toBe(false);
  expect(r.out).toContain("The reviewer found nothing.");
});

test("an unknown subagent name lists the real ones; a subagent cannot start another", () => {
  const r = run(["go"], [call("agent", { agent: "nobody", task: "x" }), call("agent", { agent: "helper", task: "do it" }), reply("sub done\n"), reply("ok\n")], { ".heyho/agents/helper.md": "You help.\n" });
  const reqs = r.requests();
  expect(reqs[1].messages.at(-1)!.content).toMatch(/No subagent "nobody"\. Subagents: helper/);
  expect(reqs[2].tools.map((t) => t.function.name)).not.toContain("agent");
});

let s: Awaited<ReturnType<typeof open>> | undefined;
afterEach(() => (s?.close(), (s = undefined)));

test("in a session: a skill is also a slash command, /skills and /agents list them, and a subagent's work is shown", async () => {
  s = await open({
    args: ["--mode", "auto"],
    files: { ...FILES, ".heyho/skills/release-notes/SKILL.md": SKILL, ".heyho/agents/reviewer.md": REVIEWER },
    steps: [reply("Notes written.\n"), call("agent", { agent: "reviewer", task: "Review src/cart.js." }), call("read", { path: "src/cart.js" }), reply("No bugs.\n"), reply("Reviewed.\n")],
  });
  await s.send("/skills");
  await s.wait(/release-notes\s+write release notes from git history/);
  await s.send("/agents");
  await s.wait(/reviewer\s+reviews a diff for bugs/);
  await s.type("/release");
  await s.wait(/❯ \/release-notes\s+write release notes from git history/);
  await s.key("Tab");
  await s.send("for v2");
  await s.wait(/Notes written\./);
  const requests = () => JSON.parse(readFileSync(`${s!.root}-requests.json`, "utf8")) as Request[];
  expect(requests()[0].messages.at(-1)!.content).toMatch(/^Use the release-notes skill\.[\s\S]*List commits since the last tag[\s\S]*for v2$/);
  await s.send("review it");
  const screen = await s.wait(/Reviewed\./);
  expect(screen).toMatch(/⏺ agent reviewer: Review src\/cart\.js\./);
  expect(screen).toMatch(/↳ read src\/cart\.js/);
});
