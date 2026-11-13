import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { heyhoHome } from "./settings.ts";

const FILE_MAX_CHARS = 4000; // ~1k tokens for any one file
const TOTAL_MAX_CHARS = 10_000;
const NOTES_MAX_CHARS = 2000;
const IMPORT_DEPTH = 4;
const NAMES = ["AGENTS.md", "CLAUDE.md"];
const LOCAL_NAMES = ["AGENTS.local.md", "CLAUDE.local.md"];

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

export type Instruction = { scope: "user" | "parent" | "project" | "local" | "notes"; file: string; chars: number; cut: boolean };

// A line that is only "@some/file.md" is replaced by that file, up to four levels deep.
function withImports(text: string, dir: string, depth = 0, seen = new Set<string>()): string {
  if (depth >= IMPORT_DEPTH) return text;
  return text.replace(/^@(\S+)[ \t]*$/gm, (line, path) => {
    const file = resolve(dir, path.replace(/^~(?=\/)/, homedir()));
    if (seen.has(file) || !existsSync(file) || !statSync(file).isFile()) return line;
    seen.add(file);
    return withImports(readFileSync(file, "utf8").trimEnd(), dirname(file), depth + 1, seen);
  });
}

const firstOf = (dir: string, names: string[]) => names.map((n) => join(dir, n)).find((f) => existsSync(f));

// The instruction files that apply in `root`, most general first: yours for every project,
// those in folders above the project, the project's own, your private one for the project,
// and the notes heyho has kept for it.
export function instructionFiles(root: string, notesFile?: string): [Instruction["scope"], string][] {
  const out: [Instruction["scope"], string][] = [];
  const add = (scope: Instruction["scope"], file: string | undefined) => file && !out.some(([, f]) => f === file) && out.push([scope, file]);
  add("user", firstOf(heyhoHome(), ["AGENTS.md"]));
  const parents: string[] = [];
  for (let dir = dirname(root); dir !== dirname(dir); dir = dirname(dir)) parents.unshift(dir);
  for (const dir of parents) add("parent", firstOf(dir, NAMES));
  add("project", firstOf(root, NAMES) ?? firstOf(join(root, ".heyho"), NAMES));
  add("local", firstOf(root, LOCAL_NAMES));
  if (notesFile && existsSync(notesFile)) add("notes", notesFile);
  return out;
}

export function instructions(root: string, notesFile?: string): { text: string; files: Instruction[] } {
  const files: Instruction[] = [];
  let text = "";
  let left = TOTAL_MAX_CHARS;
  for (const [scope, file] of instructionFiles(root, notesFile)) {
    const full = withImports(readFileSync(file, "utf8").trimEnd(), dirname(file));
    const max = Math.min(scope === "notes" ? NOTES_MAX_CHARS : FILE_MAX_CHARS, left);
    const body = full.slice(0, max);
    left -= body.length;
    files.push({ scope, file, chars: full.length, cut: full.length > body.length });
    if (!body) continue;
    const title = scope === "user" ? "Your instructions for every project" : scope === "parent" ? "Instructions from a folder above this project" : scope === "project" ? "Project instructions" : scope === "local" ? "Your private instructions for this project" : "Notes you kept from earlier sessions here";
    text += `\n\n${title} (${file.startsWith(root + "/") ? file.slice(root.length + 1) : file}):\n${body}${full.length > body.length ? "\n[cut here: the file is longer]" : ""}`;
  }
  return { text, files };
}

// Instruction files in a folder below the project root are not loaded at the start. The
// first time a file under such a folder is read, its instructions come with it.
export function folderInstructions(root: string, abs: string, given: Set<string>): string {
  let out = "";
  for (let dir = dirname(abs); dir.startsWith(root + "/"); dir = dirname(dir)) {
    const file = firstOf(dir, NAMES);
    if (!file || given.has(file)) continue;
    given.add(file);
    out = `\n\n[Instructions for files under ${dir.slice(root.length + 1)}/ (${file.slice(root.length + 1)}):\n${readFileSync(file, "utf8").trimEnd().slice(0, FILE_MAX_CHARS)}]` + out;
  }
  return out;
}

// Built once per session. Nothing in it may change mid-session, or the server loses its
// prompt cache for everything after the change.
// `custom.replace` stands in for heyho's own instructions; `custom.append` is added at the very end.
export function systemPrompt(root: string, now = new Date(), notesFile?: string, custom: { replace?: string; append?: string } = {}): string {
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).stdout?.trim();
  const env = `Working directory: ${root}\nOS: ${process.platform} ${release()}\nDate: ${now.toISOString().slice(0, 10)}${branch ? `\nGit branch: ${branch}` : ""}`;
  const notes = notesFile ? `\nNotes file: ${notesFile} (kept between sessions; when you learn something about this project that will matter next time, add a line to it with edit or write)` : "";
  return `${custom.replace ?? BASE}\n\n${env}${notes}${instructions(root, notesFile).text}${custom.append ? `\n\n${custom.append}` : ""}`;
}
