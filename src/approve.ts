// Decides which edits and commands run without asking the user, which are refused, and
// which need an answer. Rules come from settings files, from "don't ask again" answers
// saved for the project, and from the session.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Layer, Source } from "./settings.ts";

// ask: edits and commands ask. auto: edits and file commands don't. plan: nothing changes,
// the model investigates and proposes. dontask: anything that would ask is refused.
// yolo: nothing asks, commands run in the sandbox.
export type Mode = "ask" | "auto" | "plan" | "dontask" | "yolo";
export const MODES: Mode[] = ["ask", "auto", "plan", "dontask", "yolo"];
export const CYCLE: Mode[] = ["ask", "auto", "plan"];
export const MODE_HELP: Record<Mode, string> = {
  ask: "edits and commands ask first",
  auto: "edits and file commands (mkdir, mv, cp, rm …) don't ask; other commands do",
  plan: "read-only: the model looks around and proposes a plan, nothing is changed",
  dontask: "nothing asks: whatever is not already allowed is refused",
  yolo: "nothing asks; commands run in the macOS sandbox",
};
export const PLAN_REFUSAL =
  "Plan mode is on: nothing may be changed yet. Use read, search and read-only commands to investigate, then reply with your plan and stop. The user will switch modes to let you carry it out.";

export type Kind = "edit" | "write" | "bash" | "fetch" | "mcp";
export type Tool = "bash" | "edit" | "read" | "fetch" | "mcp";
export type Rule = { tool: Tool; pattern?: string; source: Source; text: string };
export type Verdict = { action: "allow" | "ask" | "deny"; rule?: Rule };

// "bash(npm test *)", "edit(src/**)", "read(.env)", or a bare tool name. Claude Code's
// spellings are accepted: Bash, Edit, Write (same as edit), Read.
export function parseRule(text: string, source: Source): Rule | null {
  // Claude Code names MCP rules mcp__server or mcp__server__tool.
  const cc = text.trim().match(/^mcp__([^_]+(?:_[^_]+)*?)(?:__(.+))?$/);
  if (cc) return { tool: "mcp", pattern: cc[2] && cc[2] !== "*" ? `${cc[1]}.${cc[2]}` : cc[1], source, text: text.trim() };
  const m = text.trim().match(/^([A-Za-z]+)(?:\((.*)\))?$/s);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const tool = name === "write" ? "edit" : name;
  if (name === "webfetch") return { tool: "fetch", pattern: m[2]?.trim().replace(/^domain:/, "") || undefined, source, text: text.trim() };
  if (tool !== "bash" && tool !== "edit" && tool !== "read" && tool !== "fetch" && tool !== "mcp") return null;
  return { tool, pattern: m[2]?.trim() || undefined, source, text: text.trim() };
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

// "npm test *" covers "npm test" and anything after it; elsewhere * is any run of characters.
function commandMatches(pattern: string, command: string): boolean {
  const prefix = pattern.match(/^(.*?)[ :]\*$/);
  if (prefix && !prefix[1].includes("*")) return command === prefix[1] || command.startsWith(prefix[1] + " ");
  return new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`, "s").test(command);
}

// Glob on a path relative to the project: ** crosses folders, * does not. A pattern with
// no slash also matches the file's name alone, so ".env" covers "config/.env".
function pathMatches(pattern: string, path: string): boolean {
  const p = pattern.replace(/^\.\//, "");
  const re = new RegExp(`^${p.split("**").map((part) => part.split("*").map(escape).join("[^/]*")).join(".*")}$`);
  return re.test(path) || (!p.includes("/") && re.test(path.split("/").pop()!)) || (p.endsWith("/**") && path === p.slice(0, -3));
}

// "example.com" is that host; "*.example.com" is any host under it.
const hostMatches = (pattern: string, host: string) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : pattern.replace(/^domain:/, "") === host);

// A command with none of these can't substitute or redirect, so it can be judged from its words.
const OPAQUE = /[`<>\n\\]|\$\(|\$\{/;
// The command with the contents of its single-quoted strings removed: the shell reads those
// literally, so a backslash or an angle bracket in them (a grep pattern, say) does nothing.
function unquoted(command: string): string {
  let out = "";
  let quote = "";
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = "";
      if (quote !== "'") out += ch;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      out += ch;
    }
  }
  return out;
}
const opaque = (command: string) => OPAQUE.test(unquoted(command));
export const isSimple = (command: string) => !opaque(command) && splitCommand(command)?.length === 1;

// Splits "a && b | c; d" into its commands. null when the command can't be taken apart
// safely (substitution, redirection, a background job, unbalanced quotes).
export function splitCommand(command: string): string[] | null {
  if (opaque(command)) return null;
  const parts: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = "";
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ";" || ch === "|" || ch === "&") {
      if (ch === "&" && command[i + 1] !== "&") return null; // a background job
      if (command[i + 1] === ch) i++;
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (quote) return null;
  parts.push(current);
  const trimmed = parts.map((p) => p.trim());
  return trimmed.every(Boolean) ? trimmed : null;
}

// Read-only commands allowed without asking, as long as no argument points outside the workspace.
const SAFE = ["ls", "pwd", "wc", "cat", "head", "tail", "grep", "rg", "find", "cd", "git status", "git diff", "git log", "git show"];
// What auto mode adds: commands that only create, move or remove files inside the workspace.
const FILE_COMMANDS = ["mkdir", "touch", "mv", "cp", "rm", "rmdir", "sed"];
// `root` itself may be named in full: models often pass absolute paths.
const staysInside = (command: string, root: string) =>
  !command.split(/\s+/).slice(1).some((a) => (a.startsWith("/") && a !== root && !a.startsWith(root + "/")) || a.startsWith("~") || a.split("/").includes(".."));
// find can delete and run programs; those forms are not read-only.
const findWrites = (command: string) => /^find\b/.test(command) && /\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/.test(command);
const startsWith = (command: string, prefix: string) => command === prefix || command.startsWith(prefix + " ");

// "npm test -- x" → "npm test"; "ls -la" → "ls". The second word is kept when it looks like a subcommand.
// Programs that run whatever command they are given: "sh *" as a rule would allow anything.
const WRAPPERS = /^(sh|bash|zsh|dash|fish|env|sudo|xargs|eval|exec|nohup|time)\b/;
function prefixOfOne(c: string): string {
  const [first, second] = c.split(/\s+/);
  return second && /^[a-z][\w:-]*$/.test(second) ? `${first} ${second}` : first;
}
export function prefixOf(command: string): string | null {
  const c = command.trim();
  return isSimple(c) ? prefixOfOne(c) : null;
}

export class Approvals {
  mode: Mode;
  private rules: { allow: Rule[]; ask: Rule[]; deny: Rule[] } = { allow: [], ask: [], deny: [] };
  private kinds = new Set<Kind>();
  private file?: string;
  private root: string;
  problems: string[] = [];

  // `file` holds the "don't ask again" answers for this project; `layers` are the settings files.
  constructor(mode: Mode, file?: string, root = "", layers: Layer[] = []) {
    this.mode = mode;
    this.file = file;
    this.root = root;
    for (const layer of layers) this.load(layer.settings.permissions ?? {}, layer.source, layer.file);
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      // An earlier format kept prefixes and exact commands in two lists.
      const allow = saved.allow ?? [...(saved.prefixes ?? []).map((p: string) => `bash(${p} *)`), ...(saved.exact ?? []).map((c: string) => `bash(${c})`)];
      this.load({ allow }, "saved", file);
    }
  }

  private load(list: { allow?: string[]; ask?: string[]; deny?: string[] }, source: Source, file: string) {
    for (const action of ["allow", "ask", "deny"] as const)
      for (const text of list[action] ?? []) {
        const rule = parseRule(text, source);
        if (rule) this.rules[action].push(rule);
        else this.problems.push(`${file}: "${text}" is not a rule. Write a tool name, or tool(pattern): bash(npm test *), edit(src/**), read(.env).`);
      }
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ allow: this.rules.allow.filter((r) => r.source === "saved").map((r) => r.text) }, null, 2));
  }

  private find(action: "allow" | "ask" | "deny", tool: Tool, test: (pattern: string) => boolean): Rule | undefined {
    return this.rules[action].find((r) => r.tool === tool && (r.pattern === undefined || test(r.pattern)));
  }

  private relative(path: string) {
    return this.root && path.startsWith(this.root + "/") ? path.slice(this.root.length + 1) : path;
  }

  // Whether a file may be read. Only a deny rule stops a read.
  readDenied(path: string): Rule | undefined {
    const rel = this.relative(path);
    return this.find("deny", "read", (p) => pathMatches(p, rel));
  }

  private builtIn(part: string): boolean {
    if (!staysInside(part, this.root) || findWrites(part)) return false;
    if (SAFE.some((p) => startsWith(part, p))) return true;
    return this.mode === "auto" && FILE_COMMANDS.some((p) => startsWith(part, p));
  }

  // `target` is the command for bash, and the path (first line of the summary) for an edit or new file.
  decide(kind: Kind, summary: string): Verdict {
    if (kind === "mcp") {
      // "server" covers every tool on it; "server.tool" covers one.
      const id = summary.split("\n")[0];
      for (const action of ["deny", "ask", "allow"] as const) {
        const rule = this.find(action, "mcp", (p) => p === id || p === id.split(".")[0]);
        if (rule) return { action, rule };
        if (action === "deny" && this.mode === "yolo") return { action: "allow" };
      }
      return { action: "ask" };
    }
    if (kind === "fetch") {
      const host = new URL(summary).hostname;
      for (const action of ["deny", "ask", "allow"] as const) {
        const rule = this.find(action, "fetch", (p) => hostMatches(p, host));
        if (rule) return { action, rule };
        if (action === "deny" && this.mode === "yolo") return { action: "allow" };
      }
      return { action: "ask" };
    }
    if (kind !== "bash") {
      const rel = this.relative(summary.split("\n")[0].replace(/ \((new file|overwrite), \d+ lines\)$/, ""));
      const deny = this.find("deny", "edit", (p) => pathMatches(p, rel));
      if (deny) return { action: "deny", rule: deny };
      if (this.mode === "yolo") return { action: "allow" };
      if (this.mode === "plan") return { action: "ask" };
      const ask = this.find("ask", "edit", (p) => pathMatches(p, rel));
      if (ask) return { action: "ask", rule: ask };
      if (this.mode === "auto" || this.kinds.has(kind) || this.find("allow", "edit", (p) => pathMatches(p, rel))) return { action: "allow" };
      return { action: "ask" };
    }
    const whole = summary.trim();
    const parts = splitCommand(whole);
    const each = [whole, ...(parts && parts.length > 1 ? parts : [])];
    for (const c of each) {
      const deny = this.find("deny", "bash", (p) => commandMatches(p, c));
      if (deny) return { action: "deny", rule: deny };
    }
    if (this.mode === "yolo") return { action: "allow" };
    if (this.mode === "plan") return { action: parts?.every((c) => SAFE.some((p) => startsWith(c, p)) && staysInside(c, this.root) && !findWrites(c)) ? "allow" : "ask" };
    for (const c of each) {
      const ask = this.find("ask", "bash", (p) => commandMatches(p, c));
      if (ask) return { action: "ask", rule: ask };
    }
    // A rule with a wildcard must not cover what is chained or redirected after the part it names,
    // so against the whole of such a command only a rule that spells it out exactly counts.
    if (this.find("allow", "bash", (p) => (parts?.length === 1 || !p.includes("*")) && commandMatches(p, whole))) return { action: "allow" };
    if (parts?.every((c) => this.builtIn(c) || this.find("allow", "bash", (p) => commandMatches(p, c)))) return { action: "allow" };
    return { action: "ask" };
  }

  allowed(kind: Kind, summary: string): boolean {
    return this.decide(kind, summary).action === "allow";
  }

  // The rules "don't ask again" would add for this command: one per part that still needs
  // an answer. null when the command can only be allowed exactly as written.
  suggest(command: string): string[] | null {
    const parts = splitCommand(command.trim());
    if (!parts) return null;
    const need = parts.filter((c) => !this.builtIn(c) && !this.find("allow", "bash", (p) => commandMatches(p, c)));
    if (need.some((c) => WRAPPERS.test(c))) return null;
    return [...new Set(need.map(prefixOfOne))];
  }

  private add(action: "allow" | "ask" | "deny", text: string, source: Source): Rule | null {
    const rule = parseRule(text, source);
    if (!rule) return null;
    if (!this.rules[action].some((r) => r.text === rule.text)) this.rules[action].push(rule);
    return rule;
  }

  allowKind(kind: Kind) {
    this.kinds.add(kind);
  }
  allowExact(command: string) {
    this.add("allow", `bash(${command.trim()})`, "saved");
    this.save();
  }
  allowServer(name: string) {
    this.add("allow", `mcp(${name})`, "saved");
    this.save();
  }
  allowHost(url: string) {
    this.add("allow", `fetch(${new URL(url).hostname})`, "saved");
    this.save();
  }
  allowPrefix(prefix: string) {
    this.add("allow", `bash(${prefix} *)`, "saved");
    this.save();
  }
  allowSuggested(command: string) {
    for (const prefix of this.suggest(command) ?? []) this.add("allow", `bash(${prefix} *)`, "saved");
    this.save();
  }
  // Adds a rule for the rest of the session, or removes one that was added that way or saved.
  addRule(action: "allow" | "ask" | "deny", text: string): boolean {
    return this.add(action, text, "session") !== null;
  }
  removeRule(text: string): boolean {
    let removed = false;
    for (const action of ["allow", "ask", "deny"] as const) {
      const before = this.rules[action].length;
      this.rules[action] = this.rules[action].filter((r) => !(r.text === text.trim() && (r.source === "session" || r.source === "saved")));
      removed ||= this.rules[action].length < before;
    }
    this.save();
    return removed;
  }

  forget() {
    this.kinds.clear();
    for (const action of ["allow", "ask", "deny"] as const) this.rules[action] = this.rules[action].filter((r) => r.source !== "saved" && r.source !== "session");
    this.save();
  }

  describe(): string[] {
    const out = [`mode: ${this.mode} (${MODE_HELP[this.mode]})`];
    out.push(`read-only commands that never ask: ${SAFE.join(", ")}`);
    if (this.kinds.size) out.push(`allowed this session: every ${[...this.kinds].join(" and ")}`);
    const where: Record<Source, string> = { user: "your settings", project: "project settings", local: "your settings for this project", saved: "saved for this project", session: "this session" };
    for (const action of ["deny", "ask", "allow"] as const) for (const r of this.rules[action]) out.push(`${action.padEnd(5)} ${r.text}  (${where[r.source]})`);
    return out;
  }
}
