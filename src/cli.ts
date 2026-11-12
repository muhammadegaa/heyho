#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Approvals, prefixOf, type Mode } from "./approve.ts";
import { Changes } from "./changes.ts";
import { compact } from "./compact.ts";
import { createInput, type Input } from "./input.ts";
import { newStats, runAgent, type RunResult } from "./loop.ts";
import { probeContext, type Message } from "./model.ts";
import { loadProfile } from "./profiles.ts";
import { systemPrompt } from "./prompt.ts";
import { listSessions, loadMessages, newSession } from "./session.ts";
import { TOOLS, toolSchemas } from "./tools/index.ts";
import type { ToolContext } from "./tools/types.ts";
import { Renderer, renderChange } from "./ui.ts";

const HELP = `heyho — coding agent for local models

  heyho                 interactive session in the current directory
  heyho "task"          run one task and exit (headless)

Options
  --profile <name>      model profile (default qwen3-coder; env HEYHO_PROFILE)
  --base-url <url>      override the profile's OpenAI-compatible endpoint
  --model <name>        override the profile's model name
  --mode <ask|auto>     ask before every edit and command (default), or only before commands
  --continue            carry on from the last session in this directory
  --yolo                with a task: no approval prompts; bash runs in the macOS sandbox
  --no-net              with --yolo, the sandbox also blocks network access
  --max-steps <n>       step limit (default 40)
  --json                with a task: print the result as JSON on stdout
  --report <file>       write a JSON run report (used by the eval runner)
  --cwd <dir>           working directory`;

const COMMANDS = `  /help             this list
  /context          tokens in use, steps and the session file
  /compact          shorten the conversation so far to free context
  /clear            start a new conversation (the old one stays on disk)
  /resume [n]       list earlier sessions here, or reopen number n
  /undo             take back the file changes of the last turn that made any
  /mode [ask|auto]  show or set whether edits ask first
  /allowed          what currently runs without asking
  /model [profile]  show or switch the model profile
  /exit             quit

  End a line with \\ to continue on the next one. Pasted text stays one message.
  @ then Tab completes a file path. Ctrl-C stops a running task.`;

const BELL_AFTER_MS = 20_000;
const SERVER_HELP = (url: string) =>
  `No model server answered at ${url}.\nStart one, for example:\n  llama-server -m <model.gguf> --jinja -c 65536 --port 8080\nor name another server with --base-url. (llama-server and Ollama are detected; set HEYHO_CTX for others.)`;

async function main() {
  const { values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string", default: process.env.HEYHO_PROFILE ?? "qwen3-coder" },
      "base-url": { type: "string" },
      model: { type: "string" },
      mode: { type: "string", default: "ask" },
      continue: { type: "boolean", default: false },
      yolo: { type: "boolean", default: false },
      "no-net": { type: "boolean", default: false },
      "max-steps": { type: "string", default: "40" },
      json: { type: "boolean", default: false },
      report: { type: "string" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (opt.help) return console.log(`${HELP}\n\nIn a session\n${COMMANDS}`);
  if (opt.mode !== "ask" && opt.mode !== "auto") throw new Error(`--mode is "ask" or "auto", not "${opt.mode}".`);

  const root = realpathSync(opt.cwd ?? process.cwd());
  const stateDir = join(homedir(), ".heyho", "projects", createHash("sha256").update(root).digest("hex").slice(0, 16));
  mkdirSync(stateDir, { recursive: true });

  const task = positionals.join(" ").trim();
  const headless = task.length > 0;
  if (opt.yolo && !headless) throw new Error("--yolo needs a task argument; it is for unattended runs.");
  if (opt.json && !headless) throw new Error("--json needs a task argument.");

  const ui = new Renderer({ stdoutTTY: Boolean(process.stdout.isTTY) && !opt.json, stderrTTY: Boolean(process.stderr.isTTY), text: opt.json ? process.stderr : process.stdout });
  const { dim, red, bold, yellow } = ui.colors;

  let profile = loadProfile(opt.profile!, { baseUrl: opt["base-url"], model: opt.model });
  let server = "";
  let contextSize = 0;
  const connect = async () => {
    const probed = profile.local ? await probeContext(profile.baseUrl) : null;
    contextSize = Number(process.env.HEYHO_CTX) || probed?.ctx || (profile.local ? 0 : 128_000);
    if (!contextSize) throw new Error(SERVER_HELP(profile.baseUrl));
    server = probed?.server ?? new URL(profile.baseUrl).host;
    if (probed?.server === "ollama" && probed.ctx > 131_072)
      ui.note(red(`Ollama is running this model with a ${probed.ctx}-token context, which uses far more memory than needed. Set OLLAMA_CONTEXT_LENGTH=65536.`));
  };
  await connect();

  const approvals = new Approvals(opt.yolo ? "yolo" : (opt.mode as Mode));
  const changes = new Changes(root);
  const stats = newStats();
  const maxSteps = Number(opt["max-steps"]) || 40;
  let input: Input | undefined;
  const prompt = () => (input ??= createInput({ historyFile: join(homedir(), ".heyho", "history"), root }));
  let runStart = 0;

  const ctx: ToolContext = {
    root,
    stateDir,
    seen: new Map(),
    sandbox: { enabled: opt.yolo!, noNet: opt["no-net"]! },
    outCount: { n: 0 },
    onChange: changes.record,
    onOutput: (chunk) => ui.output(chunk),
    approve: async (kind, summary) => {
      if (approvals.allowed(kind, summary)) return true;
      if (!process.stdin.isTTY) return false;
      const resume = ui.pause();
      if (Date.now() - runStart > BELL_AFTER_MS) process.stderr.write("\x07");
      const prefix = kind === "bash" ? prefixOf(summary) : null;
      const shown = kind === "bash" ? `${bold("bash")} ${summary}` : `${bold(kind)} ${renderChange(kind, summary, ui.colors)}`;
      const options =
        kind === "bash"
          ? `[y]es  [n]o  [a]lways for this exact command${prefix ? `  [p] always for "${prefix} …"` : ""}`
          : `[y]es  [n]o  [a]lways for ${kind}s this session`;
      process.stderr.write(`\n${shown}\n${dim(options + "  ·  or type what to do instead")}\n`);
      for (;;) {
        const a = (await prompt().answer(`${bold("Allow?")} `)).trim();
        const k = a.toLowerCase();
        if (!k) continue;
        resume();
        if (k === "a" || k === "always") kind === "bash" ? approvals.allowExact(summary) : approvals.allowKind(kind);
        if ((k === "p" || k === "prefix") && prefix) approvals.allowPrefix(prefix);
        if (["y", "yes", "a", "always"].includes(k) || ((k === "p" || k === "prefix") && prefix)) return true;
        return k === "n" || k === "no" ? false : a;
      }
    },
  };

  let session = newSession(stateDir);
  const messages: Message[] = [];
  // Messages are replaced in place: the running agent holds this same array.
  const startSession = (next: Message[], fresh: boolean) => {
    if (fresh) session = newSession(stateDir);
    session.record(fresh ? { meta: { root, profile: opt.profile, model: profile.model, baseUrl: profile.baseUrl, contextSize, server } } : { reset: true });
    messages.length = 0;
    messages.push(...next);
    for (const m of next) session.record(m);
  };
  const resumed = opt.continue ? listSessions(stateDir, 1)[0] : undefined;
  if (opt.continue && !resumed) throw new Error("There is no earlier session in this directory to continue.");
  startSession(resumed ? loadMessages(resumed.file) : [{ role: "system", content: systemPrompt(root) }], true);

  let current: AbortController | null = null;
  let note = ""; // told to the model at the start of the next user message

  const shorten = async (signal?: AbortSignal) => {
    ui.onEvent({ type: "request", step: 0 });
    const next = await compact(profile, messages, toolSchemas(TOOLS), { signal, onReasoning: (text) => ui.onEvent({ type: "thinking", text }) });
    ui.quiet();
    startSession(next, false);
    ui.note(dim("Shortened the conversation to the model's own notes. Files it read earlier will be read again when needed."));
  };

  const run = async (text: string): Promise<RunResult | { status: "error"; reason: string }> => {
    const withPaths = text.replace(/(^|\s)@(\S+)/g, (all, lead, p) => (existsSync(join(root, p)) ? lead + p : all));
    const m: Message = { role: "user", content: note + withPaths };
    note = "";
    messages.push(m);
    session.record(m);
    changes.startTurn();
    runStart = Date.now();
    const abort = (current = new AbortController());
    const onSigint = () => abort.abort();
    process.on("SIGINT", onSigint);
    ctx.signal = abort.signal;
    const agent = () => runAgent({ profile, messages, tools: TOOLS, ctx, maxSteps, contextSize, stats, onEvent: ui.onEvent, record: (e) => session.record(e), signal: abort.signal });
    let result: RunResult | { status: "error"; reason: string };
    try {
      result = await agent();
      if (result.status === "context_full") {
        await shorten(abort.signal);
        const go: Message = { role: "user", content: "Carry on with the task from where you stopped." };
        messages.push(go);
        session.record(go);
        result = await agent();
      }
    } catch (e) {
      const reason = (e as Error).message;
      result = abort.signal.aborted ? { status: "interrupted" } : { status: "error", reason: /connection failed|ECONNREFUSED|fetch failed/i.test(reason) ? `${reason}. Is the model server still running?` : reason };
    } finally {
      process.off("SIGINT", onSigint);
      current = null;
    }
    const last = stats.turns.at(-1);
    const wallMs = Date.now() - runStart;
    ui.finish(result, { model: profile.model, contextSize, wallMs, steps: stats.steps, lastPrompt: last?.prompt ?? 0, lastCompletion: last?.completion ?? 0, tps: last?.genTps, changes: changes.summary() });
    if (!headless && wallMs > BELL_AFTER_MS) process.stderr.write("\x07");
    return result;
  };

  const banner = () => `heyho · ${profile.model} · ${server} · ${contextSize} context · ${approvals.mode === "yolo" ? "yolo (sandboxed bash)" : approvals.mode} · ${root}`;
  console.error(dim(banner()));

  if (headless) {
    const t0 = Date.now();
    const result = await run(task);
    const report = { ...result, stats, wallMs: Date.now() - t0, model: profile.model, contextSize, session: session.file };
    if (opt.report) writeFileSync(opt.report, JSON.stringify(report, null, 2));
    if (opt.json) {
      const reply = messages.findLast((m) => m.role === "assistant");
      console.log(JSON.stringify({ status: result.status, reason: "reason" in result ? result.reason : undefined, reply: reply?.content ?? null, steps: stats.steps, wallMs: report.wallMs, changes: changes.summary(), session: session.file }, null, 2));
    }
    input?.close();
    process.exit(result.status === "done" ? 0 : result.status === "error" ? 1 : 2);
  }

  if (resumed) console.error(dim(`Continuing the session from ${resumed.when.toLocaleString()}: "${resumed.first}"`));
  console.error(dim("Type a task. /help lists commands. Ctrl-C stops a running task."));
  prompt().onInterrupt(() => {
    if (current) return current.abort();
    prompt().close();
    process.exit(0);
  });

  const commands: Record<string, (arg: string) => Promise<void> | void> = {
    help: () => console.error(COMMANDS),
    context: () => {
      const last = stats.turns.at(-1);
      const used = (last?.prompt ?? 0) + (last?.completion ?? 0);
      console.error(`${used} of ${contextSize} tokens in context (${Math.round((100 * used) / contextSize)}%) · ${stats.turns.length} model calls · tool calls ${JSON.stringify(stats.toolCalls)} · session ${session.file}`);
    },
    compact: async () => {
      if (messages.length < 4) return console.error("Nothing to shorten yet.");
      const abort = (current = new AbortController());
      try {
        await shorten(abort.signal);
      } catch (e) {
        ui.note(red(abort.signal.aborted ? "Stopped; the conversation is unchanged." : `Could not shorten the conversation: ${(e as Error).message}`));
      } finally {
        current = null;
      }
    },
    clear: () => {
      startSession([{ role: "system", content: systemPrompt(root) }], true);
      ctx.seen.clear();
      console.error(dim("New conversation. The previous one is still listed under /resume."));
    },
    resume: (arg) => {
      const list = listSessions(stateDir).filter((s) => s.file !== session.file);
      if (!list.length) return console.error("No earlier sessions in this directory.");
      const pick = list[Number(arg) - 1];
      if (!pick) {
        list.forEach((s, i) => console.error(`  ${i + 1}  ${s.when.toLocaleString()}  ${dim(`${s.turns} message${s.turns > 1 ? "s" : ""}`)}  ${s.first}`));
        return console.error(dim("Reopen one with /resume <number>."));
      }
      startSession(loadMessages(pick.file), true);
      ctx.seen.clear();
      console.error(dim(`Reopened "${pick.first}". Your next message continues it.`));
    },
    undo: () => {
      const r = changes.undo();
      if (!r) return console.error("No file changes to take back.");
      if (r.restored.length) {
        console.error(`Restored: ${r.restored.join(", ")}`);
        note = `[The user took back your file changes from an earlier turn. These files are back to their previous content: ${r.restored.join(", ")}. Read them again before editing.]\n\n`;
      }
      if (r.skipped.length) console.error(yellow(`Left alone because they changed after the agent wrote them: ${r.skipped.join(", ")}`));
      console.error(dim("Commands the agent ran are not undone."));
    },
    mode: (arg) => {
      if (arg === "ask" || arg === "auto") approvals.mode = arg;
      else if (arg) return console.error(`Modes are "ask" and "auto".`);
      console.error(approvals.describe()[0]);
    },
    allowed: () => console.error(approvals.describe().join("\n")),
    model: async (arg) => {
      if (arg) {
        const before = profile;
        try {
          profile = loadProfile(arg, {});
          await connect();
        } catch (e) {
          profile = before;
          return console.error(red((e as Error).message));
        }
      }
      console.error(banner());
    },
  };

  for (;;) {
    const line = await prompt().message(`\n${bold("›")} `);
    if (line === null) break;
    if (!line) continue;
    if (line.startsWith("/") && !line.includes("\n")) {
      const [name, ...rest] = line.slice(1).split(/\s+/);
      if (name === "exit" || name === "quit") break;
      const command = commands[name];
      if (command) await command(rest.join(" "));
      else console.error(`Unknown command /${name}. /help lists them.`);
      continue;
    }
    await run(line);
  }
  prompt().close();
}

main().catch((e) => {
  console.error(process.stderr.isTTY ? `\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m` : e instanceof Error ? e.message : String(e));
  process.exit(1);
});
