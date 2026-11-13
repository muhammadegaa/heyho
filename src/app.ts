// One heyho session, without a screen: the conversation, the model connection, modes and
// approval rules, file changes, and the commands that act on them. A front end (the Ink
// screen, the line mode, or a headless run) supplies `Front` and calls these methods.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Approvals, CYCLE, MODES, PLAN_REFUSAL, type Kind, type Mode } from "./approve.ts";
import { heyhoHome, loadSettings } from "./settings.ts";
import { Changes } from "./changes.ts";
import { CARRY_ON, compact } from "./compact.ts";
import { newStats, runAgent, type AgentEvent, type RunResult, type Stats } from "./loop.ts";
import { probeContext, type Message, type Profile } from "./model.ts";
import { loadProfile } from "./profiles.ts";
import { folderInstructions, instructions, systemPrompt } from "./prompt.ts";
import { listSessions, loadSession, newSession, type Checkpoint, type Loaded, type Session, type SessionInfo } from "./session.ts";
import { TOOLS, toolSchemas } from "./tools/index.ts";
import type { Change, Job, Todo, Tool, ToolContext } from "./tools/types.ts";
import type { RunInfo } from "./ui.ts";

export type Outcome = RunResult | { status: "error"; reason: string };
// `prefix` describes what "don't ask again" would allow, or is null when only the exact command can be.
export type ApprovalRequest = { kind: Kind; summary: string; change?: Change; prefix: string | null };
// "always": every edit this session, or this exact command from now on. "prefix": commands that start the same way.
export type ApprovalAnswer = "yes" | "always" | "prefix" | "no" | { say: string };

export type Front = {
  onEvent: (e: AgentEvent) => void;
  ask: (req: ApprovalRequest) => Promise<ApprovalAnswer>; // only called when a person can answer
  question?: (question: string, options: string[]) => Promise<string>; // the model asks the user something
  todos?: (items: Todo[]) => void;
  note: (text: string, tone?: "dim" | "warn" | "error") => void;
  changed?: (change: Change) => void;
  output?: (chunk: string) => void;
};

export type AppOptions = {
  profile: string;
  baseUrl?: string;
  model?: string;
  mode: Mode;
  noNet: boolean;
  maxSteps: number;
  cwd: string;
  headless: boolean;
  canAsk: boolean; // false when nobody is at a terminal to answer
  resume: boolean; // carry on from the last session here
  resumeName?: string; // or from the one whose name or first message contains this
  sessionName?: string;
  tools?: string[]; // offer the model only these
  allow?: string[]; // extra rules for this run
  deny?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
};

export const SERVER_HELP = (url: string) =>
  `No model server answered at ${url}.\nStart one, for example:\n  llama-server -m <model.gguf> --jinja -c 65536 --port 8080\nor name another server with --base-url. (llama-server and Ollama are detected; set HEYHO_CTX for others.)`;
export const INIT_TASK = `Write AGENTS.md at the root of this project: the notes you would want at the start of every session here. Look at the code first. Cover what the project is, how it is laid out, the commands to build, test and lint, and conventions the code follows. Keep it under 60 lines and state only what you verified.`;
const PLAN_ON = "[Plan mode is on. Investigate with read, search and read-only commands, then reply with a plan and stop. Do not change anything.]\n\n";
const PLAN_OFF = "[Plan mode is off. You may now make changes.]\n\n";

export type { Checkpoint };

export class App {
  readonly root: string;
  readonly stateDir: string;
  readonly approvals: Approvals;
  readonly changes: Changes;
  readonly stats: Stats = newStats();
  readonly messages: Message[] = [];
  readonly checkpoints: Checkpoint[] = [];
  profile: Profile & { local: boolean };
  profileName: string;
  server = "";
  contextSize = 0;
  session!: Session;
  resumed?: SessionInfo;
  running: AbortController | null = null;
  tools: Tool[] = TOOLS;
  problems: string[] = []; // settings that could not be used, to show at start
  private folderNotes = new Set<string>(); // subfolder instruction files already given to the model
  get notesFile() {
    return this.ctx.notesFile!;
  }
  private firstMessage(): Message {
    this.folderNotes.clear();
    return { role: "system", content: systemPrompt(this.root, new Date(), this.notesFile, { replace: this.opts.systemPrompt, append: this.opts.appendSystemPrompt }) };
  }
  // The instruction files in effect, for /memory.
  instructionFiles() {
    return instructions(this.root, this.notesFile).files;
  }
  private ctx: ToolContext;
  private note = ""; // told to the model at the start of the next user message
  private toldPlan = false;
  private runStart = 0;
  private opts: AppOptions;
  private front: Front;

  constructor(opts: AppOptions, front: Front) {
    this.opts = opts;
    this.front = front;
    this.root = opts.cwd;
    this.stateDir = join(heyhoHome(), "projects", createHash("sha256").update(this.root).digest("hex").slice(0, 16));
    mkdirSync(this.stateDir, { recursive: true });
    this.profileName = opts.profile;
    this.profile = loadProfile(opts.profile, { baseUrl: opts.baseUrl, model: opts.model });
    const settings = loadSettings(this.root);
    this.approvals = new Approvals(opts.mode, join(this.stateDir, "allowed.json"), this.root, settings.layers);
    this.problems = [...settings.problems, ...this.approvals.problems];
    for (const [action, list] of [["allow", opts.allow], ["deny", opts.deny]] as const)
      for (const rule of list ?? []) if (!this.approvals.addRule(action, rule)) throw new Error(`"${rule}" is not a rule. Examples: bash(npm test *), edit(src/**), read(.env)`);
    if (opts.tools) {
      const unknown = opts.tools.filter((n) => !TOOLS.some((t) => t.name === n));
      if (unknown.length) throw new Error(`Unknown tool${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Tools: ${TOOLS.map((t) => t.name).join(", ")}.`);
      this.tools = TOOLS.filter((t) => opts.tools!.includes(t.name));
    }
    this.changes = new Changes(this.root);
    this.ctx = {
      root: this.root,
      stateDir: this.stateDir,
      seen: new Map(),
      sandbox: { enabled: opts.mode === "yolo", noNet: opts.noNet },
      outCount: { n: 0 },
      jobs: [],
      onTodos: (items) => front.todos?.(items),
      question: opts.canAsk && front.question ? front.question : undefined,
      onChange: (abs, before, after) => {
        // The notes file is the agent's own; it is not part of the project's changes to undo.
        if (abs !== this.ctx.notesFile) {
          this.changes.record(abs, before, after);
          this.session.record({ change: { turn: this.changes.turnCount - 1, path: abs, before, after } });
        }
        front.changed?.({ path: abs.startsWith(this.root + "/") ? abs.slice(this.root.length + 1) : abs, before, after });
      },
      onOutput: (chunk) => front.output?.(chunk),
      notesFile: join(this.stateDir, "memory", "NOTES.md"),
      readExtra: (abs) => folderInstructions(this.root, abs, this.folderNotes),
      readDenied: (abs) => {
        const rule = this.approvals.readDenied(abs);
        return rule ? `A rule set by the user forbids reading this file (${rule.text}). Do not try to read it another way.` : null;
      },
      approve: (kind, summary, change) => this.approve(kind, summary, change),
    };
  }

  // Finds the server and its context size, then opens a new session or the last one.
  async start() {
    await this.connect();
    // A headless run carries on from headless runs too; an interactive one skips those one-offs.
    const earlier = listSessions(this.stateDir, 50, { headless: this.opts.headless });
    const wanted = this.opts.resumeName?.toLowerCase();
    this.resumed = wanted ? earlier.find((s) => s.first.toLowerCase().includes(wanted)) : this.opts.resume ? earlier[0] : undefined;
    if (wanted && !this.resumed) throw new Error(`No session in this directory matches "${this.opts.resumeName}".`);
    if (this.opts.resume && !this.resumed) throw new Error("There is no earlier session in this directory to continue.");
    if (this.resumed) this.restore(loadSession(this.resumed.file));
    else this.open([this.firstMessage()], true);
    if (this.opts.sessionName) this.rename(this.opts.sessionName);
  }

  // Opens a new session file that carries on an earlier one: its conversation, the points
  // it can be rewound to, the file changes behind them, its name and its mode.
  private restore(old: Loaded) {
    this.open(old.messages, true);
    this.ctx.seen.clear();
    this.checkpoints.length = 0;
    this.checkpoints.push(...old.checkpoints);
    this.changes.load(old.turns);
    old.turns.forEach((turn, n) => turn.forEach((e, path) => this.session.record({ change: { turn: n, path, ...e } })));
    this.saveCheckpoints();
    if (old.name) this.rename(old.name);
    if (old.mode && old.mode !== "yolo" && MODES.includes(old.mode as Mode)) this.setMode(old.mode as Mode);
  }

  private saveCheckpoints() {
    this.session.record({ checkpoints: this.checkpoints });
    this.session.record({ turns: this.changes.turnCount });
  }

  name = "";
  rename(name: string) {
    this.name = name.trim();
    this.session.record({ name: this.name });
  }

  async connect() {
    const probed = this.profile.local ? await probeContext(this.profile.baseUrl) : null;
    const size = Number(process.env.HEYHO_CTX) || probed?.ctx || (this.profile.local ? 0 : 128_000);
    if (!size) throw new Error(SERVER_HELP(this.profile.baseUrl));
    this.contextSize = size;
    this.server = probed?.server ?? new URL(this.profile.baseUrl).host;
    if (probed?.server === "ollama" && probed.ctx > 131_072)
      this.front.note(`Ollama is running this model with a ${probed.ctx}-token context, which uses far more memory than needed. Set OLLAMA_CONTEXT_LENGTH=65536.`, "error");
  }

  get mode() {
    return this.approvals.mode;
  }
  setMode(mode: Mode) {
    this.approvals.mode = mode;
    this.session?.record({ meta: { mode } });
    this.ctx.sandbox.enabled = mode === "yolo";
  }
  cycleMode(): Mode {
    this.setMode(CYCLE[(CYCLE.indexOf(this.mode) + 1) % CYCLE.length]);
    return this.mode;
  }

  get contextUsed() {
    const last = this.stats.turns.at(-1);
    return (last?.prompt ?? 0) + (last?.completion ?? 0);
  }

  private async approve(kind: Kind, summary: string, change?: Change): Promise<boolean | string> {
    const verdict = this.approvals.decide(kind, summary);
    if (verdict.action === "allow") return true;
    if (verdict.action === "deny") return `Blocked: a rule set by the user forbids this (${verdict.rule!.text}). Do not try another way to do the same thing; say that it is not allowed.`;
    if (this.mode === "plan" && kind !== "fetch") return PLAN_REFUSAL; // reading a page changes nothing
    if (this.mode === "dontask") return "Blocked: this session runs without asking, and this action is not on the allowed list. Carry on without it, or say what you could not do.";
    if (!this.opts.canAsk) return false;
    const suggested = kind === "bash" ? this.approvals.suggest(summary) : null;
    const prefix = kind === "fetch" ? new URL(summary).hostname : suggested?.length ? suggested.map((p) => `${p} …`).join(", ") : null;
    const answer = await this.front.ask({ kind, summary, change, prefix });
    if (typeof answer === "object") return answer.say;
    if (kind === "fetch" && (answer === "always" || answer === "prefix")) this.approvals.allowHost(summary);
    else if (answer === "always") kind === "bash" ? this.approvals.allowExact(summary) : this.approvals.allowKind(kind);
    else if (answer === "prefix" && prefix) this.approvals.allowSuggested(summary);
    return answer !== "no";
  }

  // Replaces the conversation in place: a running agent holds this same array.
  private open(next: Message[], fresh: boolean) {
    if (fresh) {
      this.session = newSession(this.stateDir);
      this.session.record({ meta: { root: this.root, profile: this.profileName, model: this.profile.model, baseUrl: this.profile.baseUrl, contextSize: this.contextSize, server: this.server, headless: this.opts.headless, mode: this.mode } });
    } else this.session.record({ reset: true });
    this.messages.length = 0;
    this.messages.push(...next);
    for (const m of next) this.session.record(m);
  }

  private push(m: Message) {
    this.messages.push(m);
    this.session.record(m);
  }

  private async shorten(signal?: AbortSignal) {
    this.front.onEvent({ type: "request", step: 0 });
    const next = await compact(this.profile, this.messages, toolSchemas(this.tools), { signal, onReasoning: (text) => this.front.onEvent({ type: "thinking", text }) });
    this.open(next, false);
    // Earlier prompts are gone from the conversation, so it can't be rewound to them any more.
    for (const c of this.checkpoints) c.messages = Math.min(c.messages, this.messages.length);
    this.saveCheckpoints();
    this.front.note("Shortened the conversation to the model's own notes. Files it read earlier will be read again when needed.", "dim");
  }

  async run(text: string): Promise<{ result: Outcome; info: RunInfo }> {
    const withPaths = text.replace(/(^|\s)@(\S+)/g, (all, lead, p) => (existsSync(join(this.root, p)) ? lead + p : all));
    const plan = this.mode === "plan";
    this.checkpoints.push({ text, messages: this.messages.length, turn: this.changes.turnCount });
    this.saveCheckpoints();
    this.push({ role: "user", content: (plan && !this.toldPlan ? PLAN_ON : !plan && this.toldPlan ? PLAN_OFF : "") + this.note + withPaths });
    this.toldPlan = plan;
    this.note = "";
    this.changes.startTurn();
    this.runStart = Date.now();
    const abort = (this.running = new AbortController());
    this.ctx.signal = abort.signal;
    const agent = () =>
      runAgent({ profile: this.profile, messages: this.messages, tools: this.tools, ctx: this.ctx, maxSteps: this.opts.maxSteps, contextSize: this.contextSize, stats: this.stats, onEvent: this.front.onEvent, record: (e) => this.session.record(e), signal: abort.signal });
    let result: Outcome;
    try {
      result = await agent();
      if (result.status === "context_full") {
        await this.shorten(abort.signal);
        this.push({ role: "user", content: CARRY_ON });
        result = await agent();
      }
    } catch (e) {
      const reason = (e as Error).message;
      result = abort.signal.aborted ? { status: "interrupted" } : { status: "error", reason: /connection failed|ECONNREFUSED|fetch failed/i.test(reason) ? `${reason}. Is the model server still running?` : reason };
    } finally {
      this.running = null;
    }
    const last = this.stats.turns.at(-1);
    const info: RunInfo = { model: this.profile.model, contextSize: this.contextSize, wallMs: Date.now() - this.runStart, steps: this.stats.steps, lastPrompt: last?.prompt ?? 0, lastCompletion: last?.completion ?? 0, tps: last?.genTps, changes: this.changes.summary() };
    return { result, info };
  }

  get runningFor() {
    return this.running ? Date.now() - this.runStart : 0;
  }
  interrupt() {
    this.running?.abort();
  }
  get jobs(): Job[] {
    return this.ctx.jobs;
  }
  // Whether a background command is still going (it may have ended without telling us if it was killed from outside).
  jobRunning(job: Job): boolean {
    if (job.exit !== undefined) return false;
    try {
      process.kill(job.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  stopJob(job: Job) {
    try {
      process.kill(-job.pid, "SIGKILL");
    } catch {}
  }
  // Background commands do not outlive the session.
  shutdown() {
    for (const job of this.ctx.jobs) if (this.jobRunning(job)) this.stopJob(job);
  }
  lastReply(): string | null {
    const m = this.messages.findLast((x) => x.role === "assistant");
    return m && typeof m.content === "string" ? m.content : null;
  }

  // ---- commands ----

  async compact(): Promise<string | null> {
    if (this.messages.length < 4) return "Nothing to shorten yet.";
    const abort = (this.running = new AbortController());
    try {
      await this.shorten(abort.signal);
      return null;
    } catch (e) {
      return abort.signal.aborted ? "Stopped; the conversation is unchanged." : `Could not shorten the conversation: ${(e as Error).message}`;
    } finally {
      this.running = null;
    }
  }

  clear() {
    this.open([this.firstMessage()], true);
    this.ctx.seen.clear();
    this.checkpoints.length = 0;
    this.changes.load([]);
    this.name = "";
  }

  sessions(): SessionInfo[] {
    return listSessions(this.stateDir).filter((s) => s.file !== this.session.file);
  }
  resume(info: SessionInfo) {
    this.restore(loadSession(info.file));
  }

  private tellUndone(restored: string[]) {
    if (restored.length) this.note = `[The user took back your file changes from an earlier turn. These files are back to their previous content: ${restored.join(", ")}. Read them again before editing.]\n\n`;
  }

  undo(): { restored: string[]; skipped: string[] } | null {
    const r = this.changes.undo();
    if (r) this.tellUndone(r.restored);
    this.saveCheckpoints();
    return r;
  }

  // Goes back to just before checkpoint `index`: the files, the conversation, or both.
  // Returns the prompt that was typed there, to put back in the input.
  rewind(index: number, what: { code: boolean; conversation: boolean }): { text: string; restored: string[]; skipped: string[] } {
    const cp = this.checkpoints[index];
    const files = what.code ? this.changes.rewindTo(cp.turn) : { restored: [], skipped: [] };
    if (what.conversation) {
      this.open(this.messages.slice(0, cp.messages), false);
      this.checkpoints.length = index;
      this.toldPlan = false;
      this.note = "";
    } else this.tellUndone(files.restored);
    this.saveCheckpoints();
    return { text: cp.text, ...files };
  }

  async switchModel(name: string): Promise<string | null> {
    const before = { profile: this.profile, name: this.profileName };
    try {
      this.profile = loadProfile(name, {});
      this.profileName = name;
      await this.connect();
      return null;
    } catch (e) {
      this.profile = before.profile;
      this.profileName = before.name;
      return (e as Error).message;
    }
  }

  // The user's own command: run as typed, and told to the model with the next message.
  shell(command: string): { output: string; code: number | null } {
    const r = spawnSync("/bin/bash", ["-c", command], { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const output = (r.stdout ?? "") + (r.stderr ?? "");
    this.note += `[The user ran \`${command.trim()}\` (exit code ${r.status}):\n${output.slice(-4000)}]\n\n`;
    return { output, code: r.status };
  }

  // The conversation as markdown: what was asked, what was answered, and which tools ran.
  exportText(): string {
    const out: string[] = [`# heyho session${this.name ? `: ${this.name}` : ""}`, "", `${this.profile.model} · ${this.root} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, ""];
    for (const m of this.messages) {
      if (m.role === "user") out.push("## You", "", m.content, "");
      else if (m.role === "assistant") {
        if (m.content) out.push("## heyho", "", m.content, "");
        for (const c of m.tool_calls ?? []) out.push(`- ran \`${c.function.name}\` ${c.function.arguments.replace(/\s+/g, " ").slice(0, 160)}`);
        if (m.tool_calls?.length) out.push("");
      }
    }
    return out.join("\n");
  }

  status(version: string): string[] {
    return [
      `heyho v${version}`,
      `folder: ${this.root}`,
      `model: ${this.profile.model} (profile ${this.profileName}) on ${this.server}, ${this.profile.baseUrl}`,
      `context: ${this.contextUsed} of ${this.contextSize} tokens`,
      `mode: ${this.mode}`,
      `session: ${this.name || "(unnamed)"} · ${this.session.file}`,
      `messages you can go back to: ${this.checkpoints.length}`,
    ];
  }

  banner() {
    return `heyho · ${this.profile.model} · ${this.server} · ${this.contextSize} context · ${this.mode === "yolo" ? "yolo (sandboxed bash)" : this.mode}`;
  }
}
