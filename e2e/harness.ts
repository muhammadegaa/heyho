// Drives the real screen in a tmux pane against the scripted server, so the tests see what
// a person would see: the rendered rows of the terminal after each key.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type Step = { think?: string; text?: string; calls?: [string, object][]; slow?: boolean };

const tmux = (...args: string[]) => spawnSync("tmux", args, { encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

export const FILES = {
  "greet.js": 'const name = "world";\nconst greeting = "hello";\nconsole.log(greeting + ", " + name);\n',
  "src/cart.js": "export const total = (items) => items.reduce((s, i) => s + i.price, 0);\n",
  "README.md": "# demo\n",
};

// `root` reuses an earlier session's folder (and so its saved sessions) instead of making a new one.
export async function open(opts: { steps?: Step[]; files?: Record<string, string>; cols?: number; rows?: number; args?: string[]; git?: boolean; root?: string; env?: Record<string, string> } = {}) {
  const name = `heyho-e2e-${process.pid}-${++n}`;
  const root = opts.root ?? realpathSync(mkdtempSync(join(tmpdir(), "heyho-e2e-")));
  for (const [path, content] of Object.entries(opts.root ? {} : (opts.files ?? FILES))) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (opts.git) spawnSync("sh", ["-c", "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init"], { cwd: root });
  const stepsFile = join(root, ".steps.json");
  writeFileSync(stepsFile, JSON.stringify(opts.steps ?? []));
  const demo = join(import.meta.dirname, "../scripts/ui-demo.ts");
  tmux("new-session", "-d", "-s", name, "-x", String(opts.cols ?? 100), "-y", String(opts.rows ?? 30), "-e", `DEMO_STEPS=${stepsFile}`, "-e", `DEMO_ROOT=${root}`, "-e", "DEMO_FAST=1", ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    `bun ${demo} ${(opts.args ?? []).join(" ")}; echo heyho has exited; sleep 600`);
  const s = {
    root,
    // The visible rows, without trailing blanks.
    screen: () => tmux("capture-pane", "-t", name, "-p").stdout.replace(/\s+$/, ""),
    // Everything printed so far, including what has scrolled off.
    scrollback: () => tmux("capture-pane", "-t", name, "-p", "-S", "-500").stdout.replace(/\s+$/, ""),
    type: async (text: string) => (tmux("send-keys", "-t", name, "-l", text), await sleep(120)),
    key: async (...keys: string[]) => {
      for (const k of keys) (tmux("send-keys", "-t", name, k), await sleep(120));
    },
    paste: async (text: string) => (tmux("set-buffer", "-b", name, text), tmux("paste-buffer", "-p", "-b", name, "-t", name), await sleep(200)),
    resize: async (cols: number, rows: number) => (tmux("resize-window", "-t", name, "-x", String(cols), "-y", String(rows)), await sleep(700)),
    // Waits until the screen matches, or fails with what the screen showed.
    wait: async (pattern: RegExp, ms = 8000) => {
      const until = Date.now() + ms;
      for (;;) {
        const now = s.screen();
        if (pattern.test(now)) return now;
        if (Date.now() > until) throw new Error(`screen never matched ${pattern}:\n${now}`);
        await sleep(100);
      }
    },
    send: async (text: string) => (await s.type(text), await s.key("Enter")),
    close: () => tmux("kill-session", "-t", name),
  };
  await s.wait(/describe a task|Type a task|Reopen a session/);
  return s;
}

export const reply = (text: string): Step => ({ text });
export const call = (name: string, args: object, text?: string): Step => ({ text, calls: [[name, args]] });
export const rules = (screen: string) => screen.split("\n").filter((l) => /^─{20,}$/.test(l.trim())).length;
