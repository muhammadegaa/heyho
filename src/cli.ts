#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { newStats, runAgent, type AgentEvent, type RunResult } from "./loop.ts";
import { probeContext, type Message } from "./model.ts";
import { loadProfile } from "./profiles.ts";
import { systemPrompt } from "./prompt.ts";
import { TOOLS } from "./tools/index.ts";
import type { ToolContext } from "./tools/types.ts";

const HELP = `heyho — coding agent for local models

  heyho                 interactive session in the current directory
  heyho "task"          run one task and exit (headless)

Options
  --profile <name>      model profile (default qwen3-coder; env HEYHO_PROFILE)
  --base-url <url>      override the profile's OpenAI-compatible endpoint
  --model <name>        override the profile's model name
  --yolo                with a task: no approval prompts; bash runs in the macOS sandbox
  --no-net              with --yolo, the sandbox also blocks network access
  --max-steps <n>       step limit (default 40)
  --report <file>       write a JSON run report (used by the eval runner)
  --cwd <dir>           working directory`;

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);

async function main() {
  const { values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string", default: process.env.HEYHO_PROFILE ?? "qwen3-coder" },
      "base-url": { type: "string" },
      model: { type: "string" },
      yolo: { type: "boolean", default: false },
      "no-net": { type: "boolean", default: false },
      "max-steps": { type: "string", default: "40" },
      report: { type: "string" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (opt.help) return console.log(HELP);

  const root = realpathSync(opt.cwd ?? process.cwd());
  const stateDir = join(homedir(), ".heyho", "projects", createHash("sha256").update(root).digest("hex").slice(0, 16));
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
  const sessionFile = join(stateDir, "sessions", `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const record = (entry: unknown) => appendFileSync(sessionFile, JSON.stringify({ t: Date.now(), ...(entry as object) }) + "\n");

  const profile = loadProfile(opt.profile!, { baseUrl: opt["base-url"], model: opt.model });
  const probed = profile.local ? await probeContext(profile.baseUrl) : null;
  const contextSize = Number(process.env.HEYHO_CTX) || probed?.ctx || (profile.local ? 0 : 128_000);
  if (!contextSize) {
    throw new Error(`Could not read the context size from the server at ${profile.baseUrl}. Is it running? (llama-server and Ollama are detected; set HEYHO_CTX for others.)`);
  }
  if (probed?.server === "ollama" && probed.ctx > 131_072)
    console.error(red(`Ollama is running this model with a ${probed.ctx}-token context, which uses far more memory than needed. Set OLLAMA_CONTEXT_LENGTH=65536.`));

  const task = positionals.join(" ").trim();
  const headless = task.length > 0;
  if (opt.yolo && !headless) throw new Error("--yolo needs a task argument; it is for unattended runs.");
  let rl: Interface | undefined;
  const ask = (q: string) => (rl ??= createInterface({ input: process.stdin, output: process.stderr })).question(q);

  const always = new Set<string>();
  const ctx: ToolContext = {
    root,
    stateDir,
    seen: new Map(),
    sandbox: { enabled: opt.yolo!, noNet: opt["no-net"]! },
    outCount: { n: 0 },
    approve: async (kind, summary) => {
      if (opt.yolo) return true;
      // Bash is not sandboxed in ask mode, so "always" covers only the exact command.
      const key = kind === "bash" ? `bash:${summary.trim()}` : kind;
      if (always.has(key)) return true;
      if (!process.stdin.isTTY) return false;
      process.stderr.write(`\n${dim(summary)}\n`);
      const label = kind === "bash" ? "this exact command" : `all ${kind}s`;
      const a = (await ask(`Allow ${kind}? [y]es / [n]o / [a]lways for ${label} this session: `)).trim().toLowerCase();
      if (a === "a") always.add(key);
      return a === "y" || a === "a";
    },
  };

  const messages: Message[] = [{ role: "system", content: systemPrompt(root) }];
  record({ meta: { root, profile: opt.profile, model: profile.model, baseUrl: profile.baseUrl, contextSize, server: probed?.server } });
  record(messages[0]);
  const stats = newStats();
  const maxSteps = Number(opt["max-steps"]) || 40;
  let atLineStart = true;

  const onEvent = (e: AgentEvent) => {
    if (e.type === "text") {
      process.stdout.write(e.text);
      atLineStart = e.text.endsWith("\n");
    } else if (e.type === "tool") {
      if (!atLineStart) process.stdout.write("\n");
      atLineStart = true;
      const arg = String(e.args.path ?? e.args.command ?? e.args.pattern ?? e.args.glob ?? "").split("\n")[0].slice(0, 100);
      const first = e.result.text.split("\n")[0].slice(0, 120);
      process.stderr.write(`${dim("→")} ${e.name} ${arg}  ${e.result.ok ? dim(first) : red(first)}\n`);
    } else {
      const u = e.usage;
      const cached = u.prompt ? Math.round((100 * u.cached) / u.prompt) : 0;
      const prefill = u.prefillMs !== undefined ? ` · prefill ${(u.prefillMs / 1000).toFixed(1)} s` : "";
      const tps = u.genTps ? ` · ${u.genTps.toFixed(0)} tok/s` : "";
      if (!atLineStart) process.stdout.write("\n");
      atLineStart = true;
      process.stderr.write(dim(`[step ${e.step} · ${u.prompt} prompt tokens, ${cached}% cached${prefill}${tps} · ${(e.ms / 1000).toFixed(1)} s]\n`));
    }
  };

  let current: AbortController | null = null;
  const run = async (input: string): Promise<RunResult | { status: "error"; reason: string }> => {
    const m: Message = { role: "user", content: input };
    messages.push(m);
    record(m);
    const abort = (current = new AbortController());
    const onSigint = () => abort.abort();
    process.on("SIGINT", onSigint);
    ctx.signal = abort.signal;
    try {
      return await runAgent({ profile, messages, tools: TOOLS, ctx, maxSteps, contextSize, stats, onEvent, record, signal: abort.signal });
    } catch (e) {
      if (abort.signal.aborted) return { status: "interrupted" };
      return { status: "error", reason: (e as Error).message };
    } finally {
      process.off("SIGINT", onSigint);
      current = null;
    }
  };

  console.error(dim(`heyho · ${profile.model} · ${probed?.server ?? new URL(profile.baseUrl).host} · ${contextSize} context · ${opt.yolo ? "yolo (sandboxed bash)" : "ask"} · ${root}`));

  if (headless) {
    const t0 = Date.now();
    const result = await run(task);
    if (!atLineStart) process.stdout.write("\n");
    if (result.status !== "done") console.error(red(`[${result.status}] ${"reason" in result && result.reason ? result.reason : ""}`));
    if (opt.report) writeFileSync(opt.report, JSON.stringify({ ...result, stats, wallMs: Date.now() - t0, model: profile.model, contextSize, session: sessionFile }, null, 2));
    rl?.close();
    process.exit(result.status === "done" ? 0 : result.status === "error" ? 1 : 2);
  }

  console.error(dim("Type a task. /context shows token use, /exit quits. Ctrl-C stops a running task."));
  rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on("SIGINT", () => {
    if (current) return current.abort();
    rl!.close();
    process.exit(0);
  });
  for (;;) {
    const input = (await rl.question("\n> ")).trim();
    if (!input) continue;
    if (input === "/exit") break;
    if (input === "/context") {
      const last = stats.turns.at(-1);
      console.error(`${last?.prompt ?? 0} of ${contextSize} tokens in context · ${stats.steps} steps · tool calls ${JSON.stringify(stats.toolCalls)} · session ${sessionFile}`);
      continue;
    }
    const result = await run(input);
    if (!atLineStart) process.stdout.write("\n");
    atLineStart = true;
    if (result.status !== "done") console.error(red(`[${result.status}] ${"reason" in result && result.reason ? result.reason : ""}`));
  }
  rl.close();
}

main().catch((e) => {
  console.error(red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
