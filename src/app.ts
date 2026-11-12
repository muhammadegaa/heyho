// One heyho session, without a screen: the conversation, the model connection, modes and
// approval rules, file changes, and the commands that act on them. A front end (the Ink
// screen, the line mode, or a headless run) supplies `Front` and calls these methods.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Approvals, MODES, PLAN_REFUSAL, prefixOf, type Kind, type Mode } from "./approve.ts";
import { Changes } from "./changes.ts";
import { CARRY_ON, compact } from "./compact.ts";
import { newStats, runAgent, type AgentEvent, type RunResult, type Stats } from "./loop.ts";
import { probeContext, type Message, type Profile } from "./model.ts";
import { loadProfile } from "./profiles.ts";
import { systemPrompt } from "./prompt.ts";
import { listSessions, loadMessages, newSession, type Session, type SessionInfo } from "./session.ts";
import { TOOLS, toolSchemas } from "./tools/index.ts";
import type { Change, ToolContext } from "./tools/types.ts";
import type { RunInfo } from "./ui.ts";

export type Outcome = RunResult | { status: "error"; reason: string };
export type ApprovalRequest = { kind: Kind; summary: string; change?: Change; prefix: string | null };
// "always": every edit this session, or this exact command from now on. "prefix": commands that start the same way.
export type ApprovalAnswer = "yes" | "always" | "prefix" | "no" | { say: string };

export type Front = {
  onEvent: (e: AgentEvent) => void;
  ask: (req: ApprovalRequest) => Promise<ApprovalAnswer>; // only called when a person can answer
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
  resume: boolean;
};

export const SERVER_HELP = (url: string) =>
  `No model server answered at ${url}.\nStart one, for example:\n  llama-server -m <model.gguf> --jinja -c 65536 --port 8080\nor name another server with --base-url. (llama-server and Ollama are detected; set HEYHO_CTX for others.)`;
export const INIT_TASK = `Write AGENTS.md at the root of this project: the notes you would want at the start of every session here. Look at the code first. Cover what the project is, how it is laid out, the commands to build, test and lint, and conventions the code follows. Keep it under 60 lines and state only what you verified.`;
const PLAN_ON = "[Plan mode is on. Investigate with read, search and read-only commands, then reply with a plan and stop. Do not change anything.]\n\n";
const PLAN_OFF = "[Plan mode is off. You may now make changes.]\n\n";

// Where a turn began: enough to put the conversation and the files back to that point.
export type Checkpoint = { text: string; messages: number; turn: number };

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
    this.stateDir = join(homedir(), ".heyho", "projects", createHash("sha256").update(this.root).digest("hex").slice(0, 16));
    mkdirSync(this.stateDir, { recursive: true });
    this.profileName = opts.profile;
    this.profile = loadProfile(opts.profile, { baseUrl: opts.baseUrl, model: opts.model });
    this.approvals = new Approvals(opts.mode, join(this.stateDir, "allowed.json"), this.root);
    this.changes = new Changes(this.root);
    this.ctx = {
      root: this.root,
      stateDir: this.stateDir,
      seen: new Map(),
      sandbox: { enabled: opts.mode === "yolo", noNet: opts.noNet },
      outCount: { n: 0 },
      onChange: (abs, before, after) => {
        this.changes.record(abs, before, after);
        front.changed?.({ path: abs.startsWith(this.root + "/") ? abs.slice(this.root.length + 1) : abs, before, after });
      },
      onOutput: (chunk) => front.output?.(chunk),
      approve: (kind, summary, change) => this.approve(kind, summary, change),
    };
  }

  // Finds the server and its context size, then opens a new session or the last one.
  async start() {
    await this.connect();
    this.resumed = this.opts.resume ? listSessions(this.stateDir, 1)[0] : undefined;
    if (this.opts.resume && !this.resumed) throw new Error("There is no earlier session in this directory to continue.");
    this.open(this.resumed ? loadMessages(this.resumed.file) : [{ role: "system", content: systemPrompt(this.root) }], true);
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
    this.ctx.sandbox.enabled = mode === "yolo";
  }
  cycleMode(): Mode {
    const cycle: Mode[] = MODES.filter((m) => m !== "yolo");
    this.setMode(cycle[(cycle.indexOf(this.mode) + 1) % cycle.length]);
    return this.mode;
  }

  get contextUsed() {
    const last = this.stats.turns.at(-1);
    return (last?.prompt ?? 0) + (last?.completion ?? 0);
  }

  private async approve(kind: Kind, summary: string, change?: Change): Promise<boolean | string> {
    if (this.approvals.allowed(kind, summary)) return true;
    if (this.mode === "plan") return PLAN_REFUSAL;
    if (!this.opts.canAsk) return false;
    const prefix = kind === "bash" ? prefixOf(summary) : null;
    const answer = await this.front.ask({ kind, summary, change, prefix });
    if (typeof answer === "object") return answer.say;
    if (answer === "always") kind === "bash" ? this.approvals.allowExact(summary) : this.approvals.allowKind(kind);
    if (answer === "prefix" && prefix) this.approvals.allowPrefix(prefix);
    return answer !== "no";
  }

  // Replaces the conversation in place: a running agent holds this same array.
  private open(next: Message[], fresh: boolean) {
    if (fresh) {
      this.session = newSession(this.stateDir);
      this.session.record({ meta: { root: this.root, profile: this.profileName, model: this.profile.model, baseUrl: this.profile.baseUrl, contextSize: this.contextSize, server: this.server, headless: this.opts.headless } });
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
    const next = await compact(this.profile, this.messages, toolSchemas(TOOLS), { signal, onReasoning: (text) => this.front.onEvent({ type: "thinking", text }) });
    this.open(next, false);
    // Earlier prompts are gone from the conversation, so it can't be rewound to them any more.
    for (const c of this.checkpoints) c.messages = Math.min(c.messages, this.messages.length);
    this.front.note("Shortened the conversation to the model's own notes. Files it read earlier will be read again when needed.", "dim");
  }

  async run(text: string): Promise<{ result: Outcome; info: RunInfo }> {
    const withPaths = text.replace(/(^|\s)@(\S+)/g, (all, lead, p) => (existsSync(join(this.root, p)) ? lead + p : all));
    const plan = this.mode === "plan";
    this.checkpoints.push({ text, messages: this.messages.length, turn: this.changes.turnCount });
    this.push({ role: "user", content: (plan && !this.toldPlan ? PLAN_ON : !plan && this.toldPlan ? PLAN_OFF : "") + this.note + withPaths });
    this.toldPlan = plan;
    this.note = "";
    this.changes.startTurn();
    this.runStart = Date.now();
    const abort = (this.running = new AbortController());
    this.ctx.signal = abort.signal;
    const agent = () =>
      runAgent({ profile: this.profile, messages: this.messages, tools: TOOLS, ctx: this.ctx, maxSteps: this.opts.maxSteps, contextSize: this.contextSize, stats: this.stats, onEvent: this.front.onEvent, record: (e) => this.session.record(e), signal: abort.signal });
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
    this.open([{ role: "system", content: systemPrompt(this.root) }], true);
    this.ctx.seen.clear();
    this.checkpoints.length = 0;
  }

  sessions(): SessionInfo[] {
    return listSessions(this.stateDir).filter((s) => s.file !== this.session.file);
  }
  resume(info: SessionInfo) {
    this.open(loadMessages(info.file), true);
    this.ctx.seen.clear();
    this.checkpoints.length = 0;
  }

  private tellUndone(restored: string[]) {
    if (restored.length) this.note = `[The user took back your file changes from an earlier turn. These files are back to their previous content: ${restored.join(", ")}. Read them again before editing.]\n\n`;
  }

  undo(): { restored: string[]; skipped: string[] } | null {
    const r = this.changes.undo();
    if (r) this.tellUndone(r.restored);
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

  banner() {
    return `heyho · ${this.profile.model} · ${this.server} · ${this.contextSize} context · ${this.mode === "yolo" ? "yolo (sandboxed bash)" : this.mode}`;
  }
}
