// Skills and subagents the user has set up, as markdown files with a short header.
//
// A skill is instructions for a kind of task: <dir>/skills/<name>/SKILL.md (or
// <dir>/skills/<name>.md). The model is told each skill's name and description, and reads
// the file when a task calls for it, so a skill costs a line of prompt until it is used.
//
// A subagent is a role for a separate conversation: <dir>/agents/<name>.md. Its text
// becomes that conversation's instructions.
//
// <dir> is ~/.heyho, then the project's .claude and .heyho; a later one replaces an
// earlier one of the same name.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { heyhoHome } from "./settings.ts";

export type Skill = { name: string; description: string; file: string; body: string };
export type AgentDef = { name: string; description: string; tools?: string[]; body: string; file: string };

const LIST_MAX_CHARS = 1200;

function parse(file: string): { header: Record<string, string>; body: string } {
  const text = readFileSync(file, "utf8");
  const front = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const header: Record<string, string> = {};
  for (const line of front?.[1].split("\n") ?? []) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) header[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { header, body: (front ? text.slice(front[0].length) : text).trim() };
}

const dirs = (root: string, kind: string) => [join(heyhoHome(), kind), join(root, ".claude", kind), join(root, ".heyho", kind)];

export function loadSkills(root: string): Skill[] {
  const found = new Map<string, Skill>();
  for (const dir of dirs(root, "skills")) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      const inFolder = join(dir, entry, "SKILL.md");
      const file = existsSync(inFolder) ? inFolder : entry.endsWith(".md") && statSync(join(dir, entry)).isFile() ? join(dir, entry) : null;
      if (!file) continue;
      const { header, body } = parse(file);
      const name = header.name || entry.replace(/\.md$/, "");
      found.set(name, { name, description: header.description || body.split("\n")[0].slice(0, 100), file, body });
    }
  }
  return [...found.values()];
}

export function loadAgents(root: string): AgentDef[] {
  const found = new Map<string, AgentDef>();
  for (const dir of dirs(root, "agents")) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
      const file = join(dir, entry);
      const { header, body } = parse(file);
      const name = header.name || entry.slice(0, -3);
      found.set(name, { name, description: header.description || body.split("\n")[0].slice(0, 100), tools: header.tools ? header.tools.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean) : undefined, body, file });
    }
  }
  return [...found.values()];
}

function listing(title: string, items: { name: string; description: string; note?: string }[]): string {
  if (!items.length) return "";
  let text = title + "\n";
  for (const [n, i] of items.entries()) {
    const line = `- ${i.name}: ${i.description.slice(0, 120)}${i.note ? ` (${i.note})` : ""}\n`;
    if (text.length + line.length > LIST_MAX_CHARS) return text + `- and ${items.length - n} more\n`;
    text += line;
  }
  return text.trimEnd();
}

export const skillsPrompt = (skills: Skill[]) => listing("Skills: instructions for particular kinds of task. When a task matches one, read its file first and follow it.", skills.map((s) => ({ ...s, note: s.file })));
export const agentsPrompt = (agents: AgentDef[]) => listing("Subagents: hand a self-contained part of the work to one with the agent tool. It works in its own conversation and returns only its final report.", agents);
