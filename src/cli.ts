#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { AppOptions } from "./app.ts";
import type { Mode } from "./approve.ts";
import { runHeadless, runLineMode, type Format } from "./line.ts";
import { loadSettings } from "./settings.ts";

const VERSION = JSON.parse(readFileSync(join(dirname(import.meta.filename), "..", "package.json"), "utf8")).version;

const HELP = `heyho — coding agent for local models

  heyho                 interactive session in the current directory
  heyho "task"          run one task and exit (headless)
  heyho -p [task]       the same, with the task (or more of it) read from stdin

Options
  --profile <name>      model profile (default qwen3-coder; env HEYHO_PROFILE)
  --base-url <url>      override the profile's OpenAI-compatible endpoint
  --model <name>        override the profile's model name
  --mode <ask|auto|plan|dontask>
                        ask before every edit and command (default); only before commands;
                        change nothing and propose a plan; or refuse whatever isn't allowed
  --continue            carry on from the last session in this directory
  --resume [name]       reopen a session by name, or choose from a list
  --yolo                with a task: no approval prompts; bash runs in the macOS sandbox
  --no-net              with --yolo, the sandbox also blocks network access
  --max-steps <n>       step limit (default 40); --max-turns is the same
  --output-format <text|json|stream-json>
                        with a task: the reply (default), one JSON result, or a JSON event per line
  --json                the same as --output-format json
  --allowed-tools <rules>     rules to allow for this run, comma separated: "bash(npm test *),edit"
  --disallowed-tools <rules>  rules to refuse for this run
  --tools <names>       offer the model only these tools: read,edit,write,bash,search
  --system-prompt <text>        use this in place of heyho's own instructions
  --append-system-prompt <text> add this after them
  --session-name <name> name the session, for --resume
  --report <file>       write a JSON run report (used by the eval runner)
  --plain               interactive session without the full-screen input box
  --cwd <dir>           working directory
  --version             show version and exit

In a session, /help lists the commands and keys.`;

async function main() {
  const { values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      "base-url": { type: "string" },
      model: { type: "string" },
      mode: { type: "string" },
      continue: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      yolo: { type: "boolean", default: false },
      "no-net": { type: "boolean", default: false },
      "max-steps": { type: "string" },
      json: { type: "boolean", default: false },
      print: { type: "boolean", short: "p", default: false },
      "output-format": { type: "string" },
      "allowed-tools": { type: "string" },
      "disallowed-tools": { type: "string" },
      tools: { type: "string" },
      "system-prompt": { type: "string" },
      "append-system-prompt": { type: "string" },
      "session-name": { type: "string" },
      "max-turns": { type: "string" },
      report: { type: "string" },
      plain: { type: "boolean", default: false },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
    },
  });
  if (opt.help) return console.log(HELP);
  if (opt.version) return console.log(VERSION);
  // A flag wins over the environment, which wins over settings files, which win over the defaults.
  const cwd = realpathSync(opt.cwd ?? process.cwd());
  const { merged: settings } = loadSettings(cwd);
  const mode = opt.mode ?? settings.mode ?? "ask";
  if (!["ask", "auto", "plan", "dontask"].includes(mode)) throw new Error(`The mode is "ask", "auto", "plan" or "dontask", not "${mode}".`);

  // `--resume` takes an optional name. In a session every word after it is the name; with -p
  // the first word is the name and the rest is the task.
  const words = [...positionals];
  const resumeName = opt.resume && words.length ? (opt.print ? words.shift()! : words.splice(0).join(" ")).trim() : undefined;
  const piped = opt.print && !process.stdin.isTTY ? readFileSync(0, "utf8").trim() : "";
  const task = [words.join(" ").trim(), piped].filter(Boolean).join("\n\n");
  if (opt.print && !task) throw new Error("-p needs a task, as an argument or on stdin.");
  const headless = task.length > 0;
  const format = opt["output-format"] ?? (opt.json ? "json" : "text");
  if (!["text", "json", "stream-json"].includes(format)) throw new Error(`--output-format is "text", "json" or "stream-json", not "${format}".`);
  const list = (v?: string) => v?.split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);
  if (opt.yolo && !headless) throw new Error("--yolo needs a task argument; it is for unattended runs. In a session, use /mode yolo.");
  if (format !== "text" && !headless) throw new Error("--output-format needs a task argument.");

  const options: AppOptions = {
    profile: opt.profile ?? process.env.HEYHO_PROFILE ?? settings.profile ?? "qwen3-coder",
    baseUrl: opt["base-url"],
    model: opt.model,
    mode: opt.yolo ? "yolo" : (mode as Mode),
    noNet: opt["no-net"]!,
    maxSteps: Number(opt["max-steps"] ?? opt["max-turns"] ?? settings.maxSteps) || 40,
    cwd,
    headless,
    canAsk: Boolean(process.stdin.isTTY),
    resume: opt.continue!,
    resumeName: headless ? resumeName : undefined,
    sessionName: opt["session-name"],
    tools: list(opt.tools),
    allow: list(opt["allowed-tools"]),
    deny: list(opt["disallowed-tools"]),
    systemPrompt: opt["system-prompt"],
    appendSystemPrompt: opt["append-system-prompt"],
  };

  if (headless) return runHeadless(options, task, { format: format as Format, report: opt.report });
  if (opt.plain || !process.stdin.isTTY || !process.stdout.isTTY) return runLineMode(options);
  // Loaded only here, so headless runs don't pay for the UI library.
  const { runTui } = await import("./tui/index.tsx");
  // `--resume` takes an optional name; with one, the words after it are the name, not a task.
  await runTui(options, VERSION, resumeName ?? (opt.resume ? true : undefined));
}

main().catch((e) => {
  const text = e instanceof Error ? e.message : String(e);
  console.error(process.stderr.isTTY ? `\x1b[31m${text}\x1b[0m` : text);
  process.exit(1);
});
