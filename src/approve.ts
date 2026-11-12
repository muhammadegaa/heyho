// Decides which edits and commands run without asking the user.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ask: edits and commands ask. auto: only commands ask. plan: nothing changes, the model
// investigates and proposes. yolo: nothing asks, commands run in the sandbox.
export type Mode = "ask" | "auto" | "plan" | "yolo";
export const MODES: Mode[] = ["ask", "auto", "plan", "yolo"];
export const MODE_HELP: Record<Mode, string> = {
  ask: "edits and commands ask first",
  auto: "edits don't ask; commands do",
  plan: "read-only: the model looks around and proposes a plan, nothing is changed",
  yolo: "nothing asks; commands run in the macOS sandbox",
};
export const PLAN_REFUSAL =
  "Plan mode is on: nothing may be changed yet. Use read, search and read-only commands to investigate, then reply with your plan and stop. The user will switch modes to let you carry it out.";
export type Kind = "edit" | "write" | "bash";

// A command with none of these can't chain, substitute or redirect, so a rule that
// matches how it starts covers everything it runs.
export const isSimple = (command: string) => !/[;&|`$<>\n\\]/.test(command);

// Read-only commands allowed without asking, as long as no argument points outside the workspace.
const SAFE = ["ls", "pwd", "wc", "cat", "head", "tail", "grep", "rg", "git status", "git diff", "git log", "git show"];
const staysInside = (command: string) => !command.split(/\s+/).slice(1).some((a) => a.startsWith("/") || a.startsWith("~") || a.split("/").includes(".."));

const startsWith = (command: string, prefix: string) => command === prefix || command.startsWith(prefix + " ");

// "npm test -- x" → "npm test"; "ls -la" → "ls". The second word is kept when it looks like a subcommand.
export function prefixOf(command: string): string | null {
  const c = command.trim();
  if (!isSimple(c)) return null;
  const [first, second] = c.split(/\s+/);
  return second && /^[a-z][\w:-]*$/.test(second) ? `${first} ${second}` : first;
}

export class Approvals {
  mode: Mode;
  private kinds = new Set<Kind>();
  private exact = new Set<string>();
  private prefixes = new Set<string>();
  private file?: string;
  // Command rules are kept per project in `file`; "always allow edits" lasts for the session only.
  constructor(mode: Mode, file?: string) {
    this.mode = mode;
    this.file = file;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      this.exact = new Set(saved.exact ?? []);
      this.prefixes = new Set(saved.prefixes ?? []);
    }
  }
  private save() {
    if (this.file) writeFileSync(this.file, JSON.stringify({ prefixes: [...this.prefixes], exact: [...this.exact] }, null, 2));
  }
  forget() {
    this.kinds.clear();
    this.exact.clear();
    this.prefixes.clear();
    this.save();
  }

  allowed(kind: Kind, summary: string): boolean {
    if (this.mode === "yolo") return true;
    const c = summary.trim();
    const readOnly = kind === "bash" && isSimple(c) && staysInside(c) && SAFE.some((p) => startsWith(c, p));
    if (this.mode === "plan") return readOnly;
    if (kind !== "bash") return this.mode === "auto" || this.kinds.has(kind);
    if (readOnly || this.exact.has(c)) return true;
    return isSimple(c) && [...this.prefixes].some((p) => startsWith(c, p));
  }

  allowKind(kind: Kind) {
    this.kinds.add(kind);
  }
  allowExact(command: string) {
    this.exact.add(command.trim());
    this.save();
  }
  allowPrefix(prefix: string) {
    this.prefixes.add(prefix);
    this.save();
  }

  describe(): string[] {
    const out = [`mode: ${this.mode} (${MODE_HELP[this.mode]})`];
    out.push(`read-only commands that never ask: ${SAFE.join(", ")}`);
    if (this.kinds.size) out.push(`allowed this session: every ${[...this.kinds].join(" and ")}`);
    if (this.prefixes.size) out.push(`allowed in this project, commands starting with: ${[...this.prefixes].join(", ")}`);
    if (this.exact.size) out.push(`allowed in this project, exact commands: ${[...this.exact].map((c) => c.split("\n")[0].slice(0, 60)).join(" | ")}`);
    return out;
  }
}
