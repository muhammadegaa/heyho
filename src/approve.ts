// Decides which edits and commands run without asking the user.
export type Mode = "ask" | "auto" | "yolo";
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
  constructor(mode: Mode) {
    this.mode = mode;
  }

  allowed(kind: Kind, summary: string): boolean {
    if (this.mode === "yolo") return true;
    if (kind !== "bash") return this.mode === "auto" || this.kinds.has(kind);
    const c = summary.trim();
    if (this.exact.has(c)) return true;
    if (!isSimple(c)) return false;
    if (staysInside(c) && SAFE.some((p) => startsWith(c, p))) return true;
    return [...this.prefixes].some((p) => startsWith(c, p));
  }

  allowKind(kind: Kind) {
    this.kinds.add(kind);
  }
  allowExact(command: string) {
    this.exact.add(command.trim());
  }
  allowPrefix(prefix: string) {
    this.prefixes.add(prefix);
  }

  describe(): string[] {
    const out = [`mode: ${this.mode}${this.mode === "auto" ? " (edits and new files don't ask; commands do)" : this.mode === "yolo" ? " (nothing asks; commands run in the sandbox)" : ""}`];
    out.push(`read-only commands that never ask: ${SAFE.join(", ")}`);
    if (this.kinds.size) out.push(`allowed this session: every ${[...this.kinds].join(" and ")}`);
    if (this.prefixes.size) out.push(`commands starting with: ${[...this.prefixes].join(", ")}`);
    if (this.exact.size) out.push(`exact commands: ${[...this.exact].map((c) => c.split("\n")[0].slice(0, 60)).join(" | ")}`);
    return out;
  }
}
