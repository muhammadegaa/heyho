// The prompt: one readline for user messages and approval answers, with history kept
// between sessions, pasted multi-line text joined into one message, and @path completion.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";

const PASTE_GAP_MS = 30; // lines closer together than this were pasted, not typed
const HISTORY = 500;

export type Input = {
  message: (prompt: () => string) => Promise<string | null>; // null at end of input
  onKey: (fn: (key: { name?: string; shift?: boolean }) => void) => void;
  redraw: () => void; // the prompt text changed while waiting
  answer: (prompt: string) => Promise<string>;
  onInterrupt: (fn: () => void) => void;
  close: () => void;
};

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "target", ".venv"]);
const WALK_MAX = 5000;

// Without a git repo: every file under root, skipping dependency and build folders.
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (out.length >= WALK_MAX || SKIP.has(e.name)) continue;
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path);
      else out.push(path);
    }
  };
  visit("");
  return out;
}

// Completes "/command" at the start of a line and "@path" anywhere in it.
// Tracked files when there is a git repo, otherwise every file under root.
export function listFiles(root: string): string[] {
  const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  return git.status === 0 ? git.stdout.split("\n").filter(Boolean) : walk(root);
}

export function completer(root: string, commands: string[]) {
  let files: string[] | null = null;
  return (line: string): [string[], string] => {
    if (/^\/\S*$/.test(line)) return [commands.map((c) => "/" + c).filter((c) => c.startsWith(line)), line];
    const at = line.match(/@(\S*)$/);
    if (!at) return [[], line];
    files ??= listFiles(root);
    const hits = files.filter((f) => f.startsWith(at[1]));
    const pool = hits.length ? hits : files.filter((f) => f.includes(at[1]));
    return [pool.slice(0, 40).map((f) => "@" + f), "@" + at[1]];
  };
}

export function createInput(opts: { historyFile: string; root: string; commands: string[] }): Input {
  const tty = Boolean(process.stdin.isTTY);
  const history = existsSync(opts.historyFile) ? readFileSync(opts.historyFile, "utf8").split("\n").filter(Boolean).reverse() : [];
  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: tty,
    history,
    historySize: HISTORY,
    completer: completer(opts.root, opts.commands),
  });
  rl.on("history", (h: string[]) => {
    mkdirSync(dirname(opts.historyFile), { recursive: true });
    writeFileSync(opts.historyFile, [...h].reverse().join("\n") + "\n");
  });

  const queue: string[] = []; // lines typed while the agent was working
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    waiter?.(null);
  });

  let fromQueue = false;
  let promptText: () => string = () => "";
  const nextLine = (prompt: string, useQueue: boolean): Promise<string | null> => {
    promptText = () => prompt;
    fromQueue = useQueue && queue.length > 0;
    if (fromQueue) return Promise.resolve(queue.shift()!);
    if (closed) return Promise.resolve(null);
    rl.setPrompt(prompt);
    rl.prompt();
    return new Promise((resolve) => (waiter = resolve));
  };

  // Waits briefly for lines that follow at paste speed.
  const pasted = (): Promise<string[]> =>
    new Promise((resolve) => {
      const more: string[] = [];
      const wait = () =>
        setTimeout(() => {
          if (!queue.length) return resolve(more);
          more.push(...queue.splice(0));
          wait();
        }, PASTE_GAP_MS);
      wait();
    });

  return {
    async message(prompt) {
      const pending = nextLine(prompt(), true);
      promptText = prompt;
      const first = await pending;
      if (first === null) return null;
      const lines = [first];
      // Lines typed ahead while the agent worked are separate messages, not one paste.
      if (tty && !fromQueue) lines.push(...(await pasted()));
      // A trailing backslash continues the message on the next line.
      while (lines.at(-1)!.endsWith("\\")) {
        lines[lines.length - 1] = lines.at(-1)!.slice(0, -1);
        const next = await nextLine("… ", false);
        if (next === null) break;
        lines.push(next);
      }
      return lines.join("\n").trim();
    },
    // Never served from typed-ahead lines: an approval must be answered after it is shown.
    async answer(prompt) {
      const a = (await nextLine(prompt, false)) ?? "";
      // Not something to offer again when the user presses Up.
      const history = (rl as unknown as { history: string[] }).history;
      if (history[0] === a) history.shift();
      return a;
    },
    onKey(fn) {
      process.stdin.on("keypress", (_s, key) => key && fn(key));
    },
    redraw() {
      if (!waiter) return;
      rl.setPrompt(promptText());
      rl.prompt(true);
    },
    onInterrupt(fn) {
      rl.on("SIGINT", fn);
    },
    close() {
      rl.close();
    },
  };
}
