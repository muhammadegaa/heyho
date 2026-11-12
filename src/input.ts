// The prompt: one readline for user messages and approval answers, with history kept
// between sessions, pasted multi-line text joined into one message, and @path completion.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface, type Interface } from "node:readline";

const PASTE_GAP_MS = 30; // lines closer together than this were pasted, not typed
const HISTORY = 500;

export type Input = {
  message: (prompt: string) => Promise<string | null>; // null at end of input
  answer: (prompt: string) => Promise<string>;
  onInterrupt: (fn: () => void) => void;
  close: () => void;
};

// `git ls-files` when there is a repo; completion is simply off otherwise.
export function fileCompleter(root: string) {
  let files: string[] | null = null;
  return (line: string): [string[], string] => {
    const at = line.match(/@(\S*)$/);
    if (!at) return [[], line];
    files ??= (spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).stdout ?? "").split("\n").filter(Boolean);
    const hits = files.filter((f) => f.startsWith(at[1]));
    const pool = hits.length ? hits : files.filter((f) => f.includes(at[1]));
    return [pool.slice(0, 40).map((f) => "@" + f), "@" + at[1]];
  };
}

export function createInput(opts: { historyFile: string; root: string }): Input {
  const tty = Boolean(process.stdin.isTTY);
  const history = existsSync(opts.historyFile) ? readFileSync(opts.historyFile, "utf8").split("\n").filter(Boolean).reverse() : [];
  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: tty,
    history,
    historySize: HISTORY,
    completer: fileCompleter(opts.root),
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
  const nextLine = (prompt: string, useQueue: boolean): Promise<string | null> => {
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
      const first = await nextLine(prompt, true);
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
      return (await nextLine(prompt, false)) ?? "";
    },
    onInterrupt(fn) {
      rl.on("SIGINT", fn);
    },
    close() {
      rl.close();
    },
  };
}
