import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { declined, fail, ok, type Job, type Tool, type ToolContext } from "./types.ts";

const HEAD = 4000;
const TAIL = 4000;
const MAX_KEEP = 50_000_000;

const q = (s: string) => JSON.stringify(s);

// macOS Seatbelt: writes only to the workspace, temp dirs and package caches; optionally no
// network. Later rules override earlier ones in SBPL. The eval runner reuses this for Pi.
export function seatbeltProfile(root: string, noNet: boolean): string {
  const home = homedir();
  const writable = [
    root,
    dirname(realpathSync(tmpdir())), // this user's /var/folders entry: $TMPDIR (T) and the cache dir (C)
    "/private/tmp",
    "/dev",
    ...[".npm", ".bun", ".cache", "Library/Caches"].map((d) => join(home, d)),
  ];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(" ")})`,
    noNet ? "(deny network*)" : "",
  ].join("\n");
}

export function capOutput(ctx: ToolContext, out: string): string {
  if (out.length <= HEAD + TAIL) return out;
  const dir = join(ctx.stateDir, "out");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${++ctx.outCount.n}.log`);
  writeFileSync(file, out);
  const omitted = out.length - HEAD - TAIL;
  return `${out.slice(0, HEAD)}\n[... ${omitted} characters omitted. Full output: ${file} (read it with offset to page through)]\n${out.slice(-TAIL)}`;
}

export const bash: Tool = {
  name: "bash",
  description:
    "Run a shell command in the working directory: tests, builds, git, listing files. Each call starts a fresh bash with no TTY and no stdin; background processes are stopped when the command exits. Long output is cut to its start and end, with the full log path shown.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
      timeout: { type: "integer", description: "Seconds before the command is killed (default 120, max 600)" },
      background: { type: "boolean", description: "For servers: return at once, output goes to a log file" },
    },
    required: ["command"],
  },
  async run(args, ctx) {
    // With background set, a trailing "&" would let bash exit at once and leave the program untracked.
    const command = args.background === true ? String(args.command).replace(/\s*&\s*$/, "") : String(args.command);
    const timeout = Math.min(600, Math.max(1, Number(args.timeout) || 120));
    const no = await declined(ctx, "bash", command);
    if (no) return no;
    const [cmd, argv] = ctx.sandbox.enabled
      ? ["/usr/bin/sandbox-exec", ["-p", seatbeltProfile(ctx.root, ctx.sandbox.noNet), "/bin/bash", "-c", command]]
      : ["/bin/bash", ["-c", command]];

    if (args.background === true) {
      const dir = join(ctx.stateDir, "jobs");
      mkdirSync(dir, { recursive: true });
      const id = ctx.jobs.length + 1;
      const log = join(dir, `${Date.now()}-${id}.log`);
      const fd = openSync(log, "w");
      const child = spawn(cmd, argv as string[], { cwd: ctx.root, env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", CI: "1", TERM: "dumb", NO_COLOR: "1" }, detached: true, stdio: ["ignore", fd, fd] });
      closeSync(fd);
      const job: Job = { id, pid: child.pid!, command, log, started: Date.now() };
      ctx.jobs.push(job);
      child.on("exit", (code) => (job.exit = code));
      child.on("error", () => (job.exit = null));
      child.unref();
      return ok(`Started in the background as job ${id} (process group ${child.pid}).\nIts output goes to ${log}; read that file to see how it is doing.\nStop it with: kill -- -${child.pid}`);
    }

    return new Promise((resolveResult) => {
      const child = spawn(cmd, argv as string[], {
        cwd: ctx.root,
        env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", CI: "1", TERM: "dumb", NO_COLOR: "1" },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      const collect = (b: Buffer) => {
        if (size < MAX_KEEP) chunks.push(b);
        size += b.length;
        ctx.onOutput?.(b.toString("utf8"));
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      let timedOut = false;
      let done = false;
      const killGroup = () => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeout * 1000);
      const onAbort = () => killGroup();
      ctx.signal?.addEventListener("abort", onAbort);

      const finish = (code: number | null, err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        killGroup();
        if (err) return resolveResult(fail(`Could not run the command: ${err.message}`));
        const out = Buffer.concat(chunks).toString("utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
        const header = timedOut ? `timed out after ${timeout} s; process killed` : ctx.signal?.aborted ? "interrupted by the user" : `exit code ${code}`;
        resolveResult(ok(`${header}\n${capOutput(ctx, out) || "(no output)"}`));
      };
      child.on("error", (e) => finish(null, e));
      // A backgrounded process can hold the pipes open after bash exits; don't wait for it.
      child.on("exit", (code) => setTimeout(() => finish(code), 300));
      child.on("close", (code) => finish(code));
    });
  },
};
