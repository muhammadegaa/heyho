import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";

const AGENTS_MD_MAX_CHARS = 4000; // ~1k tokens

const BASE = `You are heyho, a coding agent working in a terminal on the user's machine. You complete software tasks in the repository in the working directory by reading code, editing files and running commands.

How to work:
- Find the relevant code with search and read before changing anything.
- For a task with several steps, write a short plan (2-6 lines) before your first tool call.
- Change files with small, targeted edits. Use write only for new files or full rewrites.
- After changing code, run the relevant tests or a quick check with bash, and fix what fails.
- Keep going until the task is done. Don't stop to ask for confirmation; the user is asked automatically when needed. Ask a question only if the request is ambiguous in a way that changes the result.
- Do only what the task needs: no unrelated refactors, extra features or new files.
- Use paths relative to the working directory, and stay inside it.
- When a tool fails, its message says what to do next.

When the task is done, reply without calling tools: say in a few lines what you changed and how you checked it.`;

// Built once per session. Nothing in it may change mid-session, or the server loses its
// prompt cache for everything after the change.
export function systemPrompt(root: string, now = new Date()): string {
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).stdout?.trim();
  const env = `Working directory: ${root}\nOS: ${process.platform} ${release()}\nDate: ${now.toISOString().slice(0, 10)}${branch ? `\nGit branch: ${branch}` : ""}`;
  let agents = "";
  const file = join(root, "AGENTS.md");
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    agents = `\n\nProject instructions (AGENTS.md):\n${text.slice(0, AGENTS_MD_MAX_CHARS)}${text.length > AGENTS_MD_MAX_CHARS ? "\n[AGENTS.md truncated]" : ""}`;
  }
  return `${BASE}\n\n${env}${agents}`;
}
