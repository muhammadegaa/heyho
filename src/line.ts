// The two front ends that need no terminal UI: a headless run of one task, and a
// line-at-a-time session for when stdin or stdout is not a terminal.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { App, INIT_TASK, type AppOptions, type ApprovalAnswer, type ApprovalRequest } from "./app.ts";
import { expand, loadCommands } from "./commands.ts";
import type { AgentEvent } from "./loop.ts";
import { MODE_HELP, MODES, type Mode } from "./approve.ts";
import { createInput, type Input } from "./input.ts";
import { heyhoHome } from "./settings.ts";
import { changeTitle, Renderer, renderDiff } from "./ui.ts";

const COMMAND_NAMES = ["help", "context", "compact", "clear", "resume", "undo", "mode", "allowed", "init", "model", "exit"];
const HELP = `  /context  /compact  /clear  /resume [n]  /undo  /mode [name]  /allowed [reset]  /init  /model [profile]  /exit
  End a line with \\ to continue it. !command runs it yourself. Ctrl-C stops a running task.`;

function build(opts: AppOptions, ui: Renderer, input: () => Input, tap?: (e: AgentEvent) => void) {
  const { dim, bold } = ui.colors;
  const ask = async (req: ApprovalRequest): Promise<ApprovalAnswer> => {
    const resume = ui.pause();
    const shown = req.change ? `${bold(changeTitle(req.change))}\n${renderDiff(req.change, ui.colors).lines.join("\n")}` : `${bold("bash")} ${req.summary}`;
    const options =
      req.kind === "bash"
        ? `[y]es  [n]o  [a]lways for this exact command${req.prefix ? `  [p] always for "${req.prefix}"` : ""}`
        : `[y]es  [n]o  [a]lways for ${req.kind}s this session`;
    process.stderr.write(`\n${shown}\n${dim(options + "  ·  or type what to do instead")}\n`);
    for (;;) {
      const a = (await input().answer(`${bold("Allow?")} `)).trim();
      const k = a.toLowerCase();
      if (!k) continue;
      resume();
      if (k === "y" || k === "yes") return "yes";
      if (k === "a" || k === "always") return "always";
      if ((k === "p" || k === "prefix") && req.prefix) return "prefix";
      return k === "n" || k === "no" ? "no" : { say: a };
    }
  };
  const onEvent = tap ? (e: AgentEvent) => (tap(e), ui.onEvent(e)) : ui.onEvent;
  const question = async (text: string, options: string[]) => {
    const resume = ui.pause();
    process.stderr.write(`\n${bold(text)}\n${options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}${options.length ? "\n" : ""}`);
    const a = (await input().answer(`${dim(options.length ? "A number, or your own answer: " : "Your answer: ")}`)).trim();
    resume();
    return options[Number(a) - 1] ?? a;
  };
  return new App(opts, { onEvent, ask, question, note: (text, tone) => ui.note(tone === "error" ? ui.colors.red(text) : tone === "warn" ? ui.colors.yellow(text) : tone === "dim" ? dim(text) : text), changed: (c) => ui.changed(c), output: (c) => ui.output(c) });
}

export type Format = "text" | "json" | "stream-json";

// stream-json prints one JSON object per line on stdout as things happen: start, then text
// (each reply, whole), tool_call and tool_result, and a final result.
export async function runHeadless(opts: AppOptions, task: string, out: { format: Format; report?: string }) {
  const structured = out.format !== "text";
  const ui = new Renderer({ stdoutTTY: Boolean(process.stdout.isTTY) && !structured, stderrTTY: Boolean(process.stderr.isTTY), text: structured ? process.stderr : process.stdout });
  const emit = (event: object) => out.format === "stream-json" && console.log(JSON.stringify(event));
  let text = "";
  const tap = (e: AgentEvent) => {
    if (e.type === "text") text += e.text;
    else if (e.type === "turn" || e.type === "tool_start") {
      if (text) emit({ type: "text", text });
      text = "";
      if (e.type === "tool_start") emit({ type: "tool_call", name: e.name, args: e.args });
    } else if (e.type === "tool") emit({ type: "tool_result", name: e.name, ok: e.result.ok, text: e.result.text.slice(0, 4000) });
  };
  let input: Input | undefined;
  const app = build(opts, ui, () => (input ??= createInput({ historyFile: join(heyhoHome(), "history"), root: opts.cwd, commands: [] })), tap);
  await app.start();
  emit({ type: "start", model: app.profile.model, cwd: app.root, mode: app.mode, session: app.session.file });
  for (const problem of app.problems) console.error(ui.colors.yellow(problem));
  console.error(ui.colors.dim(`${app.banner()} · ${app.root}`));
  const onSigint = () => app.interrupt();
  process.on("SIGINT", onSigint);
  const { result, info } = await app.run(task);
  process.off("SIGINT", onSigint);
  ui.finish(result, info);
  if (out.report) writeFileSync(out.report, JSON.stringify({ ...result, stats: app.stats, wallMs: info.wallMs, model: app.profile.model, contextSize: app.contextSize, session: app.session.file }, null, 2));
  const summary = { status: result.status, reason: "reason" in result ? result.reason : undefined, reply: app.lastReply(), steps: app.stats.steps, wallMs: info.wallMs, changes: info.changes, session: app.session.file };
  if (out.format === "json") console.log(JSON.stringify(summary, null, 2));
  emit({ type: "result", ...summary });
  input?.close();
  app.shutdown();
  process.exit(result.status === "done" ? 0 : result.status === "error" ? 1 : 2);
}

export async function runLineMode(opts: AppOptions) {
  const ui = new Renderer({ stdoutTTY: Boolean(process.stdout.isTTY), stderrTTY: Boolean(process.stderr.isTTY) });
  const { dim, bold, red, yellow } = ui.colors;
  let input: Input | undefined;
  const prompt = () => (input ??= createInput({ historyFile: join(heyhoHome(), "history"), root: opts.cwd, commands: COMMAND_NAMES }));
  const app = build(opts, ui, prompt);
  await app.start();
  console.error(dim(`${app.banner()} · ${app.root}`));
  if (app.resumed) console.error(dim(`Continuing the session from ${app.resumed.when.toLocaleString()}: "${app.resumed.first}"`));
  console.error(dim("Type a task. /help lists commands. Ctrl-C stops a running task."));
  prompt().onInterrupt(() => {
    if (app.running) return app.interrupt();
    prompt().close();
    process.exit(0);
  });

  const run = async (text: string) => {
    const { result, info } = await app.run(text);
    ui.finish(result, info);
  };
  const commands: Record<string, (arg: string) => Promise<void> | void> = {
    help: () => console.error(HELP),
    context: () => console.error(`${app.contextUsed} of ${app.contextSize} tokens in context (${Math.round((100 * app.contextUsed) / app.contextSize)}%) · ${app.stats.turns.length} model calls · session ${app.session.file}`),
    compact: async () => {
      const problem = await app.compact();
      ui.quiet();
      if (problem) console.error(yellow(problem));
    },
    clear: () => (app.clear(), console.error(dim("New conversation. The previous one is still listed under /resume."))),
    resume: (arg) => {
      const list = app.sessions();
      if (!list.length) return console.error("No earlier sessions in this directory.");
      const pick = list[Number(arg) - 1];
      if (!pick) {
        list.forEach((s, i) => console.error(`  ${i + 1}  ${s.when.toLocaleString()}  ${dim(`${s.turns} message${s.turns > 1 ? "s" : ""}`)}  ${s.first}`));
        return console.error(dim("Reopen one with /resume <number>."));
      }
      app.resume(pick);
      console.error(dim(`Reopened "${pick.first}". Your next message continues it.`));
    },
    undo: () => {
      const r = app.undo();
      if (!r) return console.error("No file changes to take back.");
      if (r.restored.length) console.error(`Restored: ${r.restored.join(", ")}`);
      if (r.skipped.length) console.error(yellow(`Left alone because they changed after the agent wrote them: ${r.skipped.join(", ")}`));
    },
    mode: (arg) => {
      if (MODES.includes(arg as Mode)) app.setMode(arg as Mode);
      else if (arg) return console.error(`Modes: ${MODES.map((m) => `${m} (${MODE_HELP[m]})`).join("; ")}.`);
      console.error(app.approvals.describe()[0]);
    },
    allowed: (arg) => {
      if (arg === "reset") app.approvals.forget();
      console.error(app.approvals.describe().join("\n"));
    },
    init: () => run(INIT_TASK),
    model: async (arg) => {
      const problem = arg ? await app.switchModel(arg) : null;
      console.error(problem ? red(problem) : app.banner());
    },
  };

  for (;;) {
    const line = await prompt().message(() => `\n${app.mode === "ask" ? "" : dim(`${app.mode} `)}${bold("›")} `);
    if (line === null) break;
    if (!line) continue;
    if (line.startsWith("/") && !line.includes("\n")) {
      const [name, ...rest] = line.slice(1).split(/\s+/);
      if (name === "exit" || name === "quit") break;
      const command = commands[name];
      const custom = loadCommands(app.root).find((c) => c.name === name);
      if (command) await command(rest.join(" "));
      else if (custom) await run(expand(custom, rest.join(" ")));
      else console.error(`Unknown command /${name}. /help lists them.`);
      continue;
    }
    if (line.startsWith("!") && !line.includes("\n")) {
      const r = app.shell(line.slice(1));
      process.stderr.write(r.output + dim(`exit code ${r.code}\n`));
      continue;
    }
    await run(line);
  }
  app.shutdown();
  prompt().close();
}
